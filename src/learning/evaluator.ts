import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

import { estimateTokens, type ContextBudget } from "../core/budget.js";
import { requireCapability } from "../core/capabilities.js";
import { fsyncDirectory } from "../core/fs-atomic.js";
import type { VaultConfig } from "../core/types.js";
import { readJournal, type JournalReadOptions } from "./journal.js";
import { isLearningDisabled } from "./population.js";
import { DEFAULT_LEARNING_TUNING, readLearningTuning, type EvaluatorTuning } from "./sensors/index.js";
import { learningDirectory } from "./store.js";
import {
  DISARMED_RULES,
  LEARNING_SCHEMA_VERSION,
  LINE_MAX_BYTES,
  SchemaError,
  encodeLine,
  fitLine,
  nowTs,
  parseTs,
  validateVerdict,
  type DecisionEntry,
  type JournalEntry,
  type Verdict,
  type VerdictOutcome,
  type VerdictRule,
} from "./types.js";

/**
 * The evaluator joins the decision journal to what actually happened and hands
 * out one verdict per decision and per rule. It is entirely deterministic:
 * counting, comparing dates, intersecting sets. No model, no token, no opinion.
 *
 * `undetermined` is a legitimate and valuable result. A window that has not
 * closed yet, a session with no external witness, a source that does not exist:
 * the evaluator says so and counts it, rather than inventing a judgement it
 * cannot support.
 */

export const VERDICTS_FILENAME = "verdicts.jsonl";
export const VERDICT_TAIL_BYTES = 512 * 1024;

/** A route launched by hand leaves no transcript, so evaluating it would fabricate failures. */
export const MANUAL_SESSION = "manual";

/**
 * The weight is a priority for whoever reads the verdicts. It NEVER multiplies a
 * confidence delta: the deltas are plus one and minus two, and nothing else is
 * allowed to modulate them.
 */
export const VERDICT_WEIGHTS: Readonly<Record<VerdictRule, number>> = {
  sterile_route: 1,
  belief_corrected: 2,
  belief_confirmed: 1,
  dead_output: 1,
  rapid_followup: 1,
  wasted_load: 1,
  deliverable_shipped: 1,
};

/**
 * Rules allowed to conclude. The three that are absent measure something they
 * cannot see from inside the vault, so they always answer undetermined and stay
 * disarmed rather than pretend.
 */
export const ARMED_RULES: readonly VerdictRule[] = [
  "sterile_route",
  "belief_corrected",
  "belief_confirmed",
  "dead_output",
];

export function isArmed(rule: VerdictRule): boolean {
  return ARMED_RULES.includes(rule) && !DISARMED_RULES.includes(rule);
}

export interface FileEvent {
  path: string;
  ts: string;
}

/**
 * What an external witness saw of a session. The layer writes the journal
 * itself, so a rule that concludes on the journal alone would be rewarding the
 * layer on its own trace. This is the corroboration, and its absence is a
 * result rather than a detail.
 */
export interface SessionWitness {
  session: string;
  last_ts: string;
  reads: readonly FileEvent[];
  writes: readonly FileEvent[];
}

export interface EvaluationInput {
  now: string;
  decisions: readonly DecisionEntry[];
  sessions?: readonly SessionWitness[];
  population?: readonly string[] | undefined;
  windows?: EvaluatorTuning;
}

interface RuleContext {
  decision: DecisionEntry;
  /** Every decision of that session, in order, the anchor included. */
  session: readonly DecisionEntry[];
  following: readonly DecisionEntry[];
  witness: SessionWitness | undefined;
  witnesses: ReadonlyMap<string, SessionWitness>;
  lastActivity: string;
  now: string;
  windows: EvaluatorTuning;
  population: ReadonlySet<string> | undefined;
}

interface RuleOutcome {
  verdict: VerdictOutcome;
  evidence: Record<string, unknown>;
}

type Rule = (context: RuleContext) => RuleOutcome | undefined;

function msBetween(from: string, to: string): number {
  return parseTs(to).getTime() - parseTs(from).getTime();
}

function orderOf(entry: DecisionEntry): string {
  return `${entry.ts}#${entry.id}`;
}

function sortDecisions(decisions: readonly DecisionEntry[]): DecisionEntry[] {
  return [...decisions].sort((left, right) =>
    orderOf(left) < orderOf(right) ? -1 : orderOf(left) > orderOf(right) ? 1 : 0);
}

function sessionClosed(context: RuleContext): boolean {
  const idleMs = msBetween(context.lastActivity, context.now);
  return idleMs >= context.windows.session_closed_hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// The seven rules.
// ---------------------------------------------------------------------------

const ruleSterileRoute: Rule = (context) => {
  if (context.decision.type !== "route") {
    return undefined;
  }
  const routed = context.population === undefined
    ? context.decision.documents
    : context.decision.documents.filter((document) => context.population?.has(document) === true);
  if (routed.length === 0) {
    return {
      verdict: "undetermined",
      evidence: {
        documents_routed: context.decision.documents.length,
        reason: "no_document_in_population",
      },
    };
  }
  if (!context.witness) {
    return {
      verdict: "undetermined",
      evidence: { documents_routed: routed.length, reason: "session_without_transcript" },
    };
  }
  const opened = routed.filter((document) =>
    context.witness?.reads.some((read) => read.path === document && read.ts >= context.decision.ts)
    === true);
  return {
    verdict: opened.length > 0 ? "good" : "bad",
    evidence: {
      documents_routed: routed.length,
      documents_opened: opened.length,
      documents_sterile: routed.length - opened.length,
    },
  };
};

/**
 * An eviction counts once, and it is carried by the LAST application that
 * precedes it. The window slides, so without that anchor one correction would be
 * seen by the two applications before it and produce two bad verdicts, that is
 * minus four instead of minus two. A wrong number stays wrong even when it errs
 * on the safe side.
 */
const ruleBeliefCorrected: Rule = (context) => {
  const applied = context.decision.beliefs_applied;
  if (applied.length === 0) {
    return undefined;
  }
  const window = context.following.slice(0, context.windows.correction_window_turns);
  const corrected: string[] = [];
  for (const candidate of window) {
    for (const belief of applied) {
      if (!candidate.beliefs_evicted.includes(belief)) {
        continue;
      }
      const anchor = context.session
        .filter((entry) =>
          orderOf(entry) < orderOf(candidate) && entry.beliefs_applied.includes(belief))
        .at(-1);
      if (anchor?.id !== context.decision.id) {
        continue;
      }
      corrected.push(belief);
    }
  }
  if (corrected.length > 0) {
    return {
      verdict: "bad",
      evidence: {
        beliefs_applied: applied.length,
        beliefs_corrected: corrected.length,
        beliefs: [...new Set(corrected)],
        turns_observed: context.following.length,
        window_turns: context.windows.correction_window_turns,
      },
    };
  }
  if (window.length < context.windows.correction_window_turns && !sessionClosed(context)) {
    return {
      verdict: "undetermined",
      evidence: {
        beliefs_applied: applied.length,
        turns_observed: context.following.length,
        window_turns: context.windows.correction_window_turns,
        reason: "window_incomplete",
      },
    };
  }
  return {
    verdict: "undetermined",
    evidence: {
      beliefs_applied: applied.length,
      beliefs_corrected: 0,
      turns_observed: context.following.length,
      window_turns: context.windows.correction_window_turns,
    },
  };
};

/**
 * Four cumulative guards, all of them needed:
 * 1. at most once per session and per belief, carried by the earliest
 *    application, which is the only anchor that later decisions cannot move;
 * 2. the window must be COMPLETE whatever the state of the session, because a
 *    belief injected on the last turn was once confirmed on zero observed turn;
 * 3. the session must be closed, since a correction can still arrive;
 * 4. an external witness is required, because the only source of
 *    beliefs_applied is the journal, which this layer writes itself.
 */
const ruleBeliefConfirmed: Rule = (context) => {
  const earlier = context.session.filter((entry) =>
    orderOf(entry) < orderOf(context.decision));
  const applied = context.decision.beliefs_applied.filter((belief) =>
    !earlier.some((entry) => entry.beliefs_applied.includes(belief)));
  if (applied.length === 0) {
    return undefined;
  }
  const evidence: Record<string, unknown> = {
    beliefs_applied: applied.length,
    beliefs: applied,
    turns_observed: context.following.length,
    window_turns: context.windows.confirmation_window_turns,
  };
  if (context.following.length < context.windows.confirmation_window_turns) {
    return { verdict: "undetermined", evidence: { ...evidence, reason: "window_incomplete" } };
  }
  if (!context.witness) {
    return {
      verdict: "undetermined",
      evidence: { ...evidence, reason: "session_without_transcript" },
    };
  }
  if (!sessionClosed(context)) {
    return { verdict: "undetermined", evidence: { ...evidence, reason: "session_open" } };
  }
  const corrections = context.session.filter((entry) =>
    applied.some((belief) => entry.beliefs_evicted.includes(belief))).length;
  if (corrections > 0) {
    return { verdict: "undetermined", evidence: { ...evidence, corrections } };
  }
  return { verdict: "good", evidence: { ...evidence, corrections: 0 } };
};

/**
 * The files judged here are the ones the witness shows written between this
 * decision and the next produced decision of the same session. The state of the
 * working tree is never consulted: it is cumulative, it is not specific to the
 * turn, and it is dirty on paths that have nothing to do with the decision.
 */
const ruleDeadOutput: Rule = (context) => {
  if (context.decision.type !== "produced") {
    return undefined;
  }
  const nextProduced = context.following.find((entry) => entry.type === "produced");
  const writes = (context.witness?.writes ?? []).filter((write) =>
    write.ts >= context.decision.ts
    && (nextProduced === undefined || write.ts < nextProduced.ts));
  if (writes.length === 0) {
    return {
      verdict: "undetermined",
      evidence: { files_written: 0, reason: "no_write_in_transcript" },
    };
  }
  const windowMs = context.windows.dead_output_days * 24 * 60 * 60 * 1000;
  if (msBetween(context.decision.ts, context.now) < windowMs) {
    return {
      verdict: "undetermined",
      evidence: {
        files_written: writes.length,
        window_days: context.windows.dead_output_days,
        reason: "window_not_closed",
      },
    };
  }
  const dead = writes.filter((write) => {
    for (const witness of context.witnesses.values()) {
      const reread = witness.reads.some((read) =>
        read.path === write.path
        && read.ts > write.ts
        && msBetween(write.ts, read.ts) <= windowMs);
      if (reread) {
        return false;
      }
    }
    return true;
  });
  return {
    verdict: dead.length === 0 ? "good" : "bad",
    evidence: {
      files_written: writes.length,
      files_dead: dead.length,
      window_days: context.windows.dead_output_days,
    },
  };
};

/** Measured, never armed: the threshold is a rhythm, and a rhythm needs calibrating. */
const ruleRapidFollowup: Rule = (context) => {
  if (context.decision.type !== "route") {
    return undefined;
  }
  const next = context.following.find((entry) => entry.type === "route");
  if (!next) {
    return { verdict: "undetermined", evidence: { reason: "no_following_route" } };
  }
  const seconds = Math.floor(msBetween(context.decision.ts, next.ts) / 1000);
  const identical = next.input.hash === context.decision.input.hash;
  return {
    verdict: seconds > context.windows.rapid_followup_seconds || identical ? "good" : "bad",
    evidence: {
      seconds_before_followup: seconds,
      threshold_seconds: context.windows.rapid_followup_seconds,
      identical_input: identical ? 1 : 0,
    },
  };
};

/** Implemented, always undetermined: nothing in scope can tell whether injected context was used. */
const ruleWastedLoad: Rule = (context) => {
  if (context.decision.type !== "route") {
    return undefined;
  }
  return {
    verdict: "undetermined",
    evidence: {
      documents_injected: context.decision.documents.length,
      reason: "context_citation_not_observable",
    },
  };
};

/** Implemented, always undetermined: it would take a source this layer does not have. */
const ruleDeliverableShipped: Rule = (context) => {
  if (context.decision.type !== "produced") {
    return undefined;
  }
  return {
    verdict: "undetermined",
    evidence: {
      files_produced: context.decision.documents.length,
      reason: "source_unavailable",
    },
  };
};

const RULES: ReadonlyArray<[VerdictRule, Rule]> = [
  ["sterile_route", ruleSterileRoute],
  ["belief_corrected", ruleBeliefCorrected],
  ["belief_confirmed", ruleBeliefConfirmed],
  ["dead_output", ruleDeadOutput],
  ["rapid_followup", ruleRapidFollowup],
  ["wasted_load", ruleWastedLoad],
  ["deliverable_shipped", ruleDeliverableShipped],
];

export function buildVerdict(
  decisionId: string,
  rule: VerdictRule,
  outcome: RuleOutcome,
  evaluatedAt: string,
): Verdict {
  return validateVerdict({
    schema_version: LEARNING_SCHEMA_VERSION,
    decision_id: decisionId,
    rule,
    verdict: outcome.verdict,
    weight: VERDICT_WEIGHTS[rule],
    armed: isArmed(rule),
    evidence: outcome.evidence,
    evaluated_at: evaluatedAt,
  });
}

/** Every rule, over every evaluable decision. Pure: it reads nothing and writes nothing. */
export function evaluate(input: EvaluationInput): Verdict[] {
  const windows = input.windows ?? DEFAULT_LEARNING_TUNING.evaluator;
  const witnesses = new Map((input.sessions ?? []).map((session) => [session.session, session]));
  const population = input.population === undefined ? undefined : new Set(input.population);
  const ordered = sortDecisions(input.decisions);
  const bySession = new Map<string, DecisionEntry[]>();
  for (const decision of ordered) {
    const bucket = bySession.get(decision.session) ?? [];
    bucket.push(decision);
    bySession.set(decision.session, bucket);
  }

  const verdicts: Verdict[] = [];
  for (const decision of ordered) {
    // An entry of manual origin has no transcript by construction, so
    // evaluating it would manufacture sterile routes that never happened.
    if (decision.session === MANUAL_SESSION) {
      continue;
    }
    const session = bySession.get(decision.session) ?? [decision];
    const position = session.findIndex((entry) => entry.id === decision.id);
    const following = position === -1 ? [] : session.slice(position + 1);
    const witness = witnesses.get(decision.session);
    const lastDecision = session[session.length - 1]?.ts ?? decision.ts;
    const lastActivity = witness && witness.last_ts > lastDecision ? witness.last_ts : lastDecision;
    const context: RuleContext = {
      decision,
      session,
      following,
      witness,
      witnesses,
      lastActivity,
      now: input.now,
      windows,
      population,
    };
    for (const [rule, run] of RULES) {
      const outcome = run(context);
      if (outcome) {
        verdicts.push(buildVerdict(decision.id, rule, outcome, input.now));
      }
    }
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Persistence, append only and bounded on read.
// ---------------------------------------------------------------------------

export function verdictsPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), VERDICTS_FILENAME);
}

/**
 * The identity of a verdict, deliberately without evaluated_at: re-evaluating
 * the same decision to the same conclusion is not an event. A verdict that
 * CHANGES, a window that closes, an undetermined that becomes a bad, does
 * produce a new line, and the last line wins.
 */
export function verdictDigest(verdict: Verdict): string {
  return JSON.stringify([
    verdict.decision_id,
    verdict.rule,
    verdict.verdict,
    verdict.weight,
    verdict.armed,
    stableValue(verdict.evidence),
  ]);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return entries.map(([key, item]) => [key, stableValue(item)]);
  }
  return value;
}

async function readTailLines(path: string, maxBytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return [];
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}

export interface VerdictReadOptions {
  limit: number;
  rule?: VerdictRule;
  armedOnly?: boolean;
  maxBytes?: number;
}

export interface VerdictRead {
  verdicts: Verdict[];
  budget: ContextBudget;
  invalid: number;
}

export async function readVerdicts(
  config: VaultConfig,
  root: string,
  options: VerdictReadOptions,
): Promise<VerdictRead> {
  requireCapability(config, "learning");
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new SchemaError("A verdict read needs a limit of at least one entry.");
  }
  const lines = await readTailLines(verdictsPath(config, root), options.maxBytes ?? VERDICT_TAIL_BYTES);
  const kept: Verdict[] = [];
  let invalid = 0;
  let total = 0;
  for (const line of lines) {
    let verdict: Verdict;
    try {
      verdict = validateVerdict(JSON.parse(line) as unknown);
    } catch {
      invalid += 1;
      continue;
    }
    if (options.rule !== undefined && verdict.rule !== options.rule) {
      continue;
    }
    if (options.armedOnly === true && !verdict.armed) {
      continue;
    }
    total += 1;
    kept.push(verdict);
    if (kept.length > options.limit) {
      kept.shift();
    }
  }
  const text = kept.map((verdict) => JSON.stringify(verdict)).join("\n");
  return {
    verdicts: kept,
    invalid,
    budget: {
      chars: text.length,
      token_estimate: estimateTokens(text),
      items_shown: kept.length,
      items_total: total,
      truncated: total > kept.length,
    },
  };
}

export async function existingDigests(
  config: VaultConfig,
  root: string,
  maxBytes: number = VERDICT_TAIL_BYTES,
): Promise<Set<string>> {
  const lines = await readTailLines(verdictsPath(config, root), maxBytes);
  const digests = new Set<string>();
  for (const line of lines) {
    try {
      digests.add(verdictDigest(validateVerdict(JSON.parse(line) as unknown)));
    } catch {
      // A line that no longer satisfies the contract is skipped, never repaired.
    }
  }
  return digests;
}

export async function appendVerdicts(
  config: VaultConfig,
  root: string,
  verdicts: readonly Verdict[],
): Promise<number> {
  requireCapability(config, "learning.evaluate");
  if (verdicts.length === 0) {
    return 0;
  }
  const path = verdictsPath(config, root);
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true });
  const existed = await stat(path).then(() => true).catch(() => false);
  const handle = await open(path, "a");
  try {
    for (const verdict of verdicts) {
      const fitted = fitLine(validateVerdict(verdict), LINE_MAX_BYTES);
      await handle.write(Buffer.from(encodeLine(validateVerdict(fitted.record)), "utf8"));
    }
    await handle.datasync();
  } finally {
    await handle.close();
  }
  if (!existed) {
    await fsyncDirectory(directory);
  }
  return verdicts.length;
}

export interface EvaluatorPassOptions {
  now?: string;
  sessions?: readonly SessionWitness[];
  population?: readonly string[];
  limit?: number;
  maxPartitions?: number;
  since?: string;
  windows?: EvaluatorTuning;
}

export interface EvaluatorPassReport {
  ran: boolean;
  reason?: string;
  computed: number;
  written: number;
  unchanged: number;
  decisions: number;
  by_outcome: Record<VerdictOutcome, number>;
  budget: ContextBudget;
}

/**
 * One evaluation pass. It concludes, so it lives behind learning.evaluate and it
 * touches nothing at all while that capability is disarmed.
 */
export async function runEvaluatorPass(
  config: VaultConfig,
  root: string,
  options: EvaluatorPassOptions = {},
): Promise<EvaluatorPassReport> {
  requireCapability(config, "learning.evaluate");
  const now = options.now ?? nowTs();
  const empty: EvaluatorPassReport = {
    ran: false,
    computed: 0,
    written: 0,
    unchanged: 0,
    decisions: 0,
    by_outcome: { good: 0, bad: 0, undetermined: 0 },
    budget: { chars: 0, token_estimate: 0, items_shown: 0, items_total: 0, truncated: false },
  };
  if (await isLearningDisabled(config, root)) {
    return { ...empty, reason: "disabled" };
  }

  const windows = options.windows ?? (await readLearningTuning(root)).evaluator;
  const readOptions: JournalReadOptions = {
    limit: options.limit ?? 2_000,
    maxPartitions: options.maxPartitions ?? 2,
  };
  if (options.since !== undefined) {
    readOptions.since = options.since;
  }
  const journal = await readJournal(config, root, readOptions);
  const decisions = journal.entries.filter(isDecision);

  const input: EvaluationInput = {
    now,
    decisions,
    sessions: options.sessions ?? [],
    windows,
  };
  if (options.population !== undefined) {
    input.population = options.population;
  }
  const verdicts = evaluate(input);

  const known = await existingDigests(config, root);
  const fresh = verdicts.filter((verdict) => !known.has(verdictDigest(verdict)));
  const written = await appendVerdicts(config, root, fresh);

  const byOutcome: Record<VerdictOutcome, number> = { good: 0, bad: 0, undetermined: 0 };
  for (const verdict of verdicts) {
    byOutcome[verdict.verdict] += 1;
  }
  const text = fresh.map((verdict) => JSON.stringify(verdict)).join("\n");
  return {
    ran: true,
    computed: verdicts.length,
    written,
    unchanged: verdicts.length - fresh.length,
    decisions: decisions.length,
    by_outcome: byOutcome,
    budget: {
      chars: text.length,
      token_estimate: estimateTokens(text),
      items_shown: fresh.length,
      items_total: verdicts.length,
      truncated: journal.budget.truncated,
    },
  };
}

function isDecision(entry: JournalEntry): entry is DecisionEntry {
  return entry.type !== "consolidated";
}
