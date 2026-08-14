import { ExpectedError } from "../core/errors.js";
import { sha256 } from "../core/text.js";
import {
  PREFERENCE_LEDGER_SCHEMA_VERSION,
  type Preference,
  type PreferenceLedger,
  type PreferenceListOptions,
  type PreferenceLogInput,
  type PreferenceStatus,
  type PreferenceWeight,
} from "./types.js";
import {
  assertValidPreferenceLedger,
  effectiveCore,
  isLedgerDate,
  isPreferenceStatus,
  isPreferenceWeight,
  PREFERENCE_ID_PATTERN,
} from "./validation.js";

function clonePreference(preference: Preference): Preference {
  const { domains, links, evidence, ...rest } = preference;
  return {
    ...rest,
    domains: [...domains],
    ...(links ? { links: [...links] } : {}),
    evidence: evidence.map((event) => ({ ...event })),
  };
}

function toLedgerDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseLedgerDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function createPreferenceLedger(
  preferences: Preference[] = [],
): PreferenceLedger {
  const ledger: PreferenceLedger = {
    schema_version: PREFERENCE_LEDGER_SCHEMA_VERSION,
    preferences: preferences.map(clonePreference),
  };
  assertValidPreferenceLedger(ledger);
  return ledger;
}

/**
 * Retired and probation are explicit human lifecycle choices. Otherwise status
 * is deterministically derived from the resulting preference weight.
 */
export function derivePreferenceStatus(
  weight: PreferenceWeight,
  previousStatus?: PreferenceStatus,
): PreferenceStatus {
  if (previousStatus === "probation" || previousStatus === "retired") {
    return previousStatus;
  }
  if (weight === 5) {
    return "law";
  }
  if (weight >= 3) {
    return "active";
  }
  return "proposed";
}

/** Signal recorded on the evidence event a creation quote produces. */
export const PREFERENCE_CREATION_SIGNAL = "created";

export interface PreferenceAddInput {
  id: string;
  text: string;
  weight: PreferenceWeight;
  status?: PreferenceStatus;
  date?: string;
  core?: boolean;
  /** Contexts the preference applies to. Defaults to ["general"]. */
  domains?: string[];
  /** Why the preference exists. Defaults to the supplied text. */
  why?: string;
  /** How to carry the preference out. Defaults to the supplied text. */
  apply?: string;
  /** Where the preference came from, a gate batch or a manual decision. */
  source?: string;
  /** The citation that justified it, kept as the first evidence event. */
  quote?: string;
}

/**
 * Builds a complete, valid preference and appends it.
 *
 * Every schema field the caller supplies is honoured; only the ones left out
 * fall back to a default derived from the input. That matters because domains,
 * why, and apply are where personalisation actually lives: they say when a
 * preference applies, what it is for, and how to execute it. A caller that knows
 * them, the review gate for instance, must never see them replaced by the
 * generic defaults, and a caller that does not is unaffected.
 *
 * Status is derived from the weight when the caller does not set one, so a
 * weight of 5 enters as law rather than as an active preference the validator
 * would immediately flag; the date defaults to today.
 */
export function addPreference(
  ledger: PreferenceLedger,
  input: PreferenceAddInput,
  now: Date = new Date(),
): PreferenceLedger {
  assertValidPreferenceLedger(ledger);

  if (typeof input.id !== "string" || !PREFERENCE_ID_PATTERN.test(input.id)) {
    throw new ExpectedError("Preference id must be a kebab-case identifier.");
  }
  if (ledger.preferences.some((preference) => preference.id === input.id)) {
    throw new ExpectedError(`Preference id already exists: ${input.id}.`);
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new ExpectedError("Preference text must be a non-empty string.");
  }
  if (!isPreferenceWeight(input.weight)) {
    throw new ExpectedError("Preference weight must be from 1 through 5.");
  }
  if (input.status !== undefined && !isPreferenceStatus(input.status)) {
    throw new ExpectedError("Preference status is invalid.");
  }
  if (input.date !== undefined && !isLedgerDate(input.date)) {
    throw new ExpectedError("Preference date must be YYYY-MM-DD.");
  }
  if (input.core !== undefined && typeof input.core !== "boolean") {
    throw new ExpectedError("Preference core must be a boolean when provided.");
  }
  if (input.domains !== undefined) {
    if (
      !Array.isArray(input.domains)
      || input.domains.length === 0
      || input.domains.some((domain) => typeof domain !== "string" || domain.trim().length === 0)
    ) {
      throw new ExpectedError("Preference domains must be a non-empty array of non-empty strings.");
    }
  }
  for (const field of ["why", "apply", "source"] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new ExpectedError(`Preference ${field} must be a non-empty string when provided.`);
    }
  }
  if (input.quote !== undefined && typeof input.quote !== "string") {
    throw new ExpectedError("Preference quote must be a string when provided.");
  }

  const date = input.date ?? toLedgerDate(now);
  const text = input.text.trim();
  const source = input.source?.trim();
  // An empty quote is treated as no quote: seeding an evidence event with an
  // empty citation would record that something justified this preference while
  // showing nothing, which is worse than recording no evidence at all.
  const quote = input.quote?.trim();
  const preference: Preference = {
    id: input.id,
    weight: input.weight,
    status: input.status ?? derivePreferenceStatus(input.weight),
    domains: input.domains ? input.domains.map((domain) => domain.trim()) : ["general"],
    statement: text,
    why: input.why?.trim() ?? text,
    apply: input.apply?.trim() ?? text,
    origin: date,
    last_seen: date,
    evidence: quote
      ? [{
        date,
        weight_set: input.weight,
        signal: PREFERENCE_CREATION_SIGNAL,
        quote,
      }]
      : [],
    ...(input.core === undefined ? {} : { core: input.core }),
    ...(source === undefined ? {} : { source }),
  };

  const next: PreferenceLedger = {
    ...ledger,
    preferences: [...ledger.preferences.map(clonePreference), preference],
  };
  assertValidPreferenceLedger(next);
  return next;
}

/**
 * Adds one evidence event without mutating older evidence. A CLI can persist
 * the returned ledger atomically after the caller decides the signal and weight.
 */
export function logPreference(
  ledger: PreferenceLedger,
  id: string,
  input: PreferenceLogInput,
  now: Date = new Date(),
): PreferenceLedger {
  assertValidPreferenceLedger(ledger);

  if (typeof input.signal !== "string" || input.signal.trim().length === 0) {
    throw new ExpectedError("Preference evidence requires a non-empty signal.");
  }
  if (input.date !== undefined && !isLedgerDate(input.date)) {
    throw new ExpectedError("Preference evidence date must be YYYY-MM-DD.");
  }
  if (input.weight !== undefined && !isPreferenceWeight(input.weight)) {
    throw new ExpectedError("Preference evidence weight must be from 1 through 5.");
  }
  if (input.status !== undefined && !isPreferenceStatus(input.status)) {
    throw new ExpectedError("Preference status is invalid.");
  }
  if (input.quote !== undefined && typeof input.quote !== "string") {
    throw new ExpectedError("Preference evidence quote must be a string.");
  }

  const current = ledger.preferences.find((preference) => preference.id === id);
  if (!current) {
    throw new ExpectedError(`Unknown preference id: ${id}.`);
  }

  const date = input.date ?? toLedgerDate(now);
  const weight = input.weight ?? current.weight;
  const evidence = {
    date,
    weight_set: weight,
    signal: input.signal,
    ...(input.quote === undefined ? {} : { quote: input.quote }),
  };
  const nextPreference: Preference = {
    ...clonePreference(current),
    weight,
    status: input.status ?? derivePreferenceStatus(weight, current.status),
    last_seen: date,
    evidence: [...current.evidence.map((event) => ({ ...event })), evidence],
  };

  const preferences = ledger.preferences.map((preference) =>
    preference.id === id ? nextPreference : clonePreference(preference),
  );
  const next: PreferenceLedger = { ...ledger, preferences };
  assertValidPreferenceLedger(next);
  return next;
}

export function listPreferences(
  ledger: PreferenceLedger,
  options: PreferenceListOptions = {},
): Preference[] {
  assertValidPreferenceLedger(ledger);
  const today = options.today ?? new Date();

  return ledger.preferences
    .filter((preference) => {
      if (options.status && preference.status !== options.status) {
        return false;
      }
      if (options.domain && !preference.domains.includes(options.domain)) {
        return false;
      }
      if (options.minWeight && preference.weight < options.minWeight) {
        return false;
      }
      if (options.staleDays !== undefined) {
        const ageInMilliseconds = today.getTime() - parseLedgerDate(preference.last_seen).getTime();
        const ageInDays = ageInMilliseconds / (24 * 60 * 60 * 1000);
        if (ageInDays <= options.staleDays) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    .map(clonePreference);
}

export function getCorePreferences(ledger: PreferenceLedger): Preference[] {
  return listPreferences(ledger).filter(
    (preference) => effectiveCore(preference) && preference.status !== "retired",
  );
}

export const PREFERENCE_OPERATION_REQUEST_SCHEMA = "open-brain-prefs-operation-request/v1";

/**
 * Operation records kept with their request in full, most recent first.
 *
 * Older ones are compacted, never dropped. An operation identifier that is
 * forgotten is an operation that can be applied a second time, and the second
 * time is not a replay: it is a write nobody asked for, landing on a preference
 * a human may have deliberately moved since. The cap bounds how much of the
 * ledger is readable history, not how long idempotency lasts.
 */
export const MAX_OPERATION_HISTORY = 200;

/**
 * The caller's arguments frozen exactly as they were supplied, before any
 * default or derived value is applied. A replay is compared against this, which
 * is what lets idempotency survive a change of day or a weight mutated in
 * between: neither of those is part of what the caller actually asked for.
 */
export interface PreferenceOperationRequest {
  schema: typeof PREFERENCE_OPERATION_REQUEST_SCHEMA;
  kind: "add" | "log";
  id: string;
  text: string | null;
  date: string | null;
  weight: PreferenceWeight | null;
  signal: string | null;
  quote: string | null;
  status: PreferenceStatus | null;
  core: boolean | null;
  domains: string[] | null;
  why: string | null;
  apply: string | null;
  source: string | null;
}

/**
 * A frozen request as the ledger holds it: whole for a recent operation, and
 * reduced to what identifies it for a compacted one. It is also what a record
 * written by an older build looks like, a request missing the fields that did
 * not exist yet, which is why every reader of it treats absence as absence.
 */
export type StoredOperationRequest =
  & Partial<PreferenceOperationRequest>
  & Pick<PreferenceOperationRequest, "schema" | "kind" | "id">;

export interface PreferenceOperationRecord {
  operation_id: string;
  applied_at: string;
  target_id: string;
  request: StoredOperationRequest;
  /**
   * Digest of the frozen request. It is what still answers "was this the same
   * call" once the request itself has been compacted away, and it is written on
   * every new record so a compaction never has to reconstruct one.
   */
  request_sha256?: string;
  /** True once the full request was replaced by its digest. */
  compacted?: boolean;
}

export interface PreferenceAddOperation extends PreferenceAddInput {
  kind: "add";
  operationId?: string;
}

export interface PreferenceLogOperation extends PreferenceLogInput {
  kind: "log";
  id: string;
  operationId?: string;
}

export type PreferenceOperationInput = PreferenceAddOperation | PreferenceLogOperation;

export type PreferenceOperationOutcome =
  | { kind: "applied"; ledger: PreferenceLedger; preference: Preference }
  | { kind: "replayed"; message: string; preference?: Preference }
  | { kind: "conflict"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationRequest(value: unknown): value is StoredOperationRequest {
  return isRecord(value)
    && value.schema === PREFERENCE_OPERATION_REQUEST_SCHEMA
    && (value.kind === "add" || value.kind === "log")
    && typeof value.id === "string";
}

function isOperationRecord(value: unknown): value is PreferenceOperationRecord {
  return isRecord(value)
    && typeof value.operation_id === "string"
    && typeof value.applied_at === "string"
    && typeof value.target_id === "string"
    && isOperationRequest(value.request)
    && (value.request_sha256 === undefined || typeof value.request_sha256 === "string");
}

/** Reads the bounded operation index, ignoring entries an older writer malformed. */
export function readPreferenceOperations(
  ledger: PreferenceLedger,
): PreferenceOperationRecord[] {
  const operations: unknown = ledger.operations;
  return Array.isArray(operations) ? operations.filter(isOperationRecord) : [];
}

function freezeOperationRequest(input: PreferenceOperationInput): PreferenceOperationRequest {
  const shared = {
    schema: PREFERENCE_OPERATION_REQUEST_SCHEMA,
    id: input.id,
    date: input.date ?? null,
    weight: input.weight ?? null,
    status: input.status ?? null,
  } as const;
  if (input.kind === "add") {
    return {
      ...shared,
      kind: "add",
      text: input.text ?? null,
      signal: null,
      quote: input.quote ?? null,
      core: input.core ?? null,
      domains: input.domains ?? null,
      why: input.why ?? null,
      apply: input.apply ?? null,
      source: input.source ?? null,
    };
  }
  return {
    ...shared,
    kind: "log",
    text: null,
    signal: input.signal ?? null,
    quote: input.quote ?? null,
    core: null,
    domains: null,
    why: null,
    apply: null,
    source: null,
  };
}

function sameStringList(left: unknown, right: string[] | null): boolean {
  if (left === right) {
    return true;
  }
  if (!Array.isArray(left) || right === null) {
    // An absent list and an empty request are the same absence.
    return (left === undefined || left === null) && right === null;
  }
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Compares a replay with the request that was stored.
 *
 * The stored side is read as a partial: a record written before a field existed
 * simply has no key for it, and an absent key must read as the same absence a
 * caller expresses by leaving the field out. Treating it as a difference would
 * turn every legitimate replay of an older operation into a conflict.
 */
function requestsMatch(
  stored: Partial<PreferenceOperationRequest>,
  requested: PreferenceOperationRequest,
): boolean {
  const fields = [
    "kind",
    "id",
    "text",
    "date",
    "weight",
    "signal",
    "quote",
    "status",
    "core",
    "why",
    "apply",
    "source",
  ] as const;
  return fields.every((field) => (stored[field] ?? null) === requested[field])
    && sameStringList(stored.domains, requested.domains);
}

/**
 * The digest the replay check compares when the request itself is gone.
 *
 * Built from the same fields, in the same order, and with the same reading of an
 * absent one as requestsMatch: two requests have the same digest exactly when
 * that function calls them equal. A future field would change every digest at
 * once, so an old operation replayed across that change is reported as a
 * conflict rather than silently applied again, which is the safe way round.
 */
function requestDigest(request: Partial<PreferenceOperationRequest>): string {
  return sha256(JSON.stringify({
    kind: request.kind ?? null,
    id: request.id ?? null,
    text: request.text ?? null,
    date: request.date ?? null,
    weight: request.weight ?? null,
    signal: request.signal ?? null,
    quote: request.quote ?? null,
    status: request.status ?? null,
    core: request.core ?? null,
    domains: Array.isArray(request.domains) ? [...request.domains] : null,
    why: request.why ?? null,
    apply: request.apply ?? null,
    source: request.source ?? null,
  }));
}

/** Was this the same call? By digest when there is one, by fields otherwise. */
function storedRequestMatches(
  record: PreferenceOperationRecord,
  requested: PreferenceOperationRequest,
): boolean {
  return record.request_sha256 === undefined
    ? requestsMatch(record.request, requested)
    : record.request_sha256 === requestDigest(requested);
}

/** Strips one record down to what still answers the replay question. */
function compactOperationRecord(record: PreferenceOperationRecord): PreferenceOperationRecord {
  if (record.compacted === true) {
    return record;
  }
  return {
    operation_id: record.operation_id,
    applied_at: record.applied_at,
    target_id: record.target_id,
    request: {
      schema: PREFERENCE_OPERATION_REQUEST_SCHEMA,
      kind: record.request.kind,
      id: record.request.id,
    },
    request_sha256: record.request_sha256 ?? requestDigest(record.request),
    compacted: true,
  };
}

/**
 * Appends one operation record and compacts the ones that fell out of the
 * readable window.
 *
 * They used to be dropped, which made idempotency mean "at most once within the
 * last two hundred operations". Past that, a replayed batch applied a second
 * time and pushed a weight a human had lowered straight back up, which is the
 * one thing an identified operation exists to prevent. A compacted record is an
 * identifier, a date, a target and a digest: enough to recognise the call, and
 * small enough that remembering every one of them stays cheap.
 */
function withOperationRecord(
  ledger: PreferenceLedger,
  record: PreferenceOperationRecord,
): PreferenceLedger {
  const operations = [...readPreferenceOperations(ledger), record];
  const boundary = Math.max(0, operations.length - MAX_OPERATION_HISTORY);
  return {
    ...ledger,
    operations: operations.map(
      (entry, index) => (index < boundary ? compactOperationRecord(entry) : entry),
    ),
  };
}

/**
 * Applies one identified preference mutation.
 *
 * The replay check is the FIRST thing this function does, before the default
 * date, before the weight derived from the current preference, before any
 * normalisation. Applying defaults first and checking afterwards would make a
 * replay look different from the original call as soon as the day changed or the
 * weight moved in between, and the operation would silently run twice.
 *
 * Idempotency is strictly opt in: without an operationId nothing is recorded and
 * the mutation behaves exactly as it did before.
 */
export function applyPreferenceOperation(
  ledger: PreferenceLedger,
  input: PreferenceOperationInput,
  now: Date = new Date(),
): PreferenceOperationOutcome {
  if (input.operationId !== undefined) {
    if (input.operationId.trim().length === 0) {
      throw new ExpectedError("Preference operation id must be a non-empty string.");
    }
    const previous = readPreferenceOperations(ledger)
      .find((record) => record.operation_id === input.operationId);
    if (previous) {
      const requested = freezeOperationRequest(input);
      if (!storedRequestMatches(previous, requested)) {
        return {
          kind: "conflict",
          detail: `Operation ${input.operationId} was already applied to ${previous.target_id} with a different payload. Nothing was written. Use a new operation id, or replay the original payload.`,
        };
      }
      const preference = ledger.preferences.find(
        (candidate) => candidate.id === previous.target_id,
      );
      return {
        kind: "replayed",
        message: `${previous.target_id}: operation already applied, no change (${input.operationId}).`,
        ...(preference ? { preference: clonePreference(preference) } : {}),
      };
    }
  }

  const next = input.kind === "add"
    ? addPreference(ledger, input, now)
    : logPreference(ledger, input.id, input, now);
  const preference = next.preferences.find((candidate) => candidate.id === input.id);
  if (!preference) {
    throw new ExpectedError(`Unknown preference id: ${input.id}.`);
  }

  if (input.operationId === undefined) {
    return { kind: "applied", ledger: next, preference: clonePreference(preference) };
  }

  const request = freezeOperationRequest(input);
  const recorded = withOperationRecord(next, {
    operation_id: input.operationId,
    applied_at: now.toISOString(),
    target_id: input.id,
    request,
    request_sha256: requestDigest(request),
  });
  assertValidPreferenceLedger(recorded);
  return { kind: "applied", ledger: recorded, preference: clonePreference(preference) };
}
