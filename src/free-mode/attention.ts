import type { FreeMode } from "./config.js";

export type AttentionPrompt =
  | "safety-confirmation"
  | "free-mode-checkpoint"
  | "hermes-preference-nudge"
  | "optional-idea";

export interface AttentionCandidates {
  mode: FreeMode;
  safetyConfirmationRequired: boolean;
  materialFreeModeAlternative: boolean;
  atSafeBoundary: boolean;
  freeModeCheckpointAlreadyShown: boolean;
  hermesNudgeAvailable: boolean;
  optionalIdeaAvailable: boolean;
}

export interface FreeModeRequestBudget {
  checkpointShown: boolean;
}

export function createFreeModeRequestBudget(): FreeModeRequestBudget {
  return { checkpointShown: false };
}

/**
 * Selects one item from the shared attention budget. Higher-priority work
 * always suppresses lower-priority prompts for this response.
 */
export function chooseAttentionPrompt(
  candidates: AttentionCandidates,
): AttentionPrompt | undefined {
  if (candidates.safetyConfirmationRequired) {
    return "safety-confirmation";
  }

  if (
    candidates.mode === "calibrated" &&
    candidates.materialFreeModeAlternative &&
    candidates.atSafeBoundary &&
    !candidates.freeModeCheckpointAlreadyShown
  ) {
    return "free-mode-checkpoint";
  }

  if (candidates.hermesNudgeAvailable) {
    return "hermes-preference-nudge";
  }

  if (candidates.optionalIdeaAvailable) {
    return "optional-idea";
  }

  return undefined;
}

export interface FreeModeCheckpointOptions {
  mode: FreeMode;
  budget: FreeModeRequestBudget;
  materialAlternative: boolean;
  atSafeBoundary: boolean;
  safetyConfirmationRequired?: boolean;
}

export function canShowFreeModeCheckpoint(
  options: FreeModeCheckpointOptions,
): boolean {
  return (
    options.mode === "calibrated" &&
    options.materialAlternative &&
    options.atSafeBoundary &&
    !options.budget.checkpointShown &&
    !options.safetyConfirmationRequired
  );
}

export function markFreeModeCheckpointShown(
  budget: FreeModeRequestBudget,
): FreeModeRequestBudget {
  return { ...budget, checkpointShown: true };
}
