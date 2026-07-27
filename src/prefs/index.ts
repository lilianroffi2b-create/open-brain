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
  CORE_MIN_WEIGHT,
  effectiveCore,
  isLedgerDate,
  isPreferenceStatus,
  isPreferenceWeight,
  PREFERENCE_ID_PATTERN,
  shouldAutoRegen,
  validatePreferenceLedger,
} from "./validation.js";

export {
  addPreference,
  applyPreferenceOperation,
  createPreferenceLedger,
  derivePreferenceStatus,
  getCorePreferences,
  listPreferences,
  logPreference,
  MAX_OPERATION_HISTORY,
  PREFERENCE_CREATION_SIGNAL,
  PREFERENCE_OPERATION_REQUEST_SCHEMA,
  readPreferenceOperations,
  type PreferenceAddInput,
  type PreferenceAddOperation,
  type PreferenceLogOperation,
  type PreferenceOperationInput,
  type PreferenceOperationOutcome,
  type PreferenceOperationRecord,
  type PreferenceOperationRequest,
} from "./ledger.js";

export { renderPreferenceCore, renderPreferenceMirror } from "./render.js";

export {
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  PREFERENCE_LOCK_NAME,
  loadPreferenceLedger,
  regeneratePreferenceOutputs,
  runPreferenceOperation,
  savePreferenceLedger,
  withPreferenceLock,
  writePreferenceCore,
  type PreferenceOperationOptions,
  type PreferenceOperationResult,
  type PreferenceWriteContext,
} from "./io.js";

export {
  readRedlineJournal,
  readRedlineState,
  REDLINE_JOURNAL_READ_LIMIT,
  REDLINE_JOURNAL_RELATIVE_PATH,
  REDLINE_SCHEMA_VERSION,
  REDLINE_STATE_RELATIVE_PATH,
  REDLINE_TARGETS,
  verifyRedline,
  writeThroughRedline,
  type RedlineCheck,
  type RedlineEntry,
  type RedlineJournal,
  type RedlineJournalOptions,
  type RedlineProvenance,
  type RedlineReport,
  type RedlineState,
  type RedlineTarget,
  type RedlineVerdict,
  type RedlineWrite,
} from "./redline.js";

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
