import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isEnabled, requireCapability } from "../core/capabilities.js";
import { ExpectedError } from "../core/errors.js";
import { atomicWriteSet, type AtomicWriteEntry } from "../core/fs-atomic.js";
import { lockPathFor, withLock } from "../core/lock.js";
import type { VaultConfig } from "../core/types.js";
import {
  applyTransition,
  buildCandidateRow,
  depositBatchDigest,
  isCandidateStatus,
  isRecord,
  newCandidateId,
  normalizeDepositRequest,
  nowTimestamp,
  parseCandidateRow,
  sameDepositRequest,
  serializeCandidateRow,
  type TransitionPatch,
} from "./candidate.js";
import {
  CANDIDATE_SOURCES,
  CANDIDATE_STATUSES,
  CorruptStoreError,
  IdempotencyConflictError,
  MANUAL_SOURCE,
  MAX_BATCH_ITEMS,
  PENDING_STATUSES,
  RESUMABLE_STATUSES,
  STAGING_SCHEMA_VERSION,
  StagingStoreError,
  StoreLockTimeoutError,
  TERMINAL_STATUSES,
  type CandidateRow,
  type CandidateSource,
  type CandidateStatus,
  type DepositRequest,
  type PurgeTombstone,
  type StagingManifest,
} from "./types.js";

/**
 * The transactional staging store. It owns the candidate file and every
 * mutation of it: nothing else in Open Brain writes a candidate. Every mutation
 * reads the whole store, rebuilds it in memory, and republishes it atomically
 * under an inter-process lock, which is what makes a concurrent deposit
 * impossible to lose and a crash impossible to observe as a half-written line.
 */

const STAGING_DIRECTORY = "staging";
const CANDIDATES_FILE = "candidates.jsonl";
const ARCHIVE_DIRECTORY = "archive";
const BATCHES_DIRECTORY = "batches";
const MANIFEST_FILE = "_manifest.json";
const TOMBSTONES_FILE = "_tombstones.jsonl";
const ARCHIVE_SUFFIX = "_resolved.jsonl";
const LOCK_NAME = "staging";
const LOCK_HOLDER = "open-brain staging";
const MAX_ID_ATTEMPTS = 8;

export interface StagingPaths {
  directory: string;
  candidates: string;
  archive: string;
  batches: string;
  manifest: string;
  tombstones: string;
}

/** Every path is derived from the configured memory root, never hard coded. */
export function stagingPaths(root: string, config: VaultConfig): StagingPaths {
  const directory = join(root, config.paths.memory, STAGING_DIRECTORY);
  const archive = join(directory, ARCHIVE_DIRECTORY);
  return {
    directory,
    candidates: join(directory, CANDIDATES_FILE),
    archive,
    batches: join(directory, BATCHES_DIRECTORY),
    manifest: join(directory, MANIFEST_FILE),
    tombstones: join(archive, TOMBSTONES_FILE),
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

/**
 * Reads a store file strictly. A byte sequence that is not UTF-8 is corruption,
 * not something to replace with a question mark: the replacement character
 * would be written back on the next rewrite and the original would be gone.
 */
async function readStoreFile(path: string): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (bytes.includes(0)) {
    throw new CorruptStoreError(`${path} contains a null byte and cannot be a candidate store.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new CorruptStoreError(`${path} is not valid UTF-8. No mutation was attempted.`);
  }
}

function parseLines(text: string, origin: string): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    const where = `${origin}:${String(index + 1)}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new CorruptStoreError(
        `${where} is not valid JSON. Every mutation is refused until the line is repaired, so no candidate is lost.`,
      );
    }
    rows.push(parseCandidateRow(parsed, where));
  }
  return rows;
}

export interface StoreSnapshot {
  active: CandidateRow[];
  archived: CandidateRow[];
  all: CandidateRow[];
  archiveFiles: string[];
}

async function listArchiveFiles(paths: StagingPaths): Promise<string[]> {
  try {
    const entries = await readdir(paths.archive, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(ARCHIVE_SUFFIX))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

/**
 * Loads the active file and every monthly archive as one view. An identifier
 * that exists in both places must be byte identical: a divergence means an
 * archived candidate was resurrected or edited, and continuing would let the
 * same identifier tell two different stories.
 */
export async function readStore(root: string, config: VaultConfig): Promise<StoreSnapshot> {
  const paths = stagingPaths(root, config);
  const activeText = await readStoreFile(paths.candidates);
  const active = activeText === undefined ? [] : parseLines(activeText, CANDIDATES_FILE);

  const byId = new Map<string, CandidateRow>();
  for (const row of active) {
    if (byId.has(row.id)) {
      throw new CorruptStoreError(
        `Candidate ${row.id} appears twice in ${CANDIDATES_FILE}. No mutation was attempted.`,
      );
    }
    byId.set(row.id, row);
  }

  const archiveFiles = await listArchiveFiles(paths);
  const archived: CandidateRow[] = [];
  const archivedById = new Map<string, CandidateRow>();
  for (const name of archiveFiles) {
    const text = await readStoreFile(join(paths.archive, name));
    if (text === undefined) {
      continue;
    }
    for (const row of parseLines(text, `${ARCHIVE_DIRECTORY}/${name}`)) {
      const twin = archivedById.get(row.id) ?? byId.get(row.id);
      if (twin && serializeCandidateRow(twin) !== serializeCandidateRow(row)) {
        throw new CorruptStoreError(
          `Candidate ${row.id} diverges between the active store and ${ARCHIVE_DIRECTORY}/${name}. No mutation was attempted.`,
        );
      }
      if (!twin) {
        archived.push(row);
      }
      archivedById.set(row.id, row);
    }
  }

  return { active, archived, all: [...active, ...archived], archiveFiles };
}

function countByStatus(rows: readonly CandidateRow[]): Record<CandidateStatus, number> {
  const counts = {} as Record<CandidateStatus, number>;
  for (const status of CANDIDATE_STATUSES) {
    counts[status] = 0;
  }
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}

function manifestFor(
  paths: StagingPaths,
  rows: readonly CandidateRow[],
  archiveFiles: readonly string[],
): StagingManifest {
  return {
    schema_version: STAGING_SCHEMA_VERSION,
    updated_at: nowTimestamp(),
    active_path: `${STAGING_DIRECTORY}/${CANDIDATES_FILE}`,
    archive_paths: archiveFiles.map((name) => `${STAGING_DIRECTORY}/${ARCHIVE_DIRECTORY}/${name}`),
    total: rows.length,
    counts: countByStatus(rows),
  };
}

function serializeRows(rows: readonly CandidateRow[]): string {
  return rows.map((row) => `${serializeCandidateRow(row)}\n`).join("");
}

/**
 * Publishes a new store state. The manifest is written last on purpose: the set
 * write is not a transaction, so the last rename is the only usable commit
 * point, and a manifest that lags behind is harmless because the candidate file
 * is always the source of truth.
 */
async function publish(
  paths: StagingPaths,
  rows: readonly CandidateRow[],
  archives: readonly AtomicWriteEntry[] = [],
  archiveFiles?: readonly string[],
): Promise<void> {
  const names = archiveFiles ?? [];
  await atomicWriteSet([
    ...archives,
    { path: paths.candidates, content: serializeRows(rows) },
    {
      path: paths.manifest,
      content: `${JSON.stringify(manifestFor(paths, rows, names), null, 2)}\n`,
    },
  ]);
}

async function withStoreLock<T>(
  root: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const options = timeoutMs === undefined
    ? { holder: LOCK_HOLDER }
    : { holder: LOCK_HOLDER, timeoutMs };
  try {
    return await withLock(lockPathFor(root, LOCK_NAME), fn, options);
  } catch (error) {
    if (error instanceof StagingStoreError) {
      throw error;
    }
    if (error instanceof ExpectedError && error.message.startsWith("Timed out after")) {
      throw new StoreLockTimeoutError(
        `The staging store is busy and the wait is bounded rather than infinite. ${error.message}`,
      );
    }
    throw error;
  }
}

function uniqueCandidateId(taken: ReadonlySet<string>, now: Date): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = newCandidateId(now);
    if (!taken.has(id)) {
      return id;
    }
  }
  throw new StagingStoreError(
    "Could not draw a candidate identifier that is free in the store and in every archive.",
  );
}

/**
 * A deposit that comes from an automatic capture needs the capture capability.
 * A manual deposit does not, and stays available on a vault with nothing armed.
 *
 * Be precise about what that means: the manual source is a claim the caller
 * makes about itself, and an agent can make it too. Nothing here can tell a
 * person typing from a program typing. What makes the open door acceptable is
 * not the claim, it is that the staging area is inert: a candidate is a
 * proposal, and the only path from a proposal to the preference kernel runs
 * through `sync validate`, which does demand a proof of human presence that a
 * caller cannot fabricate. Close this door and the capture loop dies; leave the
 * gate open and nothing else matters.
 */
function requireDepositCapability(config: VaultConfig, request: DepositRequest): void {
  if (request.source !== MANUAL_SOURCE) {
    requireCapability(config, "capture");
  }
}

export interface AppendResult {
  candidate: CandidateRow;
  created: boolean;
}

export interface AppendManyResult {
  candidates: CandidateRow[];
  created: boolean;
}

function findByDepositOperation(
  snapshot: StoreSnapshot,
  operationId: string,
): CandidateRow | undefined {
  return snapshot.all.find((row) => row.deposit_operation_id === operationId);
}

/**
 * Files one candidate. The idempotency check runs before any default is filled
 * in, because a replay must stay a replay even when the day, the caller, or a
 * defaulted field has changed since the first call.
 */
export async function appendCandidate(
  root: string,
  config: VaultConfig,
  request: unknown,
): Promise<AppendResult> {
  const normalized = normalizeDepositRequest(request);
  requireDepositCapability(config, normalized);

  return withStoreLock(root, async () => {
    const paths = stagingPaths(root, config);
    const snapshot = await readStore(root, config);

    if (normalized.operation_id !== null) {
      const existing = findByDepositOperation(snapshot, normalized.operation_id);
      if (existing) {
        if (sameDepositRequest(existing.deposit_request, normalized)) {
          return { candidate: existing, created: false };
        }
        throw new IdempotencyConflictError(
          `Operation ${normalized.operation_id} already staged candidate ${existing.id} with different content. Use a new operation id, or replay the original deposit unchanged.`,
        );
      }
    }

    const taken = new Set(snapshot.all.map((row) => row.id));
    const row = buildCandidateRow(normalized, { id: uniqueCandidateId(taken, new Date()) });
    await publish(paths, [...snapshot.active, row], [], snapshot.archiveFiles);
    return { candidate: row, created: true };
  });
}

export interface AppendManyOptions {
  operationId?: string | undefined;
}

/**
 * Files a whole slice at once, all or nothing. Validation of every request runs
 * before the first row is built, so a malformed item in the middle of a batch
 * leaves the store byte for byte as it was.
 */
export async function appendCandidates(
  root: string,
  config: VaultConfig,
  requests: readonly unknown[],
  options: AppendManyOptions = {},
): Promise<AppendManyResult> {
  if (requests.length === 0) {
    throw new StagingStoreError("A batch deposit needs at least one request.");
  }
  if (requests.length > MAX_BATCH_ITEMS) {
    throw new StagingStoreError(
      `A batch deposit carries at most ${String(MAX_BATCH_ITEMS)} requests, received ${String(requests.length)}.`,
    );
  }

  const normalized = requests.map((request) => normalizeDepositRequest(request));
  for (const request of normalized) {
    requireDepositCapability(config, request);
  }
  const batchDigest = depositBatchDigest(normalized);

  const operationIds = normalized
    .map((request) => request.operation_id)
    .filter((value): value is string => value !== null);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new StagingStoreError("A batch deposit may not repeat the same operation id.");
  }

  return withStoreLock(root, async () => {
    const paths = stagingPaths(root, config);
    const snapshot = await readStore(root, config);

    if (options.operationId !== undefined) {
      const previous = snapshot.all.filter(
        (row) => row.deposit_batch_operation_id === options.operationId,
      );
      if (previous.length > 0) {
        const first = previous[0];
        if (first && first.deposit_batch_digest === batchDigest) {
          return {
            candidates: [...previous].sort(
              (left, right) => (left.deposit_batch_index ?? 0) - (right.deposit_batch_index ?? 0),
            ),
            created: false,
          };
        }
        throw new IdempotencyConflictError(
          `Batch operation ${options.operationId} already staged ${String(previous.length)} candidate(s) with different content. Use a new operation id, or replay the original batch unchanged.`,
        );
      }
    }

    for (const request of normalized) {
      if (request.operation_id !== null && findByDepositOperation(snapshot, request.operation_id)) {
        throw new IdempotencyConflictError(
          `Operation ${request.operation_id} is already staged, so this batch would double one of its items. Nothing was written.`,
        );
      }
    }

    const taken = new Set(snapshot.all.map((row) => row.id));
    const now = new Date();
    const rows: CandidateRow[] = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const request = normalized[index];
      if (!request) {
        continue;
      }
      const id = uniqueCandidateId(taken, now);
      taken.add(id);
      rows.push(
        buildCandidateRow(request, {
          id,
          ...(options.operationId === undefined ? {} : { batchOperationId: options.operationId }),
          batchDigest,
          batchIndex: index,
          batchSize: normalized.length,
        }),
      );
    }

    await publish(paths, [...snapshot.active, ...rows], [], snapshot.archiveFiles);
    return { candidates: rows, created: true };
  });
}

export interface TransitionParams {
  id: string;
  status: CandidateStatus;
  operationId?: string | undefined;
  batchId?: string | undefined;
  proposal?: TransitionPatch["proposal"];
  appliedRef?: string | undefined;
  applyError?: string | undefined;
  updates?: Record<string, unknown> | undefined;
}

export interface TransitionOutcome {
  candidate: CandidateRow;
  changed: boolean;
}

/**
 * Moves one candidate along the state machine. The store is the only place the
 * machine is enforced, so an illegal edge is refused with the legal ones named
 * rather than absorbed in silence.
 */
export async function transitionCandidate(
  root: string,
  config: VaultConfig,
  params: TransitionParams,
): Promise<TransitionOutcome> {
  return withStoreLock(root, async () => {
    const paths = stagingPaths(root, config);
    const snapshot = await readStore(root, config);
    const index = snapshot.active.findIndex((row) => row.id === params.id);
    if (index === -1) {
      const archived = snapshot.archived.find((row) => row.id === params.id);
      if (archived) {
        throw new StagingStoreError(
          `Candidate ${params.id} is archived as ${archived.status} and can no longer move.`,
        );
      }
      throw new StagingStoreError(`Unknown candidate ${params.id}.`);
    }

    const current = snapshot.active[index];
    if (!current) {
      throw new StagingStoreError(`Unknown candidate ${params.id}.`);
    }

    const patch: TransitionPatch = {
      status: params.status,
      operationId: params.operationId,
      batchId: params.batchId,
      proposal: params.proposal,
      appliedRef: params.appliedRef,
      applyError: params.applyError,
      updates: params.updates,
    };
    const result = applyTransition(current, patch);
    if (!result.changed) {
      return { candidate: result.row, changed: false };
    }

    const rows = [...snapshot.active];
    rows[index] = result.row;
    await publish(paths, rows, [], snapshot.archiveFiles);
    return { candidate: result.row, changed: true };
  });
}

export interface ListFilter {
  status?: CandidateStatus | undefined;
  pending?: boolean | undefined;
  resumable?: boolean | undefined;
  batchId?: string | undefined;
  includeArchived?: boolean | undefined;
}

function matchesFilter(row: CandidateRow, filter: ListFilter): boolean {
  if (filter.status !== undefined && row.status !== filter.status) {
    return false;
  }
  if (filter.pending === true && !PENDING_STATUSES.some((status) => status === row.status)) {
    return false;
  }
  if (filter.resumable === true && !RESUMABLE_STATUSES.some((status) => status === row.status)) {
    return false;
  }
  if (filter.batchId !== undefined && row.batch_id !== filter.batchId) {
    return false;
  }
  return true;
}

/** Read-only listing, ordered oldest first so a review reads chronologically. */
export async function listCandidates(
  root: string,
  config: VaultConfig,
  filter: ListFilter = {},
): Promise<CandidateRow[]> {
  const snapshot = await readStore(root, config);
  const rows = filter.includeArchived === true ? snapshot.all : snapshot.active;
  return rows
    .filter((row) => matchesFilter(row, filter))
    .sort((left, right) => (left.ts === right.ts ? left.id.localeCompare(right.id) : left.ts.localeCompare(right.ts)));
}

export async function getCandidate(
  root: string,
  config: VaultConfig,
  id: string,
): Promise<CandidateRow | undefined> {
  return (await readStore(root, config)).all.find((row) => row.id === id);
}

export interface StagingStatus {
  schema_version: number;
  total: number;
  active: number;
  archived: number;
  pending: number;
  resumable: number;
  counts: Record<CandidateStatus, number>;
  capture_enabled: boolean;
  archive_files: string[];
}

export async function stagingStatus(
  root: string,
  config: VaultConfig,
): Promise<StagingStatus> {
  const snapshot = await readStore(root, config);
  return {
    schema_version: STAGING_SCHEMA_VERSION,
    total: snapshot.all.length,
    active: snapshot.active.length,
    archived: snapshot.archived.length,
    pending: snapshot.active.filter((row) =>
      PENDING_STATUSES.some((status) => status === row.status)).length,
    resumable: snapshot.active.filter((row) =>
      RESUMABLE_STATUSES.some((status) => status === row.status)).length,
    counts: countByStatus(snapshot.active),
    capture_enabled: isEnabled(config, "capture"),
    archive_files: snapshot.archiveFiles,
  };
}

/** The only shape an archive month may take: it becomes part of a file name. */
const ARCHIVE_MONTH_PATTERN = /^\d{4}-\d{2}$/u;

/**
 * The month a candidate archives into, taken from its own timestamp and fed
 * straight into `join()` as a file name. Nothing upstream guarantees that
 * timestamp is a clean `YYYY-MM-DDTHH:mm:ss` string: a malformed or crafted
 * one, `../../../etc/passwd` sliced to seven characters is still attacker
 * shaped, would otherwise become a path segment. Refusing anything that is
 * not exactly four digits, a dash, two digits closes that door before the
 * value ever reaches a path.
 */
function archiveMonth(row: CandidateRow): string {
  const month = (row.resolved_ts ?? row.ts).slice(0, 7);
  if (!ARCHIVE_MONTH_PATTERN.test(month)) {
    throw new CorruptStoreError(
      `Candidate ${row.id} has a timestamp that does not produce a valid archive month ("${month}"). Refusing to derive an archive path from it.`,
    );
  }
  return month;
}

export interface CompactResult {
  archived: number;
  kept: number;
  files: string[];
}

/**
 * Moves terminal candidates into their monthly archive. Archives are published
 * before the shorter active file, so an interruption leaves a candidate present
 * in both places, which the reader accepts as long as the two copies agree, and
 * a retry finishes the job.
 */
export async function compactStaging(
  root: string,
  config: VaultConfig,
): Promise<CompactResult> {
  return withStoreLock(root, async () => {
    const paths = stagingPaths(root, config);
    const snapshot = await readStore(root, config);
    const terminal = snapshot.active.filter((row) =>
      TERMINAL_STATUSES.some((status) => status === row.status));
    if (terminal.length === 0) {
      return { archived: 0, kept: snapshot.active.length, files: snapshot.archiveFiles };
    }

    const existingByFile = new Map<string, CandidateRow[]>();
    for (const name of snapshot.archiveFiles) {
      const text = await readStoreFile(join(paths.archive, name));
      existingByFile.set(
        name,
        text === undefined ? [] : parseLines(text, `${ARCHIVE_DIRECTORY}/${name}`),
      );
    }

    const touched = new Set<string>();
    for (const row of terminal) {
      const name = `${archiveMonth(row)}${ARCHIVE_SUFFIX}`;
      const rows = existingByFile.get(name) ?? [];
      const twin = rows.find((item) => item.id === row.id);
      if (twin) {
        if (serializeCandidateRow(twin) !== serializeCandidateRow(row)) {
          throw new CorruptStoreError(
            `Candidate ${row.id} is already archived in ${name} with different content. Nothing was archived.`,
          );
        }
      } else {
        rows.push(row);
        touched.add(name);
      }
      existingByFile.set(name, rows);
    }

    const archives: AtomicWriteEntry[] = [...touched].sort().map((name) => ({
      path: join(paths.archive, name),
      content: serializeRows(
        [...(existingByFile.get(name) ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
      ),
    }));
    const kept = snapshot.active.filter(
      (row) => !TERMINAL_STATUSES.some((status) => status === row.status),
    );
    const files = [...new Set([...snapshot.archiveFiles, ...touched])].sort();
    await publish(paths, kept, archives, files);
    return { archived: terminal.length, kept: kept.length, files };
  });
}

export interface DropParams {
  ids?: readonly string[] | undefined;
  status?: CandidateStatus | undefined;
  sources?: readonly CandidateSource[] | undefined;
  olderThanDays?: number | undefined;
  includeArchived?: boolean | undefined;
  reason?: string | undefined;
  command?: string | undefined;
}

export interface ArchivePurgeReport {
  path: string;
  removed: number;
  remaining: number;
}

export interface DropResult {
  dropped: string[];
  kept: number;
  archived_dropped: string[];
  archive_files: ArchivePurgeReport[];
  tombstone?: PurgeTombstone;
}

const DEFAULT_PURGE_REASON = "unspecified";
const DEFAULT_PURGE_COMMAND = "open-brain staging drop";

function dropFilterIsEmpty(params: DropParams): boolean {
  return params.status === undefined
    && params.olderThanDays === undefined
    && (params.sources ?? []).length === 0;
}

function matchesDrop(
  row: CandidateRow,
  params: DropParams,
  wanted: ReadonlySet<string>,
  cutoff: number | undefined,
): boolean {
  if (wanted.has(row.id)) {
    return true;
  }
  if (dropFilterIsEmpty(params)) {
    return false;
  }
  const sources = params.sources ?? [];
  if (params.status !== undefined && row.status !== params.status) {
    return false;
  }
  if (sources.length > 0 && !sources.some((source) => source === row.source)) {
    return false;
  }
  if (cutoff !== undefined && Date.parse(row.ts) >= cutoff) {
    return false;
  }
  return true;
}

function buildTombstone(
  params: DropParams,
  activeRemoved: number,
  files: readonly ArchivePurgeReport[],
): PurgeTombstone {
  return {
    schema_version: STAGING_SCHEMA_VERSION,
    ts: nowTimestamp(),
    reason: params.reason ?? DEFAULT_PURGE_REASON,
    command: params.command ?? DEFAULT_PURGE_COMMAND,
    active_removed: activeRemoved,
    archive_removed: files.reduce((total, file) => total + file.removed, 0),
    files: files.map((file) => ({ path: file.path, removed: file.removed })),
    filters: {
      ids: (params.ids ?? []).length,
      status: params.status ?? null,
      sources: [...(params.sources ?? [])],
      older_than_days: params.olderThanDays ?? null,
    },
  };
}

/**
 * Deletes candidates outright. This is the privacy escape hatch: a raw quote is
 * stored verbatim, so a user who revokes consent must be able to erase it, and
 * the erasure has to be literal or the promise is worthless.
 *
 * By default only the active store is touched. With includeArchived the purge
 * reaches into the monthly archives too, and there the content is removed while
 * a tombstone records that a removal happened, how large it was, and why. The
 * tombstone carries no quote and no identifier: privacy wins on the content,
 * never on the trace.
 *
 * One consequence is deliberate and worth stating: purging a candidate also
 * forgets its deposit operation, so a hook replaying that same operation stages
 * a fresh candidate rather than recognizing a duplicate. Forgetting is what was
 * asked for.
 */
export async function dropCandidates(
  root: string,
  config: VaultConfig,
  params: DropParams,
): Promise<DropResult> {
  const ids = params.ids ?? [];
  if (ids.length === 0 && dropFilterIsEmpty(params)) {
    throw new StagingStoreError(
      "Dropping candidates needs a criterion: ids, a status, a source, or an age in days.",
    );
  }
  if (params.olderThanDays !== undefined
    && (!Number.isInteger(params.olderThanDays) || params.olderThanDays < 0)) {
    throw new StagingStoreError("An age in days must be a non-negative integer.");
  }
  for (const source of params.sources ?? []) {
    if (!CANDIDATE_SOURCES.some((known) => known === source)) {
      throw new StagingStoreError(
        `Unknown candidate source "${source}". Expected one of ${CANDIDATE_SOURCES.join(", ")}.`,
      );
    }
  }

  return withStoreLock(root, async () => {
    const paths = stagingPaths(root, config);
    const snapshot = await readStore(root, config);
    const includeArchived = params.includeArchived === true;
    const wanted = new Set(ids);
    const cutoff = params.olderThanDays === undefined
      ? undefined
      : Date.now() - params.olderThanDays * 86_400_000;

    const pool = includeArchived ? snapshot.all : snapshot.active;
    const unknown = [...wanted].filter((id) => !pool.some((row) => row.id === id));
    if (unknown.length > 0) {
      throw new StagingStoreError(
        includeArchived
          ? `Unknown candidate(s): ${unknown.sort().join(", ")}.`
          : `Unknown active candidate(s): ${unknown.sort().join(", ")}.`,
      );
    }

    const dropped: string[] = [];
    const kept: CandidateRow[] = [];
    for (const row of snapshot.active) {
      if (matchesDrop(row, params, wanted, cutoff)) {
        dropped.push(row.id);
      } else {
        kept.push(row);
      }
    }

    if (!includeArchived) {
      if (dropped.length > 0) {
        await publish(paths, kept, [], snapshot.archiveFiles);
      }
      return { dropped, kept: kept.length, archived_dropped: [], archive_files: [] };
    }

    const archiveEntries: AtomicWriteEntry[] = [];
    const reports: ArchivePurgeReport[] = [];
    const archivedDropped: string[] = [];
    for (const name of snapshot.archiveFiles) {
      const text = await readStoreFile(join(paths.archive, name));
      if (text === undefined) {
        continue;
      }
      const rows = parseLines(text, `${ARCHIVE_DIRECTORY}/${name}`);
      const remaining: CandidateRow[] = [];
      for (const row of rows) {
        if (matchesDrop(row, params, wanted, cutoff)) {
          archivedDropped.push(row.id);
        } else {
          remaining.push(row);
        }
      }
      if (remaining.length === rows.length) {
        continue;
      }
      archiveEntries.push({ path: join(paths.archive, name), content: serializeRows(remaining) });
      reports.push({
        path: `${ARCHIVE_DIRECTORY}/${name}`,
        removed: rows.length - remaining.length,
        remaining: remaining.length,
      });
    }

    if (dropped.length === 0 && archivedDropped.length === 0) {
      return { dropped, kept: kept.length, archived_dropped: [], archive_files: [] };
    }

    // The tombstone is published before the shortened archives on purpose. An
    // interruption between the two then leaves a recorded removal that is not
    // fully applied, which a retry finishes; the reverse order would allow
    // content to disappear with nothing saying it ever did.
    const tombstone = buildTombstone(params, dropped.length, reports);
    const previous = await readStoreFile(paths.tombstones) ?? "";
    const tombstoneEntry: AtomicWriteEntry = {
      path: paths.tombstones,
      content: `${previous}${JSON.stringify(tombstone)}\n`,
    };

    await publish(paths, kept, [tombstoneEntry, ...archiveEntries], snapshot.archiveFiles);
    return {
      dropped,
      kept: kept.length,
      archived_dropped: archivedDropped,
      archive_files: reports,
      tombstone,
    };
  });
}

function parseTombstone(value: unknown, origin: string): PurgeTombstone {
  if (!isRecord(value)) {
    throw new CorruptStoreError(`${origin} is not a JSON object.`);
  }
  const files = Array.isArray(value.files) ? value.files : [];
  const filters = isRecord(value.filters) ? value.filters : {};
  const count = (input: unknown): number =>
    typeof input === "number" && Number.isInteger(input) && input >= 0 ? input : 0;
  return {
    schema_version: count(value.schema_version) || STAGING_SCHEMA_VERSION,
    ts: typeof value.ts === "string" ? value.ts : "",
    reason: typeof value.reason === "string" ? value.reason : DEFAULT_PURGE_REASON,
    command: typeof value.command === "string" ? value.command : DEFAULT_PURGE_COMMAND,
    active_removed: count(value.active_removed),
    archive_removed: count(value.archive_removed),
    files: files
      .filter((file): file is Record<string, unknown> => isRecord(file))
      .map((file) => ({
        path: typeof file.path === "string" ? file.path : "",
        removed: count(file.removed),
      })),
    filters: {
      ids: count(filters.ids),
      status: isCandidateStatus(filters.status) ? filters.status : null,
      sources: Array.isArray(filters.sources)
        ? filters.sources.filter((source): source is CandidateSource =>
          CANDIDATE_SOURCES.some((known) => known === source))
        : [],
      older_than_days: typeof filters.older_than_days === "number"
        ? filters.older_than_days
        : null,
    },
  };
}

/**
 * The purge ledger, oldest first. It is what makes a shortened archive readable
 * as a deliberate erasure instead of an unexplained gap.
 */
export async function readPurgeTombstones(
  root: string,
  config: VaultConfig,
): Promise<PurgeTombstone[]> {
  const text = await readStoreFile(stagingPaths(root, config).tombstones);
  if (text === undefined) {
    return [];
  }
  const tombstones: PurgeTombstone[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    const where = `${ARCHIVE_DIRECTORY}/${TOMBSTONES_FILE}:${String(index + 1)}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new CorruptStoreError(`${where} is not valid JSON.`);
    }
    tombstones.push(parseTombstone(parsed, where));
  }
  return tombstones;
}
