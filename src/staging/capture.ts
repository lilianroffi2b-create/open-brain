import { capText, emptyBudget, type ContextBudget } from "../core/budget.js";
import { isEnabled, requireCapability } from "../core/capabilities.js";
import { isCodexPayload, isPlanPayload, payloadBoolean, payloadString } from "../hooks/events.js";
import { registerPreCompactExtractor } from "../hooks/pre-compact.js";
import { overBudget, type HookContext, type HookOutcome } from "../hooks/runtime.js";
import type { VaultConfig } from "../core/types.js";
import { redactText } from "../transcripts/redact.js";
import {
  identityTokens,
  readConsentedTranscript,
  type ConsentedRead,
  type HumanMessage,
} from "../transcripts/reader.js";
import { digest } from "./candidate.js";
import {
  defaultCaptureSettings,
  detectSignal,
  loadCaptureSettings,
  type CaptureSettings,
} from "./markers.js";
import { appendCandidate, appendCandidates, stagingStatus } from "./store.js";
import {
  IdempotencyConflictError,
  type CandidateRow,
  type CandidateSignal,
  type CandidateSource,
  type Harness,
} from "./types.js";

/**
 * The capture organs. Four moments where material that would otherwise be lost
 * can be filed for review, plus the offline replay that stands in for them on a
 * CLI with no hook support.
 *
 * Every one of them obeys the same four rules:
 *
 * 1. Nothing runs without capabilities.capture. It ships disarmed, and a
 *    disarmed vault never files a candidate on its own. The one exception is a
 *    deposit the user types themselves, which is `open-brain staging add` and
 *    is the user speaking rather than a machine listening.
 * 2. Nothing writes to the store directly. Everything goes through the staging
 *    store, which owns the schema, the lock, and the idempotency.
 * 3. Nothing fails loudly. An organ that cannot do its job returns nothing. A
 *    broken capture costs a lost candidate; a thrown capture costs a session.
 * 4. Nothing is unbounded. Bytes read, lines parsed, messages examined and
 *    candidates filed all have a ceiling, and what was cut is reported.
 *
 * Redaction runs before anything reaches the store, including on material that
 * never came from a transcript, because a prompt carries secrets just as
 * readily as a transcript does.
 */

export const CAPTURE_OPERATION_PREFIX = "capture-";
export const CAPTURE_BATCH_OPERATION_PREFIX = "capture-batch-";
export const MAX_REMINDER_CHARS = 400;

/**
 * The identity of one observation. An event identifier beats a turn identifier,
 * which beats the text itself, so replaying the same hook on the same session
 * never files a second copy, while two genuinely distinct events in one turn
 * stay two candidates.
 *
 * Returns null when the harness or the session is unknown: without them there
 * is no stable identity, and inventing one would make an unrelated message in
 * another session look like a replay of this one.
 */
export function captureOperationId(message: HumanMessage): string | null {
  if (message.session_id === null || message.harness === "unknown") {
    return null;
  }
  const identity = identityTokens(message);
  return CAPTURE_OPERATION_PREFIX + digest([
    message.harness,
    message.session_id,
    identity.kind,
    identity.value,
  ]);
}

export function captureBatchOperationId(
  harness: Harness,
  sessionId: string | null,
  operationIds: readonly string[],
): string {
  return CAPTURE_BATCH_OPERATION_PREFIX + digest([harness, sessionId, [...operationIds]]);
}

export interface CaptureDeposit {
  request: Record<string, unknown>;
  signal: CandidateSignal;
  markers: string[];
  operation_id: string | null;
}

function redactIfConfigured(config: VaultConfig, text: string): string {
  return config.capabilities.transcripts.redact ? redactText(text).text : text;
}

/**
 * Turns one detected message into a deposit request. The quote is the user's
 * own sentence, redacted but never rewritten: the review is worthless if what a
 * human reads is a paraphrase produced by the thing asking for approval.
 */
export function depositFromMessage(
  config: VaultConfig,
  message: HumanMessage,
  source: CandidateSource,
  settings: CaptureSettings,
): CaptureDeposit | undefined {
  const detection = detectSignal(
    {
      text: message.text,
      hasAssistantContext: message.assistant_context !== null
        && message.assistant_context.trim().length > 0,
    },
    settings.markers,
  );
  if (detection.signal === undefined) {
    return undefined;
  }
  const operationId = captureOperationId(message);
  const context = message.assistant_context === null
    ? null
    : redactIfConfigured(config, message.assistant_context).trim();

  return {
    request: {
      source,
      signal: detection.signal,
      raw_quote: redactIfConfigured(config, message.text),
      raw_markers: detection.markers,
      harness: message.harness,
      session_id: message.session_id,
      turn_id: message.turn_id,
      event_id: message.event_id,
      context: context === null || context.length === 0 ? null : context,
      ...(operationId === null ? {} : { operation_id: operationId }),
    },
    signal: detection.signal,
    markers: detection.markers,
    operation_id: operationId,
  };
}

/**
 * Every message that carries a signal, newest last, deduplicated by operation
 * identifier and capped. The cap is applied from the end: when a window carries
 * more matches than one deposit may file, the recent ones win, because they are
 * the ones the user still remembers saying.
 */
export function depositsFromMessages(
  config: VaultConfig,
  messages: readonly HumanMessage[],
  source: CandidateSource,
  settings: CaptureSettings,
): CaptureDeposit[] {
  const found: CaptureDeposit[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const deposit = depositFromMessage(config, message, source, settings);
    if (deposit === undefined) {
      continue;
    }
    if (deposit.operation_id !== null) {
      if (seen.has(deposit.operation_id)) {
        continue;
      }
      seen.add(deposit.operation_id);
    }
    found.push(deposit);
  }
  const cap = Math.max(1, settings.limits.max_candidates_per_scan);
  return found.length <= cap ? found : found.slice(found.length - cap);
}

export interface ScanResult {
  staged: CandidateRow[];
  created: boolean;
  examined: number;
  matched: number;
  filed: number;
  read: ConsentedRead;
  budget: ContextBudget;
  dry_run: boolean;
}

export interface ScanOptions {
  dryRun?: boolean | undefined;
  settings?: CaptureSettings | undefined;
  source?: CandidateSource | undefined;
  maxMessages?: number | undefined;
}

/**
 * Replays the pre-compaction detection over one transcript. This is the single
 * implementation: the hook calls it with the path the host provided, and
 * `open-brain capture scan` calls it with the path a human typed. One code
 * path, so the offline degradation cannot drift away from the wired one.
 */
export async function scanTranscriptForCandidates(
  vaultRoot: string,
  config: VaultConfig,
  transcriptPath: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    // Refuse before reading rather than after: a disarmed vault should not
    // spend a single byte discovering it cannot file what it found.
    requireCapability(config, "capture");
  }
  const settings = options.settings ?? await loadCaptureSettings(vaultRoot);
  const source: CandidateSource = options.source ?? "pre_compact";
  const read = await readConsentedTranscript(vaultRoot, config, transcriptPath, {
    maxBytes: settings.limits.transcript_max_bytes,
    maxLines: settings.limits.transcript_max_lines,
    maxMessages: options.maxMessages ?? settings.limits.max_messages_per_scan,
  });

  const deposits = depositsFromMessages(config, read.messages, source, settings);
  if (deposits.length === 0 || dryRun) {
    return {
      staged: [],
      created: false,
      examined: read.messages.length,
      matched: deposits.length,
      filed: 0,
      read,
      budget: read.budget,
      dry_run: dryRun,
    };
  }

  const operationIds = deposits
    .map((deposit) => deposit.operation_id)
    .filter((value): value is string => value !== null);
  const batchOperationId = captureBatchOperationId(
    read.session.harness,
    read.session.session_id,
    operationIds,
  );

  try {
    const result = await appendCandidates(
      vaultRoot,
      config,
      deposits.map((deposit) => deposit.request),
      { operationId: batchOperationId },
    );
    return {
      staged: result.candidates,
      created: result.created,
      examined: read.messages.length,
      matched: deposits.length,
      filed: result.created ? result.candidates.length : 0,
      read,
      budget: read.budget,
      dry_run: false,
    };
  } catch (error) {
    if (!(error instanceof IdempotencyConflictError)) {
      throw error;
    }
    // Part of this window is already staged, which is the normal case when a
    // compaction fires twice or when a scan overlaps an earlier one. Fall back
    // to one deposit at a time and keep whatever is genuinely new.
    const staged: CandidateRow[] = [];
    let filed = 0;
    for (const deposit of deposits) {
      try {
        const result = await appendCandidate(vaultRoot, config, deposit.request);
        staged.push(result.candidate);
        filed += result.created ? 1 : 0;
      } catch (itemError) {
        if (!(itemError instanceof IdempotencyConflictError)) {
          throw itemError;
        }
      }
    }
    return {
      staged,
      created: filed > 0,
      examined: read.messages.length,
      matched: deposits.length,
      filed,
      read,
      budget: read.budget,
      dry_run: false,
    };
  }
}

function messageFromPayload(payload: Record<string, unknown>, text: string): HumanMessage {
  const harness: Harness = isCodexPayload(payload) ? "codex" : "claude-code";
  return {
    harness,
    session_id: payloadString(payload, "session_id") ?? null,
    text,
    timestamp: null,
    turn_id: payloadString(payload, "turn_id") ?? null,
    event_id: payloadString(payload, "event_id") ?? payloadString(payload, "client_id") ?? null,
    transcript_path: payloadString(payload, "transcript_path") ?? "",
    assistant_context: null,
  };
}

async function settingsFor(context: HookContext): Promise<CaptureSettings> {
  try {
    return await loadCaptureSettings(context.vaultRoot);
  } catch {
    return defaultCaptureSettings();
  }
}

/**
 * UserPromptSubmit. The user just gave an instruction; if it carries an
 * explicit request to remember something, it is filed on the spot.
 *
 * Only the explicit signal is captured here. A correction or a compliment in a
 * prompt is about the turn that is starting, not about anything the assistant
 * has produced yet, and the end-of-turn organ sees it with its context intact.
 * Plan mode is inert: the assistant is drafting, not acting, and neither is the
 * user.
 */
export async function promptSubmitCapture(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  try {
    if (!isEnabled(context.config, "capture") || isPlanPayload(context.payload)) {
      return undefined;
    }
    const prompt = payloadString(context.payload, "prompt");
    if (prompt === undefined || prompt.trim().length === 0) {
      return undefined;
    }
    const settings = await settingsFor(context);
    const message = messageFromPayload(context.payload, prompt);
    const deposit = depositFromMessage(context.config, message, "prompt_submit", settings);
    if (deposit === undefined || deposit.signal !== "explicit_request") {
      return undefined;
    }
    await appendCandidate(context.vaultRoot, context.config, deposit.request);
    return undefined;
  } catch {
    // Rule 3. A capture that fails is a capture that says nothing.
    return undefined;
  }
}

/**
 * Stop. The turn that just ended is the only moment where the last thing the
 * user said can still be paired with what the assistant had produced, which is
 * what separates a compliment with evidence from one without.
 *
 * It needs the transcript, so it needs the transcripts capability too. With
 * that capability disarmed the organ reads nothing and stays silent, which is
 * the honest degradation rather than a guess from the payload alone.
 */
export async function turnEndCapture(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  try {
    if (!isEnabled(context.config, "capture")) {
      return undefined;
    }
    // The assistant is already continuing because of an earlier stop block.
    if (payloadBoolean(context.payload, "stop_hook_active") || isPlanPayload(context.payload)) {
      return undefined;
    }
    const transcriptPath = payloadString(context.payload, "transcript_path");
    if (transcriptPath === undefined || overBudget(context)) {
      return undefined;
    }
    const settings = await settingsFor(context);
    const read = await readConsentedTranscript(
      context.vaultRoot,
      context.config,
      transcriptPath,
      {
        maxBytes: settings.limits.transcript_max_bytes,
        maxLines: settings.limits.transcript_max_lines,
        maxMessages: 1,
      },
    );
    const last = read.messages[read.messages.length - 1];
    if (last === undefined) {
      return undefined;
    }
    const deposit = depositFromMessage(context.config, last, "turn_end", settings);
    if (deposit === undefined) {
      return undefined;
    }
    await appendCandidate(context.vaultRoot, context.config, deposit.request);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * PreCompact. Compaction is the one event that destroys detail on purpose, so
 * this is the last moment a window of the session can be read at full
 * resolution. It files a bounded slice and says what it did on stderr, never on
 * stdout: the host has no established contract for injecting context at
 * compaction time, and a hook that guesses one corrupts the response.
 */
export async function preCompactCapture(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  try {
    if (!isEnabled(context.config, "capture")) {
      return undefined;
    }
    const transcriptPath = payloadString(context.payload, "transcript_path");
    if (transcriptPath === undefined || overBudget(context)) {
      return undefined;
    }
    const settings = await settingsFor(context);
    const result = await scanTranscriptForCandidates(
      context.vaultRoot,
      context.config,
      transcriptPath,
      { settings, source: "pre_compact" },
    );
    if (result.filed === 0) {
      return undefined;
    }
    const truncation = result.read.truncated
      ? ` The transcript was read from its last ${String(settings.limits.transcript_max_bytes)} bytes, so earlier messages were not examined.`
      : "";
    return {
      notice: `[open-brain capture] Filed ${String(result.filed)} candidate(s) from the ${String(result.examined)} most recent message(s) before compaction.${truncation} Nothing is written to the kernel until you review it with \`open-brain sync\`.`,
    };
  } catch {
    return undefined;
  }
}

/**
 * SessionStart. Counts what is still waiting and says so in one line, or says
 * nothing at all. It reads the vault and nothing else, so it needs no
 * capability: a reminder about candidates the user already owns is not a
 * capture.
 *
 * When the store cannot be read it says exactly that. Reporting an empty
 * staging area because the file was unreadable is the one failure mode that
 * would make a user trust a queue that is silently broken.
 */
export async function sessionStartStagingReminder(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  let status;
  try {
    status = await stagingStatus(context.vaultRoot, context.config);
  } catch {
    const capped = capText(
      "[open-brain] Staging status unavailable: the candidate store could not be read. No mutation was attempted. Do not conclude that nothing is staged; report it and offer to rerun `open-brain staging status`.",
      MAX_REMINDER_CHARS,
    );
    return { context: capped.text, budget: capped.budget };
  }
  if (status.resumable === 0) {
    return undefined;
  }
  const capped = capText(
    `[open-brain] ${String(status.resumable)} staged item(s) await review. Run \`open-brain sync\` to triage and apply. Nothing is written until you approve it, and the review is human-initiated only.`,
    MAX_REMINDER_CHARS,
  );
  return { context: capped.text, budget: capped.budget };
}

/**
 * Wires the pre-compaction organ into the hook layer. It is a function rather
 * than a side effect of importing this module: an import must never change what
 * a hook does, or the wiring becomes impossible to reason about from the entry
 * point.
 */
export function registerCaptureOrgans(): void {
  registerPreCompactExtractor(preCompactCapture);
}

/**
 * The generated loader block for a CLI with no hook support. Level one of the
 * degradation ladder: no events, but the assistant reads a loader, so the
 * loader carries the commands the events would have run.
 */
export function renderCaptureLoaderLines(captureEnabled: boolean): string[] {
  const lines = [
    "## OpenBrain staging",
    "",
    "This CLI has no hook support, so nothing is captured automatically. The commands below replace the events.",
    "",
    "At the start of a session, check what is waiting:",
    "  open-brain staging status",
    "If anything is pending, tell the user and offer to run the review. Never run it yourself: `open-brain sync` is human-initiated only.",
    "",
    "When the user explicitly asks for something to be remembered, file it verbatim:",
    '  open-brain staging add --quote "their sentence, in their own words"',
    "Stage what they said, not your summary of it. That command needs no capability armed.",
  ];
  if (captureEnabled) {
    lines.push(
      "",
      "Before a long session is compacted, or at the end of one, replay the detection over the session transcript:",
      "  open-brain capture scan --transcript <path to the session transcript>",
      "That reads only inside directories consented to with `open-brain capabilities enable transcripts --root <directory>`.",
    );
  }
  return lines;
}

export function emptyCaptureBudget(): ContextBudget {
  return emptyBudget();
}
