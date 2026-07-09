export {
  PREFERENCE_LEDGER_SCHEMA_VERSION,
  PREFERENCE_STATUSES,
  PREFERENCE_WEIGHTS,
  type LedgerValidationResult,
  type Preference,
  type PreferenceEvidence,
  type PreferenceLedger,
  type PreferenceListOptions,
  type PreferenceLogInput,
  type PreferenceStatus,
  type PreferenceWeight,
} from "./types.js";

export {
  assertValidPreferenceLedger,
  isLedgerDate,
  isPreferenceStatus,
  isPreferenceWeight,
  validatePreferenceLedger,
} from "./validation.js";

export {
  addPreference,
  createPreferenceLedger,
  derivePreferenceStatus,
  getCorePreferences,
  listPreferences,
  logPreference,
} from "./ledger.js";

export { renderPreferenceCore, renderPreferenceMirror } from "./render.js";

export {
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  loadPreferenceLedger,
  savePreferenceLedger,
  writePreferenceCore,
} from "./io.js";

export {
  PREFERENCE_MIRROR_BEGIN_MARKER,
  PREFERENCE_MIRROR_END_MARKER,
  renderPreferenceMirrorBlock,
  syncPreferenceMirrorContent,
  syncPreferenceMirrorFile,
  syncPreferenceMirrors,
  type PreferenceMirrorSyncOptions,
  type PreferenceMirrorSyncResult,
} from "./mirror.js";
