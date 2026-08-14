import { dirname, resolve } from "node:path";

import { capText, estimateTokens, type ContextBudget } from "../core/budget.js";
import { isEnabled } from "../core/capabilities.js";
import { findVaultConfigPath, loadConfigResult } from "../core/config.js";
import type { VaultConfig } from "../core/types.js";
import {
  HOST_EVENT_NAMES,
  isCodexPayload,
  isRecord,
  payloadString,
  type HookEvent,
} from "./events.js";

/**
 * The common envelope every hook runs inside. It owns the five survival rules
 * of the hook contract so no handler has to remember them:
 *
 * 1. A hook never fails loudly. Every exception is caught here and the process
 *    exits 0 in silence. The only deliberate non-zero exit is a soft block.
 * 2. A hook has a time budget. A handler that checks in before the budget
 *    runs out returns what it has by then; one still running when the budget
 *    fires is dropped in silence rather than killed mid-write. It never holds
 *    a session open.
 * 3. A hook is never destructive. It moves content it owns, it never drops it.
 * 4. A hook respects capabilities. With capabilities.hooks disarmed the
 *    envelope exits 0 before reading a single byte of vault content.
 * 5. hooks status reports the wiring and hooks install repairs it, on both
 *    hosts; doctor covers the rest of the vault, not the host settings files.
 *
 * Output contract. stdout never carries bare text: it carries a JSON envelope
 * whose shape depends on the event, and on the host for one of them.
 *
 *   SessionStart, context    exit 0, hookSpecificOutput.additionalContext,
 *                            plus hookSpecificOutput.budget when the organ
 *                            that built the context reported one
 *   UserPromptSubmit, ctx    exit 0, hookSpecificOutput.additionalContext,
 *                            same optional budget field
 *   PreToolUse, refusal      exit 0, hookSpecificOutput.permissionDecision deny
 *   PostToolUse, block       exit 0, { decision: "block", reason }
 *   Stop, block              { decision: "block", reason } on Codex,
 *                            exit 2 with the message on stderr on Claude Code
 *   nothing to say           exit 0, empty stdout
 *
 * A refusal and a soft block are not the same thing and are not spelled the
 * same way. permissionDecision deny is the host's first-class refusal: the tool
 * call does not happen. exit 2 is a soft block that hands text back to the
 * assistant and lets it decide. The guard needs the first one.
 *
 * The divergence between hosts is real and is handled by branching, not by
 * flattening it: forcing one contract everywhere throws away the native
 * mechanism of whichever host loses the vote. This file is the only place that
 * knows any of these shapes. Handlers return an abstract HookOutcome and never
 * write JSON by hand.
 */

export type { HookEvent } from "./events.js";

export const DEFAULT_HOOK_BUDGET_MS = 2_000;
export const HOOK_BUDGET_ENV = "OPEN_BRAIN_HOOK_BUDGET_MS";

/**
 * The timeout Open Brain declares in the host settings files, in seconds. It
 * has to stay strictly above the internal budget so the internal deadline
 * always fires first and the hook gets to return what it has. A test asserts
 * the nesting, otherwise the configuration drifts away from the code in
 * silence.
 */
export const HOOK_DECLARED_TIMEOUT_SECONDS = 5;

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const STDIN_READ_TIMEOUT_MS = 1_000;

export interface HookContext {
  event: HookEvent;
  payload: Record<string, unknown>;
  vaultRoot: string;
  config: VaultConfig;
  deadline: number;
}

export interface HookOutcome {
  /** Text to inject into the model's context. */
  context?: string;
  /** Reason the action is refused, rendered per event and per host. */
  block?: string;
  /** What the injected context cost, for invariant I11. */
  budget?: ContextBudget;
  /**
   * A diagnostic for the human, never for the model. It goes to stderr with
   * exit 0 on its own, and is folded into the block message when there is one,
   * so a hook that did something worth knowing about is never silent about it.
   */
  notice?: string;
}

export type HookHandler = (context: HookContext) => Promise<HookOutcome | undefined>;

export function overBudget(context: HookContext): boolean {
  return Date.now() >= context.deadline;
}

/**
 * The environment variable wins when set: it is how a host or a test overrides
 * the budget for one process without editing the vault. Absent that, the
 * vault's own capabilities.hooks.budget_ms applies, and only then the default.
 */
export function hookBudgetMs(config?: VaultConfig): number {
  const raw = process.env[HOOK_BUDGET_ENV];
  if (raw !== undefined && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    if (value > 0) {
      return value;
    }
  }
  const configured = config?.capabilities.hooks.budget_ms;
  if (typeof configured === "number" && Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_HOOK_BUDGET_MS;
}

/**
 * Runs one organ that produces a HookOutcome, catching whatever it throws.
 * Composition means several organs share one handler, and one organ's failure
 * must never take the others down with it: the base outcome always survives,
 * exit 0, survival rule 1 applied at the seam between organs and not only at
 * the top of runHook.
 */
export async function runOrgan(
  organ: () => Promise<HookOutcome | undefined>,
): Promise<HookOutcome | undefined> {
  try {
    return await organ();
  } catch {
    return undefined;
  }
}

const CONTEXT_SEPARATOR = "\n\n";

function mergeField(
  base: string | undefined,
  addition: string | undefined,
  separator: string,
): string | undefined {
  const parts = [base, addition].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join(separator);
}

/**
 * Adds two budgets together. When the merged context text is known, chars and
 * token_estimate are read from that text instead of from base.chars +
 * addition.chars: the two components' own reports never included the
 * separator joining them, and a summed figure would quietly under-report the
 * true cost.
 */
function mergeBudget(
  base: ContextBudget | undefined,
  addition: ContextBudget | undefined,
  mergedContext: string | undefined,
): ContextBudget | undefined {
  if (base === undefined) {
    return addition;
  }
  if (addition === undefined) {
    return base;
  }
  return {
    chars: mergedContext === undefined ? base.chars + addition.chars : mergedContext.length,
    token_estimate: mergedContext === undefined
      ? base.token_estimate + addition.token_estimate
      : estimateTokens(mergedContext),
    items_shown: base.items_shown + addition.items_shown,
    items_total: base.items_total + addition.items_total,
    truncated: base.truncated || addition.truncated,
  };
}

/**
 * Composes a base organ's outcome with one added alongside it. Their texts
 * concatenate, their budgets add, and a block from either side always survives
 * (emit() already prefers a block over a bare context, so a block never loses
 * to an injection here).
 *
 * The base organ's content is never the one cut. When maxContextChars is
 * given and the two contexts together would cross it, the addition is capped
 * to whatever room the base left behind, which is what keeps invariant I11
 * true after composition and not only before it.
 */
export function composeHookOutcomes(
  base: HookOutcome | undefined,
  addition: HookOutcome | undefined,
  maxContextChars?: number,
): HookOutcome | undefined {
  if (addition === undefined) {
    return base;
  }
  if (base === undefined) {
    return addition;
  }

  let additionContext = addition.context;
  let additionBudget = addition.budget;
  if (
    maxContextChars !== undefined
    && additionContext !== undefined
    && additionContext.length > 0
  ) {
    const baseLength = base.context?.length ?? 0;
    // The separator only lands in the final text when both sides are
    // non-empty, so only reserve room for it in that case.
    const reserved = baseLength > 0 ? CONTEXT_SEPARATOR.length : 0;
    const room = Math.max(0, maxContextChars - baseLength - reserved);
    const capped = capText(additionContext, room);
    additionContext = capped.text.length > 0 ? capped.text : undefined;
    additionBudget = capped.budget;
  }

  const outcome: HookOutcome = {};
  const context = mergeField(base.context, additionContext, CONTEXT_SEPARATOR);
  const block = mergeField(base.block, addition.block, "\n");
  const notice = mergeField(base.notice, addition.notice, " ");
  const budget = mergeBudget(base.budget, additionBudget, context);
  if (context !== undefined) {
    outcome.context = context;
  }
  if (block !== undefined) {
    outcome.block = block;
  }
  if (notice !== undefined) {
    outcome.notice = notice;
  }
  if (budget !== undefined) {
    outcome.budget = budget;
  }
  return Object.keys(outcome).length === 0 ? undefined : outcome;
}

/**
 * Reads the JSON payload the host writes to stdin. Bounded twice: by size, so a
 * runaway producer cannot exhaust memory, and by time, so a host that opens the
 * pipe without ever closing it cannot wedge the hook.
 */
function readStdinText(): Promise<string> {
  return new Promise((resolveText) => {
    const stream = process.stdin;
    if (stream.isTTY) {
      resolveText("");
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", finish);
      stream.removeListener("error", finish);
      stream.pause();
      resolveText(Buffer.concat(chunks).toString("utf8"));
    };

    const onData = (chunk: Buffer): void => {
      const remaining = MAX_PAYLOAD_BYTES - size;
      if (remaining <= 0) {
        finish();
        return;
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      size += Math.min(chunk.length, remaining);
    };

    const timer = setTimeout(finish, STDIN_READ_TIMEOUT_MS);
    timer.unref();
    stream.on("data", onData);
    stream.once("end", finish);
    stream.once("error", finish);
  });
}

export async function readHookPayload(): Promise<Record<string, unknown>> {
  const text = await readStdinText();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Finds the vault the hook is running against. The payload's working directory
 * comes first because it is the only signal both hosts provide; the Claude Code
 * project variable is a fallback, never a requirement, because Codex does not
 * set it. Returns undefined when no vault is in scope, which is a legitimate
 * and silent outcome.
 */
export async function resolveHookVaultRoot(
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  const candidates = [
    payloadString(payload, "cwd"),
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd(),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) {
      continue;
    }
    const start = resolve(candidate);
    if (seen.has(start)) {
      continue;
    }
    seen.add(start);
    const configPath = await findVaultConfigPath(start);
    if (configPath !== undefined) {
      return dirname(dirname(configPath));
    }
  }
  return undefined;
}

const DEADLINE_REACHED = Symbol("deadline-reached");

interface Deadline {
  reached: Promise<typeof DEADLINE_REACHED>;
  cancel: () => void;
}

/**
 * The timer is deliberately not unref'd: a handler that stops doing I/O and
 * never resolves would let the event loop drain, and an unref'd timer would
 * never fire to notice. It is cancelled as soon as the race settles, so a
 * handler that finishes early does not keep the process alive for the rest of
 * its budget.
 */
function deadlineRace(budgetMs: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<typeof DEADLINE_REACHED>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(DEADLINE_REACHED), budgetMs);
  });
  return {
    reached,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/** How a refusal is spelled for one event on one host. */
export type BlockForm = "permission-deny" | "decision-block" | "stderr-exit-2";

/**
 * The rendering table. PreToolUse gets the host's first-class refusal because a
 * red line has to actually stop the call. PostToolUse gets the structured block
 * on both hosts. Stop is the one event where the two hosts genuinely differ, so
 * it branches on the payload rather than picking a winner.
 */
export function blockFormFor(event: HookEvent, codex: boolean): BlockForm {
  switch (event) {
    case "pre-tool-use":
      return "permission-deny";
    case "post-tool-use":
      return "decision-block";
    case "stop":
      return codex ? "decision-block" : "stderr-exit-2";
    case "session-start":
    case "user-prompt-submit":
    case "pre-compact":
      return "stderr-exit-2";
  }
}

/**
 * The host's own name for the event, taken from the payload when it sends one.
 * Echoing what the host called it keeps the envelope valid if a host renames an
 * event, instead of answering with a name it no longer recognises.
 */
function hostEventName(event: HookEvent, payload: Record<string, unknown>): string {
  return payloadString(payload, "hook_event_name") ?? HOST_EVENT_NAMES[event];
}

function writeEnvelope(value: unknown): void {
  // One line of JSON on stdout and nothing else: a single stray character
  // breaks the host's parsing of the whole response.
  process.stdout.write(JSON.stringify(value) + "\n");
}

function emitBlock(
  event: HookEvent,
  payload: Record<string, unknown>,
  message: string,
): void {
  switch (blockFormFor(event, isCodexPayload(payload))) {
    case "permission-deny":
      writeEnvelope({
        hookSpecificOutput: {
          hookEventName: hostEventName(event, payload),
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      });
      return;
    case "decision-block":
      writeEnvelope({ decision: "block", reason: message });
      return;
    case "stderr-exit-2":
      process.stderr.write(message + "\n");
      process.exitCode = 2;
  }
}

function emitContext(
  event: HookEvent,
  payload: Record<string, unknown>,
  text: string,
  budget: ContextBudget | undefined,
): void {
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: hostEventName(event, payload),
    additionalContext: text,
  };
  // Only added when the organ actually reported one: an envelope with no
  // budget field is what an event that never carried one still looks like,
  // so an unrelated handler's contract test never sees a new key appear.
  if (budget !== undefined) {
    hookSpecificOutput.budget = budget;
  }
  writeEnvelope({ hookSpecificOutput });
}

function emit(
  event: HookEvent,
  payload: Record<string, unknown>,
  outcome: HookOutcome,
): void {
  const notice = outcome.notice?.trim() ?? "";
  const block = outcome.block?.trim() ?? "";
  if (block.length > 0) {
    emitBlock(event, payload, notice.length > 0 ? notice + "\n" + block : block);
    return;
  }
  if (notice.length > 0) {
    process.stderr.write(notice + "\n");
  }
  const context = outcome.context?.trim() ?? "";
  if (context.length > 0) {
    emitContext(event, payload, context, outcome.budget);
  }
}

/**
 * Runs one hook handler under the contract. Never throws, never exits with a
 * code other than 0 or 2, and never writes anything a host could mistake for
 * context when the handler had nothing to say.
 */
export async function runHook(event: HookEvent, handler: HookHandler): Promise<void> {
  try {
    const payload = await readHookPayload();
    const vaultRoot = await resolveHookVaultRoot(payload);
    if (vaultRoot === undefined) {
      return;
    }

    const { config } = await loadConfigResult(vaultRoot);
    if (!isEnabled(config, "hooks")) {
      // Rule 4: disarmed means nothing is read and nothing is emitted.
      return;
    }

    const budgetMs = hookBudgetMs(config);
    const context: HookContext = {
      event,
      payload,
      vaultRoot,
      config,
      deadline: Date.now() + budgetMs,
    };

    const deadline = deadlineRace(budgetMs);
    let outcome: HookOutcome | undefined | typeof DEADLINE_REACHED;
    try {
      outcome = await Promise.race([handler(context), deadline.reached]);
    } finally {
      deadline.cancel();
    }
    if (outcome === DEADLINE_REACHED) {
      // The handler overran its budget. Nothing was written yet, so leaving now
      // costs the session a silent hook instead of a stalled prompt.
      process.exit(0);
    }
    if (outcome !== undefined) {
      emit(event, payload, outcome);
    }
  } catch {
    // Rule 1. A broken hook is a silent hook, never a broken session.
    process.exitCode = 0;
  }
}
