import {
  PREFERENCE_LEDGER_SCHEMA_VERSION,
  PREFERENCE_STATUSES,
  PREFERENCE_WEIGHTS,
  type LedgerValidationResult,
  type Preference,
  type PreferenceLedger,
  type PreferenceStatus,
  type PreferenceWeight,
} from "./types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const PREFERENCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Weight at or above which a preference is core unless overridden explicitly. */
export const CORE_MIN_WEIGHT = 4;

/**
 * Effective core flag with parity to pref_ledger.py: an explicit `core` value
 * wins, otherwise a preference is core when its weight reaches CORE_MIN_WEIGHT.
 */
export function effectiveCore(
  preference: Pick<Preference, "core" | "weight">,
): boolean {
  return preference.core ?? preference.weight >= CORE_MIN_WEIGHT;
}

/**
 * Whether a preference change should trigger regeneration of the always-on
 * core and its loader mirrors. Parity with pref_ledger.py auto-regen: it is (or
 * stays) core, or it is a high-weight change worth surfacing immediately.
 */
export function shouldAutoRegen(
  preference: Pick<Preference, "core" | "weight">,
): boolean {
  return effectiveCore(preference) || preference.weight >= CORE_MIN_WEIGHT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPreferenceWeight(value: unknown): value is PreferenceWeight {
  return (
    typeof value === "number" &&
    PREFERENCE_WEIGHTS.includes(value as PreferenceWeight)
  );
}

export function isPreferenceStatus(value: unknown): value is PreferenceStatus {
  return (
    typeof value === "string" &&
    PREFERENCE_STATUSES.includes(value as PreferenceStatus)
  );
}

export function isLedgerDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function validateStringArray(
  value: unknown,
  label: string,
  errors: string[],
  options: { allowEmpty?: boolean } = {},
): value is string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    errors.push(`${label} must be a non-empty array.`);
    return false;
  }

  if (value.some((item) => !isNonEmptyString(item))) {
    errors.push(`${label} must contain non-empty strings.`);
    return false;
  }

  return true;
}

function validatePreference(
  value: unknown,
  index: number,
  errors: string[],
  warnings: string[],
  ids: Set<string>,
): void {
  const label = `preferences[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  if (!isNonEmptyString(value.id) || !PREFERENCE_ID_PATTERN.test(value.id)) {
    errors.push(`${label}.id must be a kebab-case identifier.`);
  } else if (ids.has(value.id)) {
    errors.push(`${label}.id duplicates ${value.id}.`);
  } else {
    ids.add(value.id);
  }

  if (!isPreferenceWeight(value.weight)) {
    errors.push(`${label}.weight must be an integer from 1 through 5.`);
  }

  if (!isPreferenceStatus(value.status)) {
    errors.push(`${label}.status is invalid.`);
  }

  validateStringArray(value.domains, `${label}.domains`, errors);

  for (const field of ["statement", "why", "apply"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${label}.${field} must be a non-empty string.`);
    }
  }

  for (const field of ["origin", "last_seen"] as const) {
    if (!isLedgerDate(value[field])) {
      errors.push(`${label}.${field} must be an ISO date (YYYY-MM-DD).`);
    }
  }

  if (value.core !== undefined && typeof value.core !== "boolean") {
    errors.push(`${label}.core must be boolean when present.`);
  }

  if (value.scoped !== undefined && typeof value.scoped !== "boolean") {
    errors.push(`${label}.scoped must be boolean when present.`);
  }

  if (value.source !== undefined && !isNonEmptyString(value.source)) {
    errors.push(`${label}.source must be a non-empty string when present.`);
  }

  if (value.links !== undefined) {
    validateStringArray(value.links, `${label}.links`, errors, {
      allowEmpty: true,
    });
  }

  if (!Array.isArray(value.evidence)) {
    errors.push(`${label}.evidence must be an array.`);
  } else {
    value.evidence.forEach((event, eventIndex) => {
      const eventLabel = `${label}.evidence[${eventIndex}]`;
      if (!isRecord(event)) {
        errors.push(`${eventLabel} must be an object.`);
        return;
      }
      if (!isLedgerDate(event.date)) {
        errors.push(`${eventLabel}.date must be an ISO date (YYYY-MM-DD).`);
      }
      if (!isPreferenceWeight(event.weight_set)) {
        errors.push(`${eventLabel}.weight_set must be an integer from 1 through 5.`);
      }
      if (!isNonEmptyString(event.signal)) {
        errors.push(`${eventLabel}.signal must be a non-empty string.`);
      }
      if (event.quote !== undefined && typeof event.quote !== "string") {
        errors.push(`${eventLabel}.quote must be a string when present.`);
      }
    });
  }

  if (isPreferenceWeight(value.weight) && isPreferenceStatus(value.status)) {
    if (value.status === "law" && value.weight !== 5) {
      warnings.push(`${label} is law but has weight ${value.weight}.`);
    }
    if (value.weight === 5 && !["law", "retired"].includes(value.status)) {
      warnings.push(`${label} has weight 5 but is ${value.status}.`);
    }
    if (value.status === "proposed" && value.weight > 2) {
      warnings.push(`${label} is proposed but has weight ${value.weight}.`);
    }
    if (value.core === true && value.weight < 3) {
      warnings.push(`${label} is core but has low weight ${value.weight}.`);
    }
  }
}

/** Validates the public v3 Hermes ledger without mutating it. */
export function validatePreferenceLedger(value: unknown): LedgerValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(value)) {
    return {
      valid: false,
      errors: ["Preference ledger must be a JSON object."],
      warnings,
    };
  }

  if (value.schema_version !== PREFERENCE_LEDGER_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be ${PREFERENCE_LEDGER_SCHEMA_VERSION} for the Hermes v3 ledger.`,
    );
  }

  if (!Array.isArray(value.preferences)) {
    errors.push("preferences must be an array.");
    return { valid: false, errors, warnings };
  }

  const ids = new Set<string>();
  value.preferences.forEach((preference, index) =>
    validatePreference(preference, index, errors, warnings, ids),
  );

  const knownIds = new Set(
    value.preferences
      .filter(isRecord)
      .map((preference) => preference.id)
      .filter(isNonEmptyString),
  );

  value.preferences.forEach((preference, index) => {
    if (!isRecord(preference) || !Array.isArray(preference.links)) {
      return;
    }

    preference.links.forEach((link) => {
      if (typeof link === "string" && !knownIds.has(link)) {
        warnings.push(`preferences[${index}] links to unknown id ${link}.`);
      }
    });
  });

  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidPreferenceLedger(
  value: unknown,
): asserts value is PreferenceLedger {
  const result = validatePreferenceLedger(value);
  if (!result.valid) {
    throw new TypeError(`Invalid preference ledger: ${result.errors.join(" ")}`);
  }
}
