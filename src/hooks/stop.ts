import { join } from "node:path";

import { ExpectedError } from "../core/errors.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import { lockPathFor, withLock } from "../core/lock.js";
import { toPosixPath } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import {
  OPENBRAIN_LOADER_BEGIN_MARKER,
  OPENBRAIN_LOADER_END_MARKER,
} from "../loaders/index.js";
import { turnEndCapture } from "../staging/capture.js";
import { isPlanPayload, payloadBoolean } from "./events.js";
import {
  composeHookOutcomes,
  overBudget,
  runOrgan,
  type HookContext,
  type HookOutcome,
} from "./runtime.js";
import {
  fileMtimeMs,
  newestAuthoredMtimeMs,
  readTextFile,
  stateFilePath,
  stateRelativePath,
} from "./vault.js";

/**
 * The end-of-turn ritual: read first, write last. It does three things.
 *
 * It reminds. A turn that changed the vault and left the living state untouched
 * ends with a soft block, so continuity stops depending on the assistant
 * remembering to close its own loop. The evidence is modification times, not
 * the git index: a vault does not have to be a git repository, and a change
 * committed during the turn would vanish from a porcelain listing. The
 * comparison is coarse by design, which is exactly why the reminder is a soft
 * block and not a refusal.
 *
 * It enforces the load cap. A continuity file that grows without a ceiling
 * eventually costs more per session than it saves, which is invariant I11
 * applied to the one file every session reads first. The ceiling is declared by
 * the document itself, in its own front matter, and never hard-coded here: only
 * the person who writes the file knows how much of it is worth reading every
 * single time.
 *
 * It enforces the per-line budgets. The cap on the whole file evicts whole
 * sections, so one line that swallows an entire day keeps the document from ever
 * converging, however diligent the assistant is. That guard runs before the
 * reminder, because a turn that did update the state and left it out of budget
 * is exactly the turn that has to hear about it.
 *
 * The hook never authors vault content. Consolidation moves the overflow into
 * the archive layer and leaves a pointer behind; no sentence is rewritten and
 * no character is dropped. Moving is not deleting, which is what keeps survival
 * rule 3 intact. The archive is published before the living state is trimmed,
 * so the worst a crash between the two writes can produce is the same text
 * existing twice, never text existing nowhere.
 */

export const MAX_LOAD_KEY = "max_load";
export const STATE_ARCHIVE_DIRECTORY = "state";
const MAX_LOAD_SCAN_CHARS = 4_000;
const MAX_LOAD_LINE = /^max_load:[ \t]*(\d+)[ \t]*$/mu;
const CONSOLIDATION_LOCK_TIMEOUT_MS = 250;

/**
 * Per-line budgets of the living state, in characters, keyed by the front
 * matter key each one is declared under.
 *
 * The cap on the whole file cannot do this job. Consolidation evicts whole
 * sections, so a single day packed onto one enormous line can sit at eighty
 * percent of the declared max_load and leave the document unable to converge,
 * however diligent the assistant is. The tiers do the rest: a fresh day gets
 * room, an older one tightens on its own, and past a week consolidation moves
 * it to the archive and leaves a pointer.
 *
 * They are budgets per line rather than per section because the failure they
 * exist for is one line, not one section, and because a rule that lives only in
 * the header of a document does not hold. This one is checked by code.
 */
export const LINE_BUDGET_KEYS = {
  day: "line_budget_day",
  d1_d3: "line_budget_d1_d3",
  d4_d7: "line_budget_d4_d7",
  project: "line_budget_project",
  closed: "line_budget_closed",
} as const;

export type LineBudgetTier = keyof typeof LINE_BUDGET_KEYS;

export type StateLineBudgets = Record<LineBudgetTier, number>;

export const DEFAULT_LINE_BUDGETS: StateLineBudgets = {
  day: 1_200,
  d1_d3: 700,
  d4_d7: 250,
  project: 450,
  closed: 150,
};

/**
 * Headings whose dated lines are day entries of the running session, and
 * headings whose bullets are one workstream each. Matched by prefix, like the
 * session-start injector does, so "Current work (August)" still counts.
 */
const DAY_SECTION_HEADERS = ["Current session", "Current work"];
const PROJECT_SECTION_HEADERS = ["Active workstreams"];
/**
 * No template Open Brain ships generates a closed section, so this matches only
 * a vault whose owner keeps one. The budget exists for that case and costs
 * nothing when the section is absent.
 */
const CLOSED_SECTION_HEADERS = ["Closed"];

const DAY_LINE = /^(?:- )?(\d{4})-(\d{2})-(\d{2})\b/u;
const BULLET_LINE = /^- /u;

/** Offending lines named at once, per invariant I11. */
const MAX_LINES_REPORTED = 10;

export function handoffMessage(stateRelative: string): string {
  return `[open-brain handoff] End of turn: vault content changed but the living state was not updated. Update ${stateRelative} and provide a ready-to-paste restart prompt.`;
}

/**
 * The cap the document declares for itself, in characters.
 *
 * Characters and not lines, and the distinction is the whole point: a file that
 * packs one entry per very long line sits under any line ceiling forever while
 * costing a fortune in tokens. A ceiling that measures the wrong quantity never
 * fires, and a guard that never fires reads exactly like a guard that works.
 *
 * The lookup is deliberately cheap and shallow: the key is read from the head
 * of the file only, so a document that declares no cap costs one regular
 * expression and nothing more.
 */
export function declaredMaxLoad(text: string): number | undefined {
  const match = MAX_LOAD_LINE.exec(text.slice(0, MAX_LOAD_SCAN_CHARS));
  const raw = match?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The per-line budgets the document declares, defaulted key by key. A file that
 * declares none is still governed: the defaults are the contract, and the front
 * matter is how an owner disagrees with one of them without losing the rest.
 */
export function declaredLineBudgets(text: string): StateLineBudgets {
  const head = text.slice(0, MAX_LOAD_SCAN_CHARS);
  const budgets = { ...DEFAULT_LINE_BUDGETS };
  for (const tier of Object.keys(LINE_BUDGET_KEYS) as LineBudgetTier[]) {
    const match = new RegExp(`^${LINE_BUDGET_KEYS[tier]}:[ \\t]*(\\d+)[ \\t]*$`, "mu").exec(head);
    const raw = match?.[1];
    if (raw === undefined) {
      continue;
    }
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) {
      budgets[tier] = value;
    }
  }
  return budgets;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Age of a dated line in whole days, both dates taken at local noon so a
 * daylight saving change cannot move an entry into the wrong tier.
 */
export function dayLineAge(year: number, month: number, day: number, now: Date): number {
  const entry = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(entry.getTime())) {
    return 0;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - entry.getTime()) / MILLISECONDS_PER_DAY));
}

export function budgetForAge(age: number, budgets: StateLineBudgets): number {
  if (age <= 0) {
    return budgets.day;
  }
  return age <= 3 ? budgets.d1_d3 : budgets.d4_d7;
}

function sectionKind(title: string): "day" | "project" | "closed" | undefined {
  if (DAY_SECTION_HEADERS.some((header) => title.startsWith(header))) {
    return "day";
  }
  if (PROJECT_SECTION_HEADERS.some((header) => title.startsWith(header))) {
    return "project";
  }
  return CLOSED_SECTION_HEADERS.some((header) => title.startsWith(header)) ? "closed" : undefined;
}

function dayViolation(
  section: string,
  line: string,
  match: RegExpExecArray,
  budgets: StateLineBudgets,
  now: Date,
): string | undefined {
  const age = dayLineAge(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    now,
  );
  const budget = budgetForAge(age, budgets);
  if (line.length <= budget) {
    return undefined;
  }
  const date = `${String(match[1])}-${String(match[2])}-${String(match[3])}`;
  return `  ${section}, day ${date} (D-${String(age)}): ${String(line.length)} characters for a budget of ${String(budget)}. Keep the decisions, the red lines, the dated bars and the file paths; drop anything already written in a file this line cites.`;
}

function bulletViolation(
  section: string,
  line: string,
  budget: number,
): string | undefined {
  if (line.length <= budget) {
    return undefined;
  }
  const label = line.replace(BULLET_LINE, "").slice(0, 60).trim();
  return `  ${section}, "${label}": ${String(line.length)} characters for a budget of ${String(budget)}. The detail belongs in the vault file this line points to, not here.`;
}

/**
 * Every line of the living state that is over the budget of its own tier.
 *
 * Generated blocks are skipped: a consolidation pointer and a managed block are
 * machine output, not authored text, so judging them would only teach people to
 * edit what the engine wrote. Sections the vault does not have cost nothing,
 * which is how a state file that never grew a workstream list still passes.
 */
export function stateLineViolations(text: string, now: Date = new Date()): string[] {
  const budgets = declaredLineBudgets(text);
  const violations: string[] = [];
  let section = "";
  let kind: "day" | "project" | "closed" | undefined;
  let generated = false;

  for (const raw of splitFrontmatterText(text).body.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (line.startsWith(OPENBRAIN_LOADER_BEGIN_MARKER)) {
      generated = true;
      continue;
    }
    if (line.startsWith(OPENBRAIN_LOADER_END_MARKER)) {
      generated = false;
      continue;
    }
    if (generated || line.startsWith(">")) {
      continue;
    }
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      kind = sectionKind(section);
      continue;
    }
    if (kind === undefined) {
      continue;
    }

    const dated = DAY_LINE.exec(line);
    if (kind === "day") {
      const violation = dated === null
        ? undefined
        : dayViolation(section, line, dated, budgets, now);
      if (violation !== undefined) {
        violations.push(violation);
      }
      continue;
    }
    if (!BULLET_LINE.test(line)) {
      continue;
    }
    const violation = bulletViolation(
      section,
      line,
      kind === "project" ? budgets.project : budgets.closed,
    );
    if (violation !== undefined) {
      violations.push(violation);
    }
  }
  return violations;
}

/**
 * The message a soft block carries. It names each offending line, its size, its
 * budget and what to do about it, because a guard that only says "too long"
 * leaves the reader to guess which sentence to sacrifice.
 */
export function lineBudgetMessage(stateRelative: string, violations: readonly string[]): string {
  const listed = violations.slice(0, MAX_LINES_REPORTED);
  const rest = violations.length - listed.length;
  const lines = [
    `[open-brain load] ${stateRelative} is over the per-line budgets it declares in its own front matter. A writing rule that lives only in a header does not hold, so this one is checked here. Fix these before the turn closes:`,
    ...listed,
  ];
  if (rest > 0) {
    lines.push(`  ${String(rest)} more line(s) are over budget. Open the file to see them.`);
  }
  return lines.join("\n");
}

/** The guard as the stop hook runs it. Silent when every line fits. */
export async function checkStateLineBudgets(
  context: HookContext,
): Promise<string | undefined> {
  const text = await readTextFile(stateFilePath(context.vaultRoot, context.config));
  if (text === undefined) {
    return undefined;
  }
  const violations = stateLineViolations(text);
  return violations.length === 0
    ? undefined
    : lineBudgetMessage(stateRelativePath(context.config), violations);
}

function splitFrontmatterText(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text);
  return match
    ? { frontmatter: match[0], body: text.slice(match[0].length) }
    : { frontmatter: "", body: text };
}

/**
 * Splits a body into chunks that each begin at a level-two heading, with any
 * preamble as the first chunk. Concatenating the chunks reproduces the body
 * character for character, which is what makes the archive provably lossless.
 */
export function splitStateChunks(body: string): string[] {
  if (body.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of body.split(/(?<=\n)/u)) {
    if (piece.startsWith("## ") && current.length > 0) {
      chunks.push(current);
      current = piece;
      continue;
    }
    current += piece;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export interface ConsolidationPlan {
  keptText: string;
  archivedBody: string;
  movedChars: number;
  maxLoad: number;
}

function pointerLine(archiveRelative: string, movedChars: number): string {
  return `\n> [open-brain] ${String(movedChars)} character(s) moved to ${archiveRelative} to stay under the declared max_load. Nothing was deleted; open that file to read the rest.\n`;
}

/**
 * Decides what stays and what moves, without touching the disk. Returns
 * undefined when the file is under its cap, when it has no section to move, or
 * when moving anything would leave nothing behind: a living state reduced to a
 * pointer helps nobody.
 */
export function planConsolidation(
  text: string,
  archiveRelative: string,
): ConsolidationPlan | undefined {
  const maxLoad = declaredMaxLoad(text);
  if (maxLoad === undefined || text.length <= maxLoad) {
    return undefined;
  }

  const { frontmatter, body } = splitFrontmatterText(text);
  const chunks = splitStateChunks(body);
  if (chunks.length < 2) {
    return undefined;
  }

  // The pointer carries the final count, which is not known yet, so the room
  // reserved for it uses the longest form it could take.
  const reserve = pointerLine(archiveRelative, body.length).length;
  const room = maxLoad - frontmatter.length - reserve;
  const kept: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (kept.length > 0 && used + chunk.length > room) {
      break;
    }
    kept.push(chunk);
    used += chunk.length;
  }

  if (kept.length === chunks.length) {
    return undefined;
  }
  const keptBody = kept.join("");
  const archivedBody = body.slice(keptBody.length);
  return {
    keptText: frontmatter + keptBody + pointerLine(archiveRelative, archivedBody.length),
    archivedBody,
    movedChars: archivedBody.length,
    maxLoad,
  };
}

function archiveHeader(stateRelative: string, when: Date): string {
  return [
    "---",
    "lifecycle: data",
    "---",
    `# Archived living state, ${when.toISOString()}`,
    "",
    `Moved out of ${stateRelative} to keep it under its declared max_load.`,
    "Everything below this line is the overflow, verbatim and unedited.",
    "",
  ].join("\n") + "\n";
}

export function stateArchiveRelativePath(config: VaultConfig, when: Date): string {
  const stamp = when.toISOString().replace(/[:.]/gu, "-");
  return toPosixPath(
    join(config.paths.archive, STATE_ARCHIVE_DIRECTORY, `_state-${stamp}.md`),
  );
}

export interface ConsolidationResult {
  archive_path: string;
  moved_chars: number;
  max_load: number;
}

/**
 * Publishes the archive, then trims the living state. That order is the entire
 * safety argument: a crash between the two writes leaves the overflow in both
 * files, which is noise, rather than in neither, which is loss.
 */
export async function enforceStateCap(
  context: HookContext,
): Promise<ConsolidationResult | undefined> {
  const statePath = stateFilePath(context.vaultRoot, context.config);
  const text = await readTextFile(statePath);
  if (text === undefined || declaredMaxLoad(text) === undefined) {
    return undefined;
  }

  const when = new Date();
  const archiveRelative = stateArchiveRelativePath(context.config, when);
  const plan = planConsolidation(text, archiveRelative);
  if (plan === undefined) {
    return undefined;
  }

  try {
    return await withLock(
      lockPathFor(context.vaultRoot, "hook-state-cap"),
      async () => {
        // Re-read under the lock: whatever was read before acquiring it is
        // stale by construction, and this file is about to be rewritten.
        const current = await readTextFile(statePath);
        if (current !== text) {
          return undefined;
        }
        await atomicWriteText(
          join(context.vaultRoot, archiveRelative),
          archiveHeader(stateRelativePath(context.config), when) + plan.archivedBody,
        );
        await atomicWriteText(statePath, plan.keptText);
        return {
          archive_path: archiveRelative,
          moved_chars: plan.movedChars,
          max_load: plan.maxLoad,
        };
      },
      { timeoutMs: CONSOLIDATION_LOCK_TIMEOUT_MS, holder: "open-brain hook stop" },
    );
  } catch (error) {
    // Another process is already doing this. A hook waits for nothing.
    if (error instanceof ExpectedError) {
      return undefined;
    }
    throw error;
  }
}

export function consolidationNotice(result: ConsolidationResult): string {
  return `[open-brain load] The living state passed its declared max_load of ${String(result.max_load)} characters. ${String(result.moved_chars)} character(s) moved to ${result.archive_path}. Nothing was deleted.`;
}

export async function stopHook(context: HookContext): Promise<HookOutcome | undefined> {
  // The assistant is already continuing because of an earlier stop block.
  // Blocking again is how a hook turns into an infinite loop. turnEndCapture
  // guards on the same two conditions, so bailing here before ever calling it
  // is equivalent, not a behavior cut.
  if (payloadBoolean(context.payload, "stop_hook_active")) {
    return undefined;
  }
  if (isPlanPayload(context.payload)) {
    return undefined;
  }

  // Files the last human message before anything else in this handler, so a
  // slow or failing consolidation below never costs the deposit.
  const capture = overBudget(context)
    ? undefined
    : await runOrgan(() => turnEndCapture(context));

  const statePath = stateFilePath(context.vaultRoot, context.config);
  const stateRelative = stateRelativePath(context.config);
  // Captured before consolidation. Trimming the file touches it, and comparing
  // against the new timestamp would silently excuse a turn that never updated
  // the state at all.
  const stateMtime = await fileMtimeMs(statePath);
  if (stateMtime === undefined) {
    // No living state to keep current, so there is no ritual to enforce.
    return composeHookOutcomes(undefined, capture);
  }

  const consolidated = overBudget(context) ? undefined : await enforceStateCap(context);
  const notice = consolidated === undefined ? undefined : consolidationNotice(consolidated);
  const quiet: HookOutcome | undefined = notice === undefined ? undefined : { notice };

  if (overBudget(context)) {
    return composeHookOutcomes(quiet, capture);
  }

  // Before the handoff reminder, on purpose. A turn that did update the living
  // state but left a line over its budget has to hear about it, otherwise the
  // rule never applies at the one moment it could be acted on. It runs after
  // consolidation so it judges the file as it now stands on disk.
  const overflow = await runOrgan(async () => {
    const message = await checkStateLineBudgets(context);
    return message === undefined ? undefined : { block: message };
  });
  if (overflow !== undefined) {
    const overflowBase: HookOutcome = notice === undefined
      ? overflow
      : { notice, ...overflow };
    return composeHookOutcomes(overflowBase, capture);
  }

  const newestContent = await newestAuthoredMtimeMs(
    context.vaultRoot,
    context.config,
    context.deadline,
    new Set([stateRelative]),
  );
  if (newestContent === 0 || newestContent <= stateMtime) {
    return composeHookOutcomes(quiet, capture);
  }
  const block = handoffMessage(stateRelative);
  const base: HookOutcome = notice === undefined ? { block } : { notice, block };
  return composeHookOutcomes(base, capture);
}
