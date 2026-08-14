import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { estimateTokens, type ContextBudget } from "../core/budget.js";
import { requireCapability } from "../core/capabilities.js";
import { fsyncDirectory } from "../core/fs-atomic.js";
import type { VaultConfig } from "../core/types.js";
import { learningDirectory } from "./store.js";
import {
  INPUT_SUMMARY_CAP,
  LEARNING_SCHEMA_VERSION,
  LINE_MAX_BYTES,
  SchemaError,
  encodeLine,
  fitLine,
  nowTs,
  validateJournalEntry,
  type DecisionEntry,
  type DecisionType,
  type JournalEntry,
  type VerdictOutcome,
} from "./types.js";

/**
 * The decision journal: what Open Brain chose, not only what it produced.
 *
 * The safest organ of the layer. It records and judges nothing, changes no
 * behavior, and costs no token: the hot path is a random id, a hash, and one
 * append. Entries are append-only and partitioned by month, so no rotation ever
 * has to move a line that another process may be writing.
 *
 * Concurrency rests on two properties together, not on a lock: a descriptor
 * opened in append mode places every write at the current end of file, and a
 * line always fits in a single write because it is capped at LINE_MAX_BYTES.
 * Two processes journaling at the same time therefore never lose an entry and
 * never interleave one.
 *
 * Reading is always bounded, invariant I11: every read takes a cap and returns
 * what it cost. You query this journal, you never dump it.
 */

export const JOURNAL_DIRECTORY_NAME = "journal";
export const JOURNAL_PARTITION_PREFIX = "journal-";
export const JOURNAL_PARTITION_SUFFIX = ".jsonl";
export const JOURNAL_ERRORS_FILENAME = "journal-errors.jsonl";

/** Bounds of the error trace, which deliberately has no contract of its own. */
export const ERROR_MESSAGE_CAP = 400;
export const ERROR_CONTEXT_CAP = 600;

/** Default number of monthly partitions a single read is allowed to open. */
export const DEFAULT_MAX_PARTITIONS = 2;

const PARTITION_PATTERN = /^journal-(\d{4})-(\d{2})\.jsonl$/u;

export function journalDirectory(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), JOURNAL_DIRECTORY_NAME);
}

export function journalPartitionName(ts: string): string {
  return `${JOURNAL_PARTITION_PREFIX}${ts.slice(0, 7)}${JOURNAL_PARTITION_SUFFIX}`;
}

export function journalPartitionPath(config: VaultConfig, root: string, ts: string): string {
  return join(journalDirectory(config, root), journalPartitionName(ts));
}

export function journalErrorsPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), JOURNAL_ERRORS_FILENAME);
}

/** Newest partition first. Names sort chronologically, so a plain sort is enough. */
export async function listJournalPartitions(
  config: VaultConfig,
  root: string,
): Promise<string[]> {
  try {
    const entries = await readdir(journalDirectory(config, root));
    return entries.filter((name) => PARTITION_PATTERN.test(name)).sort().reverse();
  } catch {
    return [];
  }
}

export function newDecisionId(ts: string): string {
  const compact = ts.replace(/[-:]/gu, "").slice(0, 13);
  return `dec_${compact}_${randomBytes(4).toString("hex")}`;
}

function sha1(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

function clip(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : characters.slice(0, max).join("");
}

export interface DecisionInput {
  session: string;
  type: DecisionType;
  /**
   * The full text is hashed and summarized, never copied. The prompt itself
   * already lives in the session transcript; duplicating it here would put a
   * second copy of everything the user typed inside the vault.
   */
  input: { text?: string; hash?: string; summary: string };
  options?: string[];
  choice?: string | null;
  score?: number | null;
  beliefs_applied?: string[];
  beliefs_evicted?: string[];
  documents?: string[];
  cost?: { tokens_estimated?: number; ms?: number };
  verdict?: VerdictOutcome | null;
  ts?: string;
  id?: string;
}

/** Builds a valid decision entry, or raises with the invariant that refused it. */
export function buildDecision(input: DecisionInput): DecisionEntry {
  const ts = input.ts ?? nowTs();
  const hash = input.input.hash
    ?? `sha1:${sha1(input.input.text ?? input.input.summary)}`;
  const entry: DecisionEntry = {
    schema_version: LEARNING_SCHEMA_VERSION,
    id: input.id ?? newDecisionId(ts),
    ts,
    session: input.session,
    type: input.type,
    input: { hash, summary: clip(input.input.summary, INPUT_SUMMARY_CAP) },
    options: input.options ?? [],
    choice: input.choice ?? null,
    score: input.score ?? null,
    beliefs_applied: input.beliefs_applied ?? [],
    beliefs_evicted: input.beliefs_evicted ?? [],
    documents: input.documents ?? [],
    cost: {
      tokens_estimated: input.cost?.tokens_estimated ?? 0,
      ms: input.cost?.ms ?? 0,
    },
    verdict: input.verdict ?? null,
  };
  return validateJournalEntry(entry) as DecisionEntry;
}

async function appendLine(path: string, line: string): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true });
  const existed = await stat(path).then(() => true).catch(() => false);
  const handle = await open(path, "a");
  try {
    // One write, one line, under the byte cap: that is what makes concurrent
    // appends atomic without a lock.
    await handle.write(Buffer.from(line, "utf8"));
    await handle.datasync();
  } finally {
    await handle.close();
  }
  if (!existed) {
    await fsyncDirectory(directory);
  }
}

export interface WrittenEntry {
  entry: JournalEntry;
  path: string;
  truncated: boolean;
  bytes: number;
}

/**
 * Writes one entry, strictly. The entry is validated, then shrunk to fit the
 * line cap if needed, then validated again: a line that had to be truncated is
 * still a line that satisfies its own contract.
 */
export async function writeEntry(
  config: VaultConfig,
  root: string,
  entry: JournalEntry,
): Promise<WrittenEntry> {
  requireCapability(config, "learning");
  const validated = validateJournalEntry(entry);
  const fitted = fitLine(validated, LINE_MAX_BYTES);
  const final = validateJournalEntry(fitted.record);
  const line = encodeLine(final);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > LINE_MAX_BYTES) {
    throw new SchemaError(
      `A journal line of ${String(bytes)} bytes exceeds the ${String(LINE_MAX_BYTES)} byte cap after fitting.`,
    );
  }
  const path = journalPartitionPath(config, root, final.ts);
  await appendLine(path, line);
  return { entry: final, path, truncated: fitted.truncated, bytes };
}

/**
 * Writes one entry and never raises. This is the API a hook point uses: a
 * failure of the learning layer must never break a session, change an exit
 * code, or alter what a hook prints. The failure lands in the error trace
 * instead, and the caller gets undefined.
 */
export async function writeEntryTolerant(
  config: VaultConfig,
  root: string,
  entry: JournalEntry,
  origin: string,
): Promise<WrittenEntry | undefined> {
  try {
    return await writeEntry(config, root, entry);
  } catch (error) {
    await noteError(config, root, origin, error, entry);
    return undefined;
  }
}

/**
 * Appends to the error trace, which is deliberately outside every contract of
 * this layer: a trace of a failure must not depend on a contract that could be
 * the cause of the failure. Never raises, for the same reason.
 */
export async function noteError(
  config: VaultConfig,
  root: string,
  origin: string,
  error: unknown,
  context?: unknown,
): Promise<void> {
  try {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    const record = {
      ts: nowTs(),
      origin,
      error: clip(message, ERROR_MESSAGE_CAP),
      context: clip(
        context === undefined ? "" : JSON.stringify(context) ?? String(context),
        ERROR_CONTEXT_CAP,
      ),
    };
    await appendLine(journalErrorsPath(config, root), `${JSON.stringify(record)}\n`);
  } catch {
    // A trace that fails to be written must not become a second failure.
  }
}

export interface JournalReadOptions {
  /** Hard cap on the number of entries returned. Required: reads are never unbounded. */
  limit: number;
  /** Optional cap on the characters the returned entries are worth. */
  maxChars?: number;
  /** Number of monthly partitions this read may open, newest first. */
  maxPartitions?: number;
  types?: readonly string[];
  session?: string;
  /** Inclusive lower bound on the entry timestamp. */
  since?: string;
  /** Inclusive upper bound on the entry timestamp. */
  until?: string;
}

export interface JournalRead {
  entries: JournalEntry[];
  budget: ContextBudget;
  /** Lines that did not satisfy the contract, counted and skipped, never guessed. */
  invalid: number;
  /** Partitions this read actually opened, newest first. */
  partitions: string[];
  /** Partitions left unopened by the partition cap. */
  partitions_skipped: number;
}

function matches(entry: JournalEntry, options: JournalReadOptions): boolean {
  if (options.types !== undefined && !options.types.includes(entry.type)) {
    return false;
  }
  if (options.session !== undefined) {
    const session = "session" in entry ? entry.session : undefined;
    if (session !== options.session) {
      return false;
    }
  }
  if (options.since !== undefined && entry.ts < options.since) {
    return false;
  }
  if (options.until !== undefined && entry.ts > options.until) {
    return false;
  }
  return true;
}

/**
 * The budget of a read, in the shared vocabulary of invariant I11 and with the
 * shared estimator: two organs must never disagree about what a block of text
 * costs, so the number comes from core/budget rather than from a local formula.
 */
function budgetOf(entries: JournalEntry[], total: number, truncated: boolean): ContextBudget {
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return {
    chars: text.length,
    token_estimate: estimateTokens(text),
    items_shown: entries.length,
    items_total: total,
    truncated,
  };
}

/**
 * Reads the newest matching entries, bounded by construction. It opens at most
 * maxPartitions monthly partitions, keeps at most limit entries in memory, and
 * reports what it left out instead of hiding it: a caller who cannot see that
 * something was cut cannot correct it.
 */
export async function readJournal(
  config: VaultConfig,
  root: string,
  options: JournalReadOptions,
): Promise<JournalRead> {
  requireCapability(config, "learning");
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new SchemaError("A journal read needs a limit of at least one entry.");
  }
  const maxPartitions = options.maxPartitions ?? DEFAULT_MAX_PARTITIONS;
  const available = await listJournalPartitions(config, root);
  const opened = available.slice(0, Math.max(0, maxPartitions));

  const kept: JournalEntry[] = [];
  let total = 0;
  let invalid = 0;

  for (const partition of opened) {
    let raw: string;
    try {
      raw = await readFile(join(journalDirectory(config, root), partition), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let entry: JournalEntry;
      try {
        entry = validateJournalEntry(JSON.parse(line) as unknown);
      } catch {
        // Tolerant on read only: a bad line is counted and skipped, never fixed.
        invalid += 1;
        continue;
      }
      if (!matches(entry, options)) {
        continue;
      }
      total += 1;
      kept.push(entry);
      if (kept.length > options.limit) {
        kept.shift();
      }
    }
  }

  kept.sort((left, right) => (left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0));
  if (options.maxChars !== undefined) {
    while (
      kept.length > 0
      && kept.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0) > options.maxChars
    ) {
      kept.shift();
    }
  }

  const skipped = available.length - opened.length;
  const truncated = total > kept.length || skipped > 0;
  return {
    entries: kept,
    budget: budgetOf(kept, total, truncated),
    invalid,
    partitions: opened,
    partitions_skipped: skipped,
  };
}
