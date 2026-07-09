export const PREFERENCE_LEDGER_SCHEMA_VERSION = 3;

export const PREFERENCE_WEIGHTS = [1, 2, 3, 4, 5] as const;
export type PreferenceWeight = (typeof PREFERENCE_WEIGHTS)[number];

export const PREFERENCE_STATUSES = [
  "law",
  "active",
  "proposed",
  "probation",
  "retired",
] as const;
export type PreferenceStatus = (typeof PREFERENCE_STATUSES)[number];

export interface PreferenceEvidence {
  date: string;
  weight_set: PreferenceWeight;
  signal: string;
  quote?: string;
}

export interface Preference {
  id: string;
  weight: PreferenceWeight;
  status: PreferenceStatus;
  domains: string[];
  statement: string;
  why: string;
  apply: string;
  origin: string;
  last_seen: string;
  evidence: PreferenceEvidence[];
  core?: boolean;
  scoped?: boolean;
  source?: string;
  links?: string[];
}

export interface PreferenceLedger {
  schema_version: typeof PREFERENCE_LEDGER_SCHEMA_VERSION;
  preferences: Preference[];
  [key: string]: unknown;
}

export interface LedgerValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PreferenceListOptions {
  status?: PreferenceStatus;
  domain?: string;
  minWeight?: PreferenceWeight;
  staleDays?: number;
  today?: Date;
}

export interface PreferenceLogInput {
  signal: string;
  date?: string;
  weight?: PreferenceWeight;
  status?: PreferenceStatus;
  quote?: string;
}
