import { ExpectedError } from "../core/errors.js";
import { splitFrontmatter } from "../core/frontmatter.js";
import { normalize, toPosixPath } from "../core/text.js";
import { isCalendarDate } from "../staging/candidate.js";
import {
  CONTENT_CAP,
  EVIDENCE_BASES,
  MAX_BATCH_ITEMS,
  PROPOSAL_TYPES,
  QUOTE_CAP,
  REASON_CAP,
  TARGET_CAP,
  type EvidenceBasis,
  type Proof,
  type ProposalType,
  type Recommendation,
} from "../staging/types.js";

/**
 * The frozen contract of the learning layer. Every record shape, every bound,
 * and every validator lives here and nowhere else: no other module of the layer
 * is allowed to define a data shape. Validators refuse unknown keys on purpose,
 * so a later version cannot write a field that the current one would swallow in
 * silence.
 *
 * Reads are tolerant backwards: a validator returns a normalized copy and fills
 * schema_version when an older record does not carry it.
 *
 * The classification contract below is the output contract of the classifier
 * and the input contract of the gate. It lives here, and only here, because the
 * classifier and the learning layer must never disagree on what a
 * classification is; src/classifier/contract.ts re-exports it verbatim.
 */

export const LEARNING_SCHEMA_VERSION = 1;

/** One timestamp format for the whole layer: UTC, second precision, nothing else. */
export const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
export const TS_STEP_MS = 1_000;

export const RANK_SHADOW_FLOOR = 0;
export const RANK_ACTIVE_FLOOR = 3;
export const RANK_LAW_FLOOR = 7;

/** The only confidence a belief may be born at. */
export const CONFIDENCE_CREATION = 3 as const;
export const CONFIDENCE_ENGRAVED = 8;
export const CONFIDENCE_RETRACTED = -1;
export const CONFIDENCE_FLOOR = -1;
export const CONFIDENCE_CEILING = 10;
/** Automatic growth stops half a step below law: only a human hand opens law. */
export const UNLOCKED_CONFIDENCE_CAP = 6.5;

export const DELTA_APPLICATION_CONFIRMED = 1;
export const DELTA_APPLICATION_CORRECTED = -2;
export const DELTA_DORMANCY = -0.5;
export const DORMANCY_DAYS = 30;

export const INFERRED_SURVIVAL_APPLICATIONS = 20;
export const INFERRED_SURVIVAL_CORRECTIONS_MAX = 0;
export const INFERRED_SURVIVAL_AGE_DAYS = 60;
export const INFERRED_EVIDENCE_OCCURRENCES_MIN = 3;

export const VERDICT_WEIGHT_MIN = 1;
export const VERDICT_WEIGHT_MAX = 2;

/**
 * Hard cap of one journal line, newline included. Concurrent appends stay
 * atomic on a descriptor opened in append mode only while a line fits in a
 * single write, so this bound is a correctness property, not a style rule.
 */
export const LINE_MAX_BYTES = 4096;
export const INPUT_SUMMARY_CAP = 160;
export const QUOTE_MAX_CHARS = 400;
export const BELIEF_ID_MAX_CHARS = 48;

export const BELIEF_ID_PATTERN = /^b_[a-z0-9]+(?:_[a-z0-9]+)*$/u;
export const DECISION_ID_PATTERN = /^dec_\d{8}T\d{4}_[0-9a-f]{4,16}$/u;
export const OBSERVATION_ID_PATTERN = /^obs_\d{8}_\d{4}$/u;
export const SHA1_PATTERN = /^sha1:[0-9a-f]{40}$/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const PERIOD_PATTERN = /^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/u;

export const BELIEF_RANKS = ["retired", "shadow", "active", "law"] as const;
export type BeliefRank = (typeof BELIEF_RANKS)[number];

/**
 * The only rank a belief may be born at. `shadow` is a sanction, so it is an
 * exit state and never an entry state: a belief born there would never be
 * injected, therefore never evaluated, therefore never promoted. Encoding it in
 * the type means the creation input has no way to ask for anything else.
 */
export type BeliefBirthRank = Extract<BeliefRank, "active">;

export const BELIEF_ORIGINS = ["declared", "inferred"] as const;
export type BeliefOrigin = (typeof BELIEF_ORIGINS)[number];

/**
 * The closed set a producer inside this layer may write. The validator keeps
 * the field open to any non-empty string on purpose, so a future producer can
 * add a cause without a data migration.
 */
export const MOVE_CAUSES = [
  "creation",
  "application_confirmed",
  "application_corrected",
  "dormancy",
  "human_engrave",
  "human_retract",
] as const;
export type MoveCause = (typeof MOVE_CAUSES)[number];

/** Causes a caller may hand to the store. `creation` belongs to createBelief. */
export type ApplicationCause = Exclude<MoveCause, "creation">;

/**
 * Causes that always leave a history entry, even when the confidence does not
 * move. The entry is the idempotency mark, so this set is exactly the set of
 * causes guarded against replay. Dormancy is deliberately absent: its ref
 * repeats from window to window, so a mark would freeze it after the first one,
 * and its own bound is max(seen_at, moved_at).
 */
export const TRACING_CAUSES: readonly ApplicationCause[] = [
  "application_confirmed",
  "application_corrected",
  "human_engrave",
  "human_retract",
];

export const HISTORY_SUMMARY_CAUSE = "history_summary";

export const DECISION_TYPES = [
  "route",
  "load",
  "produced",
  "belief_applied",
  "pruned",
  "ruling",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const VERDICT_OUTCOMES = ["good", "bad", "undetermined"] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

export const VERDICT_RULES = [
  "sterile_route",
  "belief_corrected",
  "belief_confirmed",
  "dead_output",
  "rapid_followup",
  "wasted_load",
  "deliverable_shipped",
] as const;
export type VerdictRule = (typeof VERDICT_RULES)[number];

/**
 * Rules that cannot conclude yet, each for its own reason: rapid_followup
 * measures a rhythm that has to be calibrated on a corpus first, while
 * wasted_load and deliverable_shipped would need a source none of them has, so
 * they always answer undetermined.
 *
 * The contract refuses them armed rather than trusting the evaluator to emit
 * armed: false, because a rule the caller carries is a rule the next caller can
 * forget. No configuration mistake and no new producer can turn one of them
 * into a confidence move.
 */
export const DISARMED_RULES: readonly VerdictRule[] = [
  "rapid_followup",
  "wasted_load",
  "deliverable_shipped",
];

/**
 * Sensor names are declared here and only here. One name per sensor that
 * actually exists: declaring a sensor that nothing produces would advertise a
 * capacity the layer does not have.
 */
export const SENSORS = ["circulation"] as const;
export type SensorName = (typeof SENSORS)[number];

/** Sensors whose readings are about a document, so they must name a population member. */
export const DOCUMENTARY_SENSORS: readonly SensorName[] = ["circulation"];

/**
 * Keys a line may never lose while being shrunk to fit the line cap, at any
 * nesting depth. beliefs_applied is the join key of the whole learning loop: an
 * evaluator reading a truncated one would correct a belief that was never
 * applied, or miss the one that was.
 */
export const ESSENTIAL_LINE_FIELDS: readonly string[] = [
  "armed",
  "beliefs_applied",
  "beliefs_evicted",
  "choice",
  "deconsolidation_verified",
  "decision_id",
  "document",
  "evaluated_at",
  "hash",
  "id",
  "population",
  "reread_ok",
  "result",
  "rule",
  "schema_version",
  "score",
  "sensor",
  "session",
  "subject",
  "truncated",
  "ts",
  "turn",
  "type",
  "verdict",
  "weight",
];

/** Lists whose contract demands at least one element, so they stop shrinking at one. */
export const FLOOR_ONE_LISTS: readonly string[] = ["blocks"];

export interface HistoryPolicy {
  /**
   * Maximum number of history entries kept on a belief. Overflow is folded into
   * a single summary entry, never dropped in silence, so at least two are
   * needed: the summary and one detailed entry.
   */
  max_entries: number;
}

export const DEFAULT_HISTORY_POLICY: HistoryPolicy = { max_entries: 200 };
export const HISTORY_POLICY_MIN_ENTRIES = 2;

export class SchemaError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/**
 * Carries the stable code of the invariant that refused the record, so a
 * negative test can prove WHICH rule fired instead of only proving that
 * something threw.
 */
export class InvariantError extends SchemaError {
  public readonly invariant: string;

  public constructor(invariant: string, message: string) {
    super(message);
    this.name = "InvariantError";
    this.invariant = invariant;
  }
}

function fail(invariant: string, message: string): never {
  throw new InvariantError(invariant, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function checkedRecord(value: unknown, form: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(`${form}.shape`, `A ${form} must be a JSON object.`);
  }
  return value;
}

function checkKeys(
  value: Record<string, unknown>,
  form: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(`${form}.keys.unknown`, `A ${form} carries the unknown key "${key}".`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      fail(`${form}.keys.missing`, `A ${form} is missing the required key "${key}".`);
    }
  }
}

function checkedSchemaVersion(value: unknown, form: string): number {
  if (value === undefined) {
    return LEARNING_SCHEMA_VERSION;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    fail(`${form}.schema_version`, `A ${form} carries an invalid schema_version.`);
  }
  return value as number;
}

function checkedStringList(value: unknown, form: string, invariant: string): string[] {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    fail(invariant, `A ${form} expects an array of non-empty strings for this key.`);
  }
  return (value as string[]).map((item) => item);
}

function checkedNumberMap(
  value: unknown,
  invariant: string,
  message: string,
  allowEmpty: boolean,
): Record<string, number> {
  if (!isRecord(value)) {
    fail(invariant, message);
  }
  const entries = Object.entries(value);
  if (!allowEmpty && entries.length === 0) {
    fail(invariant, message);
  }
  for (const [key, item] of entries) {
    // A boolean is a number in too many languages. Here it is not.
    if (typeof item !== "number" || !Number.isFinite(item)) {
      fail(invariant, `${message} The key "${key}" is not a finite number.`);
    }
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

export function isTs(value: unknown): value is string {
  return typeof value === "string" && TS_PATTERN.test(value);
}

export function formatTs(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function nowTs(): string {
  return formatTs(new Date());
}

export function parseTs(value: string): Date {
  if (!isTs(value)) {
    fail("ts.format", `"${value}" is not a timestamp of the form YYYY-MM-DDTHH:MM:SSZ.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail("ts.format", `"${value}" is not a real instant.`);
  }
  return date;
}

/**
 * One code for every timestamp refusal, whichever field carries it: a negative
 * test asserts on the rule that fired, and the rule here is always the same.
 */
function checkedTs(value: unknown, label: string): string {
  if (typeof value !== "string" || !isTs(value)) {
    fail("ts.format", `${label} must be a timestamp of the form YYYY-MM-DDTHH:MM:SSZ.`);
  }
  parseTs(value);
  return value;
}

/**
 * Rank bounds are closed on the left and open on the right, with no overlap.
 * Every confidence move is a multiple of 0.5 and therefore exact in binary, so
 * no epsilon is needed here and none must be introduced.
 */
export function rankForConfidence(confidence: number): BeliefRank {
  if (confidence < RANK_SHADOW_FLOOR) {
    return "retired";
  }
  if (confidence < RANK_ACTIVE_FLOOR) {
    return "shadow";
  }
  if (confidence < RANK_LAW_FLOOR) {
    return "active";
  }
  return "law";
}

/** An inferred belief reaches the absolute ceiling only after it has survived. */
export function inferredSurvivalReached(belief: Belief, now: string = nowTs()): boolean {
  if (!Number.isInteger(belief.applications) || !Number.isInteger(belief.corrections)) {
    return false;
  }
  if (belief.applications < INFERRED_SURVIVAL_APPLICATIONS) {
    return false;
  }
  if (belief.corrections > INFERRED_SURVIVAL_CORRECTIONS_MAX) {
    return false;
  }
  if (!isTs(belief.created_at) || !isTs(now)) {
    return false;
  }
  const ageMs = parseTs(now).getTime() - parseTs(belief.created_at).getTime();
  return ageMs >= INFERRED_SURVIVAL_AGE_DAYS * 24 * 60 * 60 * 1000;
}

export interface FoldedHistory {
  entries: number;
  first_ts: string;
  last_ts: string;
  causes: Record<string, number>;
}

export interface BeliefHistoryEntry {
  ts: string;
  /** Null only on the creation entry. */
  from: number | null;
  to: number;
  cause: string;
  ref: string;
  /** Present only on a folded summary entry, and required there. */
  folded?: FoldedHistory;
}

export interface BeliefEvidence {
  occurrences: number;
  refs: string[];
  quote: string;
  decision_source?: string;
}

export interface Belief {
  id: string;
  statement: string;
  domain: string;
  origin: BeliefOrigin;
  ledger_ref?: string | null;
  evidence: BeliefEvidence;
  rank: BeliefRank;
  confidence: number;
  /** Set by a human hand, and never set back to false by anything. */
  locked: boolean;
  opportunities: number;
  applications: number;
  corrections: number;
  created_at: string;
  seen_at: string;
  moved_at: string;
  history: BeliefHistoryEntry[];
}

/** A belief as it may leave createBelief: rank active, confidence 3, nothing else. */
export interface NewBelief extends Omit<Belief, "rank" | "confidence"> {
  rank: BeliefBirthRank;
  confidence: typeof CONFIDENCE_CREATION;
}

export interface OperationRecord {
  operation_id: string;
  digest: string;
  ts: string;
}

export interface BeliefDocument {
  schema_version: number;
  updated_at: string;
  beliefs: Belief[];
  /** Idempotency registry of the store, bounded and owned by the store alone. */
  operations: OperationRecord[];
}

export interface DecisionEntry {
  schema_version: number;
  id: string;
  ts: string;
  session: string;
  type: DecisionType;
  input: { hash: string; summary: string };
  options: string[];
  choice: string | null;
  score: number | null;
  beliefs_applied: string[];
  beliefs_evicted: string[];
  documents: string[];
  cost: { tokens_estimated: number; ms: number };
  verdict: VerdictOutcome | null;
  truncated?: boolean;
}

export interface ConsolidationBlock {
  archive: string;
  period: string;
  entries: number;
  size: number;
  sha256_block: string;
  reread_ok: boolean;
}

export interface ConsolidationEntry {
  schema_version: number;
  id: string;
  ts: string;
  type: "consolidated";
  document: string;
  before: { size: number; sha256: string };
  after: { size: number; sha256: string };
  blocks: ConsolidationBlock[];
  deconsolidation_verified: boolean;
  truncated?: boolean;
}

export type JournalEntry = DecisionEntry | ConsolidationEntry;

export interface Observation {
  schema_version: number;
  id: string;
  sensor: SensorName;
  ts: string;
  subject: string;
  population?: string;
  measure: Record<string, number>;
  derived: Record<string, number>;
  truncated?: boolean;
}

export interface Verdict {
  schema_version: number;
  decision_id: string;
  rule: VerdictRule;
  verdict: VerdictOutcome;
  weight: number;
  armed: boolean;
  evidence: Record<string, unknown>;
  evaluated_at: string;
  truncated?: boolean;
}

const BELIEF_REQUIRED = [
  "id",
  "statement",
  "domain",
  "origin",
  "evidence",
  "rank",
  "confidence",
  "locked",
  "opportunities",
  "applications",
  "corrections",
  "created_at",
  "seen_at",
  "moved_at",
  "history",
] as const;
const BELIEF_OPTIONAL = ["ledger_ref"] as const;
const EVIDENCE_REQUIRED = ["occurrences", "refs", "quote"] as const;
const EVIDENCE_OPTIONAL = ["decision_source"] as const;
const HISTORY_REQUIRED = ["ts", "from", "to", "cause", "ref"] as const;
const HISTORY_OPTIONAL = ["folded"] as const;
const FOLDED_REQUIRED = ["entries", "first_ts", "last_ts", "causes"] as const;

export interface BeliefValidationOptions {
  /** Reference instant for the age-dependent checks. */
  now?: string;
  /** Enforces the birth rules: rank active and confidence 3. */
  creation?: boolean;
  /**
   * When given, a declared belief must carry a quote found literally inside it.
   * Absent, the literal check is skipped because there is nothing to check
   * against, never because the rule is optional.
   */
  sourceText?: string;
}

function validateFolded(value: unknown, cause: string): FoldedHistory {
  if (cause !== HISTORY_SUMMARY_CAUSE) {
    fail(
      "belief.history.summary.cause",
      `Only a "${HISTORY_SUMMARY_CAUSE}" entry may carry a folded payload.`,
    );
  }
  const folded = checkedRecord(value, "belief.history.summary");
  checkKeys(folded, "belief.history.summary", FOLDED_REQUIRED, []);
  if (!Number.isInteger(folded.entries) || (folded.entries as number) < 1) {
    fail("belief.history.summary.entries", "A folded summary must have folded at least one entry.");
  }
  const firstTs = checkedTs(folded.first_ts, "folded.first_ts");
  const lastTs = checkedTs(folded.last_ts, "folded.last_ts");
  if (parseTs(firstTs).getTime() > parseTs(lastTs).getTime()) {
    fail("belief.history.summary.ts", "A folded summary window ends before it starts.");
  }
  const causes = checkedNumberMap(
    folded.causes,
    "belief.history.summary.causes",
    "A folded summary must tally the causes it folded.",
    false,
  );
  return { entries: folded.entries as number, first_ts: firstTs, last_ts: lastTs, causes };
}

function validateHistoryEntry(value: unknown, index: number): BeliefHistoryEntry {
  const entry = checkedRecord(value, "belief.history");
  checkKeys(entry, "belief.history", HISTORY_REQUIRED, HISTORY_OPTIONAL);
  const ts = checkedTs(entry.ts, `history[${String(index)}].ts`);
  if (entry.from !== null && !isFiniteNumber(entry.from)) {
    fail("belief.history.from", `history[${String(index)}].from must be a number or null.`);
  }
  if (!isFiniteNumber(entry.to)) {
    fail("belief.history.to", `history[${String(index)}].to must be a number.`);
  }
  if (!isNonEmptyString(entry.cause)) {
    fail("belief.history.cause", `history[${String(index)}].cause must be a non-empty string.`);
  }
  if (!isNonEmptyString(entry.ref)) {
    fail("belief.history.ref", `history[${String(index)}].ref must be a non-empty string.`);
  }
  const normalized: BeliefHistoryEntry = {
    ts,
    from: entry.from === null ? null : (entry.from as number),
    to: entry.to as number,
    cause: entry.cause as string,
    ref: entry.ref as string,
  };
  if (entry.folded !== undefined) {
    normalized.folded = validateFolded(entry.folded, normalized.cause);
  } else if (normalized.cause === HISTORY_SUMMARY_CAUSE) {
    fail(
      "belief.history.summary.shape",
      "A history summary entry must carry its folded payload.",
    );
  }
  return normalized;
}

function validateEvidence(value: unknown, origin: BeliefOrigin, sourceText?: string): BeliefEvidence {
  const evidence = checkedRecord(value, "belief.evidence");
  checkKeys(evidence, "belief.evidence", EVIDENCE_REQUIRED, EVIDENCE_OPTIONAL);
  if (!isNonNegativeInteger(evidence.occurrences)) {
    fail("belief.evidence.occurrences", "evidence.occurrences must be a non-negative integer.");
  }
  if (
    origin === "inferred"
    && (evidence.occurrences as number) < INFERRED_EVIDENCE_OCCURRENCES_MIN
  ) {
    fail(
      "belief.inferred.occurrences",
      `An inferred belief needs at least ${String(INFERRED_EVIDENCE_OCCURRENCES_MIN)} occurrences.`,
    );
  }
  const refs = checkedStringList(evidence.refs, "belief.evidence", "belief.evidence.refs");
  if (origin === "inferred" && refs.length === 0) {
    fail("belief.inferred.refs", "An inferred belief needs at least one evidence ref.");
  }
  if (typeof evidence.quote !== "string") {
    fail("belief.evidence.quote.type", "evidence.quote must be a string.");
  }
  const quote = evidence.quote;
  if (Array.from(quote).length > QUOTE_MAX_CHARS) {
    fail(
      "belief.evidence.quote.cap",
      `evidence.quote is longer than ${String(QUOTE_MAX_CHARS)} characters.`,
    );
  }
  if (origin === "declared" && quote.trim().length === 0) {
    fail("belief.declared.quote", "A declared belief must carry a quote.");
  }
  if (origin === "declared" && sourceText !== undefined && !sourceText.includes(quote)) {
    fail(
      "belief.declared.quote.literal",
      "The quote of a declared belief must appear literally in its source text.",
    );
  }
  if (
    evidence.decision_source !== undefined
    && evidence.decision_source !== null
    && !isNonEmptyString(evidence.decision_source)
  ) {
    fail("belief.evidence.decision_source", "evidence.decision_source must be a non-empty string.");
  }
  const normalized: BeliefEvidence = {
    occurrences: evidence.occurrences as number,
    refs,
    quote,
  };
  if (isNonEmptyString(evidence.decision_source)) {
    normalized.decision_source = evidence.decision_source;
  }
  return normalized;
}

export function validateBelief(value: unknown, options: BeliefValidationOptions = {}): Belief {
  const belief = checkedRecord(value, "belief");
  checkKeys(belief, "belief", BELIEF_REQUIRED, BELIEF_OPTIONAL);

  if (typeof belief.id !== "string") {
    fail("belief.id.type", "belief.id must be a string.");
  }
  if (!BELIEF_ID_PATTERN.test(belief.id)) {
    fail("belief.id.format", `belief.id "${belief.id}" does not match the belief id format.`);
  }
  if (!isNonEmptyString(belief.statement)) {
    fail("belief.statement", "belief.statement must be a non-empty string.");
  }
  if (!isNonEmptyString(belief.domain)) {
    fail("belief.domain", "belief.domain must be a non-empty string.");
  }
  if (belief.origin !== "declared" && belief.origin !== "inferred") {
    fail("belief.origin", 'belief.origin must be "declared" or "inferred".');
  }
  const origin: BeliefOrigin = belief.origin;
  if (
    belief.ledger_ref !== undefined
    && belief.ledger_ref !== null
    && !isNonEmptyString(belief.ledger_ref)
  ) {
    fail("belief.ledger_ref.type", "belief.ledger_ref must be a non-empty string or null.");
  }
  if (isNonEmptyString(belief.ledger_ref) && origin !== "declared") {
    fail("belief.ledger_ref.origin", "Only a declared belief may point at the preference ledger.");
  }

  const evidence = validateEvidence(belief.evidence, origin, options.sourceText);

  if (!isFiniteNumber(belief.confidence)) {
    fail("belief.confidence.type", "belief.confidence must be a number.");
  }
  const confidence = belief.confidence;
  if (confidence < CONFIDENCE_FLOOR || confidence > CONFIDENCE_CEILING) {
    fail(
      "belief.confidence.range",
      `belief.confidence must sit within [${String(CONFIDENCE_FLOOR)}, ${String(CONFIDENCE_CEILING)}].`,
    );
  }
  if (typeof belief.rank !== "string" || !BELIEF_RANKS.some((rank) => rank === belief.rank)) {
    fail("belief.rank.value", "belief.rank is not one of the four ranks.");
  }
  const rank = belief.rank as BeliefRank;
  if (rank !== rankForConfidence(confidence)) {
    fail(
      "belief.rank.coherence",
      `belief.rank "${rank}" contradicts a confidence of ${String(confidence)}.`,
    );
  }
  if (typeof belief.locked !== "boolean") {
    fail("belief.locked.type", "belief.locked must be a boolean.");
  }
  for (const key of ["opportunities", "applications", "corrections"] as const) {
    if (!isNonNegativeInteger(belief[key])) {
      fail("belief.counters", `belief.${key} must be a non-negative integer.`);
    }
  }
  if ((belief.applications as number) > (belief.opportunities as number)) {
    fail("belief.counters.coherence", "A belief cannot be applied more often than it had occasions.");
  }

  const createdAt = checkedTs(belief.created_at, "belief.created_at");
  const seenAt = checkedTs(belief.seen_at, "belief.seen_at");
  const movedAt = checkedTs(belief.moved_at, "belief.moved_at");
  const createdMs = parseTs(createdAt).getTime();
  if (parseTs(seenAt).getTime() < createdMs || parseTs(movedAt).getTime() < createdMs) {
    fail("belief.dates.order", "belief.seen_at and belief.moved_at cannot precede belief.created_at.");
  }

  if (!Array.isArray(belief.history) || belief.history.length === 0) {
    fail("belief.history.shape", "belief.history must be a non-empty array.");
  }
  const history = (belief.history as unknown[]).map((entry, index) =>
    validateHistoryEntry(entry, index));
  let previousMs = Number.NEGATIVE_INFINITY;
  for (const [index, entry] of history.entries()) {
    const currentMs = parseTs(entry.ts).getTime();
    if (currentMs <= previousMs) {
      fail(
        "belief.history.monotonic",
        `belief.history is not strictly increasing in ts at index ${String(index)}.`,
      );
    }
    previousMs = currentMs;
    if (entry.from === null && (index !== 0 || entry.cause !== "creation")) {
      fail(
        "belief.history.from",
        "Only the first entry of a history, the creation, may carry a null from.",
      );
    }
  }
  const last = history[history.length - 1];
  if (!last || last.ts !== movedAt) {
    fail("belief.moved_at.coherence", "belief.moved_at must equal the ts of the last history entry.");
  }

  // Checked before the sanction rule below so a belief handed in as a creation
  // gets the sharper diagnosis of the two.
  if (options.creation === true) {
    if (rank !== "active") {
      fail("belief.creation.rank", "A belief is born at rank active and nowhere else.");
    }
    if (confidence !== CONFIDENCE_CREATION) {
      fail(
        "belief.creation.confidence",
        `A belief is born at confidence ${String(CONFIDENCE_CREATION)} and nowhere else.`,
      );
    }
    if (history.length !== 1 || history[0]?.cause !== "creation") {
      fail("belief.creation.history", "A belief is born with exactly one creation history entry.");
    }
  }

  // A belief born at rank active can only reach shadow after being demoted, so
  // rank shadow demands a move that is not the creation. Stated on the cause
  // rather than on a null `from` so it still holds once the oldest entries have
  // been folded into a summary.
  if (rank === "shadow" && !history.some((entry) => entry.cause !== "creation")) {
    fail(
      "belief.shadow.sanction",
      "Rank shadow is a sanction: it demands a demotion in the history, and this belief has none.",
    );
  }

  const now = options.now ?? nowTs();
  const normalized: Belief = {
    id: belief.id,
    statement: belief.statement,
    domain: belief.domain,
    origin,
    evidence,
    rank,
    confidence,
    locked: belief.locked,
    opportunities: belief.opportunities as number,
    applications: belief.applications as number,
    corrections: belief.corrections as number,
    created_at: createdAt,
    seen_at: seenAt,
    moved_at: movedAt,
    history,
  };
  if (belief.ledger_ref !== undefined) {
    normalized.ledger_ref = isNonEmptyString(belief.ledger_ref) ? belief.ledger_ref : null;
  }

  if (origin === "inferred" && rank === "law" && !inferredSurvivalReached(normalized, now)) {
    fail(
      "belief.inferred.law",
      "An inferred belief cannot sit at rank law before it has met the survival threshold.",
    );
  }

  return normalized;
}

const DOCUMENT_REQUIRED = ["updated_at", "beliefs"] as const;
const DOCUMENT_OPTIONAL = ["schema_version", "operations"] as const;
const OPERATION_REQUIRED = ["operation_id", "digest", "ts"] as const;

export function validateBeliefDocument(
  value: unknown,
  options: BeliefValidationOptions = {},
): BeliefDocument {
  const document = checkedRecord(value, "beliefs");
  checkKeys(document, "beliefs", DOCUMENT_REQUIRED, DOCUMENT_OPTIONAL);
  const schemaVersion = checkedSchemaVersion(document.schema_version, "beliefs");
  const updatedAt = checkedTs(document.updated_at, "updated_at");
  if (!Array.isArray(document.beliefs)) {
    fail("beliefs.list", "beliefs must be an array.");
  }
  const beliefs = (document.beliefs as unknown[]).map((belief) => validateBelief(belief, options));
  const seen = new Set<string>();
  for (const belief of beliefs) {
    if (seen.has(belief.id)) {
      fail("belief.id.unique", `The belief id "${belief.id}" appears more than once.`);
    }
    seen.add(belief.id);
  }

  const operations: OperationRecord[] = [];
  if (document.operations !== undefined) {
    if (!Array.isArray(document.operations)) {
      fail("beliefs.operations", "beliefs.operations must be an array.");
    }
    for (const entry of document.operations as unknown[]) {
      const operation = checkedRecord(entry, "beliefs.operations");
      checkKeys(operation, "beliefs.operations", OPERATION_REQUIRED, []);
      if (!isNonEmptyString(operation.operation_id) || !isNonEmptyString(operation.digest)) {
        fail("beliefs.operations", "An operation record needs an operation_id and a digest.");
      }
      operations.push({
        operation_id: operation.operation_id,
        digest: operation.digest,
        ts: checkedTs(operation.ts, "operation.ts"),
      });
    }
  }

  return { schema_version: schemaVersion, updated_at: updatedAt, beliefs, operations };
}

const DECISION_REQUIRED = [
  "id",
  "ts",
  "session",
  "type",
  "input",
  "options",
  "choice",
  "score",
  "beliefs_applied",
  "beliefs_evicted",
  "documents",
  "cost",
  "verdict",
] as const;
const DECISION_OPTIONAL = ["schema_version", "truncated"] as const;

export function validateDecision(value: unknown): DecisionEntry {
  const decision = checkedRecord(value, "decision");
  checkKeys(decision, "decision", DECISION_REQUIRED, DECISION_OPTIONAL);
  const schemaVersion = checkedSchemaVersion(decision.schema_version, "decision");

  if (typeof decision.id !== "string") {
    fail("decision.id.type", "decision.id must be a string.");
  }
  if (!DECISION_ID_PATTERN.test(decision.id)) {
    fail("decision.id.format", `decision.id "${decision.id}" does not match the decision id format.`);
  }
  const ts = checkedTs(decision.ts, "decision.ts");
  if (!isNonEmptyString(decision.session)) {
    fail("decision.session", "decision.session must be a non-empty string.");
  }
  if (
    typeof decision.type !== "string"
    || !DECISION_TYPES.some((type) => type === decision.type)
  ) {
    fail("decision.type", `decision.type "${String(decision.type)}" is not a decision type.`);
  }

  const input = checkedRecord(decision.input, "decision.input");
  checkKeys(input, "decision.input", ["hash", "summary"], []);
  if (typeof input.hash !== "string") {
    fail("decision.input.hash.type", "decision.input.hash must be a string.");
  }
  if (!SHA1_PATTERN.test(input.hash)) {
    fail("decision.input.hash.format", "decision.input.hash must look like sha1:<40 hex>.");
  }
  if (typeof input.summary !== "string") {
    fail("decision.input.summary.type", "decision.input.summary must be a string.");
  }
  if (Array.from(input.summary).length > INPUT_SUMMARY_CAP) {
    fail(
      "decision.input.summary.cap",
      `decision.input.summary is longer than ${String(INPUT_SUMMARY_CAP)} characters.`,
    );
  }

  const options = checkedStringList(decision.options, "decision", "decision.options");
  if (decision.choice !== null && typeof decision.choice !== "string") {
    fail("decision.choice.type", "decision.choice must be a string or null.");
  }
  const choice = decision.choice as string | null;
  if (choice !== null && options.length > 0 && !options.includes(choice)) {
    fail("decision.choice.coherence", `decision.choice "${choice}" is not one of the options.`);
  }
  if (decision.score !== null && !isFiniteNumber(decision.score)) {
    fail("decision.score", "decision.score must be a number or null.");
  }

  const applied = checkedStringList(decision.beliefs_applied, "decision", "decision.beliefs.type");
  const evicted = checkedStringList(decision.beliefs_evicted, "decision", "decision.beliefs.type");
  for (const id of [...applied, ...evicted]) {
    if (!BELIEF_ID_PATTERN.test(id)) {
      fail("decision.beliefs.id", `"${id}" is not a belief id.`);
    }
  }
  if (applied.some((id) => evicted.includes(id))) {
    fail("decision.beliefs.disjoint", "A belief cannot be applied and evicted by the same decision.");
  }
  const documents = checkedStringList(decision.documents, "decision", "decision.documents");

  const cost = checkedRecord(decision.cost, "decision.cost");
  checkKeys(cost, "decision.cost", ["tokens_estimated", "ms"], []);
  for (const key of ["tokens_estimated", "ms"] as const) {
    if (!isNonNegativeInteger(cost[key])) {
      fail("decision.cost", `decision.cost.${key} must be a non-negative integer.`);
    }
  }

  if (
    decision.verdict !== null
    && (typeof decision.verdict !== "string"
      || !VERDICT_OUTCOMES.some((outcome) => outcome === decision.verdict))
  ) {
    fail("decision.verdict", "decision.verdict must be good, bad, undetermined, or null.");
  }
  if (decision.truncated !== undefined && typeof decision.truncated !== "boolean") {
    fail("decision.truncated", "decision.truncated must be a boolean.");
  }

  const normalized: DecisionEntry = {
    schema_version: schemaVersion,
    id: decision.id,
    ts,
    session: decision.session,
    type: decision.type as DecisionType,
    input: { hash: input.hash, summary: input.summary },
    options,
    choice,
    score: decision.score as number | null,
    beliefs_applied: applied,
    beliefs_evicted: evicted,
    documents,
    cost: {
      tokens_estimated: cost.tokens_estimated as number,
      ms: cost.ms as number,
    },
    verdict: decision.verdict as VerdictOutcome | null,
  };
  if (decision.truncated === true) {
    normalized.truncated = true;
  }
  return normalized;
}

const CONSOLIDATION_REQUIRED = [
  "id",
  "ts",
  "type",
  "document",
  "before",
  "after",
  "blocks",
  "deconsolidation_verified",
] as const;
const CONSOLIDATION_OPTIONAL = ["schema_version", "truncated"] as const;
const BLOCK_REQUIRED = [
  "archive",
  "period",
  "entries",
  "size",
  "sha256_block",
  "reread_ok",
] as const;

function validateDigestPair(value: unknown, label: string): { size: number; sha256: string } {
  const pair = checkedRecord(value, `consolidation.${label}`);
  checkKeys(pair, `consolidation.${label}`, ["size", "sha256"], []);
  if (!isNonNegativeInteger(pair.size)) {
    fail("consolidation.digest.size", `consolidation.${label}.size must be a non-negative integer.`);
  }
  if (typeof pair.sha256 !== "string" || !SHA256_PATTERN.test(pair.sha256)) {
    fail("consolidation.digest.sha256", `consolidation.${label}.sha256 must be 64 lowercase hex.`);
  }
  return { size: pair.size as number, sha256: pair.sha256 };
}

export function validateConsolidation(value: unknown): ConsolidationEntry {
  const entry = checkedRecord(value, "consolidation");
  checkKeys(entry, "consolidation", CONSOLIDATION_REQUIRED, CONSOLIDATION_OPTIONAL);
  const schemaVersion = checkedSchemaVersion(entry.schema_version, "consolidation");
  if (typeof entry.id !== "string" || !DECISION_ID_PATTERN.test(entry.id)) {
    fail("consolidation.id.format", "A consolidation carries a journal entry id.");
  }
  const ts = checkedTs(entry.ts, "consolidation.ts");
  if (entry.type !== "consolidated") {
    fail("consolidation.type", 'consolidation.type must be exactly "consolidated".');
  }
  if (!isNonEmptyString(entry.document)) {
    fail("consolidation.document", "consolidation.document must be a non-empty string.");
  }
  const before = validateDigestPair(entry.before, "before");
  const after = validateDigestPair(entry.after, "after");
  if (after.size > before.size) {
    fail(
      "consolidation.size.monotonic_decrease",
      "A consolidation never makes the living document grow.",
    );
  }
  if (!Array.isArray(entry.blocks) || entry.blocks.length === 0) {
    fail("consolidation.blocks.empty", "A consolidation must move at least one block.");
  }
  const blocks: ConsolidationBlock[] = [];
  for (const raw of entry.blocks as unknown[]) {
    const block = checkedRecord(raw, "consolidation.blocks");
    checkKeys(block, "consolidation.blocks", BLOCK_REQUIRED, []);
    if (!isNonEmptyString(block.archive)) {
      fail("consolidation.blocks.archive.type", "A block archive must be a non-empty path.");
    }
    if (block.archive.split("/").includes("..")) {
      fail("consolidation.blocks.archive.zone", "A block archive path may not walk up the tree.");
    }
    if (typeof block.period !== "string" || !PERIOD_PATTERN.test(block.period)) {
      fail("consolidation.blocks.period", "A block period must read YYYY-MM-DD/YYYY-MM-DD.");
    }
    if (!Number.isInteger(block.entries) || (block.entries as number) < 1) {
      fail("consolidation.blocks.entries", "A block must carry at least one entry.");
    }
    if (!Number.isInteger(block.size) || (block.size as number) < 1) {
      fail("consolidation.blocks.size", "A block must carry at least one byte.");
    }
    if (typeof block.sha256_block !== "string" || !SHA256_PATTERN.test(block.sha256_block)) {
      fail("consolidation.blocks.sha256", "A block digest must be 64 lowercase hex.");
    }
    if (typeof block.reread_ok !== "boolean") {
      fail("consolidation.blocks.reread_ok.type", "A block reread_ok must be a boolean.");
    }
    blocks.push({
      archive: block.archive,
      period: block.period,
      entries: block.entries as number,
      size: block.size as number,
      sha256_block: block.sha256_block,
      reread_ok: block.reread_ok,
    });
  }
  if (typeof entry.deconsolidation_verified !== "boolean") {
    fail(
      "consolidation.deconsolidation_verified.type",
      "consolidation.deconsolidation_verified must be a boolean.",
    );
  }
  const aborted = !entry.deconsolidation_verified || blocks.some((block) => !block.reread_ok);
  if (aborted && (after.size !== before.size || after.sha256 !== before.sha256)) {
    fail(
      "consolidation.abort.document_untouched",
      "On an abort the living document must be strictly identical to what it was.",
    );
  }
  if (entry.truncated !== undefined && typeof entry.truncated !== "boolean") {
    fail("consolidation.truncated", "consolidation.truncated must be a boolean.");
  }

  const normalized: ConsolidationEntry = {
    schema_version: schemaVersion,
    id: entry.id,
    ts,
    type: "consolidated",
    document: entry.document,
    before,
    after,
    blocks,
    deconsolidation_verified: entry.deconsolidation_verified,
  };
  if (entry.truncated === true) {
    normalized.truncated = true;
  }
  return normalized;
}

export function validateJournalEntry(value: unknown): JournalEntry {
  const record = checkedRecord(value, "journal");
  return record.type === "consolidated" ? validateConsolidation(record) : validateDecision(record);
}

const OBSERVATION_REQUIRED = ["id", "sensor", "ts", "subject", "measure", "derived"] as const;
const OBSERVATION_OPTIONAL = ["schema_version", "population", "truncated"] as const;

export interface ObservationValidationOptions {
  /** When given, a documentary reading must name a document of that population. */
  population?: readonly string[];
}

export function validateObservation(
  value: unknown,
  options: ObservationValidationOptions = {},
): Observation {
  const observation = checkedRecord(value, "observation");
  checkKeys(observation, "observation", OBSERVATION_REQUIRED, OBSERVATION_OPTIONAL);
  const schemaVersion = checkedSchemaVersion(observation.schema_version, "observation");
  if (typeof observation.id !== "string") {
    fail("observation.id.type", "observation.id must be a string.");
  }
  if (!OBSERVATION_ID_PATTERN.test(observation.id)) {
    fail("observation.id.format", `observation.id "${observation.id}" is malformed.`);
  }
  if (
    typeof observation.sensor !== "string"
    || !SENSORS.some((sensor) => sensor === observation.sensor)
  ) {
    fail("observation.sensor", `"${String(observation.sensor)}" is not a declared sensor.`);
  }
  const sensor = observation.sensor as SensorName;
  const ts = checkedTs(observation.ts, "observation.ts");
  if (!isNonEmptyString(observation.subject)) {
    fail("observation.subject", "observation.subject must be a non-empty string.");
  }
  const documentary = DOCUMENTARY_SENSORS.includes(sensor);
  if (observation.population === undefined && documentary) {
    fail(
      "observation.population.required",
      `The sensor "${sensor}" reads documents, so it must name the document it read.`,
    );
  }
  if (observation.population !== undefined && !isNonEmptyString(observation.population)) {
    fail("observation.population.type", "observation.population must be a non-empty string.");
  }
  if (
    typeof observation.population === "string"
    && options.population !== undefined
    && !options.population.includes(observation.population)
  ) {
    fail(
      "observation.population.unknown",
      `"${observation.population}" is not part of the sensor population.`,
    );
  }
  const measure = checkedNumberMap(
    observation.measure,
    "observation.measure",
    "observation.measure must be a non-empty map of numbers.",
    false,
  );
  const derived = checkedNumberMap(
    observation.derived,
    "observation.derived",
    "observation.derived must be a map of numbers.",
    true,
  );
  if (observation.truncated !== undefined && typeof observation.truncated !== "boolean") {
    fail("observation.truncated", "observation.truncated must be a boolean.");
  }

  const normalized: Observation = {
    schema_version: schemaVersion,
    id: observation.id,
    sensor,
    ts,
    subject: observation.subject,
    measure,
    derived,
  };
  if (typeof observation.population === "string") {
    normalized.population = observation.population;
  }
  if (observation.truncated === true) {
    normalized.truncated = true;
  }
  return normalized;
}

const VERDICT_REQUIRED = [
  "decision_id",
  "rule",
  "verdict",
  "weight",
  "armed",
  "evidence",
  "evaluated_at",
] as const;
const VERDICT_OPTIONAL = ["schema_version", "truncated"] as const;

export function validateVerdict(value: unknown): Verdict {
  const verdict = checkedRecord(value, "verdict");
  checkKeys(verdict, "verdict", VERDICT_REQUIRED, VERDICT_OPTIONAL);
  const schemaVersion = checkedSchemaVersion(verdict.schema_version, "verdict");
  if (typeof verdict.decision_id !== "string") {
    fail("verdict.decision_id.type", "verdict.decision_id must be a string.");
  }
  if (!DECISION_ID_PATTERN.test(verdict.decision_id)) {
    fail("verdict.decision_id.format", "verdict.decision_id must be a decision id.");
  }
  if (typeof verdict.rule !== "string" || !VERDICT_RULES.some((rule) => rule === verdict.rule)) {
    fail("verdict.rule", `"${String(verdict.rule)}" is not one of the evaluation rules.`);
  }
  const rule = verdict.rule as VerdictRule;
  if (
    typeof verdict.verdict !== "string"
    || !VERDICT_OUTCOMES.some((outcome) => outcome === verdict.verdict)
  ) {
    fail("verdict.verdict", "verdict.verdict must be good, bad, or undetermined.");
  }
  if (
    !Number.isInteger(verdict.weight)
    || (verdict.weight as number) < VERDICT_WEIGHT_MIN
    || (verdict.weight as number) > VERDICT_WEIGHT_MAX
  ) {
    fail(
      "verdict.weight",
      `verdict.weight must be an integer within [${String(VERDICT_WEIGHT_MIN)}, ${String(VERDICT_WEIGHT_MAX)}].`,
    );
  }
  if (typeof verdict.armed !== "boolean") {
    fail("verdict.armed.type", "verdict.armed must be a boolean.");
  }
  if (verdict.armed === true && DISARMED_RULES.includes(rule)) {
    fail(
      "verdict.armed.disarmed",
      `The rule "${rule}" needs calibration before it may be armed, so the contract refuses it armed.`,
    );
  }
  if (!isRecord(verdict.evidence) || Object.keys(verdict.evidence).length === 0) {
    fail("verdict.evidence.empty", "A verdict without evidence is an opinion, so it is refused.");
  }
  const evaluatedAt = checkedTs(verdict.evaluated_at, "verdict.evaluated_at");
  if (verdict.truncated !== undefined && typeof verdict.truncated !== "boolean") {
    fail("verdict.truncated", "verdict.truncated must be a boolean.");
  }

  const normalized: Verdict = {
    schema_version: schemaVersion,
    decision_id: verdict.decision_id,
    rule,
    verdict: verdict.verdict as VerdictOutcome,
    weight: verdict.weight as number,
    armed: verdict.armed,
    evidence: { ...verdict.evidence },
    evaluated_at: evaluatedAt,
  };
  if (verdict.truncated === true) {
    normalized.truncated = true;
  }
  return normalized;
}

export interface CreateBeliefInput {
  statement: string;
  domain?: string;
  origin?: BeliefOrigin;
  evidence: {
    quote: string;
    occurrences?: number;
    refs?: string[];
    decision_source?: string;
  };
  ledger_ref?: string;
  /** Explicit id, otherwise derived from the statement. */
  id?: string;
  /** Ref of the creation history entry. */
  ref?: string;
  now?: string;
  /** Source text the quote of a declared belief must appear in, literally. */
  sourceText?: string;
}

export function slugifyBeliefId(statement: string): string {
  const words = normalize(statement).match(/[a-z0-9]+/gu) ?? [];
  if (words.length === 0) {
    throw new SchemaError("A belief id cannot be derived from a statement without letters or digits.");
  }
  let id = "b_";
  for (const word of words) {
    const candidate = id === "b_" ? id + word : `${id}_${word}`;
    if (candidate.length > BELIEF_ID_MAX_CHARS) {
      break;
    }
    id = candidate;
  }
  if (id === "b_") {
    id = `b_${words[0]?.slice(0, BELIEF_ID_MAX_CHARS - 2) ?? ""}`;
  }
  return id;
}

/**
 * The one way into the belief population. There is no parameter for the rank
 * and none for the confidence: a belief enters at confidence 3 and rank active,
 * and `shadow` stays what it is, a sanction handed out later.
 */
export function createBelief(input: CreateBeliefInput): NewBelief {
  const now = input.now ?? nowTs();
  checkedTs(now, "createBelief now");
  const ref = input.ref ?? "creation";
  const origin: BeliefOrigin = input.origin ?? "declared";
  const evidence: BeliefEvidence = {
    occurrences: input.evidence.occurrences ?? 1,
    refs: input.evidence.refs ?? [],
    quote: input.evidence.quote,
  };
  if (input.evidence.decision_source !== undefined) {
    evidence.decision_source = input.evidence.decision_source;
  }

  const belief: NewBelief = {
    id: input.id ?? slugifyBeliefId(input.statement),
    statement: input.statement.trim(),
    domain: input.domain?.trim() || "general",
    origin,
    evidence,
    rank: "active",
    confidence: CONFIDENCE_CREATION,
    locked: false,
    opportunities: 0,
    applications: 0,
    corrections: 0,
    created_at: now,
    seen_at: now,
    moved_at: now,
    history: [{ ts: now, from: null, to: CONFIDENCE_CREATION, cause: "creation", ref }],
  };
  if (input.ledger_ref !== undefined) {
    belief.ledger_ref = input.ledger_ref;
  }

  const validationOptions: BeliefValidationOptions = { now, creation: true };
  if (input.sourceText !== undefined) {
    validationOptions.sourceText = input.sourceText;
  }
  validateBelief(belief, validationOptions);
  return belief;
}

export function encodeLine(record: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch {
    throw new InvariantError("json.serializable", "A journal record must be JSON serializable.");
  }
  if (json === undefined) {
    throw new InvariantError("json.serializable", "A journal record must be JSON serializable.");
  }
  if (json.includes("\n")) {
    throw new InvariantError("line.newline", "A journal line may not contain a newline.");
  }
  return `${json}\n`;
}

export function lineSize(record: unknown): number {
  return Buffer.byteLength(encodeLine(record), "utf8");
}

interface Reducible {
  container: Record<string, unknown> | unknown[];
  key: string | number;
  kind: "string" | "array";
  size: number;
}

function collectReducibles(value: unknown, parentKey: string | undefined, found: Reducible[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectReducibles(item, parentKey, found);
      if (typeof item === "string") {
        found.push({ container: value, key: index, kind: "string", size: item.length });
      }
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (ESSENTIAL_LINE_FIELDS.includes(key)) {
      continue;
    }
    if (typeof item === "string") {
      found.push({ container: value, key, kind: "string", size: item.length });
      continue;
    }
    if (Array.isArray(item)) {
      const floor = FLOOR_ONE_LISTS.includes(key) ? 1 : 0;
      if (item.length > floor) {
        found.push({ container: value, key, kind: "array", size: JSON.stringify(item).length });
      }
      collectReducibles(item, key, found);
      continue;
    }
    collectReducibles(item, key, found);
  }
}

export interface FitLineResult<T> {
  record: T;
  truncated: boolean;
}

/**
 * Shrinks a record until its encoded line fits the hard cap. Essential fields
 * are never touched at any depth, a list whose contract demands one element
 * stops at one, and a string never shrinks to empty because a contract that
 * demands a non-empty string would be violated by the fix rather than by the
 * overflow. When nothing is left to reduce and the line still overflows, it
 * raises rather than return a record that no longer validates.
 *
 * The flag says "this line WAS truncated": an existing one is preserved, never
 * cleared.
 */
export function fitLine<T>(record: T, maxBytes: number = LINE_MAX_BYTES): FitLineResult<T> {
  const alreadyTruncated = isRecord(record) && record.truncated === true;
  if (lineSize(record) <= maxBytes && !alreadyTruncated) {
    return { record, truncated: false };
  }

  const working = JSON.parse(JSON.stringify(record)) as T;
  const asRecord: Record<string, unknown> | undefined = isRecord(working) ? working : undefined;
  if (asRecord && alreadyTruncated) {
    asRecord.truncated = true;
  }
  let truncated = alreadyTruncated;

  while (lineSize(working) > maxBytes) {
    if (asRecord && asRecord.truncated !== true) {
      // Setting the flag costs bytes, so it is set before measuring again.
      asRecord.truncated = true;
      truncated = true;
      continue;
    }
    const found: Reducible[] = [];
    collectReducibles(working, undefined, found);
    // A list gives up a whole element before any string is mangled: dropping an
    // item loses it honestly, while cutting a constrained string inside a
    // structured item would produce something that still looks real and is not.
    const target = found.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "array" ? -1 : 1;
      }
      return right.size - left.size;
    })[0];
    if (!target || target.size <= 1) {
      throw new InvariantError(
        "line.cap.irreducible",
        `A journal line still exceeds ${String(maxBytes)} bytes with nothing left to reduce.`,
      );
    }
    truncated = true;
    if (target.kind === "array") {
      const list = (target.container as Record<string, unknown>)[target.key as string];
      if (Array.isArray(list)) {
        list.pop();
      }
      continue;
    }
    const container = target.container as Record<string | number, unknown>;
    const current = container[target.key];
    if (typeof current === "string") {
      container[target.key] = current.slice(0, Math.max(1, Math.floor(current.length / 2)));
    }
  }

  return { record: working, truncated };
}

// ---------------------------------------------------------------------------
// The load contract: the frontmatter declaration of a bounded document, read
// by the consolidation organ before it moves a single byte. The reader itself,
// readLoadContract, stays in learning/consolidation.ts because it also needs
// the archive zone of the vault it is running against; only the shape and its
// validator live here, with every other frozen shape of this layer.
// ---------------------------------------------------------------------------

export const LOAD_POLICIES = ["dated_rotation", "fifo_rotation", "refuse"] as const;
export type LoadPolicy = (typeof LOAD_POLICIES)[number];

export interface LoadContract {
  lifecycle: string;
  /** Hard cap of the living document, in characters. */
  load_max: number;
  load_policy: LoadPolicy;
  load_archive: string;
  load_boundary: string;
}

export interface LoadContractOptions {
  /** The archive zone a load_archive path must live under, trailing slash included. */
  archiveZone: string;
}

const LOAD_INTEGER_PATTERN = /^-?\d+$/u;

function isLoadPolicy(value: string): value is LoadPolicy {
  return LOAD_POLICIES.some((policy) => policy === value);
}

function unquoteLoadValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Reads and validates the load contract of a bounded document. The reader is
 * deliberately poor: flat `key: value`, surrounding quotes removed, integers
 * recognized by shape. An unterminated frontmatter yields no contract at all
 * rather than a partial one.
 */
export function validateLoadContract(text: string, options: LoadContractOptions): LoadContract {
  const frontmatter = splitFrontmatter(text).frontmatter ?? {};
  const lifecycle = unquoteLoadValue(frontmatter.lifecycle ?? "");
  if (lifecycle.length === 0) {
    fail("load.lifecycle", "A bounded document must declare a lifecycle.");
  }

  const rawMax = frontmatter.load_max;
  if (rawMax === undefined) {
    fail(
      "load.load_max.missing",
      "This document carries no load_max, so Open Brain has no cap to hold it to and will not touch it.",
    );
  }
  const cleanedMax = unquoteLoadValue(rawMax);
  if (!LOAD_INTEGER_PATTERN.test(cleanedMax)) {
    fail("load.load_max", "load_max must be an integer number of characters.");
  }
  const loadMax = Number.parseInt(cleanedMax, 10);
  if (loadMax <= 0) {
    fail("load.load_max", "load_max must be strictly positive.");
  }

  const rawPolicy = unquoteLoadValue(frontmatter.load_policy ?? "");
  if (!isLoadPolicy(rawPolicy)) {
    fail(
      "load.load_policy",
      `load_policy must be one of ${LOAD_POLICIES.join(", ")}.`,
    );
  }

  const archive = toPosixPath(unquoteLoadValue(frontmatter.load_archive ?? ""));
  if (rawPolicy !== "refuse" && archive.length === 0) {
    fail("load.load_archive.type", "load_archive must name the directory the overflow moves to.");
  }
  if (archive.length > 0) {
    const zone = options.archiveZone;
    if (archive.split("/").includes("..") || !`${archive}/`.startsWith(zone)) {
      fail(
        "load.load_archive.zone",
        `load_archive must live under ${zone} and may not walk up the tree.`,
      );
    }
  }

  const boundary = unquoteLoadValue(frontmatter.load_boundary ?? "");
  if (rawPolicy === "dated_rotation") {
    if (boundary.length === 0) {
      fail("load.load_boundary.missing", "A dated rotation needs a load_boundary to cut on.");
    }
    try {
      new RegExp(boundary);
    } catch {
      fail("load.load_boundary.regex", `load_boundary "${boundary}" is not a valid expression.`);
    }
  }

  return {
    lifecycle,
    load_max: loadMax,
    load_policy: rawPolicy,
    load_archive: archive.replace(/\/+$/u, ""),
    load_boundary: boundary,
  };
}

// ---------------------------------------------------------------------------
// The classification contract: the output of the classifier, the input of the
// gate. It is deliberately strict and deliberately dumb, a JSON array
// validated field by field with unknown keys refused rather than ignored. The
// classifier is a model, so its output is untrusted input; the only thing
// standing between a hallucinated field and the preference kernel is this
// parser and the human review that comes after it. Nothing here calls a
// model, reads a transcript, or touches the vault.
// ---------------------------------------------------------------------------

export const CLASSIFICATION_SCHEMA = "open-brain/classification/v1";
export const CLASSIFICATION_SCHEMA_VERSION = 1;

/** A batch is capped at the same size the store caps a deposit batch at. */
export const MAX_CLASSIFICATION_ITEMS = MAX_BATCH_ITEMS;

/**
 * The two Unicode dashes that must never reach a persisted artifact. They are
 * written as escapes on purpose: the repository lint refuses the literal
 * character anywhere, including in the code that rejects it.
 */
const CLASSIFICATION_EN_DASH = "\u2013";
const CLASSIFICATION_EM_DASH = "\u2014";

const CLASSIFICATION_REQUIRED_ITEM_FIELDS: readonly string[] = [
  "id",
  "type",
  "target",
  "content",
  "proposed_weight",
  "reason",
  "proofs",
  "status",
];

const CLASSIFICATION_COMMON_OPTIONAL_ITEM_FIELDS: readonly string[] = [
  "merged_ids",
  "weak",
  "recommendation",
  "evidence_basis",
];

/** Only a preference carries these: they describe how a preference applies. */
const CLASSIFICATION_PREFERENCE_ONLY_FIELDS: readonly string[] = ["domains", "why", "apply"];

export const CLASSIFICATION_ITEM_FIELDS: readonly string[] = [
  ...CLASSIFICATION_REQUIRED_ITEM_FIELDS,
  ...CLASSIFICATION_COMMON_OPTIONAL_ITEM_FIELDS,
  ...CLASSIFICATION_PREFERENCE_ONLY_FIELDS,
];

export const PREFERENCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const DOMAIN_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** The weight every new preference enters at. A creation never enters higher. */
export const NEW_PREFERENCE_WEIGHT = 2;

export interface ClassificationItem {
  id: string;
  /** Always present after parsing, sorted, and always containing id. */
  merged_ids: string[];
  type: ProposalType;
  target: string;
  content: string;
  proposed_weight: number | null;
  reason: string;
  proofs: Proof[];
  status: "proposed";
  weak: boolean;
  recommendation: Recommendation;
  evidence_basis: EvidenceBasis | null;
  domains?: string[];
  why?: string;
  apply?: string;
}

/** A malformed classification. Never a crash, always a readable refusal. */
export class ClassificationError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "ClassificationError";
  }
}

function countPoints(value: string): number {
  return Array.from(value).length;
}

/**
 * Walks the whole document, keys included, looking for either Unicode dash.
 * They are refused because they survive a copy into a preference statement and
 * then into every prompt that preference is injected in, where they are both
 * invisible to the author and impossible to type back.
 */
export function assertNoForbiddenDashes(value: unknown, where = "classification"): void {
  if (typeof value === "string") {
    if (value.includes(CLASSIFICATION_EN_DASH) || value.includes(CLASSIFICATION_EM_DASH)) {
      throw new ClassificationError(
        `${where} contains a Unicode dash (U+2013 or U+2014), which is refused everywhere in Open Brain. Use a plain hyphen or rewrite the sentence.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoForbiddenDashes(item, `${where}[${String(index)}]`);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertNoForbiddenDashes(key, `${where} key`);
      assertNoForbiddenDashes(item, `${where}.${key}`);
    }
  }
}

function requiredText(value: unknown, field: string, where: string, cap: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClassificationError(`${where}.${field} must be a non-empty string.`);
  }
  if (countPoints(value) > cap) {
    throw new ClassificationError(
      `${where}.${field} may not exceed ${String(cap)} characters.`,
    );
  }
  return value;
}

function parseProofs(value: unknown, where: string): Proof[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClassificationError(
      `${where}.proofs must be a non-empty array of {date, quote} objects. A proposal with no proof is an opinion, and the gate refuses opinions.`,
    );
  }
  const seen = new Set<string>();
  const proofs: Proof[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const proof: unknown = value[index];
    const label = `${where}.proofs[${String(index)}]`;
    if (!isRecord(proof)) {
      throw new ClassificationError(`${label} must be an object.`);
    }
    const extra = Object.keys(proof).filter((key) => key !== "date" && key !== "quote");
    if (extra.length > 0) {
      throw new ClassificationError(
        `${label} carries only a date and a quote, found ${extra.sort().join(", ")}.`,
      );
    }
    if (!isCalendarDate(proof.date)) {
      throw new ClassificationError(
        `${label}.date must be a real calendar date in YYYY-MM-DD form, received ${JSON.stringify(proof.date)}.`,
      );
    }
    const quote = requiredText(proof.quote, "quote", label, QUOTE_CAP);
    const key = JSON.stringify([proof.date, quote]);
    if (seen.has(key)) {
      throw new ClassificationError(`${label} repeats an earlier (date, quote) pair.`);
    }
    seen.add(key);
    proofs.push({ date: proof.date, quote });
  }
  return proofs;
}

function parseMergedIds(value: unknown, id: string, where: string): string[] {
  if (value === undefined) {
    return [id];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClassificationError(`${where}.merged_ids must be a non-empty array of ids.`);
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ClassificationError(`${where}.merged_ids must contain non-empty strings.`);
    }
    if (ids.includes(entry)) {
      throw new ClassificationError(`${where}.merged_ids repeats ${entry}.`);
    }
    ids.push(entry);
  }
  if (!ids.includes(id)) {
    throw new ClassificationError(
      `${where}.merged_ids must contain its own id ${id}: a merge names every candidate it speaks for, including the main one.`,
    );
  }
  return [...ids].sort();
}

function parseDomains(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClassificationError(`${where}.domains must be a non-empty array of slugs.`);
  }
  const domains: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !DOMAIN_SLUG_PATTERN.test(entry)) {
      throw new ClassificationError(
        `${where}.domains must contain lowercase slugs, received ${JSON.stringify(entry)}.`,
      );
    }
    if (domains.includes(entry)) {
      throw new ClassificationError(`${where}.domains repeats ${entry}.`);
    }
    domains.push(entry);
  }
  return domains;
}

function parseProposedWeight(value: unknown, type: ProposalType, where: string): number | null {
  if (value !== null && (typeof value !== "number" || !Number.isInteger(value))) {
    throw new ClassificationError(`${where}.proposed_weight must be an integer or null.`);
  }
  if (type === "memory") {
    if (value !== null) {
      throw new ClassificationError(
        `${where}.proposed_weight must be null for a memory: a note carries no weight.`,
      );
    }
    return null;
  }
  if (value === null) {
    throw new ClassificationError(
      `${where}.proposed_weight is required for a ${type} proposal.`,
    );
  }
  if (value < 1 || value > 5) {
    throw new ClassificationError(`${where}.proposed_weight must be from 1 through 5.`);
  }
  if (type === "preference" && value !== NEW_PREFERENCE_WEIGHT) {
    throw new ClassificationError(
      `${where}.proposed_weight must be ${String(NEW_PREFERENCE_WEIGHT)} for a new preference. A preference earns its weight through evidence, it is never born strong.`,
    );
  }
  return value;
}

function parseOneItem(value: unknown, index: number): ClassificationItem {
  const where = `item ${String(index + 1)}`;
  if (!isRecord(value)) {
    throw new ClassificationError(`${where} must be a JSON object.`);
  }

  const missing = CLASSIFICATION_REQUIRED_ITEM_FIELDS.filter((field) => value[field] === undefined);
  if (missing.length > 0) {
    throw new ClassificationError(`${where} is missing ${missing.sort().join(", ")}.`);
  }

  if (value.status !== "proposed") {
    throw new ClassificationError(
      `${where}.status must be exactly "proposed": the classifier proposes, it never decides.`,
    );
  }

  const rawType = value.type;
  if (typeof rawType !== "string" || !PROPOSAL_TYPES.some((item) => item === rawType)) {
    throw new ClassificationError(
      `${where}.type must be one of ${PROPOSAL_TYPES.join(", ")}, received ${JSON.stringify(rawType)}.`,
    );
  }
  const type = rawType as ProposalType;

  const allowed = type === "preference"
    ? CLASSIFICATION_ITEM_FIELDS
    : [...CLASSIFICATION_REQUIRED_ITEM_FIELDS, ...CLASSIFICATION_COMMON_OPTIONAL_ITEM_FIELDS];
  const unknownFields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknownFields.length > 0) {
    throw new ClassificationError(
      `${where} carries unknown field(s) ${unknownFields.sort().join(", ")}. Allowed for a ${type}: ${allowed.join(", ")}.`,
    );
  }

  const id = requiredText(value.id, "id", where, TARGET_CAP);
  const target = requiredText(value.target, "target", where, TARGET_CAP);
  const content = requiredText(value.content, "content", where, CONTENT_CAP);
  const reason = requiredText(value.reason, "reason", where, REASON_CAP);
  const proofs = parseProofs(value.proofs, where);
  const mergedIds = parseMergedIds(value.merged_ids, id, where);
  const proposedWeight = parseProposedWeight(value.proposed_weight, type, where);

  if (value.weak !== undefined && typeof value.weak !== "boolean") {
    throw new ClassificationError(`${where}.weak must be a boolean when present.`);
  }
  const weak = value.weak === true;

  const rawRecommendation = value.recommendation;
  if (
    rawRecommendation !== undefined
    && rawRecommendation !== "approve"
    && rawRecommendation !== "reject_only"
  ) {
    throw new ClassificationError(
      `${where}.recommendation must be approve or reject_only when present.`,
    );
  }
  const recommendation: Recommendation = rawRecommendation === undefined
    ? (weak ? "reject_only" : "approve")
    : rawRecommendation;
  if (weak !== (recommendation === "reject_only")) {
    throw new ClassificationError(
      `${where} disagrees with itself: weak and reject_only are the same statement, so they must always be set together.`,
    );
  }

  const rawBasis = value.evidence_basis;
  if (
    rawBasis !== undefined
    && rawBasis !== null
    && (typeof rawBasis !== "string" || !EVIDENCE_BASES.some((item) => item === rawBasis))
  ) {
    throw new ClassificationError(
      `${where}.evidence_basis must be null or one of ${EVIDENCE_BASES.join(", ")}.`,
    );
  }
  const evidenceBasis: EvidenceBasis | null = rawBasis === undefined || rawBasis === null
    ? null
    : (rawBasis as EvidenceBasis);

  if (recommendation === "reject_only" && evidenceBasis !== "insufficient") {
    throw new ClassificationError(
      `${where} is reject_only, so its evidence_basis must be insufficient. That is the whole reason it cannot be approved.`,
    );
  }

  if (type === "preference" && !PREFERENCE_ID_PATTERN.test(target)) {
    throw new ClassificationError(
      `${where}.target must be a kebab-case preference id, received ${JSON.stringify(target)}.`,
    );
  }
  if (type === "weight" && !PREFERENCE_ID_PATTERN.test(target)) {
    throw new ClassificationError(
      `${where}.target must be the kebab-case id of an existing preference, received ${JSON.stringify(target)}.`,
    );
  }

  const base: ClassificationItem = {
    id,
    merged_ids: mergedIds,
    type,
    target,
    content,
    proposed_weight: proposedWeight,
    reason,
    proofs,
    status: "proposed",
    weak,
    recommendation,
    evidence_basis: evidenceBasis,
  };

  if (type !== "preference") {
    return base;
  }

  const preferenceMissing = CLASSIFICATION_PREFERENCE_ONLY_FIELDS.filter(
    (field) => value[field] === undefined,
  );
  if (preferenceMissing.length > 0) {
    throw new ClassificationError(
      `${where} is a preference and must also carry ${preferenceMissing.sort().join(", ")}: a preference that does not say where it applies cannot be applied.`,
    );
  }

  return {
    ...base,
    domains: parseDomains(value.domains, where),
    why: requiredText(value.why, "why", where, REASON_CAP),
    apply: requiredText(value.apply, "apply", where, REASON_CAP),
  };
}

/**
 * Parses a whole classification array. Every failure names the item and the
 * field, because the human who reads it is the one who has to decide whether to
 * re-run the classifier or fix the file by hand.
 */
export function parseClassification(value: unknown): ClassificationItem[] {
  if (!Array.isArray(value)) {
    throw new ClassificationError(
      "A classification must be a JSON array of items, with no prose and no Markdown fence around it.",
    );
  }
  if (value.length === 0) {
    throw new ClassificationError(
      "A classification may not be empty. Every staged candidate must come back as an item, even the ones that are only fit to be rejected.",
    );
  }
  if (value.length > MAX_CLASSIFICATION_ITEMS) {
    throw new ClassificationError(
      `A classification carries at most ${String(MAX_CLASSIFICATION_ITEMS)} items, received ${String(value.length)}.`,
    );
  }

  assertNoForbiddenDashes(value);

  const items = value.map((item, index) => parseOneItem(item, index));

  const owner = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    for (const candidateId of item.merged_ids) {
      const previous = owner.get(candidateId);
      if (previous !== undefined) {
        throw new ClassificationError(
          `Candidate ${candidateId} is claimed by item ${String(previous + 1)} and item ${String(index + 1)}. Each raw candidate belongs to exactly one item.`,
        );
      }
      owner.set(candidateId, index);
    }
  }

  return items;
}

/**
 * Reads a classification from the text of a file. The classifier writes that
 * file with the host's own write tool, never with a shell echo or a heredoc,
 * which is why the content is treated as data here and never as a command.
 */
export function parseClassificationDocument(text: string): ClassificationItem[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    throw new ClassificationError(
      "The classification file is wrapped in a Markdown fence. It must be the raw JSON array and nothing else.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ClassificationError(
      `The classification file is not valid JSON: ${detail}. Nothing was staged, nothing was prepared.`,
    );
  }
  return parseClassification(parsed);
}

/**
 * Checks that the classification covers exactly the slice it was handed. A
 * missing candidate would sit in the staging area forever without ever being
 * shown to a human; an extra one would smuggle a candidate into a batch the
 * slice never committed to.
 */
export function assertCoversSlice(
  items: readonly ClassificationItem[],
  candidateIds: readonly string[],
): void {
  const covered = new Set<string>();
  for (const item of items) {
    for (const id of item.merged_ids) {
      covered.add(id);
    }
  }
  const expected = new Set(candidateIds);
  const missing = [...expected].filter((id) => !covered.has(id)).sort();
  const extra = [...covered].filter((id) => !expected.has(id)).sort();

  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`never classified: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`not part of this slice: ${extra.join(", ")}`);
    }
    throw new ClassificationError(
      `The classification does not cover the staged slice exactly (${parts.join("; ")}). Re-run the classifier on the slice that \`open-brain sync staged\` returned.`,
    );
  }
}

/** The union of every candidate a classification speaks for, sorted. */
export function classifiedCandidateIds(items: readonly ClassificationItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    for (const id of item.merged_ids) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}
