export {
  FREE_MODE_VALUES,
  isFreeMode,
  parseFreeMode,
  readFreeMode,
  setFreeMode,
  type FreeMode,
  type InteractionConfig,
  type VaultConfigLike,
  type VaultConfigWithFreeMode,
} from "./config.js";

export {
  FREE_MODE_CHECK_TEMPLATE,
  FREE_MODE_ATTENTION_PRIORITY,
  OPTIONAL_IDEA_TEMPLATE,
  describeFreeMode,
} from "./prompts.js";

export {
  FREE_MODE_STATE_RELATIVE_PATH,
  FREE_MODE_STATE_SCHEMA_VERSION,
  createFreeModeLocalState,
  dismissIdea,
  fingerprintIdea,
  getFreeModeStatePath,
  isIdeaDismissed,
  loadFreeModeLocalState,
  saveFreeModeLocalState,
  setFreeModeLocalStateMode,
  validateFreeModeLocalState,
  type FreeModeLocalState,
} from "./state.js";
