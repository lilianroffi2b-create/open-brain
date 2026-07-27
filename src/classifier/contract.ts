/**
 * The output contract of the classifier, and the input contract of the gate.
 *
 * The shape and its validators moved to src/learning/types.ts: the learning
 * layer needs the same classification shape the classifier produces, and two
 * organs defining it separately is exactly how they end up disagreeing on what
 * a classification is. This file re-exports the canonical form so every
 * existing import of it keeps working unchanged.
 */

export {
  assertCoversSlice,
  assertNoForbiddenDashes,
  classifiedCandidateIds,
  CLASSIFICATION_ITEM_FIELDS,
  CLASSIFICATION_SCHEMA,
  CLASSIFICATION_SCHEMA_VERSION,
  ClassificationError,
  DOMAIN_SLUG_PATTERN,
  MAX_CLASSIFICATION_ITEMS,
  NEW_PREFERENCE_WEIGHT,
  parseClassification,
  parseClassificationDocument,
  PREFERENCE_ID_PATTERN,
  type ClassificationItem,
} from "../learning/types.js";
