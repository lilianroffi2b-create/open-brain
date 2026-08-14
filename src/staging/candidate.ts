import { randomBytes } from "node:crypto";

// Only the pure half of that module is used here, the keyed hash itself. The
// key is read from disk by the callers, which is what keeps this file free of
// any I/O of its own.
import { vaultMac, type VaultSecret } from "../core/secret.js";
import { sha256 } from "../core/text.js";
import {
  ALLOWED_TRANSITIONS,
  APPLY_ERROR_CAP,
  CANDIDATE_SIGNALS,
  CANDIDATE_SOURCES,
  CANDIDATE_STATUSES,
  CONTENT_CAP,
  CONTEXT_CAP,
  CorruptStoreError,
  DEPOSIT_REQUEST_FIELDS,
  EVIDENCE_BASES,
  HARNESSES,
  IdempotencyConflictError,
  IMMUTABLE_CANDIDATE_FIELDS,
  InvalidTransitionError,
  MAX_RAW_MARKERS,
  MUTABLE_CANDIDATE_FIELDS,
  PROPOSAL_TYPES,
  QUOTE_CAP,
  RAW_QUOTE_CAP,
  REASON_CAP,
  STAGING_SCHEMA_VERSION,
  StagingStoreError,
  TARGET_CAP,
  type CandidateRow,
  type CandidateSignal,
  type CandidateSource,
  type CandidateStatus,
  type EvidenceBasis,
  type Harness,
  type DepositRequest,
  type Proof,
  type ProposalInput,
  type ProposalType,
  type Recommendation,
  type StatusHistoryEntry,
} from "./types.js";

/**
 * Pure candidate logic: normalization, validation, identifier derivation, and
 * the state machine itself. Nothing here touches the disk, so the store can
 * hold its lock for the shortest possible time and the gate can reuse the very
 * same rules without importing an I/O module.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CANDIDATE_ID_PATTERN = /^cand-\d{8}-[0-9a-f]{16}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTC second precision, the format every persisted timestamp uses. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

export function nowTimestamp(): string {
  return formatTimestamp(new Date());
}

export function newCandidateId(date = new Date()): string {
  const day = date.toISOString().slice(0, 10).replace(/-/gu, "");
  return `cand-${day}-${randomBytes(8).toString("hex")}`;
}

export function isCandidateId(value: string): boolean {
  return CANDIDATE_ID_PATTERN.test(value);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Key-sorted, separator-free JSON, so two equal objects always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function isCandidateStatus(value: unknown): value is CandidateStatus {
  return typeof value === "string" && CANDIDATE_STATUSES.some((item) => item === value);
}

export function isCandidateSource(value: unknown): value is CandidateSource {
  return typeof value === "string" && CANDIDATE_SOURCES.some((item) => item === value);
}

export function isCandidateSignal(value: unknown): value is CandidateSignal {
  return typeof value === "string" && CANDIDATE_SIGNALS.some((item) => item === value);
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && HARNESSES.some((item) => item === value);
}

export function isProposalType(value: unknown): value is ProposalType {
  return typeof value === "string" && PROPOSAL_TYPES.some((item) => item === value);
}

export function isRecommendation(value: unknown): value is Recommendation {
  return value === "approve" || value === "reject_only";
}

export function isEvidenceBasis(value: unknown): value is EvidenceBasis {
  return typeof value === "string" && EVIDENCE_BASES.some((item) => item === value);
}

/** Rejects 2026-02-30 and friends, which a regular expression alone accepts. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function truncate(value: string, cap: number): string {
  return Array.from(value).length <= cap ? value : Array.from(value).slice(0, cap).join("");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StagingStoreError(`Deposit field "${field}" must be a non-empty string.`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new StagingStoreError(
      `Deposit field "${field}" must be a non-empty string or null.`,
    );
  }
  return value;
}

/**
 * Turns an untrusted deposit into the exact shape the store persists. Unknown
 * keys are refused instead of dropped: a hook that misspells a field has a bug
 * worth seeing, and silently discarding it would lose the provenance of a
 * candidate a human is later asked to trust.
 */
export function normalizeDepositRequest(input: unknown): DepositRequest {
  if (!isRecord(input)) {
    throw new StagingStoreError("A deposit request must be a JSON object.");
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !DEPOSIT_REQUEST_FIELDS.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new StagingStoreError(
      `Unknown deposit fields: ${unknownKeys.sort().join(", ")}. Allowed fields are ${DEPOSIT_REQUEST_FIELDS.join(", ")}.`,
    );
  }

  const source = requiredText(input.source, "source");
  if (!isCandidateSource(source)) {
    throw new StagingStoreError(
      `Unknown deposit source "${source}". Expected one of ${CANDIDATE_SOURCES.join(", ")}.`,
    );
  }

  const signal = requiredText(input.signal, "signal");
  if (!isCandidateSignal(signal)) {
    throw new StagingStoreError(
      `Unknown deposit signal "${signal}". Expected one of ${CANDIDATE_SIGNALS.join(", ")}.`,
    );
  }

  const rawQuote = requiredText(input.raw_quote, "raw_quote");

  const rawMarkersValue = input.raw_markers;
  if (!Array.isArray(rawMarkersValue)) {
    throw new StagingStoreError("Deposit field \"raw_markers\" must be an array of strings.");
  }
  if (rawMarkersValue.some((item) => typeof item !== "string")) {
    throw new StagingStoreError("Every item of \"raw_markers\" must be a string.");
  }
  const rawMarkers = (rawMarkersValue as string[]).slice(0, MAX_RAW_MARKERS);

  const harnessValue = input.harness === undefined || input.harness === null
    ? "claude-code"
    : requiredText(input.harness, "harness");
  if (!isHarness(harnessValue)) {
    throw new StagingStoreError(
      `Unknown harness "${harnessValue}". Expected one of ${HARNESSES.join(", ")}.`,
    );
  }

  const context = input.context === undefined || input.context === null
    ? null
    : truncate(requiredText(input.context, "context"), CONTEXT_CAP);

  return {
    source,
    signal,
    raw_quote: truncate(rawQuote, RAW_QUOTE_CAP),
    raw_markers: rawMarkers,
    harness: harnessValue,
    session_id: optionalText(input.session_id, "session_id"),
    turn_id: optionalText(input.turn_id, "turn_id"),
    event_id: optionalText(input.event_id, "event_id"),
    context,
    operation_id: optionalText(input.operation_id, "operation_id"),
    batch_id: optionalText(input.batch_id, "batch_id"),
  };
}

export function sameDepositRequest(left: DepositRequest, right: DepositRequest): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Identity of a whole multi-deposit, so a replay of the batch is recognizable. */
export function depositBatchDigest(requests: readonly DepositRequest[]): string {
  return digest(requests.map((request) => sortValue(request)));
}

export interface BuildCandidateOptions {
  id?: string | undefined;
  now?: string | undefined;
  batchOperationId?: string | undefined;
  batchDigest?: string | undefined;
  batchIndex?: number | undefined;
  batchSize?: number | undefined;
}

export function buildCandidateRow(
  request: DepositRequest,
  options: BuildCandidateOptions = {},
): CandidateRow {
  const ts = options.now ?? nowTimestamp();
  const id = options.id ?? newCandidateId(new Date(ts));
  const history: StatusHistoryEntry = {
    status: "staged",
    ts,
    operation_id: request.operation_id,
    batch_id: request.batch_id,
  };

  return {
    schema_version: STAGING_SCHEMA_VERSION,
    id,
    ts,
    session_id: request.session_id,
    turn_id: request.turn_id,
    event_id: request.event_id,
    harness: request.harness,
    source: request.source,
    signal: request.signal,
    raw_quote: request.raw_quote,
    raw_markers: [...request.raw_markers],
    context: request.context,
    operation_id: request.operation_id,
    batch_id: request.batch_id,
    deposit_operation_id: request.operation_id,
    deposit_request: { ...request, raw_markers: [...request.raw_markers] },
    deposit_batch_operation_id: options.batchOperationId ?? null,
    deposit_batch_digest: options.batchDigest ?? null,
    deposit_batch_index: options.batchIndex ?? null,
    deposit_batch_size: options.batchSize ?? null,
    status: "staged",
    type: null,
    target: null,
    content: null,
    proposed_weight: null,
    reason: null,
    proofs: null,
    weak: null,
    recommendation: null,
    evidence_basis: null,
    gate_item_index: null,
    gate_write_payload: null,
    apply_error: null,
    proposed_ts: null,
    decided_ts: null,
    apply_started_ts: null,
    resolved_ts: null,
    applied_ref: null,
    last_transition_ts: ts,
    status_history: [history],
  };
}

function optionalStoredText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStoredInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function storedProofs(value: unknown): Proof[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const proofs: Proof[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.date === "string" && typeof item.quote === "string") {
      proofs.push({ date: item.date, quote: item.quote });
    }
  }
  return proofs;
}

function storedHistory(value: unknown, fallback: StatusHistoryEntry): StatusHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [fallback];
  }
  const entries: StatusHistoryEntry[] = [];
  for (const item of value) {
    if (isRecord(item) && isCandidateStatus(item.status) && typeof item.ts === "string") {
      entries.push({
        status: item.status,
        ts: item.ts,
        operation_id: optionalStoredText(item.operation_id),
        batch_id: optionalStoredText(item.batch_id),
      });
    }
  }
  return entries.length > 0 ? entries : [fallback];
}

function storedDepositRequest(value: unknown, row: CandidateRow): DepositRequest {
  if (isRecord(value)) {
    try {
      return normalizeDepositRequest(value);
    } catch {
      // An unreadable copy of the request is not corruption of the candidate
      // itself: the row still carries every field the request was built from.
    }
  }
  return {
    source: row.source,
    signal: row.signal,
    raw_quote: row.raw_quote,
    raw_markers: [...row.raw_markers],
    harness: row.harness,
    session_id: row.session_id,
    turn_id: row.turn_id,
    event_id: row.event_id,
    context: row.context,
    operation_id: row.operation_id,
    batch_id: row.batch_id,
  };
}

/**
 * Reads a stored line back into a candidate. Structural damage that would make
 * a rewrite lose or duplicate a candidate is corruption and stops everything;
 * a missing optional field written by an older version is simply defaulted, so
 * an older vault keeps loading.
 */
export function parseCandidateRow(value: unknown, origin: string): CandidateRow {
  if (!isRecord(value)) {
    throw new CorruptStoreError(`${origin} is not a JSON object.`);
  }
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new CorruptStoreError(`${origin} has a missing or empty candidate id.`);
  }
  if (!isCandidateStatus(value.status)) {
    throw new CorruptStoreError(
      `${origin} has an unknown candidate status ${JSON.stringify(value.status)}.`,
    );
  }
  const ts = typeof value.ts === "string" && value.ts.length > 0 ? value.ts : nowTimestamp();

  const partial: CandidateRow = {
    schema_version: optionalStoredInteger(value.schema_version) ?? STAGING_SCHEMA_VERSION,
    id,
    ts,
    session_id: optionalStoredText(value.session_id),
    turn_id: optionalStoredText(value.turn_id),
    event_id: optionalStoredText(value.event_id),
    harness: isHarness(value.harness) ? value.harness : "unknown",
    source: isCandidateSource(value.source) ? value.source : "manual",
    signal: isCandidateSignal(value.signal) ? value.signal : "praise_weak",
    raw_quote: typeof value.raw_quote === "string" ? value.raw_quote : "",
    raw_markers: Array.isArray(value.raw_markers)
      ? value.raw_markers.filter((item): item is string => typeof item === "string")
      : [],
    context: optionalStoredText(value.context),
    operation_id: optionalStoredText(value.operation_id),
    batch_id: optionalStoredText(value.batch_id),
    deposit_operation_id: optionalStoredText(value.deposit_operation_id),
    deposit_request: {
      source: "manual",
      signal: "praise_weak",
      raw_quote: "",
      raw_markers: [],
      harness: "unknown",
      session_id: null,
      turn_id: null,
      event_id: null,
      context: null,
      operation_id: null,
      batch_id: null,
    },
    deposit_batch_operation_id: optionalStoredText(value.deposit_batch_operation_id),
    deposit_batch_digest: optionalStoredText(value.deposit_batch_digest),
    deposit_batch_index: optionalStoredInteger(value.deposit_batch_index),
    deposit_batch_size: optionalStoredInteger(value.deposit_batch_size),
    status: value.status,
    type: isProposalType(value.type) ? value.type : null,
    target: optionalStoredText(value.target),
    content: optionalStoredText(value.content),
    proposed_weight: optionalStoredInteger(value.proposed_weight),
    reason: optionalStoredText(value.reason),
    proofs: storedProofs(value.proofs),
    weak: typeof value.weak === "boolean" ? value.weak : null,
    recommendation: isRecommendation(value.recommendation) ? value.recommendation : null,
    evidence_basis: isEvidenceBasis(value.evidence_basis) ? value.evidence_basis : null,
    gate_item_index: optionalStoredInteger(value.gate_item_index),
    gate_write_payload: isRecord(value.gate_write_payload) ? value.gate_write_payload : null,
    apply_error: optionalStoredText(value.apply_error),
    proposed_ts: optionalStoredText(value.proposed_ts),
    decided_ts: optionalStoredText(value.decided_ts),
    apply_started_ts: optionalStoredText(value.apply_started_ts),
    resolved_ts: optionalStoredText(value.resolved_ts),
    applied_ref: optionalStoredText(value.applied_ref),
    last_transition_ts: optionalStoredText(value.last_transition_ts) ?? ts,
    status_history: [],
  };

  partial.deposit_request = storedDepositRequest(value.deposit_request, partial);
  partial.status_history = storedHistory(value.status_history, {
    status: partial.status,
    ts,
    operation_id: partial.operation_id,
    batch_id: partial.batch_id,
  });
  return partial;
}

/** Fixed key order, so a rewritten store produces a readable and stable diff. */
export function serializeCandidateRow(row: CandidateRow): string {
  return JSON.stringify({
    schema_version: row.schema_version,
    id: row.id,
    ts: row.ts,
    session_id: row.session_id,
    turn_id: row.turn_id,
    event_id: row.event_id,
    harness: row.harness,
    source: row.source,
    signal: row.signal,
    raw_quote: row.raw_quote,
    raw_markers: row.raw_markers,
    context: row.context,
    operation_id: row.operation_id,
    batch_id: row.batch_id,
    deposit_operation_id: row.deposit_operation_id,
    deposit_request: row.deposit_request,
    deposit_batch_operation_id: row.deposit_batch_operation_id,
    deposit_batch_digest: row.deposit_batch_digest,
    deposit_batch_index: row.deposit_batch_index,
    deposit_batch_size: row.deposit_batch_size,
    status: row.status,
    type: row.type,
    target: row.target,
    content: row.content,
    proposed_weight: row.proposed_weight,
    reason: row.reason,
    proofs: row.proofs,
    weak: row.weak,
    recommendation: row.recommendation,
    evidence_basis: row.evidence_basis,
    gate_item_index: row.gate_item_index,
    gate_write_payload: row.gate_write_payload,
    apply_error: row.apply_error,
    proposed_ts: row.proposed_ts,
    decided_ts: row.decided_ts,
    apply_started_ts: row.apply_started_ts,
    resolved_ts: row.resolved_ts,
    applied_ref: row.applied_ref,
    last_transition_ts: row.last_transition_ts,
    status_history: row.status_history,
  });
}

export function isTransitionAllowed(from: CandidateStatus, to: CandidateStatus): boolean {
  return ALLOWED_TRANSITIONS[from].some((status) => status === to);
}

function validateProofs(proofs: unknown): Proof[] {
  if (!Array.isArray(proofs) || proofs.length === 0) {
    throw new StagingStoreError(
      "A proposal needs at least one proof of the form {date, quote}.",
    );
  }
  const seen = new Set<string>();
  const validated: Proof[] = [];
  for (const proof of proofs) {
    if (!isRecord(proof)) {
      throw new StagingStoreError("Every proof must be an object with a date and a quote.");
    }
    const extraKeys = Object.keys(proof).filter((key) => key !== "date" && key !== "quote");
    if (extraKeys.length > 0) {
      throw new StagingStoreError(
        `A proof carries only a date and a quote, found ${extraKeys.sort().join(", ")}.`,
      );
    }
    if (!isCalendarDate(proof.date)) {
      throw new StagingStoreError(
        `Proof date ${JSON.stringify(proof.date)} is not a real calendar date in YYYY-MM-DD form.`,
      );
    }
    if (typeof proof.quote !== "string" || proof.quote.trim().length === 0) {
      throw new StagingStoreError("Every proof needs a non-empty quote.");
    }
    if (Array.from(proof.quote).length > QUOTE_CAP) {
      throw new StagingStoreError(`A proof quote may not exceed ${String(QUOTE_CAP)} characters.`);
    }
    const key = canonicalJson([proof.date, proof.quote]);
    if (seen.has(key)) {
      throw new StagingStoreError("A proposal may not repeat the same (date, quote) proof.");
    }
    seen.add(key);
    validated.push({ date: proof.date, quote: proof.quote });
  }
  return validated;
}

function hasRecurrence(proofs: readonly Proof[]): boolean {
  return new Set(proofs.map((proof) => proof.date)).size >= 2;
}

/**
 * The evidence threshold, enforced here on the store side and again on the gate
 * side. Both copies ship on purpose: keeping only the gate copy would let a
 * direct call to the store stage a proposal the gate would have refused, which
 * is a bypass of the human review rather than a duplicated check.
 *
 * The contract, per signal of the candidate the proposal is attached to:
 * - explicit_request, the user asked for it out loud, so a single proof is enough;
 * - correction and praise are passive readings of a session, so approving one
 *   requires recurrence, meaning proofs on at least two distinct dates;
 * - praise_weak can never be approved, whatever the number of candidates merged
 *   into the item, which is what stops a weak signal from being laundered by
 *   merging it with stronger ones;
 * - a weight bump always needs recurrence or documented pain, whatever the signal.
 */
export function validateProposal(row: CandidateRow, proposal: ProposalInput): void {
  if (!isProposalType(proposal.type)) {
    throw new StagingStoreError(
      `Unknown proposal type ${JSON.stringify(proposal.type)}. Expected one of ${PROPOSAL_TYPES.join(", ")}.`,
    );
  }
  if (typeof proposal.target !== "string" || proposal.target.trim().length === 0) {
    throw new StagingStoreError("A proposal needs a non-empty target.");
  }
  if (Array.from(proposal.target).length > TARGET_CAP) {
    throw new StagingStoreError(`A proposal target may not exceed ${String(TARGET_CAP)} characters.`);
  }
  if (typeof proposal.content !== "string" || proposal.content.trim().length === 0) {
    throw new StagingStoreError("A proposal needs non-empty content.");
  }
  if (Array.from(proposal.content).length > CONTENT_CAP) {
    throw new StagingStoreError(
      `Proposal content may not exceed ${String(CONTENT_CAP)} characters.`,
    );
  }
  if (typeof proposal.reason !== "string" || proposal.reason.trim().length === 0) {
    throw new StagingStoreError("A proposal needs a non-empty reason.");
  }
  if (Array.from(proposal.reason).length > REASON_CAP) {
    throw new StagingStoreError(`A proposal reason may not exceed ${String(REASON_CAP)} characters.`);
  }
  if (!isRecommendation(proposal.recommendation)) {
    throw new StagingStoreError(
      "A proposal recommendation must be either approve or reject_only.",
    );
  }
  if (typeof proposal.weak !== "boolean") {
    throw new StagingStoreError("A proposal must state whether it is weak.");
  }
  if (proposal.weak !== (proposal.recommendation === "reject_only")) {
    throw new StagingStoreError(
      "A weak proposal is exactly a reject_only one: weak and recommendation must agree.",
    );
  }
  if (proposal.evidence_basis !== null && !isEvidenceBasis(proposal.evidence_basis)) {
    throw new StagingStoreError(
      `Unknown evidence basis ${JSON.stringify(proposal.evidence_basis)}.`,
    );
  }
  if (!Number.isInteger(proposal.gate_item_index) || proposal.gate_item_index < 1) {
    throw new StagingStoreError("A proposal needs a 1-based gate item index.");
  }
  if (!isRecord(proposal.gate_write_payload)) {
    throw new StagingStoreError("A proposal needs its write payload.");
  }
  if (
    proposal.proposed_weight !== null
    && (!Number.isInteger(proposal.proposed_weight)
      || proposal.proposed_weight < 1
      || proposal.proposed_weight > 5)
  ) {
    throw new StagingStoreError("A proposed weight must be an integer from 1 through 5.");
  }
  if (proposal.type === "weight" && proposal.proposed_weight === null) {
    throw new StagingStoreError("A weight proposal must carry the weight it proposes.");
  }

  const proofs = validateProofs(proposal.proofs);
  const approving = proposal.recommendation === "approve";

  if (!approving) {
    if (
      proposal.evidence_basis !== null
      && proposal.evidence_basis !== "insufficient"
    ) {
      throw new StagingStoreError(
        "A reject_only proposal may only claim an insufficient evidence basis.",
      );
    }
    if (row.signal === "praise_weak" && proposal.evidence_basis !== "insufficient") {
      throw new StagingStoreError(
        "A praise_weak candidate must be recorded with an insufficient evidence basis.",
      );
    }
    return;
  }

  if (row.signal === "praise_weak") {
    throw new StagingStoreError(
      `Candidate ${row.id} carries a praise_weak signal, which can never be approved. Merging it with stronger candidates does not change that. Propose it as reject_only, or capture an explicit request instead.`,
    );
  }

  if (row.signal !== "explicit_request" && !hasRecurrence(proofs)) {
    throw new StagingStoreError(
      `Candidate ${row.id} carries a passive ${row.signal} signal, so approving it needs recurrence: proofs on at least two distinct dates. It has ${String(new Set(proofs.map((proof) => proof.date)).size)}.`,
    );
  }

  if (
    proposal.type === "weight"
    && proposal.evidence_basis !== "recurrence"
    && proposal.evidence_basis !== "documented_pain"
  ) {
    throw new StagingStoreError(
      "A weight bump needs an evidence basis of recurrence or documented_pain.",
    );
  }

  if (
    row.signal !== "explicit_request"
    && proposal.evidence_basis !== "recurrence"
    && proposal.evidence_basis !== "documented_pain"
  ) {
    throw new StagingStoreError(
      `Approving a passive ${row.signal} signal needs an evidence basis of recurrence or documented_pain.`,
    );
  }
}

export interface CandidateUpdates {
  type?: ProposalType;
  target?: string;
  content?: string;
  proposed_weight?: number | null;
  reason?: string;
  proofs?: Proof[];
  weak?: boolean;
  recommendation?: Recommendation;
  evidence_basis?: EvidenceBasis | null;
  gate_item_index?: number;
  gate_write_payload?: Record<string, unknown>;
  apply_error?: string;
  applied_ref?: string;
}

/**
 * Filters a free-form update down to the classification fields. Deposit
 * provenance is refused rather than ignored: it is the evidence a human weighs
 * when deciding, so a caller that tries to rewrite where a claim came from must
 * fail loudly and leave the candidate exactly where it was.
 */
export function sanitizeCandidateUpdates(updates: unknown): CandidateUpdates {
  if (!isRecord(updates)) {
    throw new StagingStoreError("Candidate updates must be a JSON object.");
  }
  const reserved = Object.keys(updates).filter((key) =>
    IMMUTABLE_CANDIDATE_FIELDS.includes(key));
  if (reserved.length > 0) {
    throw new StagingStoreError(
      `Reserved candidate fields cannot be updated: ${reserved.sort().join(", ")}. Deposit provenance and the state machine are immutable after staging.`,
    );
  }
  const unknown = Object.keys(updates).filter((key) => !MUTABLE_CANDIDATE_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new StagingStoreError(`Unknown candidate fields: ${unknown.sort().join(", ")}.`);
  }

  const sanitized: CandidateUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    switch (key) {
      case "type":
        if (!isProposalType(value)) {
          throw new StagingStoreError("Update field \"type\" must be a proposal type.");
        }
        sanitized.type = value;
        break;
      case "target":
      case "content":
      case "reason":
      case "apply_error":
      case "applied_ref":
        if (typeof value !== "string" || value.length === 0) {
          throw new StagingStoreError(`Update field "${key}" must be a non-empty string.`);
        }
        sanitized[key] = value;
        break;
      case "proposed_weight":
        if (value !== null && (typeof value !== "number" || !Number.isInteger(value))) {
          throw new StagingStoreError("Update field \"proposed_weight\" must be an integer or null.");
        }
        sanitized.proposed_weight = value as number | null;
        break;
      case "proofs":
        sanitized.proofs = validateProofs(value);
        break;
      case "weak":
        if (typeof value !== "boolean") {
          throw new StagingStoreError("Update field \"weak\" must be a boolean.");
        }
        sanitized.weak = value;
        break;
      case "recommendation":
        if (!isRecommendation(value)) {
          throw new StagingStoreError(
            "Update field \"recommendation\" must be approve or reject_only.",
          );
        }
        sanitized.recommendation = value;
        break;
      case "evidence_basis":
        if (value !== null && !isEvidenceBasis(value)) {
          throw new StagingStoreError("Update field \"evidence_basis\" is not a known basis.");
        }
        sanitized.evidence_basis = value as EvidenceBasis | null;
        break;
      case "gate_item_index":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          throw new StagingStoreError(
            "Update field \"gate_item_index\" must be a positive integer.",
          );
        }
        sanitized.gate_item_index = value;
        break;
      case "gate_write_payload":
        if (!isRecord(value)) {
          throw new StagingStoreError("Update field \"gate_write_payload\" must be an object.");
        }
        sanitized.gate_write_payload = value;
        break;
      default:
        break;
    }
  }
  return sanitized;
}

export interface TransitionPatch {
  status: CandidateStatus;
  operationId?: string | undefined;
  batchId?: string | undefined;
  proposal?: ProposalInput | undefined;
  appliedRef?: string | undefined;
  applyError?: string | undefined;
  updates?: Record<string, unknown> | undefined;
}

export interface TransitionResult {
  row: CandidateRow;
  changed: boolean;
}

function patchedFields(row: CandidateRow, patch: TransitionPatch): CandidateRow {
  const next: CandidateRow = { ...row };
  if (patch.updates !== undefined) {
    const updates = sanitizeCandidateUpdates(patch.updates);
    Object.assign(next, updates);
  }
  if (patch.operationId !== undefined) {
    next.operation_id = patch.operationId;
  }
  if (patch.batchId !== undefined) {
    next.batch_id = patch.batchId;
  }
  if (patch.proposal) {
    next.type = patch.proposal.type;
    next.target = patch.proposal.target;
    next.content = patch.proposal.content;
    next.proposed_weight = patch.proposal.proposed_weight;
    next.reason = patch.proposal.reason;
    next.proofs = patch.proposal.proofs.map((proof) => ({ ...proof }));
    next.weak = patch.proposal.weak;
    next.recommendation = patch.proposal.recommendation;
    next.evidence_basis = patch.proposal.evidence_basis;
    next.gate_item_index = patch.proposal.gate_item_index;
    next.gate_write_payload = patch.proposal.gate_write_payload;
  }
  if (patch.appliedRef !== undefined) {
    next.applied_ref = patch.appliedRef;
  }
  if (patch.applyError !== undefined) {
    next.apply_error = truncate(patch.applyError, APPLY_ERROR_CAP);
  }
  return next;
}

function assertPatchShape(row: CandidateRow, patch: TransitionPatch): void {
  if (patch.proposal && patch.status !== "proposed") {
    throw new StagingStoreError(
      "A proposal payload belongs to the staged to proposed transition only.",
    );
  }
  if (patch.status === "proposed" && !patch.proposal) {
    throw new StagingStoreError(
      `Candidate ${row.id} cannot become proposed without its classified proposal.`,
    );
  }
  if (patch.appliedRef !== undefined && patch.status !== "applied") {
    throw new StagingStoreError("An applied reference belongs to the applied transition only.");
  }
  if (patch.applyError !== undefined && patch.status !== "apply_failed") {
    throw new StagingStoreError("An apply error belongs to the apply_failed transition only.");
  }
}

/**
 * Runs one edge of the candidate state machine. A repeat of the current status
 * is a no-op only when every value in the patch is already exactly in place;
 * anything else is a conflict, because silently accepting a second, different
 * write under the same status is how two callers overwrite each other.
 */
export function applyTransition(
  row: CandidateRow,
  patch: TransitionPatch,
  now = nowTimestamp(),
): TransitionResult {
  if (patch.status === "staged") {
    throw new InvalidTransitionError(
      `Candidate ${row.id} cannot return to staged: staged is an entry state only.`,
    );
  }
  assertPatchShape(row, patch);

  if (patch.proposal) {
    validateProposal(row, patch.proposal);
  }

  if (patch.status === row.status) {
    const repeated = patchedFields(row, patch);
    if (serializeCandidateRow(repeated) === serializeCandidateRow(row)) {
      return { row, changed: false };
    }
    throw new IdempotencyConflictError(
      `Candidate ${row.id} is already ${row.status}, and this repeat carries different values. Read the candidate before writing it again.`,
    );
  }

  if (!isTransitionAllowed(row.status, patch.status)) {
    throw new InvalidTransitionError(
      `Candidate ${row.id} cannot move from ${row.status} to ${patch.status}. Legal moves from ${row.status}: ${ALLOWED_TRANSITIONS[row.status].join(", ") || "none, it is terminal"}.`,
    );
  }

  if (patch.status === "approved" && row.recommendation === "reject_only") {
    throw new InvalidTransitionError(
      `Candidate ${row.id} was classified reject_only, so it can only be rejected. Reclassify it if you disagree.`,
    );
  }

  const next = patchedFields(row, patch);
  next.status = patch.status;
  next.last_transition_ts = now;

  if (row.status === "apply_failed") {
    next.resolved_ts = null;
    if (patch.applyError === undefined) {
      next.apply_error = null;
    }
  }

  switch (patch.status) {
    case "proposed":
      next.proposed_ts = now;
      break;
    case "approved":
    case "rejected":
      next.decided_ts = now;
      break;
    case "applying":
      next.apply_started_ts = now;
      break;
    default:
      break;
  }

  if (patch.status === "applied" || patch.status === "rejected" || patch.status === "apply_failed") {
    next.resolved_ts = now;
  }

  next.status_history = [
    ...row.status_history,
    {
      status: patch.status,
      ts: now,
      operation_id: next.operation_id,
      batch_id: next.batch_id,
    },
  ];

  return { row: next, changed: true };
}

/** selection-<24 hex> over the sorted candidate slice a batch was built from. */
export function computeSelectionId(candidateIds: readonly string[]): string {
  return `selection-${digest([...candidateIds].sort()).slice(0, 24)}`;
}

/** sync-<32 hex> over an item and its position, the idempotency key of a write. */
export function computeItemOperationId(index: number, item: unknown): string {
  return `sync-${digest({ index, item }).slice(0, 32)}`;
}

/**
 * The three seals below are keyed, and that is the whole point of them.
 *
 * They used to be plain sha256 digests over the very document they sealed, so
 * anybody able to write the file could recompute the seal and the check was a
 * formality: a batch, an apply state or a frozen human decision could all be
 * rewritten from scratch and would verify perfectly. Keyed with the vault
 * secret, which lives outside the vault, they answer a different and much more
 * useful question: was this document produced by a run of this gate, on this
 * machine, or merely dropped in the directory.
 *
 * The domain tags keep the three apart. A state and a decision that happened to
 * canonicalize to the same bytes would otherwise share a seal, and a seal that
 * fits two documents vouches for neither.
 */
const BATCH_CONTENT_DOMAIN = "open-brain/batch-content/v1";
const BATCH_STATE_DOMAIN = "open-brain/batch-state/v1";
const BATCH_DECISION_DOMAIN = "open-brain/batch-decision/v1";

/**
 * The signature of a batch, over everything that is a clause of the contract.
 *
 * prepared_at is excluded exactly like batch_id and content_hash: it is
 * freshness metadata, not a term a human decides on, so a batch keeps the same
 * identity whether or not the stamp is there.
 */
export function computeContentHash(
  batch: Record<string, unknown>,
  secret: VaultSecret,
): string {
  const {
    batch_id: _batchId,
    content_hash: _contentHash,
    prepared_at: _preparedAt,
    ...rest
  } = batch;
  return vaultMac(secret, BATCH_CONTENT_DOMAIN, canonicalJson(rest));
}

export function computeBatchId(contentHash: string): string {
  return `batch-${contentHash.slice(0, 24)}`;
}

export function computeStateHash(
  state: Record<string, unknown>,
  secret: VaultSecret,
): string {
  const { state_hash: _stateHash, ...rest } = state;
  return vaultMac(secret, BATCH_STATE_DOMAIN, canonicalJson(rest));
}

/**
 * The seal of one human decision, bound to the batch it was made about.
 *
 * The batch identifier is part of the sealed message on purpose. Without it the
 * seal would only cover the approved and rejected numbers, which repeat across
 * batches: a legitimate seal for "approve item 1" of one batch would then verify
 * as a decision to approve item 1 of any other batch, and a decision file could
 * be forged simply by copying a hash from the batch next door.
 */
export function computeDecisionHash(
  approvedIndices: readonly number[],
  rejectedIndices: readonly number[],
  secret: VaultSecret,
  batchId: string,
): string {
  return vaultMac(secret, BATCH_DECISION_DOMAIN, canonicalJson({
    batch_id: batchId,
    approved_indices: [...approvedIndices],
    rejected_indices: [...rejectedIndices],
  }));
}
