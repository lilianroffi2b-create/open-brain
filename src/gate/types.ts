import type { ContextBudget } from "../core/budget.js";
import { ExpectedError } from "../core/errors.js";
import type {
  BatchItem,
  BatchPhase,
  CandidateStatus,
  StagingBatch,
} from "../staging/types.js";
import type { HumanPresence } from "./presence.js";

/**
 * The shapes of the human gate: the one door through which anything reaches the
 * preference kernel or a memory note.
 *
 * Everything here is built around a single sentence: no byte reaches the kernel
 * without an explicit human decision. The batch is immutable, the decision is
 * immutable, and the undo record is immutable, so the three questions a reader
 * can ever have (what was proposed, what was chosen, what was there before) all
 * have exactly one answer that cannot be rewritten after the fact.
 */

export const SYNC_UNDO_SCHEMA = "open-brain/sync-undo/v1";
export const SYNC_UNDO_SEAL_SCHEMA = "open-brain/sync-undo-seal/v1";
export const SYNC_UNDONE_SCHEMA = "open-brain/sync-undone/v1";
export const SYNC_PRESENTATION_SCHEMA = "open-brain/sync-presentation/v1";
export const SYNC_SCHEMA_VERSION = 1;

/** Named lock guarding prepare and validate. Distinct from the store lock. */
export const SYNC_LOCK_NAME = "sync";

/** Directory of memory notes, under the configured memory root. */
export const MEMORY_DIRECTORY = "notes";

/**
 * A note filename states what kind of note it is before it is opened. The set
 * is a naming convention, not a security boundary: the boundary is the
 * traversal and symlink refusal in resolveMemoryTarget.
 */
export const MEMORY_NAME_PREFIXES: readonly string[] = [
  "project_",
  "reference_",
  "feedback_",
];

export const MEMORY_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*\.md$/u;

/** The lifecycles a note may declare. Mirrors the vault lifecycle vocabulary. */
export const MEMORY_LIFECYCLES: readonly string[] = ["working", "reference", "master"];

/**
 * Age past which a batch stops being presentable as it stands, in days.
 *
 * The gate cannot VERIFY freshness: whether an item is still true is a semantic
 * question, and answering it is the model's job. What the gate can do is refuse
 * to let staleness pass in silence, so a batch prepared last week never reaches
 * a reviewer looking exactly like one prepared a minute ago.
 */
export const BATCH_STALE_DAYS = 2;

/** How old a batch is, and whether that age has to be said out loud. */
export interface BatchFreshness {
  /** When the batch was built, or null on a batch written before the stamp. */
  prepared_at: string | null;
  /** Age in days, rounded to one decimal. Null when there is no stamp to age. */
  age_days: number | null;
  stale: boolean;
  /** Present only when stale, and addressed to whoever presents the batch. */
  stale_warning?: string;
}

/** Default character cap of a review presentation, per invariant I11. */
export const DEFAULT_REVIEW_CHARS = 12_000;

/** Default character cap of the staged listing handed to a classifier. */
export const DEFAULT_STAGED_CHARS = 24_000;

/** Longest file a unified diff is computed line by line for. */
export const DIFF_LINE_LIMIT = 2_000;

export const SIGNAL_VALIDATED = "validated_sync";
export const SIGNAL_VALIDATED_EVIDENCE = "validated_sync_evidence";
export const PREFERENCE_SOURCE = "open-brain-sync";

/** Every failure of the gate a human is meant to read and act on. */
export class SyncGateError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "SyncGateError";
  }
}

/** Nothing is staged, so there is nothing to review. Not an error state. */
export class EmptyStagingError extends SyncGateError {
  public constructor(message: string) {
    super(message);
    this.name = "EmptyStagingError";
  }
}

/**
 * The trace that a batch was actually put in front of somebody, and the token
 * that trace hands out. Written by `sync show`, read by `sync validate`.
 *
 * It is what turns "the caller typed an item number" into "the caller read the
 * presentation": the numbers are guessable, the token is not.
 */
export interface PresentationRecord {
  schema: typeof SYNC_PRESENTATION_SCHEMA;
  schema_version: number;
  batch_id: string;
  presented_at: string;
  token: string;
  /** Keyed with the vault secret, so the token cannot be chosen by its reader. */
  seal: string;
}

/**
 * What a caller offers as proof that this decision is a human decision.
 *
 * A replay carries no proof at all, and it does not need one: it is only ever
 * accepted when the decision is already frozen on disk, which means the proof
 * was given the first time. Everything that freezes a new decision must be of
 * kind human.
 */
export type DecisionProof =
  | { kind: "human"; confirm: string; presence: HumanPresence }
  | { kind: "replay" };

/**
 * Phases a batch can be in from the outside, including the two that exist only
 * because a crash can land between two writes. They are derived, never stored:
 * a stored phase that lies would be worse than no phase at all.
 */
export type DerivedBatchPhase =
  | BatchPhase
  | "needs_resume"
  | "decision_needs_resume"
  | "complete_needs_compact";

export interface ActiveBatchView extends BatchFreshness {
  batch_id: string;
  phase: DerivedBatchPhase;
  stored_phase: BatchPhase | null;
  items: number;
  approved: number | null;
  rejected: number | null;
  applied_operations: number;
  pending_operations: number;
  failed_operations: number;
  compacted: boolean;
  scan_done: boolean;
  undoable: boolean;
  undone: boolean;
  next: string;
}

export interface PendingReport {
  schema_version: number;
  active_batches: ActiveBatchView[];
  /** Batches that are applied and archived. Counted, never listed: I11. */
  completed_batches: number;
  /** How many active batches are older than BATCH_STALE_DAYS, listed or not. */
  stale_count: number;
  pending_candidates: number;
  staged_candidates: number;
  budget: ContextBudget;
  next: string;
}

export interface StagedCandidateView {
  id: string;
  ts: string;
  source: string;
  signal: string;
  harness: string;
  session_id: string | null;
  raw_markers: string[];
  context: string | null;
  raw_quote: string;
}

export interface StagedSlice {
  schema_version: number;
  count: number;
  remaining_count: number;
  selection_id: string;
  candidate_ids: string[];
  staged: StagedCandidateView[];
  budget: ContextBudget;
  next: string;
}

export interface PrepareResult {
  schema_version: number;
  batch_id: string;
  selection_id: string;
  items: number;
  created: boolean;
  proposed: number;
  reject_only_indices: number[];
  approvable_indices: number[];
  budget: ContextBudget;
  next: string;
}

export interface ShowResult extends BatchFreshness {
  schema_version: number;
  batch_id: string;
  phase: DerivedBatchPhase;
  items: number;
  reject_only_indices: number[];
  approvable_indices: number[];
  decision: { approved_indices: number[]; rejected_indices: number[] } | null;
  presentation: string;
  /** Retyped into `sync validate --confirm`. Printed here and nowhere else. */
  confirmation_token: string;
  budget: ContextBudget;
  next: string;
}

/** Preflight verdict of one approved item, decided before any mutation runs. */
export type PreflightVerdict = "pending" | "already_applied";

export interface ItemPreflight {
  index: number;
  operation_id: string;
  verdict: PreflightVerdict;
  ref: string;
  detail: string;
}

export type UndoTargetKind =
  | "preference_ledger"
  | "preference_core"
  | "loader_mirror"
  | "memory_note";

/**
 * The state of one file before the batch touched it, kept whole. A hash alone
 * would let undo detect a change without being able to reverse it, which is
 * exactly the gap this record exists to close.
 */
export interface UndoTargetSnapshot {
  kind: UndoTargetKind;
  path: string;
  existed: boolean;
  sha256: string | null;
  bytes: number | null;
  content: string | null;
}

export interface UndoRecord {
  schema: typeof SYNC_UNDO_SCHEMA;
  schema_version: number;
  batch_id: string;
  recorded_at: string;
  approved_indices: number[];
  targets: UndoTargetSnapshot[];
  /**
   * Keyed with the vault secret, which lives outside the vault. The per snapshot
   * sha256 says the bytes are the ones the record names; this says the record
   * itself came from a run of the gate rather than from whoever could write the
   * directory. See gate/undo.ts sealUndoRecord.
   */
  seal: string;
}

export interface UndoSealTarget {
  kind: UndoTargetKind;
  path: string;
  exists: boolean;
  sha256: string | null;
}

/**
 * The fingerprint of every target once the batch finished applying. Undo
 * restores only when the disk still matches this exactly: anything else means
 * someone edited the file afterwards, and silently overwriting their work would
 * be a second unwanted write rather than the reversal of the first.
 */
export interface UndoSeal {
  schema: typeof SYNC_UNDO_SEAL_SCHEMA;
  schema_version: number;
  batch_id: string;
  sealed_at: string;
  targets: UndoSealTarget[];
  /** Keyed with the vault secret. See gate/undo.ts sealUndoSeal. */
  seal: string;
}

export interface UndoneMarker {
  schema: typeof SYNC_UNDONE_SCHEMA;
  schema_version: number;
  batch_id: string;
  undone_at: string;
  restored: string[];
  removed: string[];
  /** Keyed with the vault secret. See gate/undo.ts sealUndoneMarker. */
  seal: string;
}

export interface UndoResult {
  schema_version: number;
  batch_id: string;
  restored: string[];
  removed: string[];
  already_undone: boolean;
  budget: ContextBudget;
  next: string;
}

export interface ValidateResult {
  schema_version: number;
  batch_id: string;
  approved_indices: number[];
  rejected_indices: number[];
  phase: BatchPhase;
  compacted: boolean;
  reindexed: boolean;
  refs: Record<string, string>;
  warnings: string[];
  undo_available: boolean;
  budget: ContextBudget;
  next: string;
}

/** A batch plus the candidate statuses it currently governs. */
export interface BatchView {
  batch: StagingBatch;
  items: BatchItem[];
  candidateStatuses: Record<string, CandidateStatus>;
}
