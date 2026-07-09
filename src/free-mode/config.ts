/**
 * Public configuration contract for OpenBrain Free Mode.
 *
 * The parser and writer for vault.config.yml live in the core workstream.
 * These helpers deliberately operate on plain objects so CLI commands can use
 * the same contract without depending on a specific YAML library here.
 */

export const FREE_MODE_VALUES = ["off", "calibrated"] as const;

export type FreeMode = (typeof FREE_MODE_VALUES)[number];

export interface InteractionConfig {
  free_mode?: FreeMode;
  [key: string]: unknown;
}

export type VaultConfigLike = Record<string, unknown> & {
  interaction?: InteractionConfig;
};

export interface VaultConfigWithFreeMode extends Record<string, unknown> {
  interaction: InteractionConfig & { free_mode: FreeMode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFreeMode(value: unknown): value is FreeMode {
  return typeof value === "string" && FREE_MODE_VALUES.includes(value as FreeMode);
}

/**
 * Reads an individual mode value. Missing configuration deliberately defaults
 * to off so a skipped onboarding can never enable proactive behaviour.
 */
export function parseFreeMode(value: unknown, fallback: FreeMode = "off"): FreeMode {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (isFreeMode(value)) {
    return value;
  }

  throw new TypeError('interaction.free_mode must be "off" or "calibrated".');
}

/** Reads interaction.free_mode from a parsed vault configuration. */
export function readFreeMode(config: unknown): FreeMode {
  if (config === undefined || config === null) {
    return "off";
  }

  if (!isRecord(config)) {
    throw new TypeError("Vault configuration must be a mapping.");
  }

  const interaction = config.interaction;
  if (interaction === undefined || interaction === null) {
    return "off";
  }

  if (!isRecord(interaction)) {
    throw new TypeError("interaction must be a mapping.");
  }

  return parseFreeMode(interaction.free_mode);
}

/**
 * Returns a new configuration object with interaction.free_mode updated.
 * Callers own serialising the returned object back to vault.config.yml.
 */
export function setFreeMode(
  config: VaultConfigLike,
  mode: FreeMode,
): VaultConfigWithFreeMode {
  const freeMode = parseFreeMode(mode);
  const currentInteraction = config.interaction;

  if (currentInteraction !== undefined && !isRecord(currentInteraction)) {
    throw new TypeError("interaction must be a mapping.");
  }

  return {
    ...config,
    interaction: {
      ...(currentInteraction ?? {}),
      free_mode: freeMode,
    },
  };
}
