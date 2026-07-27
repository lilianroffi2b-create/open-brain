import { ExpectedError } from "../core/errors.js";

/**
 * The shapes of the staging area, which is the only place in the vault where
 * writing is free. Candidates land here without validation and nothing leaves
 * without an explicit human decision, so every artifact below is versioned and
 * read back tolerantly.
 */

export const STAGING_SCHEMA_VERSION = 1;

export const CANDIDATE_SCHEMA = "open-brain/staging-candidate/v1";
export const BATCH_SCHEMA = "open-brain/sync-batch/v1";
export const BATCH_STATE_SCHEMA = "open-brain/sync-state/v1";
export const BATCH_DECISION_SCHEMA = "open-brain/sync-decision/v1";

export const RAW_QUOTE_CAP = 500;
export const CONTEXT_CAP = 280;
export const REASON_CAP = 5_000;
export const QUOTE_CAP = 5_000;
export const TARGET_CAP = 240;
export const CONTENT_CAP = 100_000;
export const APPLY_ERROR_CAP = 1_000;
export const MAX_BATCH_ITEMS = 200;
export const MAX_RAW_MARKERS = 32;

export type CandidateStatus =
  | "staged"
  | "proposed"
  | "approved"
  | "rejected"
  | "applying"
  | "applied"
  | "apply_failed";

export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  "staged",
  "proposed",
  "approved",
  "rejected",
  "applying",
  "applied",
  "apply_failed",
];

/** Statuses that still owe the human something, used by every pending count. */
export const PENDING_STATUSES: readonly CandidateStatus[] = ["staged", "proposed"];

/** Statuses that can never move again, and therefore the only archivable ones. */
export const TERMINAL_STATUSES: readonly CandidateStatus[] = ["applied", "rejected"];

/** Statuses a session can resume: everything that is neither terminal nor absent. */
export const RESUMABLE_STATUSES: readonly CandidateStatus[] = [
  "staged",
  "proposed",
  "approved",
  "applying",
  "apply_failed",
];

export const ALLOWED_TRANSITIONS: Readonly<
  Record<CandidateStatus, readonly CandidateStatus[]>
> = {
  staged: ["proposed"],
  proposed: ["approved", "rejected"],
  approved: ["applying"],
  applying: ["applied", "apply_failed"],
  apply_failed: ["approved", "applying", "rejected"],
  applied: [],
  rejected: [],
};

export type CandidateSource = "turn_end" | "prompt_submit" | "pre_compact" | "manual";

export const CANDIDATE_SOURCES: readonly CandidateSource[] = [
  "turn_end",
  "prompt_submit",
  "pre_compact",
  "manual",
];

/** The only source a human types themselves, and the only one capture never gates. */
export const MANUAL_SOURCE: CandidateSource = "manual";

/**
 * Every source a machine produced by reading a session rather than the user
 * typing. A privacy purge has to be able to name these as a group: a user who
 * revokes consent to transcripts asks to forget what was read from them, and
 * cannot be expected to enumerate identifiers they never saw.
 */
export const CAPTURED_SOURCES: readonly CandidateSource[] = [
  "turn_end",
  "prompt_submit",
  "pre_compact",
];

export type CandidateSignal =
  | "explicit_request"
  | "correction"
  | "praise"
  | "praise_weak";

export const CANDIDATE_SIGNALS: readonly CandidateSignal[] = [
  "explicit_request",
  "correction",
  "praise",
  "praise_weak",
];

export type Harness = "claude-code" | "codex" | "unknown";

export const HARNESSES: readonly Harness[] = ["claude-code", "codex", "unknown"];

export type ProposalType = "preference" | "memory" | "weight";

export const PROPOSAL_TYPES: readonly ProposalType[] = ["preference", "memory", "weight"];

export type Recommendation = "approve" | "reject_only";

export type EvidenceBasis = "recurrence" | "documented_pain" | "insufficient";

export const EVIDENCE_BASES: readonly EvidenceBasis[] = [
  "recurrence",
  "documented_pain",
  "insufficient",
];

export interface Proof {
  date: string;
  quote: string;
}

/**
 * What a depositor hands to the store. Any key outside this set is refused
 * rather than ignored: a typo in a hook must fail loudly, not vanish.
 */
export interface DepositRequest {
  source: CandidateSource;
  signal: CandidateSignal;
  raw_quote: string;
  raw_markers: string[];
  harness: Harness;
  session_id: string | null;
  turn_id: string | null;
  event_id: string | null;
  context: string | null;
  operation_id: string | null;
  batch_id: string | null;
}

export const DEPOSIT_REQUEST_FIELDS: readonly string[] = [
  "source",
  "signal",
  "raw_quote",
  "raw_markers",
  "harness",
  "session_id",
  "turn_id",
  "event_id",
  "context",
  "operation_id",
  "batch_id",
];

export interface StatusHistoryEntry {
  status: CandidateStatus;
  ts: string;
  operation_id: string | null;
  batch_id: string | null;
}

/** A classified proposal, as the gate hands it to the store on staged to proposed. */
export interface ProposalInput {
  type: ProposalType;
  target: string;
  content: string;
  proposed_weight: number | null;
  reason: string;
  proofs: Proof[];
  weak: boolean;
  recommendation: Recommendation;
  evidence_basis: EvidenceBasis | null;
  gate_item_index: number;
  gate_write_payload: Record<string, unknown>;
}

export interface CandidateRow {
  schema_version: number;
  id: string;
  ts: string;
  session_id: string | null;
  turn_id: string | null;
  event_id: string | null;
  harness: Harness;
  source: CandidateSource;
  signal: CandidateSignal;
  raw_quote: string;
  raw_markers: string[];
  context: string | null;
  operation_id: string | null;
  batch_id: string | null;
  deposit_operation_id: string | null;
  deposit_request: DepositRequest;
  deposit_batch_operation_id: string | null;
  deposit_batch_digest: string | null;
  deposit_batch_index: number | null;
  deposit_batch_size: number | null;
  status: CandidateStatus;
  type: ProposalType | null;
  target: string | null;
  content: string | null;
  proposed_weight: number | null;
  reason: string | null;
  proofs: Proof[] | null;
  weak: boolean | null;
  recommendation: Recommendation | null;
  evidence_basis: EvidenceBasis | null;
  gate_item_index: number | null;
  gate_write_payload: Record<string, unknown> | null;
  apply_error: string | null;
  proposed_ts: string | null;
  decided_ts: string | null;
  apply_started_ts: string | null;
  resolved_ts: string | null;
  applied_ref: string | null;
  last_transition_ts: string;
  status_history: StatusHistoryEntry[];
}

/**
 * Deposit provenance is frozen the moment a candidate is staged. Rewriting any
 * of it would let a later pass forge where a claim came from, which is exactly
 * what the human review is there to judge.
 */
export const IMMUTABLE_CANDIDATE_FIELDS: readonly string[] = [
  "schema_version",
  "id",
  "ts",
  "status",
  "status_history",
  "batch_id",
  "operation_id",
  "deposit_operation_id",
  "deposit_request",
  "source",
  "signal",
  "raw_quote",
  "raw_markers",
  "context",
  "harness",
  "session_id",
  "turn_id",
  "event_id",
  "deposit_batch_operation_id",
  "deposit_batch_digest",
  "deposit_batch_index",
  "deposit_batch_size",
  "proposed_ts",
  "decided_ts",
  "apply_started_ts",
  "resolved_ts",
  "last_transition_ts",
];

/** The only fields a later pass may rewrite, all of them classification output. */
export const MUTABLE_CANDIDATE_FIELDS: readonly string[] = [
  "type",
  "target",
  "content",
  "proposed_weight",
  "reason",
  "proofs",
  "weak",
  "recommendation",
  "evidence_basis",
  "gate_item_index",
  "gate_write_payload",
  "apply_error",
  "applied_ref",
];

export interface PreferenceWritePayload {
  kind: "preference";
  args: {
    id: string;
    statement: string;
    weight: number;
    domains: string[];
    why: string;
    apply: string;
    source: string;
    quote: string;
    date: string;
  };
  precondition: { preference: "absent" };
}

export interface WeightWritePayload {
  kind: "weight";
  mode: "bump" | "evidence";
  args: {
    id: string;
    date: string;
    weight: number;
    signal: "validated_sync" | "validated_sync_evidence";
    quote: string;
    status: string | null;
    regen: boolean;
  };
  content: string;
  precondition: { expected_current_weight: number };
}

export interface MemoryWritePayload {
  kind: "memory";
  target: string;
  content: string;
  content_sha256: string;
  diff: string;
  precondition: { expected_sha256: string };
}

export interface RejectOnlyWritePayload {
  kind: "reject_only";
  content: string;
  reason: "insufficient_evidence";
  proposal_weight: number | null;
  precondition: Record<string, never>;
}

export type WritePayload =
  | PreferenceWritePayload
  | WeightWritePayload
  | MemoryWritePayload
  | RejectOnlyWritePayload;

/** Sentinel used by a precondition that requires the target not to exist yet. */
export const ABSENT_SENTINEL = "absent";

export interface BatchItem {
  index: number;
  type: ProposalType;
  target: string;
  merged_ids: string[];
  reason: string;
  proofs: Proof[];
  weak: boolean;
  recommendation: Recommendation;
  evidence_basis: EvidenceBasis | null;
  write: WritePayload;
  operation_id: string;
}

export interface StagingBatch {
  schema: typeof BATCH_SCHEMA;
  schema_version: number;
  candidate_ids: string[];
  selection_id: string;
  items: BatchItem[];
  batch_id: string;
  content_hash: string;
}

export type BatchPhase =
  | "proposed"
  | "decided"
  | "applying"
  | "apply_failed"
  | "complete";

export type BatchOperationStatus = "pending" | "applying" | "applied" | "apply_failed";

export interface BatchOperationState {
  status: BatchOperationStatus;
  attempts: number;
  ref: string | null;
  error: string | null;
}

export interface BatchDecisionRecord {
  approved_indices: number[];
  rejected_indices: number[];
  hash: string;
}

export interface BatchState {
  schema: typeof BATCH_STATE_SCHEMA;
  schema_version: number;
  batch_id: string;
  phase: BatchPhase;
  decision: BatchDecisionRecord | null;
  operations: Record<string, BatchOperationState>;
  scan_done: boolean;
  compacted: boolean;
  state_hash: string;
}

export interface BatchDecisionFile {
  schema: typeof BATCH_DECISION_SCHEMA;
  schema_version: number;
  batch_id: string;
  decision: BatchDecisionRecord;
}

export interface PurgeTombstoneFile {
  path: string;
  removed: number;
}

/**
 * What a purge leaves behind once the content is gone.
 *
 * The archive is append-only and auditable by design, and a privacy purge has
 * to delete inside it. The arbitration is that privacy wins on the CONTENT and
 * never on the TRACE: the quotes disappear, the fact that a removal happened
 * and how large it was does not. Nothing here identifies what was erased, only
 * how much, when, why, and through which command. An archive that was silently
 * shortened would be less honest than one that says it was purged.
 */
export interface PurgeTombstone {
  schema_version: number;
  ts: string;
  reason: string;
  command: string;
  active_removed: number;
  archive_removed: number;
  files: PurgeTombstoneFile[];
  filters: {
    ids: number;
    status: CandidateStatus | null;
    sources: CandidateSource[];
    older_than_days: number | null;
  };
}

export interface StagingManifest {
  schema_version: number;
  updated_at: string;
  active_path: string;
  archive_paths: string[];
  total: number;
  counts: Record<CandidateStatus, number>;
}

/** Base class for every staging failure a human is meant to read and act on. */
export class StagingStoreError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "StagingStoreError";
  }
}

/**
 * A line of the store could not be read. Every mutation stops rather than
 * rewriting the file without it, because rewriting is how a corrupt line turns
 * into a lost candidate.
 */
export class CorruptStoreError extends StagingStoreError {
  public constructor(message: string) {
    super(message);
    this.name = "CorruptStoreError";
  }
}

export class InvalidTransitionError extends StagingStoreError {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export class IdempotencyConflictError extends StagingStoreError {
  public constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class StoreLockTimeoutError extends StagingStoreError {
  public constructor(message: string) {
    super(message);
    this.name = "StoreLockTimeoutError";
  }
}
