import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteJson, atomicWriteText, fsyncDirectory } from "../core/fs-atomic.js";
import { sha256, toPosixPath } from "../core/text.js";

/**
 * Tamper evidence for the preference kernel.
 *
 * The N1 guard that refuses a write before it happens lives in a PreToolUse
 * hook, so it only exists under a host CLI that has hooks. Under any other CLI
 * the kernel would be unprotected, and claiming otherwise would be a false
 * promise. This module therefore doubles the protection after the fact, and it
 * is deliberately named for what it is: every legitimate write is recorded with
 * its provenance, and any content that does not match the last recorded write
 * is DETECTED. It is not prevented. Nothing here makes a file impossible to
 * modify; it makes a modification impossible to hide.
 *
 * The record lives under .open-brain/local/, outside the indexed vault: it is
 * excluded from the scan and gitignored, so it never becomes source material
 * and never travels with the vault.
 */

export const REDLINE_SCHEMA_VERSION = 1;

export const REDLINE_STATE_RELATIVE_PATH = join(
  ".open-brain",
  "local",
  "prefs-redline.json",
);

export const REDLINE_JOURNAL_RELATIVE_PATH = join(
  ".open-brain",
  "local",
  "prefs-redline.jsonl",
);

/** Most recent journal entries returned by default, newest last. */
export const REDLINE_JOURNAL_READ_LIMIT = 200;

export const REDLINE_TARGETS = ["ledger", "core"] as const;
export type RedlineTarget = (typeof REDLINE_TARGETS)[number];

/** Where a write came from. Recorded verbatim so a reader can retrace it. */
export interface RedlineProvenance {
  /** The command that performed the write, for example "prefs log". */
  command: string;
  /** The validation path the content went through before it was written. */
  validation: string;
  /** The idempotency key of the operation, when the caller supplied one. */
  operationId?: string;
}

export interface RedlineWrite extends RedlineProvenance {
  target: RedlineTarget;
  /** Vault-relative path of the file being published. */
  relativePath: string;
  content: string;
}

export interface RedlineEntry {
  schema_version: number;
  recorded_at: string;
  target: RedlineTarget;
  path: string;
  sha256: string;
  bytes: number;
  command: string;
  validation: string;
  operation_id?: string;
}

export interface RedlineState {
  schema_version: number;
  updated_at: string;
  targets: Partial<Record<RedlineTarget, RedlineEntry>>;
}

export type RedlineVerdict = "match" | "modified" | "missing" | "unrecorded";

export interface RedlineCheck {
  target: RedlineTarget;
  path: string;
  verdict: RedlineVerdict;
  detail: string;
  expected_sha256?: string;
  actual_sha256?: string;
  recorded_at?: string;
  command?: string;
}

export interface RedlineReport {
  checked_at: string;
  /** True when at least one recorded target no longer matches its record. */
  tampered: boolean;
  checks: RedlineCheck[];
}

export interface RedlineJournalOptions {
  limit?: number;
}

export interface RedlineJournal {
  entries: RedlineEntry[];
  /** Total readable entries in the journal, before the limit was applied. */
  total: number;
  truncated: boolean;
  /** Entries the journal holds that could not be parsed, never silently dropped. */
  unreadable: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRedlineTarget(value: unknown): value is RedlineTarget {
  return typeof value === "string"
    && REDLINE_TARGETS.includes(value as RedlineTarget);
}

function isRedlineEntry(value: unknown): value is RedlineEntry {
  return isRecord(value)
    && typeof value.schema_version === "number"
    && typeof value.recorded_at === "string"
    && isRedlineTarget(value.target)
    && typeof value.path === "string"
    && typeof value.sha256 === "string"
    && typeof value.bytes === "number"
    && typeof value.command === "string"
    && typeof value.validation === "string"
    && (value.operation_id === undefined || typeof value.operation_id === "string");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function stateEntries(value: unknown): Partial<Record<RedlineTarget, RedlineEntry>> {
  if (!isRecord(value) || !isRecord(value.targets)) {
    return {};
  }
  const targets: Partial<Record<RedlineTarget, RedlineEntry>> = {};
  for (const [key, entry] of Object.entries(value.targets)) {
    if (isRedlineTarget(key) && isRedlineEntry(entry)) {
      targets[key] = entry;
    }
  }
  return targets;
}

export async function readRedlineState(vaultRoot: string): Promise<RedlineState> {
  let raw: string;
  try {
    raw = await readFile(join(vaultRoot, REDLINE_STATE_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { schema_version: REDLINE_SCHEMA_VERSION, updated_at: "", targets: {} };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // An unreadable record is itself a signal, but it must never break a write.
    // Every target it covered simply becomes unrecorded again.
    return { schema_version: REDLINE_SCHEMA_VERSION, updated_at: "", targets: {} };
  }

  return {
    schema_version: isRecord(parsed) && typeof parsed.schema_version === "number"
      ? parsed.schema_version
      : REDLINE_SCHEMA_VERSION,
    updated_at: isRecord(parsed) && typeof parsed.updated_at === "string"
      ? parsed.updated_at
      : "",
    targets: stateEntries(parsed),
  };
}

/**
 * Appends one line to the provenance journal and flushes it. Append mode plus a
 * single write keeps concurrent writers from interleaving, and the flush is what
 * makes the entry survive a crash: an entry that is lost proves nothing.
 */
async function appendJournalEntry(vaultRoot: string, entry: RedlineEntry): Promise<void> {
  const path = join(vaultRoot, REDLINE_JOURNAL_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(JSON.stringify(entry) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publishes one preference kernel file and records what was written, by whom,
 * through which validation path, and under which operation id. The content is
 * written first: a record that describes a write that never landed would be
 * worse than no record at all.
 */
export async function writeThroughRedline(
  vaultRoot: string,
  write: RedlineWrite,
): Promise<RedlineEntry> {
  const relativePath = toPosixPath(write.relativePath);
  await atomicWriteText(join(vaultRoot, write.relativePath), write.content);

  const entry: RedlineEntry = {
    schema_version: REDLINE_SCHEMA_VERSION,
    recorded_at: new Date().toISOString(),
    target: write.target,
    path: relativePath,
    sha256: sha256(write.content),
    bytes: Buffer.byteLength(write.content, "utf8"),
    command: write.command,
    validation: write.validation,
    ...(write.operationId === undefined ? {} : { operation_id: write.operationId }),
  };

  // The journal is appended before the state is replaced. The journal is the
  // evidence; the state file is only the fast comparison point and can always be
  // rebuilt from the journal, so a crash between the two loses nothing.
  await appendJournalEntry(vaultRoot, entry);

  const state = await readRedlineState(vaultRoot);
  const next: RedlineState = {
    schema_version: REDLINE_SCHEMA_VERSION,
    updated_at: entry.recorded_at,
    targets: { ...state.targets, [entry.target]: entry },
  };
  const statePath = join(vaultRoot, REDLINE_STATE_RELATIVE_PATH);
  await atomicWriteJson(statePath, next);
  await fsyncDirectory(dirname(statePath));
  return entry;
}

/**
 * Compares every recorded target with the file on disk. A target that was never
 * written through this module is reported as unrecorded rather than as a
 * problem: absence of a record is not evidence of tampering.
 */
export async function verifyRedline(vaultRoot: string): Promise<RedlineReport> {
  const state = await readRedlineState(vaultRoot);
  const checks: RedlineCheck[] = [];

  for (const target of REDLINE_TARGETS) {
    const entry = state.targets[target];
    if (!entry) {
      checks.push({
        target,
        path: "",
        verdict: "unrecorded",
        detail: `No write to the ${target} has been recorded yet, so there is nothing to compare.`,
      });
      continue;
    }

    let content: string;
    try {
      content = await readFile(join(vaultRoot, entry.path), "utf8");
    } catch {
      checks.push({
        target,
        path: entry.path,
        verdict: "missing",
        detail: `${entry.path} was recorded on ${entry.recorded_at} by ${entry.command} but cannot be read now. Its removal is detected, not prevented.`,
        expected_sha256: entry.sha256,
        recorded_at: entry.recorded_at,
        command: entry.command,
      });
      continue;
    }

    const actual = sha256(content);
    if (actual === entry.sha256) {
      checks.push({
        target,
        path: entry.path,
        verdict: "match",
        detail: `${entry.path} matches the write recorded on ${entry.recorded_at} by ${entry.command}.`,
        expected_sha256: entry.sha256,
        actual_sha256: actual,
        recorded_at: entry.recorded_at,
        command: entry.command,
      });
      continue;
    }

    checks.push({
      target,
      path: entry.path,
      verdict: "modified",
      detail: `${entry.path} changed outside the recorded write paths. Last recorded write: ${entry.command} on ${entry.recorded_at}. The change is detected, not prevented; review it, then re-run the command that owns this file.`,
      expected_sha256: entry.sha256,
      actual_sha256: actual,
      recorded_at: entry.recorded_at,
      command: entry.command,
    });
  }

  return {
    checked_at: new Date().toISOString(),
    tampered: checks.some((check) => check.verdict === "modified" || check.verdict === "missing"),
    checks,
  };
}

/**
 * Reads the provenance journal, newest last. The limit bounds what a caller
 * receives; the count of readable and unreadable lines is always exact, so a
 * truncated read never hides how much it left out.
 */
export async function readRedlineJournal(
  vaultRoot: string,
  options: RedlineJournalOptions = {},
): Promise<RedlineJournal> {
  const limit = options.limit ?? REDLINE_JOURNAL_READ_LIMIT;
  let raw: string;
  try {
    raw = await readFile(join(vaultRoot, REDLINE_JOURNAL_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { entries: [], total: 0, truncated: false, unreadable: 0 };
    }
    throw error;
  }

  const entries: RedlineEntry[] = [];
  let unreadable = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      unreadable += 1;
      continue;
    }
    if (isRedlineEntry(parsed)) {
      entries.push(parsed);
    } else {
      unreadable += 1;
    }
  }

  const kept = limit >= 0 && entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return {
    entries: kept,
    total: entries.length,
    truncated: kept.length < entries.length,
    unreadable,
  };
}
