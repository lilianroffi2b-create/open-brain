import type { FreeMode } from "./config.js";
import {
  fingerprintIdea,
  isIdeaDismissed,
  type FreeModeLocalState,
} from "./state.js";

export interface OptionalIdeaCandidate {
  idea: string;
  isNovel: boolean;
  isDirectlySupported: boolean;
  isMaterial: boolean;
  isSafelyDeferrable: boolean;
}

export type OptionalIdeaRejectionReason =
  | "free_mode_off"
  | "already_offered_this_session"
  | "dismissed"
  | "not_eligible";

export interface OptionalIdeaDecision {
  eligible: boolean;
  fingerprint: string;
  reason?: OptionalIdeaRejectionReason;
}

/**
 * Session-only guard for the one-optional-idea rule. It intentionally never
 * writes a session identifier or idea text to disk.
 */
export class OptionalIdeaSession {
  private offered = false;

  get hasOfferedOptionalIdea(): boolean {
    return this.offered;
  }

  markOptionalIdeaOffered(): void {
    this.offered = true;
  }
}

export function evaluateOptionalIdea(
  mode: FreeMode,
  session: OptionalIdeaSession,
  state: FreeModeLocalState,
  candidate: OptionalIdeaCandidate,
): OptionalIdeaDecision {
  const fingerprint = fingerprintIdea(candidate.idea);

  if (mode === "off") {
    return { eligible: false, fingerprint, reason: "free_mode_off" };
  }

  if (session.hasOfferedOptionalIdea) {
    return {
      eligible: false,
      fingerprint,
      reason: "already_offered_this_session",
    };
  }

  if (isIdeaDismissed(state, candidate.idea)) {
    return { eligible: false, fingerprint, reason: "dismissed" };
  }

  if (
    !candidate.isNovel ||
    !candidate.isDirectlySupported ||
    !candidate.isMaterial ||
    !candidate.isSafelyDeferrable
  ) {
    return { eligible: false, fingerprint, reason: "not_eligible" };
  }

  return { eligible: true, fingerprint };
}
