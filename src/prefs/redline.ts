import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteJson, atomicWriteText, fsyncDirectory } from "../core/fs-atomic.js";
import { loadVaultSecret, sealsMatch, vaultMac, type VaultSecret } from "../core/secret.js";
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
 *
 * Every entry is sealed with the vault key, which does NOT live under
 * .open-brain/local/ and does not live in the vault at all (see core/secret.ts).
 * That distinction is the whole difference between a record and a claim: the
 * record sits next to the file it vouches for, so anybody who can rewrite the
 * kernel can rewrite the record too, and while both were plain sha256 the second
 * rewrite was as easy as the first. Detection then amounted to catching people
 * who had not bothered.
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

/**
 * Where each target lives, so a target no record covers can still be looked
 * for. Without this, a kernel file nothing has ever recorded is indistinguishable
 * from a kernel file that does not exist, and the two mean opposite things.
 */
export const REDLINE_TARGET_PATHS: Readonly<Record<RedlineTarget, string>> = {
  ledger: join("10_memory", "preferences", "_ledger.json"),
  core: join("10_memory", "preferences", "_core.md"),
};

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
  /**
   * The seal of the entry before this one in the journal, which is what turns a
   * pile of lines into a chain. Empty on the first entry a journal ever holds.
   */
  prev?: string;
  /**
   * Keyed with the vault secret. Without it, an entry is a line of JSON: the
   * sha256 next to it is computed with a public function, so anybody able to
   * write the kernel could write the record that vouches for it and the whole
   * detector would agree the forgery was reviewed. With it, an entry can still
   * be added or edited by anybody, and any such entry reads as unverifiable
   * rather than as clean.
   */
  seal?: string;
}

/**
 * Whether a record could be read at all. Absent and unreadable are different
 * facts about the world, and collapsing them is how "I cannot tell" starts
 * reading as "there is nothing to tell".
 */
export type RedlineRecordStatus = "absent" | "loaded" | "unreadable";

export interface RedlineState {
  schema_version: number;
  updated_at: string;
  targets: Partial<Record<RedlineTarget, RedlineEntry>>;
  status: RedlineRecordStatus;
}

/**
 * What a check concluded.
 *
 * The last one is the one that matters most, and the one that used to be
 * missing: unverifiable says the file is there and nothing here can vouch for
 * it. Reporting that as unrecorded, and unrecorded as untampered, turned every
 * way of losing the record into a clean bill of health, which is the one answer
 * a tamper detector must never give when it does not know.
 */
export type RedlineVerdict =
  | "match"
  | "modified"
  | "missing"
  | "unrecorded"
  | "unverifiable";

/** Which half of the record answered. The journal is the evidence. */
export type RedlineSource = "state" | "journal";

export interface RedlineCheck {
  target: RedlineTarget;
  path: string;
  verdict: RedlineVerdict;
  detail: string;
  /** Absent when no record covered this target at all. */
  source?: RedlineSource;
  expected_sha256?: string;
  actual_sha256?: string;
  recorded_at?: string;
  command?: string;
}

export interface RedlineReport {
  checked_at: string;
  /** True when at least one recorded target no longer matches its record. */
  tampered: boolean;
  /** True when at least one target exists that nothing here can vouch for. */
  unverified: boolean;
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

function emptyState(status: RedlineRecordStatus): RedlineState {
  return { schema_version: REDLINE_SCHEMA_VERSION, updated_at: "", targets: {}, status };
}

export async function readRedlineState(vaultRoot: string): Promise<RedlineState> {
  let raw: string;
  try {
    raw = await readFile(join(vaultRoot, REDLINE_STATE_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return emptyState("absent");
    }
    // A record that is there and cannot be read is not a record that is not
    // there. It must still never break a write, so it returns rather than
    // throws, but it says which of the two it is.
    return emptyState("unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyState("unreadable");
  }
  if (!isRecord(parsed)) {
    return emptyState("unreadable");
  }

  return {
    schema_version: typeof parsed.schema_version === "number"
      ? parsed.schema_version
      : REDLINE_SCHEMA_VERSION,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    targets: stateEntries(parsed),
    status: "loaded",
  };
}

/** Domain tag of a journal entry, so its seal fits nowhere else. */
const REDLINE_ENTRY_DOMAIN = "open-brain/prefs-redline-entry/v1";

/**
 * The seal of one recorded write, over the entry AND over the seal of the entry
 * before it.
 *
 * Two different attacks, one countermeasure each. The key stops an entry from
 * being written by anybody but a run holding the vault secret, so a forged
 * record can no longer vouch for a forged kernel. The chain stops the other
 * half, which a signature alone never covers: an attacker who cannot write an
 * entry can still DELETE the last ones, rolling the comparison point back to an
 * older recorded state and then restoring the matching old content, and every
 * check would report a clean match. With each entry naming the one before it, a
 * deletion leaves the next entry pointing at a seal that is no longer anywhere
 * in the file, and the journal says so instead of shrinking quietly.
 */
export function sealRedlineEntry(
  entry: Omit<RedlineEntry, "seal">,
  secret: VaultSecret,
): string {
  return vaultMac(secret, REDLINE_ENTRY_DOMAIN, JSON.stringify([
    entry.schema_version,
    entry.recorded_at,
    entry.target,
    entry.path,
    entry.sha256,
    entry.bytes,
    entry.command,
    entry.validation,
    entry.operation_id ?? null,
    entry.prev ?? "",
  ]));
}

function entryIsSealed(entry: RedlineEntry, secret: VaultSecret): boolean {
  return sealsMatch(entry.seal, sealRedlineEntry(entry, secret));
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
  const secret = await loadVaultSecret(vaultRoot);
  await atomicWriteText(join(vaultRoot, write.relativePath), write.content);

  // The tail of the journal is read before the entry is built, so the new entry
  // names the one it follows. Read here rather than kept in memory: the journal
  // on disk is the evidence, and a link computed from anything else would be a
  // link to a file this process only believes in.
  //
  // It links to the last entry that is itself sealed and linked, not simply to
  // the last line. A line somebody appended by hand would otherwise become a
  // link nothing can verify, and every honest write after it would inherit that,
  // leaving a vault permanently unverifiable with no way back. Chaining past it
  // hides nothing: the line stays in the file, stays unsealed, and stays
  // reported as such.
  const existing = await loadJournalEvidence(vaultRoot, secret);
  const last = existing.authentic[existing.authentic.length - 1];
  const unsealed: Omit<RedlineEntry, "seal"> = {
    schema_version: REDLINE_SCHEMA_VERSION,
    recorded_at: new Date().toISOString(),
    target: write.target,
    path: relativePath,
    sha256: sha256(write.content),
    bytes: Buffer.byteLength(write.content, "utf8"),
    command: write.command,
    validation: write.validation,
    ...(write.operationId === undefined ? {} : { operation_id: write.operationId }),
    prev: last?.seal ?? "",
  };
  const entry: RedlineEntry = { ...unsealed, seal: sealRedlineEntry(unsealed, secret) };

  // The journal is appended before the state is replaced. The journal is the
  // evidence; the state file is only the fast comparison point and can always be
  // rebuilt from the journal, so a crash between the two loses nothing.
  await appendJournalEntry(vaultRoot, entry);

  // A comparison point that could not be read is rebuilt from the journal
  // rather than replaced by this single entry: writing one target must never be
  // what makes the other one unverifiable. Entries the state carries for the
  // other targets are kept only when they are sealed, so a state file somebody
  // seeded by hand is not laundered into the next one by an unrelated write.
  const state = await readRedlineState(vaultRoot);
  const base = state.status === "loaded"
    ? Object.fromEntries(
      Object.entries(state.targets)
        .filter(([, kept]) => kept !== undefined && entryIsSealed(kept, secret)),
    ) as Partial<Record<RedlineTarget, RedlineEntry>>
    : await rebuildTargetsFromJournal(vaultRoot);
  const next = {
    schema_version: REDLINE_SCHEMA_VERSION,
    updated_at: entry.recorded_at,
    targets: { ...base, [entry.target]: entry },
  } satisfies Omit<RedlineState, "status">;
  const statePath = join(vaultRoot, REDLINE_STATE_RELATIVE_PATH);
  await atomicWriteJson(statePath, next);
  await fsyncDirectory(dirname(statePath));
  return entry;
}

/** The last thing the journal recorded about one target, if it recorded any. */
function lastJournalEntry(
  entries: readonly RedlineEntry[],
  target: RedlineTarget,
): RedlineEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.target === target) {
      return entry;
    }
  }
  return undefined;
}

/** What the journal can actually vouch for, once its own integrity is read. */
interface JournalEvidence {
  /** Every readable entry, in file order. */
  entries: RedlineEntry[];
  /** The subset that is sealed and correctly linked to what precedes it. */
  authentic: RedlineEntry[];
  /** True when a readable entry is unsealed, or points at a link that is gone. */
  chainBroken: boolean;
  status: RedlineRecordStatus;
}

/**
 * Reads the journal and walks its chain.
 *
 * An entry counts as evidence only when its seal verifies and its prev names an
 * entry that really does come before it in the file. The rule is deliberately
 * "some earlier entry" rather than "the entry immediately before": two writers
 * appending at the same moment read the same tail and both link to it, which is
 * a fork rather than a break, and refusing that would turn honest concurrency
 * into a tamper report. Removing an entry, on the other hand, orphans everything
 * that pointed at it, and that is exactly what this catches.
 */
async function loadJournalEvidence(
  vaultRoot: string,
  secret: VaultSecret,
): Promise<JournalEvidence> {
  const journal = await loadJournalEntries(vaultRoot);
  const seen = new Set<string>();
  const authentic: RedlineEntry[] = [];
  let chainBroken = false;

  for (const entry of journal.entries) {
    if (!entryIsSealed(entry, secret)) {
      chainBroken = true;
      continue;
    }
    // An empty link means "nothing was here yet", which is true of the first
    // entry of a journal and of the first honest entry after one that cannot be
    // verified. Anything else has to name an entry already seen above it.
    const previous = entry.prev ?? "";
    const linked = previous.length === 0 ? seen.size === 0 : seen.has(previous);
    if (!linked) {
      chainBroken = true;
      continue;
    }
    seen.add(entry.seal ?? "");
    authentic.push(entry);
  }

  return { entries: journal.entries, authentic, chainBroken, status: journal.status };
}

/** Rebuilds the comparison point from the evidence, target by target. */
async function rebuildTargetsFromJournal(
  vaultRoot: string,
): Promise<Partial<Record<RedlineTarget, RedlineEntry>>> {
  const secret = await loadVaultSecret(vaultRoot);
  const journal = await loadJournalEvidence(vaultRoot, secret);
  const targets: Partial<Record<RedlineTarget, RedlineEntry>> = {};
  for (const target of REDLINE_TARGETS) {
    const entry = lastJournalEntry(journal.authentic, target);
    if (entry) {
      targets[target] = entry;
    }
  }
  return targets;
}

/** Says out loud that the comparison did not come from the usual place. */
function fallbackNote(status: RedlineRecordStatus): string {
  return status === "unreadable"
    ? " The fast comparison record could not be read, so this was checked against the provenance journal, which is the evidence."
    : " The fast comparison record is gone, so this was checked against the provenance journal, which is the evidence.";
}

/**
 * Compares every target with what the record says was last written to it.
 *
 * The evidence is the journal, and only the journal: entries are sealed with the
 * vault key and chained, so what it holds was written by a run of this project
 * and nothing was quietly removed from underneath. The state file is a fast
 * comparison point and never a second opinion. It is read all the same, and held
 * against the journal every time, because the two disagreeing is itself a fact
 * worth reporting: whichever half was tampered with, nothing here can say what
 * the reviewed content was any more.
 *
 * The verdicts follow from that, in one direction only. Agreement gives a real
 * answer, match or modified or missing. Disagreement, a state entry the journal
 * never recorded, a journal that cannot vouch for itself, and a kernel file
 * nothing covers at all, are all unverifiable: different stories, one honest
 * conclusion, which is that this report cannot tell. Calling any of them clean
 * would mean vouching for bytes nobody here has ever seen.
 */
export async function verifyRedline(vaultRoot: string): Promise<RedlineReport> {
  const secret = await loadVaultSecret(vaultRoot);
  const state = await readRedlineState(vaultRoot);
  const journal = await loadJournalEvidence(vaultRoot, secret);
  const checks: RedlineCheck[] = [];

  for (const target of REDLINE_TARGETS) {
    const fromState = state.targets[target];
    const fromJournal = lastJournalEntry(journal.authentic, target);
    const path = toPosixPath(
      fromJournal?.path ?? fromState?.path ?? toPosixPath(REDLINE_TARGET_PATHS[target]),
    );

    // Defect 8, and the reason this reads the way it does. The comparison used
    // to be `fromState ?? fromJournal`: the state file answered whenever it
    // existed and the journal was consulted only in its absence, so a state
    // file rewritten to describe an older write was believed without ever being
    // held against the evidence, and the report said match. The two are now
    // ALWAYS compared, and any disagreement between them is reported as
    // unverifiable. A detector that cannot tell must say so; saying match is the
    // one answer it must never give.
    if (fromState !== undefined && fromJournal !== undefined
      && !sealsMatch(fromState.seal, fromJournal.seal ?? "")) {
      checks.push({
        target,
        path,
        verdict: "unverifiable",
        detail: `The fast comparison record and the provenance journal disagree about the last write to ${path}: the record names ${fromState.command} on ${fromState.recorded_at}, the journal names ${fromJournal.command} on ${fromJournal.recorded_at}. One of the two was written outside the recorded paths, and nothing here can say which content was ever reviewed. That is an absence of evidence, not a clean result. The next write through \`open-brain prefs\` or the sync gate rebuilds the record from the journal and settles it.`,
        source: "journal",
        expected_sha256: fromJournal.sha256,
        recorded_at: fromJournal.recorded_at,
        command: fromJournal.command,
      });
      continue;
    }

    // A state entry the journal does not carry is the same story told the other
    // way round: the evidence is what was appended, so a comparison point that
    // claims a write nothing recorded is a claim about a journal that has been
    // truncated, forged, or both.
    if (fromState !== undefined && fromJournal === undefined) {
      checks.push({
        target,
        path,
        verdict: "unverifiable",
        detail: `The fast comparison record names a write to ${path} by ${fromState.command} on ${fromState.recorded_at} that the provenance journal does not carry. The journal is the evidence, so a record without it vouches for nothing.${journal.chainBroken ? " Entries of the journal are also unsealed or missing from its chain." : ""} That is an absence of evidence, not a clean result.`,
        source: "state",
        expected_sha256: fromState.sha256,
        recorded_at: fromState.recorded_at,
        command: fromState.command,
      });
      continue;
    }

    const entry = fromJournal;
    const source: RedlineSource = fromState === undefined ? "journal" : "state";
    const note = fromState === undefined && entry !== undefined
      ? fallbackNote(state.status)
      : "";

    if (!entry) {
      const exists = await pathIsReadable(join(vaultRoot, REDLINE_TARGET_PATHS[target]));
      checks.push(exists
        ? {
          target,
          path,
          verdict: "unverifiable",
          detail: `${path} exists and no write to it has ever been recorded here, so nothing in this report can say whether its content was ever reviewed. That is an absence of evidence, not a clean result.${journal.chainBroken ? " Entries the journal does hold are unsealed or missing from its chain, so they were not counted." : ""} The next write through \`open-brain prefs\` or the sync gate records it, and every later check compares against that.`,
        }
        : {
          target,
          path,
          verdict: "unrecorded",
          detail: `No write to the ${target} has been recorded, and there is no file at ${path} either, so there is nothing to compare.`,
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
        detail: `${entry.path} was recorded on ${entry.recorded_at} by ${entry.command} but cannot be read now. Its removal is detected, not prevented.${note}`,
        source,
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
        detail: `${entry.path} matches the write recorded on ${entry.recorded_at} by ${entry.command}.${note}`,
        source,
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
      detail: `${entry.path} changed outside the recorded write paths. Last recorded write: ${entry.command} on ${entry.recorded_at}. The change is detected, not prevented; review it, then re-run the command that owns this file.${note}`,
      source,
      expected_sha256: entry.sha256,
      actual_sha256: actual,
      recorded_at: entry.recorded_at,
      command: entry.command,
    });
  }

  return {
    checked_at: new Date().toISOString(),
    tampered: checks.some((check) => check.verdict === "modified" || check.verdict === "missing"),
    unverified: checks.some((check) => check.verdict === "unverifiable"),
    checks,
  };
}

function parseJournalLines(raw: string): { entries: RedlineEntry[]; unreadable: number } {
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
  return { entries, unreadable };
}

/**
 * Reads the journal for a verification, which must never fail because of the
 * journal itself: a check that throws when the evidence is unreadable reports
 * nothing at all about the file it was asked about.
 */
async function loadJournalEntries(vaultRoot: string): Promise<{
  entries: RedlineEntry[];
  status: RedlineRecordStatus;
}> {
  let raw: string;
  try {
    raw = await readFile(join(vaultRoot, REDLINE_JOURNAL_RELATIVE_PATH), "utf8");
  } catch (error) {
    return { entries: [], status: hasErrorCode(error, "ENOENT") ? "absent" : "unreadable" };
  }
  return { entries: parseJournalLines(raw).entries, status: "loaded" };
}

async function pathIsReadable(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    // A path that exists and cannot be read is still a path that exists, and
    // saying otherwise would turn a locked file into an absent one.
    return !hasErrorCode(error, "ENOENT");
  }
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

  const { entries, unreadable } = parseJournalLines(raw);
  const kept = limit >= 0 && entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return {
    entries: kept,
    total: entries.length,
    truncated: kept.length < entries.length,
    unreadable,
  };
}
