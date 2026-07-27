import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { atomicWriteText } from "../core/fs-atomic.js";
import { lockPathFor, withLock } from "../core/lock.js";
import { sha256, toPosixPath } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import {
  assertCoversSlice,
  classifiedCandidateIds,
  NEW_PREFERENCE_WEIGHT,
  parseClassificationDocument,
  type ClassificationItem,
} from "../classifier/contract.js";
import { loadPreferenceLedger } from "../prefs/index.js";
import type { Preference, PreferenceLedger } from "../prefs/types.js";
import {
  computeBatchId,
  computeContentHash,
  computeDecisionHash,
  computeItemOperationId,
  computeSelectionId,
  computeStateHash,
  isCalendarDate,
  isRecord,
  nowTimestamp,
} from "../staging/candidate.js";
import { listCandidates, readStore, transitionCandidate } from "../staging/store.js";
import {
  BATCH_DECISION_SCHEMA,
  BATCH_SCHEMA,
  BATCH_STATE_SCHEMA,
  MAX_BATCH_ITEMS,
  STAGING_SCHEMA_VERSION,
  type BatchDecisionFile,
  type BatchItem,
  type BatchOperationState,
  type BatchOperationStatus,
  type BatchPhase,
  type BatchState,
  type CandidateRow,
  type EvidenceBasis,
  type MemoryWritePayload,
  type PreferenceWritePayload,
  type Proof,
  type ProposalInput,
  type ProposalType,
  type Recommendation,
  type RejectOnlyWritePayload,
  type StagingBatch,
  type WeightWritePayload,
  type WritePayload,
} from "../staging/types.js";
import { newConfirmationToken } from "./presence.js";
import { renderReview, renderStagedSlice, unifiedDiff } from "./render.js";
import {
  DEFAULT_REVIEW_CHARS,
  DEFAULT_STAGED_CHARS,
  MEMORY_DIRECTORY,
  MEMORY_LIFECYCLES,
  MEMORY_NAME_PATTERN,
  MEMORY_NAME_PREFIXES,
  PREFERENCE_SOURCE,
  SIGNAL_VALIDATED,
  SIGNAL_VALIDATED_EVIDENCE,
  SYNC_LOCK_NAME,
  SYNC_PRESENTATION_SCHEMA,
  SYNC_SCHEMA_VERSION,
  SyncGateError,
  type ActiveBatchView,
  type DerivedBatchPhase,
  type PendingReport,
  type PrepareResult,
  type PresentationRecord,
  type ShowResult,
  type StagedCandidateView,
  type StagedSlice,
} from "./types.js";

/**
 * The read half of the gate: what is pending, what is staged, and how a
 * classification becomes an immutable batch waiting for a human.
 *
 * Nothing in this file writes to the preference kernel or to a memory note. It
 * reads destinations to compute preconditions and it writes only inside the
 * staging area. The first byte that reaches a destination is written by
 * apply.ts, after a human has said yes.
 */

const BATCH_ID_PATTERN = /^batch-[0-9a-f]{24}$/u;
const BATCH_FILE_PATTERN = /^batch-[0-9a-f]{24}\.json$/u;

/** Active batches listed at once by `sync pending`, per invariant I11. */
const MAX_PENDING_LISTED = 20;

export interface BatchPaths {
  directory: string;
  batch: string;
  state: string;
  decision: string;
  presentation: string;
  undo: string;
  seal: string;
  undone: string;
}

export function batchesDirectory(root: string, config: VaultConfig): string {
  return join(root, config.paths.memory, "staging", "batches");
}

export function batchPaths(root: string, config: VaultConfig, batchId: string): BatchPaths {
  if (!BATCH_ID_PATTERN.test(batchId)) {
    throw new SyncGateError(
      `${batchId} is not a batch identifier. A batch identifier looks like batch- followed by 24 hexadecimal characters.`,
    );
  }
  const directory = batchesDirectory(root, config);
  return {
    directory,
    batch: join(directory, `${batchId}.json`),
    state: join(directory, `${batchId}.state.json`),
    decision: join(directory, `${batchId}.decision.json`),
    presentation: join(directory, `${batchId}.presented.json`),
    undo: join(directory, `${batchId}.undo.json`),
    seal: join(directory, `${batchId}.undo-seal.json`),
    undone: join(directory, `${batchId}.undone.json`),
  };
}

/** The notes directory, derived from the configured memory root. */
export function notesDirectory(config: VaultConfig): string {
  return toPosixPath(join(config.paths.memory, MEMORY_DIRECTORY));
}

export function withSyncLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withLock(lockPathFor(root, SYNC_LOCK_NAME), fn, { holder: "open-brain sync" });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function readJsonFile(path: string, origin: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyncGateError(
      `${origin} is not valid JSON. It was written by the gate and must never be edited by hand. Nothing was changed.`,
    );
  }
}

/**
 * Writes a file that must never change once written. A second write of the same
 * bytes is a no-op, which is what makes a crashed run safe to replay; a second
 * write of different bytes is refused, which is what makes the batch and the
 * decision impossible to rewrite after the fact.
 */
export async function writeImmutableJson(
  path: string,
  value: unknown,
  label: string,
): Promise<boolean> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const existing = await readTextFile(path);
  if (existing !== undefined) {
    if (existing === content) {
      return false;
    }
    throw new SyncGateError(
      `${label} already exists with different content at ${path}. It is immutable by design: a decision that can be rewritten is not a decision. Read it with \`open-brain sync show\`.`,
    );
  }
  await atomicWriteText(path, content);
  return true;
}

function requiredString(value: unknown, field: string, origin: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncGateError(`${origin}.${field} must be a non-empty string.`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string, origin: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SyncGateError(`${origin}.${field} must be an integer.`);
  }
  return value;
}

function requiredStringArray(value: unknown, field: string, origin: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SyncGateError(`${origin}.${field} must be an array of strings.`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseProofs(value: unknown, origin: string): Proof[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SyncGateError(`${origin}.proofs must be a non-empty array.`);
  }
  return value.map((item, index) => {
    const where = `${origin}.proofs[${String(index)}]`;
    if (!isRecord(item) || !isCalendarDate(item.date) || typeof item.quote !== "string") {
      throw new SyncGateError(`${where} must be {date, quote}.`);
    }
    return { date: item.date, quote: item.quote };
  });
}

function parseWritePayload(value: unknown, origin: string): WritePayload {
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin}.write must be an object.`);
  }
  const precondition = isRecord(value.precondition) ? value.precondition : {};
  switch (value.kind) {
    case "preference": {
      const args = isRecord(value.args) ? value.args : {};
      const payload: PreferenceWritePayload = {
        kind: "preference",
        args: {
          id: requiredString(args.id, "args.id", origin),
          statement: requiredString(args.statement, "args.statement", origin),
          weight: requiredInteger(args.weight, "args.weight", origin),
          domains: requiredStringArray(args.domains, "args.domains", origin),
          why: requiredString(args.why, "args.why", origin),
          apply: requiredString(args.apply, "args.apply", origin),
          source: requiredString(args.source, "args.source", origin),
          quote: requiredString(args.quote, "args.quote", origin),
          date: requiredString(args.date, "args.date", origin),
        },
        precondition: { preference: "absent" },
      };
      if (precondition.preference !== "absent") {
        throw new SyncGateError(`${origin}.write.precondition.preference must be "absent".`);
      }
      return payload;
    }
    case "weight": {
      const args = isRecord(value.args) ? value.args : {};
      if (value.mode !== "bump" && value.mode !== "evidence") {
        throw new SyncGateError(`${origin}.write.mode must be bump or evidence.`);
      }
      const signal = requiredString(args.signal, "args.signal", origin);
      if (signal !== SIGNAL_VALIDATED && signal !== SIGNAL_VALIDATED_EVIDENCE) {
        throw new SyncGateError(`${origin}.write.args.signal is not a gate signal.`);
      }
      const payload: WeightWritePayload = {
        kind: "weight",
        mode: value.mode,
        args: {
          id: requiredString(args.id, "args.id", origin),
          date: requiredString(args.date, "args.date", origin),
          weight: requiredInteger(args.weight, "args.weight", origin),
          signal,
          quote: requiredString(args.quote, "args.quote", origin),
          status: typeof args.status === "string" ? args.status : null,
          regen: args.regen === true,
        },
        content: requiredString(value.content, "write.content", origin),
        precondition: {
          expected_current_weight: requiredInteger(
            precondition.expected_current_weight,
            "write.precondition.expected_current_weight",
            origin,
          ),
        },
      };
      return payload;
    }
    case "memory": {
      const payload: MemoryWritePayload = {
        kind: "memory",
        target: requiredString(value.target, "write.target", origin),
        content: requiredString(value.content, "write.content", origin),
        content_sha256: requiredString(value.content_sha256, "write.content_sha256", origin),
        diff: typeof value.diff === "string" ? value.diff : "",
        precondition: {
          expected_sha256: requiredString(
            precondition.expected_sha256,
            "write.precondition.expected_sha256",
            origin,
          ),
        },
      };
      return payload;
    }
    case "reject_only": {
      const payload: RejectOnlyWritePayload = {
        kind: "reject_only",
        content: requiredString(value.content, "write.content", origin),
        reason: "insufficient_evidence",
        proposal_weight: typeof value.proposal_weight === "number"
          ? value.proposal_weight
          : null,
        precondition: {},
      };
      if (value.reason !== "insufficient_evidence") {
        throw new SyncGateError(`${origin}.write.reason must be insufficient_evidence.`);
      }
      return payload;
    }
    default:
      throw new SyncGateError(
        `${origin}.write.kind ${JSON.stringify(value.kind)} is not a known write kind.`,
      );
  }
}

function parseBatchItem(value: unknown, index: number): BatchItem {
  const origin = `item ${String(index + 1)}`;
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin} must be an object.`);
  }
  const type = value.type;
  if (type !== "preference" && type !== "memory" && type !== "weight") {
    throw new SyncGateError(`${origin}.type is not a proposal type.`);
  }
  const recommendation = value.recommendation;
  if (recommendation !== "approve" && recommendation !== "reject_only") {
    throw new SyncGateError(`${origin}.recommendation is not a recommendation.`);
  }
  const basis = value.evidence_basis;
  if (
    basis !== null
    && basis !== "recurrence"
    && basis !== "documented_pain"
    && basis !== "insufficient"
  ) {
    throw new SyncGateError(`${origin}.evidence_basis is not an evidence basis.`);
  }
  return {
    index: requiredInteger(value.index, "index", origin),
    type: type as ProposalType,
    target: requiredString(value.target, "target", origin),
    merged_ids: requiredStringArray(value.merged_ids, "merged_ids", origin),
    reason: requiredString(value.reason, "reason", origin),
    proofs: parseProofs(value.proofs, origin),
    weak: value.weak === true,
    recommendation: recommendation as Recommendation,
    evidence_basis: basis as EvidenceBasis | null,
    write: parseWritePayload(value.write, origin),
    operation_id: requiredString(value.operation_id, "operation_id", origin),
  };
}

/**
 * Reads a persisted batch and proves it was not touched. The content hash is
 * recomputed from the file itself and compared to both the stored hash and the
 * identifier derived from it, so an edited item, an added item, or a renamed
 * file are all caught before a single precondition is evaluated.
 */
export function parseBatch(value: unknown, origin: string): StagingBatch {
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin} is not a JSON object.`);
  }
  if (value.schema !== BATCH_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${BATCH_SCHEMA} document.`);
  }
  const contentHash = requiredString(value.content_hash, "content_hash", origin);
  const batchId = requiredString(value.batch_id, "batch_id", origin);
  const recomputed = computeContentHash(value);
  if (recomputed !== contentHash) {
    throw new SyncGateError(
      `${origin} does not match its own content hash. The batch was modified after it was written, so it is refused. Nothing was applied.`,
    );
  }
  if (computeBatchId(contentHash) !== batchId) {
    throw new SyncGateError(
      `${origin} carries an identifier that does not derive from its content hash. It is refused.`,
    );
  }
  if (!Array.isArray(value.items)) {
    throw new SyncGateError(`${origin}.items must be an array.`);
  }
  const items = value.items.map((item, index) => parseBatchItem(item, index));
  items.forEach((item, index) => {
    if (item.index !== index + 1) {
      throw new SyncGateError(
        `${origin}.items are not numbered 1 to ${String(items.length)}: item at position ${String(index + 1)} claims index ${String(item.index)}.`,
      );
    }
  });
  return {
    schema: BATCH_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : STAGING_SCHEMA_VERSION,
    candidate_ids: requiredStringArray(value.candidate_ids, "candidate_ids", origin),
    selection_id: requiredString(value.selection_id, "selection_id", origin),
    items,
    batch_id: batchId,
    content_hash: contentHash,
  };
}

function parseOperationState(value: unknown, origin: string): BatchOperationState {
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin} must be an object.`);
  }
  const status = value.status;
  if (
    status !== "pending"
    && status !== "applying"
    && status !== "applied"
    && status !== "apply_failed"
  ) {
    throw new SyncGateError(`${origin}.status is not an operation status.`);
  }
  return {
    status: status as BatchOperationStatus,
    attempts: requiredInteger(value.attempts, "attempts", origin),
    ref: typeof value.ref === "string" ? value.ref : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

export function parseBatchState(value: unknown, origin: string): BatchState {
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin} is not a JSON object.`);
  }
  if (value.schema !== BATCH_STATE_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${BATCH_STATE_SCHEMA} document.`);
  }
  const stateHash = requiredString(value.state_hash, "state_hash", origin);
  if (computeStateHash(value) !== stateHash) {
    throw new SyncGateError(
      `${origin} does not match its own state hash. The apply state was modified outside the gate, so it is refused. Nothing was applied.`,
    );
  }
  const phase = value.phase;
  if (
    phase !== "proposed"
    && phase !== "decided"
    && phase !== "applying"
    && phase !== "apply_failed"
    && phase !== "complete"
  ) {
    throw new SyncGateError(`${origin}.phase is not a batch phase.`);
  }
  const operations: Record<string, BatchOperationState> = {};
  if (!isRecord(value.operations)) {
    throw new SyncGateError(`${origin}.operations must be an object.`);
  }
  for (const [key, operation] of Object.entries(value.operations)) {
    operations[key] = parseOperationState(operation, `${origin}.operations.${key}`);
  }

  let decision: BatchState["decision"] = null;
  if (isRecord(value.decision)) {
    const approved = value.decision.approved_indices;
    const rejected = value.decision.rejected_indices;
    if (!Array.isArray(approved) || !Array.isArray(rejected)) {
      throw new SyncGateError(`${origin}.decision must carry two index arrays.`);
    }
    decision = {
      approved_indices: approved.filter((item): item is number => typeof item === "number"),
      rejected_indices: rejected.filter((item): item is number => typeof item === "number"),
      hash: requiredString(value.decision.hash, "decision.hash", origin),
    };
    if (
      computeDecisionHash(decision.approved_indices, decision.rejected_indices) !== decision.hash
    ) {
      throw new SyncGateError(
        `${origin}.decision does not match its own hash. The recorded human decision was modified, so it is refused.`,
      );
    }
  }

  return {
    schema: BATCH_STATE_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : STAGING_SCHEMA_VERSION,
    batch_id: requiredString(value.batch_id, "batch_id", origin),
    phase: phase as BatchPhase,
    decision,
    operations,
    scan_done: value.scan_done === true,
    compacted: value.compacted === true,
    state_hash: stateHash,
  };
}

export function parseBatchDecision(value: unknown, origin: string): BatchDecisionFile {
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin} is not a JSON object.`);
  }
  if (value.schema !== BATCH_DECISION_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${BATCH_DECISION_SCHEMA} document.`);
  }
  if (!isRecord(value.decision)) {
    throw new SyncGateError(`${origin}.decision must be an object.`);
  }
  const approved = value.decision.approved_indices;
  const rejected = value.decision.rejected_indices;
  if (!Array.isArray(approved) || !Array.isArray(rejected)) {
    throw new SyncGateError(`${origin}.decision must carry two index arrays.`);
  }
  const approvedIndices = approved.filter((item): item is number => typeof item === "number");
  const rejectedIndices = rejected.filter((item): item is number => typeof item === "number");
  const hash = requiredString(value.decision.hash, "decision.hash", origin);
  if (computeDecisionHash(approvedIndices, rejectedIndices) !== hash) {
    throw new SyncGateError(
      `${origin} does not match its own decision hash. The frozen human decision was modified, so it is refused.`,
    );
  }
  return {
    schema: BATCH_DECISION_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : STAGING_SCHEMA_VERSION,
    batch_id: requiredString(value.batch_id, "batch_id", origin),
    decision: {
      approved_indices: approvedIndices,
      rejected_indices: rejectedIndices,
      hash,
    },
  };
}

export async function loadBatch(
  root: string,
  config: VaultConfig,
  batchId: string,
): Promise<StagingBatch> {
  const paths = batchPaths(root, config, batchId);
  const value = await readJsonFile(paths.batch, `${batchId}.json`);
  if (value === undefined) {
    throw new SyncGateError(
      `Unknown batch ${batchId}. List what is active with \`open-brain sync pending\`.`,
    );
  }
  return parseBatch(value, `${batchId}.json`);
}

export async function loadBatchState(
  root: string,
  config: VaultConfig,
  batchId: string,
): Promise<BatchState | undefined> {
  const paths = batchPaths(root, config, batchId);
  const value = await readJsonFile(paths.state, `${batchId}.state.json`);
  return value === undefined ? undefined : parseBatchState(value, `${batchId}.state.json`);
}

export async function loadBatchDecision(
  root: string,
  config: VaultConfig,
  batchId: string,
): Promise<BatchDecisionFile | undefined> {
  const paths = batchPaths(root, config, batchId);
  const value = await readJsonFile(paths.decision, `${batchId}.decision.json`);
  return value === undefined ? undefined : parseBatchDecision(value, `${batchId}.decision.json`);
}

function parsePresentation(value: unknown, origin: string): PresentationRecord {
  if (!isRecord(value) || value.schema !== SYNC_PRESENTATION_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${SYNC_PRESENTATION_SCHEMA} document.`);
  }
  return {
    schema: SYNC_PRESENTATION_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : SYNC_SCHEMA_VERSION,
    batch_id: requiredString(value.batch_id, "batch_id", origin),
    presented_at: requiredString(value.presented_at, "presented_at", origin),
    token: requiredString(value.token, "token", origin),
  };
}

/** The proof that this batch was put in front of somebody, if it ever was. */
export async function loadPresentation(
  root: string,
  config: VaultConfig,
  batchId: string,
): Promise<PresentationRecord | undefined> {
  const paths = batchPaths(root, config, batchId);
  const value = await readJsonFile(paths.presentation, `${batchId}.presented.json`);
  return value === undefined ? undefined : parsePresentation(value, `${batchId}.presented.json`);
}

/**
 * Records that a batch was presented, and hands out the token that proves it.
 *
 * The record is written once and reused afterwards, so showing the same batch
 * twice prints the same token: a token that changed under the reader would only
 * teach people to run the command again until it works. The file is re-read
 * after the write so two concurrent presentations converge on the token that
 * actually reached the disk rather than on the one each of them drew.
 */
async function recordPresentation(
  root: string,
  config: VaultConfig,
  batchId: string,
): Promise<PresentationRecord> {
  const existing = await loadPresentation(root, config, batchId);
  if (existing) {
    return existing;
  }
  const paths = batchPaths(root, config, batchId);
  const record: PresentationRecord = {
    schema: SYNC_PRESENTATION_SCHEMA,
    schema_version: SYNC_SCHEMA_VERSION,
    batch_id: batchId,
    presented_at: nowTimestamp(),
    token: newConfirmationToken(),
  };
  await atomicWriteText(paths.presentation, `${JSON.stringify(record, null, 2)}\n`);
  return await loadPresentation(root, config, batchId) ?? record;
}

export function sealState(state: BatchState): BatchState {
  const withoutHash = {
    schema: state.schema,
    schema_version: state.schema_version,
    batch_id: state.batch_id,
    phase: state.phase,
    decision: state.decision,
    operations: state.operations,
    scan_done: state.scan_done,
    compacted: state.compacted,
  };
  return { ...withoutHash, state_hash: computeStateHash(withoutHash) };
}

export async function saveBatchState(
  root: string,
  config: VaultConfig,
  state: BatchState,
): Promise<BatchState> {
  const sealed = sealState(state);
  const paths = batchPaths(root, config, sealed.batch_id);
  await atomicWriteText(paths.state, `${JSON.stringify(sealed, null, 2)}\n`);
  return sealed;
}

export function initialBatchState(batch: StagingBatch): BatchState {
  const operations: Record<string, BatchOperationState> = {};
  for (const item of batch.items) {
    operations[item.operation_id] = { status: "pending", attempts: 0, ref: null, error: null };
  }
  return sealState({
    schema: BATCH_STATE_SCHEMA,
    schema_version: STAGING_SCHEMA_VERSION,
    batch_id: batch.batch_id,
    phase: "proposed",
    decision: null,
    operations,
    scan_done: false,
    compacted: false,
    state_hash: "",
  });
}

/**
 * The phase a human actually needs, including the two that exist only because a
 * crash can land between two writes. Deriving it every time is deliberate: a
 * stored phase that disagrees with the files on disk would send a resume down
 * the wrong path.
 */
export function derivePhase(
  state: BatchState | undefined,
  decision: BatchDecisionFile | undefined,
): DerivedBatchPhase {
  if (!state) {
    return "needs_resume";
  }
  if (decision && (state.decision === null || state.phase === "proposed")) {
    return "decision_needs_resume";
  }
  if (state.phase === "complete" && !state.compacted) {
    return "complete_needs_compact";
  }
  return state.phase;
}

function nextForPhase(batchId: string, phase: DerivedBatchPhase, undone: boolean): string {
  if (undone) {
    return `This batch was applied and then undone. Nothing more to do. Inspect it with \`open-brain sync show --batch ${batchId}\`.`;
  }
  switch (phase) {
    case "proposed":
      return `Present it with \`open-brain sync show --batch ${batchId}\`, then decide with \`open-brain sync validate --batch ${batchId} --approve "<indices or empty>" --confirm <the token sync show prints>\`.`;
    case "needs_resume":
    case "decision_needs_resume":
    case "decided":
    case "applying":
    case "apply_failed":
    case "complete_needs_compact":
      return `Resume it with \`open-brain sync resume --batch ${batchId}\`. The classifier is never run again for a batch that already exists.`;
    case "complete":
      return `Nothing left to do. Reverse it with \`open-brain sync undo ${batchId}\` if it should not have been applied.`;
  }
}

async function listBatchIds(root: string, config: VaultConfig): Promise<string[]> {
  const directory = batchesDirectory(root, config);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && BATCH_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name.replace(/\.json$/u, ""))
      .sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function countOperations(state: BatchState | undefined, status: BatchOperationStatus): number {
  if (!state) {
    return 0;
  }
  return Object.values(state.operations).filter((operation) => operation.status === status).length;
}

/**
 * The token gate of the whole protocol: is there already an active batch?
 *
 * This runs before anything else and it is the reason a classifier is never
 * invoked twice for the same slice. A batch that exists is resumed, never
 * reclassified: reclassifying would produce a second batch for candidates that
 * are already committed to the first one.
 */
export async function syncPending(root: string, config: VaultConfig): Promise<PendingReport> {
  const ids = await listBatchIds(root, config);
  const active: ActiveBatchView[] = [];
  let completed = 0;

  for (const batchId of ids) {
    const state = await loadBatchState(root, config, batchId);
    const decision = await loadBatchDecision(root, config, batchId);
    const phase = derivePhase(state, decision);

    // A settled batch is counted without being read: verifying the content hash
    // of every batch ever applied would make this command slower every month,
    // and nothing here depends on their items.
    if (phase === "complete" && (state?.compacted ?? false)) {
      completed += 1;
      continue;
    }

    const batch = await loadBatch(root, config, batchId);
    const paths = batchPaths(root, config, batchId);
    const undone = (await readTextFile(paths.undone)) !== undefined;
    const undoable = (await readTextFile(paths.seal)) !== undefined && !undone;

    active.push({
      batch_id: batchId,
      phase,
      stored_phase: state?.phase ?? null,
      items: batch.items.length,
      approved: state?.decision?.approved_indices.length ?? null,
      rejected: state?.decision?.rejected_indices.length ?? null,
      applied_operations: countOperations(state, "applied"),
      pending_operations: countOperations(state, "pending"),
      failed_operations: countOperations(state, "apply_failed"),
      compacted: state?.compacted ?? false,
      scan_done: state?.scan_done ?? false,
      undoable,
      undone,
      next: nextForPhase(batchId, phase, undone),
    });
  }

  const rows = await listCandidates(root, config, {});
  const staged = rows.filter((row) => row.status === "staged").length;
  const pending = rows.filter(
    (row) => row.status === "staged" || row.status === "proposed",
  ).length;

  const shown = active.slice(0, MAX_PENDING_LISTED);
  const truncated = shown.length < active.length;
  const text = shown.map((view) => `${view.batch_id} ${view.phase}`).join("\n");

  const next = active.length > 0
    ? `${String(active.length)} batch(es) still need you. Resume or present them before classifying anything new: a batch that exists is never reclassified.`
    : staged > 0
      ? `${String(staged)} candidate(s) are staged. Take the next slice with \`open-brain sync staged\`.`
      : "Nothing staged to review.";

  return {
    schema_version: SYNC_SCHEMA_VERSION,
    active_batches: shown,
    completed_batches: completed,
    pending_candidates: pending,
    staged_candidates: staged,
    budget: {
      chars: text.length,
      token_estimate: Math.max(0, Math.floor(text.length / 4)),
      items_shown: shown.length,
      items_total: active.length,
      truncated,
    },
    next,
  };
}

function stagedView(row: CandidateRow): StagedCandidateView {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source,
    signal: row.signal,
    harness: row.harness,
    session_id: row.session_id,
    raw_markers: [...row.raw_markers],
    context: row.context,
    raw_quote: row.raw_quote,
  };
}

export interface StagedOptions {
  maxChars?: number;
  limit?: number;
}

/**
 * The deterministic slice. Sorted by identifier and capped, so two callers
 * looking at the same store always commit to the same candidates, and the
 * selection identifier freezes that commitment: a deposit that lands while the
 * classifier is thinking joins the next slice instead of invalidating this one.
 */
export async function syncStaged(
  root: string,
  config: VaultConfig,
  options: StagedOptions = {},
): Promise<StagedSlice> {
  const limit = Math.min(options.limit ?? MAX_BATCH_ITEMS, MAX_BATCH_ITEMS);
  const rows = (await listCandidates(root, config, { status: "staged" }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const capped = rows.slice(0, limit);
  const presentation = renderStagedSlice(
    capped.map((row) => stagedView(row)),
    options.maxChars ?? DEFAULT_STAGED_CHARS,
  );

  // The slice is trimmed to what actually fits, not just its presentation. A
  // caller told to classify a slice must receive that slice whole: handing over
  // ten candidates while claiming a commitment to two hundred is how a batch
  // ends up covering candidates nobody ever read.
  const slice = capped.slice(0, Math.max(0, presentation.shown));
  const views = slice.map((row) => stagedView(row));
  const candidateIds = slice.map((row) => row.id);
  const remaining = rows.length - slice.length;

  return {
    schema_version: SYNC_SCHEMA_VERSION,
    count: slice.length,
    remaining_count: remaining,
    selection_id: computeSelectionId(candidateIds),
    candidate_ids: candidateIds,
    staged: views,
    budget: {
      ...presentation.budget,
      items_shown: slice.length,
      items_total: rows.length,
      truncated: remaining > 0,
    },
    next: slice.length === 0
      ? "Nothing staged to review."
      : `Classify exactly these ${String(slice.length)} candidate(s), then run \`open-brain sync prepare --input <file> --selection <selection_id>\`. ${remaining > 0 ? `${String(remaining)} more candidate(s) wait for the next slice. ` : ""}Nothing is written until you approve it.`,
  };
}

function latestProof(proofs: readonly Proof[]): Proof {
  let latest = proofs[0];
  if (!latest) {
    throw new SyncGateError("A proposal reached the gate with no proof at all.");
  }
  for (const proof of proofs) {
    if (proof.date >= latest.date) {
      latest = proof;
    }
  }
  return latest;
}

function distinctDates(proofs: readonly Proof[]): number {
  return new Set(proofs.map((proof) => proof.date)).size;
}

/**
 * The evidence threshold, enforced here on the gate side.
 *
 * The store enforces the same contract on the staged to proposed transition.
 * Both copies exist on purpose: dropping this one would let a malformed
 * classification through the gate until the store caught it halfway into a
 * batch, and dropping the store one would let a direct call bypass the human
 * review entirely. Amendment 10.12 of the architecture: they both ship.
 */
export function assertEvidenceThreshold(
  item: ClassificationItem,
  candidates: readonly CandidateRow[],
): void {
  if (item.recommendation !== "approve") {
    if (item.evidence_basis !== "insufficient") {
      throw new SyncGateError(
        `Item ${String(item.merged_ids.join(", "))} is reject_only and must declare an insufficient evidence basis.`,
      );
    }
    return;
  }

  const weak = candidates.find((row) => row.signal === "praise_weak");
  if (weak) {
    throw new SyncGateError(
      `Candidate ${weak.id} carries a praise_weak signal, which can never be approved. Merging it with stronger candidates does not launder it. Propose it as reject_only.`,
    );
  }

  const passive = candidates.find((row) => row.signal !== "explicit_request");
  if (passive && distinctDates(item.proofs) < 2) {
    throw new SyncGateError(
      `Candidate ${passive.id} carries a passive ${passive.signal} signal, so approving it needs recurrence: proofs on at least two distinct dates. This item has ${String(distinctDates(item.proofs))}.`,
    );
  }

  if (passive && item.evidence_basis !== "recurrence" && item.evidence_basis !== "documented_pain") {
    throw new SyncGateError(
      `Approving a passive ${passive.signal} signal needs an evidence basis of recurrence or documented_pain, not ${String(item.evidence_basis)}.`,
    );
  }

  if (
    item.type === "weight"
    && item.evidence_basis !== "recurrence"
    && item.evidence_basis !== "documented_pain"
  ) {
    throw new SyncGateError(
      "A weight change always needs an evidence basis of recurrence or documented_pain, whatever the signal that produced it.",
    );
  }
}

function findPreference(ledger: PreferenceLedger, id: string): Preference | undefined {
  return ledger.preferences.find((preference) => preference.id === id);
}

function buildPreferenceWrite(
  item: ClassificationItem,
  ledger: PreferenceLedger,
): PreferenceWritePayload {
  if (findPreference(ledger, item.target)) {
    throw new SyncGateError(
      `Preference ${item.target} already exists. A new preference cannot be created over it: propose a weight change instead.`,
    );
  }
  const proof = latestProof(item.proofs);
  const domains = item.domains ?? [];
  if (domains.length === 0) {
    throw new SyncGateError(`Preference ${item.target} must declare at least one domain.`);
  }
  return {
    kind: "preference",
    args: {
      id: item.target,
      statement: item.content,
      weight: NEW_PREFERENCE_WEIGHT,
      domains,
      why: item.why ?? item.reason,
      apply: item.apply ?? item.content,
      source: PREFERENCE_SOURCE,
      quote: proof.quote,
      date: proof.date,
    },
    precondition: { preference: "absent" },
  };
}

function buildWeightWrite(
  item: ClassificationItem,
  ledger: PreferenceLedger,
): WeightWritePayload {
  const preference = findPreference(ledger, item.target);
  if (!preference) {
    throw new SyncGateError(
      `Preference ${item.target} does not exist, so its weight cannot change. Propose it as a new preference instead.`,
    );
  }
  const current = preference.weight;
  const proposed = item.proposed_weight;
  if (proposed === null) {
    throw new SyncGateError(`Weight item on ${item.target} carries no proposed weight.`);
  }
  const bump = current < 5 && proposed === current + 1;
  const evidence = current === 5 && proposed === 5;
  if (!bump && !evidence) {
    throw new SyncGateError(
      `Weight item on ${item.target} proposes ${String(proposed)} while the preference weighs ${String(current)}. A weight moves one step at a time, and at 5 the only move left is to record evidence.`,
    );
  }
  const proof = latestProof(item.proofs);
  return {
    kind: "weight",
    mode: bump ? "bump" : "evidence",
    args: {
      id: item.target,
      date: proof.date,
      weight: proposed,
      signal: bump ? SIGNAL_VALIDATED : SIGNAL_VALIDATED_EVIDENCE,
      quote: proof.quote,
      status: null,
      regen: true,
    },
    content: item.content,
    precondition: { expected_current_weight: current },
  };
}

/**
 * Resolves a memory target the hard way. A note lands directly under the notes
 * directory, with no traversal, no symlink anywhere on the path, and no
 * existing entry that is not a regular file. Every one of those checks exists
 * because the alternative is a classified string deciding which file on the
 * machine gets overwritten.
 */
export async function resolveMemoryTarget(
  root: string,
  config: VaultConfig,
  target: string,
): Promise<{ relativePath: string; absolutePath: string }> {
  const relative = toPosixPath(target);
  if (isAbsolute(target) || relative.includes("\\")) {
    throw new SyncGateError(
      `Memory target ${target} must be a vault-relative posix path under ${notesDirectory(config)}/.`,
    );
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SyncGateError(
      `Memory target ${target} contains a path segment that is empty or a traversal. It is refused.`,
    );
  }
  const notes = notesDirectory(config);
  const expectedPrefix = `${notes}/`;
  if (!relative.startsWith(expectedPrefix)) {
    throw new SyncGateError(
      `Memory target ${target} must live directly under ${notes}/.`,
    );
  }
  const name = relative.slice(expectedPrefix.length);
  if (name.includes("/")) {
    throw new SyncGateError(
      `Memory target ${target} must be a file directly under ${notes}/, not in a subdirectory.`,
    );
  }
  if (!MEMORY_NAME_PATTERN.test(name)) {
    throw new SyncGateError(
      `Memory note ${name} must be a lowercase snake_case .md filename.`,
    );
  }
  if (!MEMORY_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new SyncGateError(
      `Memory note ${name} must start with one of ${MEMORY_NAME_PREFIXES.join(", ")} so its kind is readable before it is opened.`,
    );
  }

  const absolutePath = join(root, relative);
  let current = resolve(root);
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new SyncGateError(
        `${toPosixPath(current)} is a symbolic link. The gate never follows a link on the way to a memory note.`,
      );
    }
    if (current === absolutePath && !info.isFile()) {
      throw new SyncGateError(
        `${relative} exists and is not a regular file. It is refused before it is opened.`,
      );
    }
  }

  return { relativePath: relative, absolutePath };
}

function assertMemoryContent(content: string, relativePath: string): void {
  if (!content.startsWith("---\n")) {
    throw new SyncGateError(
      `${relativePath} must open with a front matter block delimited by ---.`,
    );
  }
  if (!content.endsWith("\n")) {
    throw new SyncGateError(`${relativePath} must end with a newline.`);
  }
  const closing = content.indexOf("\n---\n", 3);
  if (closing === -1) {
    throw new SyncGateError(`${relativePath} has a front matter block that is never closed.`);
  }
  const frontMatter = content.slice(4, closing + 1);
  const lifecycles = frontMatter
    .split("\n")
    .filter((line) => /^lifecycle:\s*\S+\s*$/u.test(line));
  if (lifecycles.length !== 1) {
    throw new SyncGateError(
      `${relativePath} must declare exactly one lifecycle line in its front matter, found ${String(lifecycles.length)}.`,
    );
  }
  const declared = (lifecycles[0] ?? "").split(":")[1]?.trim() ?? "";
  if (!MEMORY_LIFECYCLES.includes(declared)) {
    throw new SyncGateError(
      `${relativePath} declares lifecycle ${JSON.stringify(declared)}, which is not one of ${MEMORY_LIFECYCLES.join(", ")}.`,
    );
  }
}

async function buildMemoryWrite(
  root: string,
  config: VaultConfig,
  item: ClassificationItem,
): Promise<MemoryWritePayload> {
  const resolved = await resolveMemoryTarget(root, config, item.target);
  assertMemoryContent(item.content, resolved.relativePath);
  const existing = await readTextFile(resolved.absolutePath);
  if (existing === item.content) {
    throw new SyncGateError(
      `${resolved.relativePath} would be written with the content it already has. A no-op is not a proposal, so the item is refused rather than shown to you as a change.`,
    );
  }
  return {
    kind: "memory",
    target: resolved.relativePath,
    content: item.content,
    content_sha256: sha256(item.content),
    diff: unifiedDiff(existing ?? "", item.content, resolved.relativePath),
    precondition: {
      expected_sha256: existing === undefined ? "absent" : sha256(existing),
    },
  };
}

function buildRejectOnlyWrite(item: ClassificationItem): RejectOnlyWritePayload {
  return {
    kind: "reject_only",
    content: item.content,
    reason: "insufficient_evidence",
    proposal_weight: item.proposed_weight,
    precondition: {},
  };
}

async function buildWrite(
  root: string,
  config: VaultConfig,
  item: ClassificationItem,
  ledger: PreferenceLedger | undefined,
): Promise<WritePayload> {
  if (item.recommendation === "reject_only") {
    return buildRejectOnlyWrite(item);
  }
  if (item.type === "memory") {
    return buildMemoryWrite(root, config, item);
  }
  if (!ledger) {
    throw new SyncGateError(
      "This batch touches the preference ledger, but no ledger exists in this vault yet. Run `open-brain init` or `open-brain prefs add` first.",
    );
  }
  return item.type === "preference"
    ? buildPreferenceWrite(item, ledger)
    : buildWeightWrite(item, ledger);
}

/** Round trip through JSON so a typed payload becomes plain persisted data. */
function toRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(parsed)) {
    throw new SyncGateError(`${label} did not serialize to a JSON object.`);
  }
  return parsed;
}

export interface BuildBatchInput {
  items: readonly ClassificationItem[];
  candidateIds: readonly string[];
  selectionId: string;
}

/**
 * Assembles the immutable batch. Every operation identifier is derived from the
 * item it applies, and the batch identifier from the whole document, so a
 * replay of the same classification produces the same identifiers and lands on
 * the same batch instead of creating a second one.
 */
export async function buildBatch(
  root: string,
  config: VaultConfig,
  input: BuildBatchInput,
  ledger: PreferenceLedger | undefined,
): Promise<StagingBatch> {
  const items: BatchItem[] = [];
  for (let position = 0; position < input.items.length; position += 1) {
    const item = input.items[position];
    if (!item) {
      continue;
    }
    const index = position + 1;
    const write = await buildWrite(root, config, item, ledger);
    const partial = {
      index,
      type: item.type,
      target: item.target,
      merged_ids: [...item.merged_ids],
      reason: item.reason,
      proofs: item.proofs.map((proof) => ({ ...proof })),
      weak: item.weak,
      recommendation: item.recommendation,
      evidence_basis: item.evidence_basis,
      write: toRecord(write, `item ${String(index)} write payload`),
    };
    items.push({ ...partial, write, operation_id: computeItemOperationId(index, partial) });
  }

  const draft = {
    schema: BATCH_SCHEMA,
    schema_version: STAGING_SCHEMA_VERSION,
    candidate_ids: [...input.candidateIds].sort(),
    selection_id: input.selectionId,
    items: items.map((item) => ({ ...item, write: toRecord(item.write, "write payload") })),
  };
  const contentHash = computeContentHash(draft);
  return {
    schema: BATCH_SCHEMA,
    schema_version: STAGING_SCHEMA_VERSION,
    candidate_ids: draft.candidate_ids,
    selection_id: input.selectionId,
    items,
    batch_id: computeBatchId(contentHash),
    content_hash: contentHash,
  };
}

function proposalFor(item: BatchItem, classified: ClassificationItem): ProposalInput {
  return {
    type: item.type,
    target: item.target,
    content: classified.content,
    proposed_weight: classified.proposed_weight,
    reason: item.reason,
    proofs: item.proofs.map((proof) => ({ ...proof })),
    weak: item.weak,
    recommendation: item.recommendation,
    evidence_basis: item.evidence_basis,
    gate_item_index: item.index,
    gate_write_payload: toRecord(item.write, `item ${String(item.index)} write payload`),
  };
}

/** Deterministic identifier of one staged to proposed move inside a batch. */
export function proposeOperationId(batchId: string, candidateId: string): string {
  return `${batchId}:propose:${candidateId}`;
}

export interface PrepareInput {
  items: readonly ClassificationItem[];
  selectionId?: string | undefined;
  maxChars?: number | undefined;
}

/**
 * Finds the slice a selection identifier names.
 *
 * A slice is always a prefix of the staged candidates sorted by identifier, so
 * a bounded classification that only received the first ten of two hundred is
 * still a legitimate, exhaustive commitment to those ten. Without a selection
 * identifier the slice is the whole capped set, which is what an unbounded
 * caller means.
 */
function resolveSlice(
  stagedRows: readonly CandidateRow[],
  selectionId: string | undefined,
): CandidateRow[] {
  const capped = stagedRows.slice(0, MAX_BATCH_ITEMS);
  if (selectionId === undefined) {
    return capped;
  }
  for (let length = capped.length; length >= 1; length -= 1) {
    const prefix = capped.slice(0, length);
    if (computeSelectionId(prefix.map((row) => row.id)) === selectionId) {
      return prefix;
    }
  }
  return [];
}

/**
 * Turns a classification into a persisted batch waiting for a human.
 *
 * Everything that can refuse runs before the first write: coverage of the
 * slice, the evidence threshold, the destinations, the preconditions. The batch
 * file is written immutably, then the initial state, then the candidates move
 * from staged to proposed. Every one of those steps is a resume point, and each
 * is idempotent, so a crash anywhere is repaired by running prepare or resume
 * again with the same input.
 */
export async function prepareBatch(
  root: string,
  config: VaultConfig,
  input: PrepareInput,
): Promise<PrepareResult> {
  return withSyncLock(root, async () => {
    const snapshot = await readStore(root, config);
    const active = snapshot.active;
    const byId = new Map(snapshot.all.map((row) => [row.id, row]));

    const stagedRows = active
      .filter((row) => row.status === "staged")
      .sort((left, right) => left.id.localeCompare(right.id));
    const classifiedIds = classifiedCandidateIds(input.items);
    const slice = resolveSlice(stagedRows, input.selectionId);

    if (slice.length === 0 && classifiedIds.length === 0) {
      throw new SyncGateError("Nothing staged to review.");
    }

    if (slice.length > 0) {
      assertCoversSlice(input.items, slice.map((row) => row.id));
    } else {
      // Replay path: the batch was already written and the candidates already
      // moved. Re-running prepare with the same file must land on the same
      // batch rather than refuse, which is what makes a crash recoverable.
      for (const id of classifiedIds) {
        const row = byId.get(id);
        if (!row) {
          throw new SyncGateError(`Unknown candidate ${id}. Nothing was prepared.`);
        }
        if (row.status === "staged") {
          throw new SyncGateError(
            `Selection ${String(input.selectionId)} no longer names a slice of the staged store: candidate ${id} is still staged but the slice it belonged to has changed. Run \`open-brain sync staged\` again and reclassify that slice. Nothing was prepared.`,
          );
        }
        if (row.status !== "proposed") {
          throw new SyncGateError(
            `Candidate ${id} is ${row.status}, so it is not available for a new batch. Nothing was prepared. Run \`open-brain sync pending\` to see what is active.`,
          );
        }
      }
    }

    const candidateIds = slice.length > 0 ? slice.map((row) => row.id) : classifiedIds;
    const selectionId = computeSelectionId(candidateIds);
    if (input.selectionId !== undefined && input.selectionId !== selectionId) {
      throw new SyncGateError(
        `The staged slice moved since it was handed to the classifier: expected selection ${input.selectionId}, the store now offers ${selectionId}. Run \`open-brain sync staged\` again and reclassify that slice.`,
      );
    }

    for (const item of input.items) {
      const rows = item.merged_ids.map((id) => {
        const row = byId.get(id);
        if (!row) {
          throw new SyncGateError(`Unknown candidate ${id}. Nothing was prepared.`);
        }
        return row;
      });
      assertEvidenceThreshold(item, rows);
    }

    let ledger: PreferenceLedger | undefined;
    try {
      ledger = await loadPreferenceLedger(root);
    } catch {
      ledger = undefined;
    }

    const batch = await buildBatch(
      root,
      config,
      { items: input.items, candidateIds, selectionId },
      ledger,
    );

    // Only one batch may be waiting for a decision at a time. A second one
    // would put the same reviewer in front of two competing truths about the
    // same destinations.
    const otherProposed = active.find(
      (row) => row.status === "proposed" && row.batch_id !== null && row.batch_id !== batch.batch_id,
    );
    if (otherProposed) {
      throw new SyncGateError(
        `Batch ${String(otherProposed.batch_id)} is already waiting for your decision. Present or resume it before preparing another one: \`open-brain sync show --batch ${String(otherProposed.batch_id)}\`.`,
      );
    }

    const paths = batchPaths(root, config, batch.batch_id);
    const created = await writeImmutableJson(paths.batch, batch, "This batch");

    const existingState = await loadBatchState(root, config, batch.batch_id);
    if (!existingState) {
      await saveBatchState(root, config, initialBatchState(batch));
    }

    let proposed = 0;
    for (const item of batch.items) {
      const classified = input.items[item.index - 1];
      if (!classified) {
        continue;
      }
      for (const candidateId of item.merged_ids) {
        const row = byId.get(candidateId);
        if (row && row.status === "proposed" && row.batch_id !== batch.batch_id) {
          throw new SyncGateError(
            `Candidate ${candidateId} is already proposed under batch ${String(row.batch_id)}. Nothing was changed.`,
          );
        }
        const outcome = await transitionCandidate(root, config, {
          id: candidateId,
          status: "proposed",
          batchId: batch.batch_id,
          operationId: proposeOperationId(batch.batch_id, candidateId),
          proposal: proposalFor(item, classified),
        });
        if (outcome.changed) {
          proposed += 1;
        }
      }
    }

    const rejectOnly = batch.items
      .filter((item) => item.recommendation === "reject_only")
      .map((item) => item.index);
    const approvable = batch.items
      .filter((item) => item.recommendation !== "reject_only")
      .map((item) => item.index);
    const presentation = renderReview(batch.items, {
      maxChars: input.maxChars ?? DEFAULT_REVIEW_CHARS,
      command: `open-brain sync show --batch ${batch.batch_id}`,
    });

    return {
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: batch.batch_id,
      selection_id: selectionId,
      items: batch.items.length,
      created,
      proposed,
      reject_only_indices: rejectOnly,
      approvable_indices: approvable,
      budget: presentation.budget,
      next: `Present the batch with \`open-brain sync show --batch ${batch.batch_id}\`, then record your decision with \`open-brain sync validate --batch ${batch.batch_id} --approve "<indices you approve, or an empty string to reject everything>" --confirm <the token sync show prints>\`. Nothing is written before that command runs, and the gate refuses that command unless something proves a human is behind it.`,
    };
  });
}

/** Reads a classification file and prepares a batch from it. */
export async function prepareBatchFromFile(
  root: string,
  config: VaultConfig,
  inputPath: string,
  options: { selectionId?: string | undefined; maxChars?: number | undefined } = {},
): Promise<PrepareResult> {
  const text = await readTextFile(inputPath);
  if (text === undefined) {
    throw new SyncGateError(
      `No classification file at ${inputPath}. The classifier writes it with the host's write tool, never with a shell echo.`,
    );
  }
  return prepareBatch(root, config, {
    items: parseClassificationDocument(text),
    selectionId: options.selectionId,
    maxChars: options.maxChars,
  });
}

export interface ShowOptions {
  maxChars?: number | undefined;
  from?: number | undefined;
}

/**
 * Presents a batch, and is the only place the confirmation token is ever
 * printed. Showing is therefore no longer free of consequence: it is the step
 * that records a human was given the chance to read this batch, which is what
 * `sync validate` later demands proof of.
 */
export async function showBatch(
  root: string,
  config: VaultConfig,
  batchId: string,
  options: ShowOptions = {},
): Promise<ShowResult> {
  const batch = await loadBatch(root, config, batchId);
  const state = await loadBatchState(root, config, batchId);
  const decision = await loadBatchDecision(root, config, batchId);
  const phase = derivePhase(state, decision);
  const presentation = renderReview(batch.items, {
    maxChars: options.maxChars ?? DEFAULT_REVIEW_CHARS,
    from: options.from ?? 0,
    command: `open-brain sync show --batch ${batchId}`,
  });
  const recorded = decision?.decision ?? state?.decision ?? null;
  const presented = await recordPresentation(root, config, batchId);
  const decide = `Decide with \`open-brain sync validate --batch ${batchId} --approve "<indices you approve, or an empty string to reject everything>" --confirm ${presented.token}\`. The token is printed here and nowhere else: retyping it is how the gate knows somebody read this batch.`;

  return {
    schema_version: SYNC_SCHEMA_VERSION,
    batch_id: batchId,
    phase,
    items: batch.items.length,
    reject_only_indices: batch.items
      .filter((item) => item.recommendation === "reject_only")
      .map((item) => item.index),
    approvable_indices: batch.items
      .filter((item) => item.recommendation !== "reject_only")
      .map((item) => item.index),
    decision: recorded === null
      ? null
      : {
        approved_indices: [...recorded.approved_indices],
        rejected_indices: [...recorded.rejected_indices],
      },
    presentation: presentation.text,
    confirmation_token: presented.token,
    budget: presentation.budget,
    next: phase === "proposed"
      ? `${presentation.next === undefined ? "" : `${presentation.next} `}${decide}`
      : presentation.next ?? nextForPhase(
        batchId,
        phase,
        (await readTextFile(batchPaths(root, config, batchId).undone)) !== undefined,
      ),
  };
}
