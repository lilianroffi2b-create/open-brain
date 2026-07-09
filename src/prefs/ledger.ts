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
  isLedgerDate,
  isPreferenceStatus,
  isPreferenceWeight,
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

function cloneLedger(ledger: PreferenceLedger): PreferenceLedger {
  return {
    ...ledger,
    preferences: ledger.preferences.map(clonePreference),
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

export function addPreference(
  ledger: PreferenceLedger,
  preference: Preference,
): PreferenceLedger {
  assertValidPreferenceLedger(ledger);
  const next: PreferenceLedger = {
    ...cloneLedger(ledger),
    preferences: [...ledger.preferences.map(clonePreference), clonePreference(preference)],
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
    throw new TypeError("Preference evidence requires a non-empty signal.");
  }
  if (input.date !== undefined && !isLedgerDate(input.date)) {
    throw new TypeError("Preference evidence date must be YYYY-MM-DD.");
  }
  if (input.weight !== undefined && !isPreferenceWeight(input.weight)) {
    throw new TypeError("Preference evidence weight must be from 1 through 5.");
  }
  if (input.status !== undefined && !isPreferenceStatus(input.status)) {
    throw new TypeError("Preference status is invalid.");
  }
  if (input.quote !== undefined && typeof input.quote !== "string") {
    throw new TypeError("Preference evidence quote must be a string.");
  }

  const preferenceIndex = ledger.preferences.findIndex(
    (preference) => preference.id === id,
  );
  if (preferenceIndex === -1) {
    throw new RangeError(`Unknown preference id: ${id}.`);
  }

  const current = ledger.preferences[preferenceIndex]!;
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

  const preferences = ledger.preferences.map((preference, index) =>
    index === preferenceIndex ? nextPreference : clonePreference(preference),
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
    (preference) => preference.core && preference.status !== "retired",
  );
}
