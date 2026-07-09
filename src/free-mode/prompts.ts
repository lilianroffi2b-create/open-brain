import type { FreeMode } from "./config.js";

export const FREE_MODE_CHECK_TEMPLATE =
  "Free Mode check: A leads to [consequence]. B would [benefit], based on [evidence]. I recommend B. Continue with A / switch to B / use your judgment?";

export const OPTIONAL_IDEA_TEMPLATE =
  "One optional idea: [idea]. It fits because [discovery]. I have not changed it. Want it scoped next?";

export const FREE_MODE_ATTENTION_PRIORITY = [
  "safety confirmation",
  "Free Mode checkpoint",
  "Hermes preference nudge",
  "optional idea",
] as const;

export function describeFreeMode(mode: FreeMode): string {
  if (mode === "calibrated") {
    return "Calibrated Free Mode is enabled.";
  }

  return "Free Mode is off.";
}
