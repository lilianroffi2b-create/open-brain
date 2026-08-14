import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { requireCapability } from "../core/capabilities.js";
import { ExpectedError } from "../core/errors.js";
import { atomicWriteJson } from "../core/fs-atomic.js";
import { lockPathFor, withLock } from "../core/lock.js";
import { sha256 } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import {
  CONFIDENCE_CEILING,
  CONFIDENCE_FLOOR,
  DEFAULT_HISTORY_POLICY,
  HISTORY_POLICY_MIN_ENTRIES,
  HISTORY_SUMMARY_CAUSE,
  LEARNING_SCHEMA_VERSION,
  SchemaError,
  TRACING_CAUSES,
  TS_STEP_MS,
  formatTs,
  nowTs,
  parseTs,
  rankForConfidence,
  validateBeliefDocument,
  type ApplicationCause,
  type Belief,
  type BeliefDocument,
  type BeliefHistoryEntry,
  type HistoryPolicy,
  type OperationRecord,
} from "./types.js";

/**
 * Durable storage of the belief population. It records and it marks; it never
 * decides what a confidence should be. The number comes from the caller, the
 * fact and its idempotency mark come from here.
 *
 * Corruption policy is strict: any anomaly raises and nothing is written. A
 * snapshot that cannot be read is not a snapshot that can be safely rewritten.
 */

export const LEARNING_DIRECTORY_NAME = "learning";
export const LEARNING_LOCK_NAME = "learning";
export const BELIEFS_FILENAME = "beliefs.json";

/** Bound of the store idempotency registry, oldest records fall off the end. */
export const OPERATIONS_MEMORY = 64;

export class CorruptStoreError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "CorruptStoreError";
  }
}

export class IdempotencyConflictError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class UnknownBeliefError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "UnknownBeliefError";
  }
}

export function learningDirectory(config: VaultConfig, root: string): string {
  return join(root, config.paths.memory, LEARNING_DIRECTORY_NAME);
}

export function beliefsPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), BELIEFS_FILENAME);
}

export function emptyBeliefDocument(now: string = nowTs()): BeliefDocument {
  return {
    schema_version: LEARNING_SCHEMA_VERSION,
    updated_at: now,
    beliefs: [],
    operations: [],
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

function sortBeliefs(beliefs: Belief[]): Belief[] {
  return [...beliefs].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function beliefsDigest(beliefs: Belief[]): string {
  return sha256(JSON.stringify(sortBeliefs(beliefs)));
}

async function readDocumentUnlocked(path: string): Promise<BeliefDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return emptyBeliefDocument();
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CorruptStoreError(
      `The belief store at ${path} is not valid JSON. Nothing was written. Fix or remove the file, then run the command again.`,
    );
  }
  try {
    return validateBeliefDocument(parsed);
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new CorruptStoreError(
        `The belief store at ${path} does not satisfy its contract: ${error.message} Nothing was written.`,
      );
    }
    throw error;
  }
}

/**
 * Reads the belief population. A missing file is a legitimate empty store, an
 * unreadable one is not: it raises rather than silently start from scratch.
 */
export async function readBeliefDocument(
  config: VaultConfig,
  root: string,
): Promise<BeliefDocument> {
  requireCapability(config, "learning");
  return readDocumentUnlocked(beliefsPath(config, root));
}

export function historyWatermark(belief: Belief): string | undefined {
  const first = belief.history[0];
  return first?.cause === HISTORY_SUMMARY_CAUSE ? first.folded?.last_ts : undefined;
}

/**
 * True when this belief already carries the mark of that decision under that
 * cause. The history entry IS the mark: an application that changed no
 * confidence still leaves one, which is what stops a verdict from replaying on
 * every pass.
 */
export function alreadyConsumed(belief: Belief, ref: string, cause: ApplicationCause): boolean {
  return belief.history.some((entry) => entry.ref === ref && entry.cause === cause);
}

function checkedPolicy(policy: HistoryPolicy | undefined): HistoryPolicy {
  const resolved = policy ?? DEFAULT_HISTORY_POLICY;
  if (
    !Number.isInteger(resolved.max_entries)
    || resolved.max_entries < HISTORY_POLICY_MIN_ENTRIES
  ) {
    throw new ExpectedError(
      `The belief history policy needs max_entries to be an integer of at least ${String(HISTORY_POLICY_MIN_ENTRIES)}: one summary entry plus one detailed entry.`,
    );
  }
  return resolved;
}

/**
 * Caps the history and folds the overflow into a single summary entry rather
 * than dropping it. The summary keeps the count, the window, and the tally by
 * cause, so nothing disappears in silence, and its last_ts becomes a watermark:
 * any guarded application whose instant falls at or before it is refused as
 * already settled. That is what keeps the cap from reopening the replay bug
 * that the individual marks were closing.
 */
export function foldHistory(
  history: BeliefHistoryEntry[],
  policy: HistoryPolicy,
): BeliefHistoryEntry[] {
  if (history.length <= policy.max_entries) {
    return history;
  }
  const foldCount = history.length - policy.max_entries + 1;
  const folded = history.slice(0, foldCount);
  const rest = history.slice(foldCount);
  const head = folded[0];
  const tail = folded[folded.length - 1];
  if (!head || !tail) {
    return history;
  }

  const causes: Record<string, number> = {};
  let entries = 0;
  let firstTs = head.cause === HISTORY_SUMMARY_CAUSE && head.folded ? head.folded.first_ts : head.ts;
  for (const entry of folded) {
    if (entry.cause === HISTORY_SUMMARY_CAUSE && entry.folded) {
      entries += entry.folded.entries;
      for (const [cause, count] of Object.entries(entry.folded.causes)) {
        causes[cause] = (causes[cause] ?? 0) + count;
      }
      continue;
    }
    entries += 1;
    causes[entry.cause] = (causes[entry.cause] ?? 0) + 1;
  }
  if (parseTs(firstTs).getTime() > parseTs(tail.ts).getTime()) {
    firstTs = tail.ts;
  }

  // A null `from` belongs to the creation entry alone, so a summary that
  // swallowed the creation starts from the confidence that creation set.
  const from = head.from === null ? head.to : head.from;
  const summary: BeliefHistoryEntry = {
    ts: tail.ts,
    from,
    to: tail.to,
    cause: HISTORY_SUMMARY_CAUSE,
    ref: `summary:${String(entries)}`,
    folded: { entries, first_ts: firstTs, last_ts: tail.ts, causes },
  };
  return [summary, ...rest];
}

export interface BeliefApplication {
  belief_id: string;
  cause: ApplicationCause;
  /** The decision id. This is the idempotency key. */
  ref: string;
  /** The arrival confidence, computed by the caller. */
  confidence: number;
  /** When the move happened. Defaults to now. */
  at?: string;
}

export type ApplicationSkipReason =
  | "unknown_belief"
  | "already_consumed"
  | "already_settled"
  | "no_effect";

export interface AppliedApplication {
  belief_id: string;
  cause: ApplicationCause;
  ref: string;
  from: number;
  to: number;
  ts: string;
  /** State of the lock after this application, so a caller can report it. */
  locked: boolean;
}

export interface SkippedApplication {
  belief_id: string;
  cause: ApplicationCause;
  ref: string;
  reason: ApplicationSkipReason;
}

export interface ApplyOptions {
  historyPolicy?: HistoryPolicy;
  operationId?: string;
  now?: string;
}

export interface ApplyResult {
  document: BeliefDocument;
  applied: AppliedApplication[];
  skipped: SkippedApplication[];
  written: boolean;
}

interface CounterEffect {
  opportunities: number;
  applications: number;
  corrections: number;
  refreshesSeenAt: boolean;
  /**
   * True for the two causes that are a human hand. They set the lock, and
   * nothing in this layer ever sets it back to false.
   */
  locks: boolean;
}

const COUNTER_EFFECTS: Record<ApplicationCause, CounterEffect> = {
  application_confirmed: {
    opportunities: 1,
    applications: 1,
    corrections: 0,
    refreshesSeenAt: true,
    locks: false,
  },
  application_corrected: {
    opportunities: 1,
    applications: 1,
    corrections: 1,
    refreshesSeenAt: true,
    locks: false,
  },
  dormancy: {
    opportunities: 0,
    applications: 0,
    corrections: 0,
    refreshesSeenAt: false,
    locks: false,
  },
  human_engrave: {
    opportunities: 0,
    applications: 0,
    corrections: 0,
    refreshesSeenAt: true,
    locks: true,
  },
  human_retract: {
    opportunities: 0,
    applications: 0,
    corrections: 0,
    refreshesSeenAt: true,
    locks: true,
  },
};

export type BeliefApplicationOutcome =
  | { applied: true; belief: Belief; entry: AppliedApplication }
  | { applied: false; reason: ApplicationSkipReason };

/**
 * Records one application on one belief, pure. The guard is checked before any
 * default and before any derived value, so a replay can never slip through a
 * normalization step.
 */
export function applyToBelief(
  belief: Belief,
  application: BeliefApplication,
  policy: HistoryPolicy = DEFAULT_HISTORY_POLICY,
  now: string = nowTs(),
): BeliefApplicationOutcome {
  const guarded = TRACING_CAUSES.includes(application.cause);
  const requestedAt = application.at ?? now;

  if (guarded && alreadyConsumed(belief, application.ref, application.cause)) {
    return { applied: false, reason: "already_consumed" };
  }
  const watermark = historyWatermark(belief);
  if (
    guarded
    && watermark !== undefined
    && parseTs(requestedAt).getTime() <= parseTs(watermark).getTime()
  ) {
    return { applied: false, reason: "already_settled" };
  }

  if (!Number.isFinite(application.confidence)) {
    throw new ExpectedError("An application must carry a finite arrival confidence.");
  }
  if (
    application.confidence < CONFIDENCE_FLOOR
    || application.confidence > CONFIDENCE_CEILING
  ) {
    throw new ExpectedError(
      `An arrival confidence of ${String(application.confidence)} sits outside [${String(CONFIDENCE_FLOOR)}, ${String(CONFIDENCE_CEILING)}].`,
    );
  }

  const effect = COUNTER_EFFECTS[application.cause];
  const from = belief.confidence;
  // A lock set by a human hand resists automatic decay and automatic growth
  // alike, so an ordinary cause moves no confidence on a locked belief whatever
  // arrival the caller computed. The rule is enforced here as well as in the
  // organ that computes the number, because a rule that only the caller applies
  // is a rule a direct call to the store can walk around.
  const to = belief.locked && !effect.locks ? from : application.confidence;
  const locked = belief.locked || effect.locks;
  const traced = to !== from || guarded;
  // The counters keep moving under a lock because they are facts, and a guarded
  // cause still writes its mark, which is what keeps the verdict from replaying.
  if (
    !traced
    && locked === belief.locked
    && effect.opportunities === 0
    && !effect.refreshesSeenAt
  ) {
    return { applied: false, reason: "no_effect" };
  }

  const last = belief.history[belief.history.length - 1];
  const lastMs = last ? parseTs(last.ts).getTime() : Number.NEGATIVE_INFINITY;
  const requestedMs = parseTs(requestedAt).getTime();
  // History is strictly increasing at second precision, so two moves can never
  // share a second: a move that lands on or before the last one is pushed one
  // second past it.
  const instant = requestedMs > lastMs ? requestedAt : formatTs(new Date(lastMs + TS_STEP_MS));

  const history = traced
    ? [
      ...belief.history,
      { ts: instant, from, to, cause: application.cause, ref: application.ref },
    ]
    : belief.history;

  const next: Belief = {
    ...belief,
    confidence: to,
    rank: rankForConfidence(to),
    locked,
    opportunities: belief.opportunities + effect.opportunities,
    applications: belief.applications + effect.applications,
    corrections: belief.corrections + effect.corrections,
    seen_at: effect.refreshesSeenAt ? instant : belief.seen_at,
    moved_at: traced ? instant : belief.moved_at,
    history: foldHistory(history, policy),
  };

  return {
    applied: true,
    belief: next,
    entry: {
      belief_id: belief.id,
      cause: application.cause,
      ref: application.ref,
      from,
      to,
      ts: instant,
      locked,
    },
  };
}

function nextOperations(
  operations: OperationRecord[],
  operationId: string | undefined,
  digest: string,
  now: string,
): OperationRecord[] {
  if (operationId === undefined) {
    return operations;
  }
  return [...operations, { operation_id: operationId, digest, ts: now }].slice(-OPERATIONS_MEMORY);
}

/**
 * Checks the idempotency registry before anything else, as the very first
 * instruction of a mutation. A known operation id with the same result is a
 * non-event; the same id with a different result is a conflict, never a silent
 * overwrite.
 */
function checkOperation(
  document: BeliefDocument,
  operationId: string | undefined,
  digest: string,
): "new" | "replay" {
  if (operationId === undefined) {
    return "new";
  }
  const known = document.operations.find((record) => record.operation_id === operationId);
  if (!known) {
    return "new";
  }
  if (known.digest !== digest) {
    throw new IdempotencyConflictError(
      `The operation ${operationId} was already applied to the belief store with a different result. Refusing to apply it a second time under the same id.`,
    );
  }
  return "replay";
}

interface CommitResult {
  document: BeliefDocument;
  written: boolean;
}

async function commit(
  path: string,
  current: BeliefDocument,
  beliefs: Belief[],
  operationId: string | undefined,
  now: string,
): Promise<CommitResult> {
  const sorted = sortBeliefs(beliefs);
  const digest = beliefsDigest(sorted);
  if (checkOperation(current, operationId, digest) === "replay") {
    return { document: current, written: false };
  }
  const unchanged = beliefsDigest(current.beliefs) === digest;
  if (unchanged && operationId === undefined) {
    // An identical rewrite is a non-event: the file is left exactly as it is,
    // mtime included.
    return { document: current, written: false };
  }
  const document: BeliefDocument = {
    schema_version: LEARNING_SCHEMA_VERSION,
    updated_at: now,
    beliefs: sorted,
    operations: nextOperations(current.operations, operationId, digest, now),
  };
  validateBeliefDocument(document, { now });
  await atomicWriteJson(path, document);
  return { document, written: true };
}

export interface WriteOptions {
  operationId?: string;
  now?: string;
}

export interface WriteResult {
  document: BeliefDocument;
  written: boolean;
}

/** Replaces the belief population wholesale, under the layer lock. */
export async function writeBeliefs(
  config: VaultConfig,
  root: string,
  beliefs: Belief[],
  options: WriteOptions = {},
): Promise<WriteResult> {
  requireCapability(config, "learning");
  const path = beliefsPath(config, root);
  const now = options.now ?? nowTs();
  return withLock(lockPathFor(root, LEARNING_LOCK_NAME), async () => {
    const current = await readDocumentUnlocked(path);
    return commit(path, current, beliefs, options.operationId, now);
  });
}

/** Adds a belief to the population. A duplicate id is refused, never merged. */
export async function addBelief(
  config: VaultConfig,
  root: string,
  belief: Belief,
  options: WriteOptions = {},
): Promise<WriteResult> {
  requireCapability(config, "learning");
  const path = beliefsPath(config, root);
  const now = options.now ?? nowTs();
  return withLock(lockPathFor(root, LEARNING_LOCK_NAME), async () => {
    const current = await readDocumentUnlocked(path);
    if (current.beliefs.some((existing) => existing.id === belief.id)) {
      throw new ExpectedError(
        `The belief ${belief.id} already exists in this vault. Refusing to overwrite it.`,
      );
    }
    return commit(path, current, [...current.beliefs, belief], options.operationId, now);
  });
}

/**
 * Applies a batch of recorded applications in one lock, one read, one write.
 * Every application that is not skipped leaves a history entry, including when
 * the confidence does not move: the entry is the proof that this decision was
 * consumed, so the same verdict can never move the belief a second time.
 */
export async function applyBeliefApplications(
  config: VaultConfig,
  root: string,
  applications: BeliefApplication[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  requireCapability(config, "learning");
  const policy = checkedPolicy(options.historyPolicy);
  const path = beliefsPath(config, root);
  const now = options.now ?? nowTs();

  return withLock(lockPathFor(root, LEARNING_LOCK_NAME), async () => {
    const current = await readDocumentUnlocked(path);
    const beliefs = new Map(current.beliefs.map((belief) => [belief.id, belief]));
    const applied: AppliedApplication[] = [];
    const skipped: SkippedApplication[] = [];

    for (const application of applications) {
      const belief = beliefs.get(application.belief_id);
      if (!belief) {
        skipped.push({
          belief_id: application.belief_id,
          cause: application.cause,
          ref: application.ref,
          reason: "unknown_belief",
        });
        continue;
      }
      const outcome = applyToBelief(belief, application, policy, now);
      if (!outcome.applied) {
        skipped.push({
          belief_id: application.belief_id,
          cause: application.cause,
          ref: application.ref,
          reason: outcome.reason,
        });
        continue;
      }
      beliefs.set(outcome.belief.id, outcome.belief);
      applied.push(outcome.entry);
    }

    const result = await commit(path, current, [...beliefs.values()], options.operationId, now);
    return { document: result.document, applied, skipped, written: result.written };
  });
}

/** Reads one belief, or raises with a message that names the id. */
export async function readBelief(
  config: VaultConfig,
  root: string,
  id: string,
): Promise<Belief> {
  const document = await readBeliefDocument(config, root);
  const belief = document.beliefs.find((candidate) => candidate.id === id);
  if (!belief) {
    throw new UnknownBeliefError(`No belief named ${id} in this vault.`);
  }
  return belief;
}

export async function beliefStoreExists(config: VaultConfig, root: string): Promise<boolean> {
  try {
    await stat(beliefsPath(config, root));
    return true;
  } catch {
    return false;
  }
}
