import type { FreeMode } from "../free-mode/config.js";
import {
  FREE_MODE_ATTENTION_PRIORITY,
  FREE_MODE_CHECK_TEMPLATE,
  OPTIONAL_IDEA_TEMPLATE,
} from "../free-mode/prompts.js";
import {
  OPENBRAIN_LOADER_BEGIN_MARKER,
  OPENBRAIN_LOADER_END_MARKER,
} from "./markers.js";

/** Renders the generated Free Mode section shared by every supported loader. */
export function renderFreeModeLoaderBlock(mode: FreeMode): string {
  const enabled = mode === "calibrated";
  const lines = [
    OPENBRAIN_LOADER_BEGIN_MARKER,
    "## OpenBrain Free Mode",
    "",
    `Configuration: \`interaction.free_mode: ${mode}\`.`,
    "",
  ];

  if (!enabled) {
    lines.push(
      "Free Mode is off. Do not show proactive Free Mode checkpoints or optional ideas.",
      "",
      "Enable it only when the user selects Calibrated Free Mode.",
      OPENBRAIN_LOADER_END_MARKER,
    );
    return lines.join("\n");
  }

  lines.push(
    "Calibrated Free Mode is proactive assistant discipline, not a bundled free model or provider tier. OpenBrain does not enforce it at runtime; you, the agent, apply it.",
    "Ask before acting only when a concrete, evidence-backed alternative materially changes outcome, scope, reversibility, external impact, cost, security, or maintenance.",
    "Raise at most one material checkpoint per turn, and only at a safe boundary. Do not interrupt for routine or cosmetic choices.",
    "With explicit carte blanche, build everything safe without stopping, then disclose the routes you chose at handoff. Safety, destructive, privacy, legal, and publication confirmations still require a checkpoint even under carte blanche.",
    "",
    `Checkpoint template: ${FREE_MODE_CHECK_TEMPLATE}`,
    "",
    "After completing work, you may offer at most one optional idea per session. It must be novel, directly supported by what you discovered, material, and safely deferrable.",
    "Before offering an optional idea, confirm it was not already dismissed:",
    '  open-brain free-mode check "your idea in a short phrase"',
    "A non-zero exit means the user dismissed this idea before; do not raise it again without materially new evidence.",
    "If the user declines an idea you offered, record it so it is never repeated:",
    '  open-brain free-mode dismiss "your idea in a short phrase"',
    `Optional idea template: ${OPTIONAL_IDEA_TEMPLATE}`,
    "",
    `Shared attention priority: ${FREE_MODE_ATTENTION_PRIORITY.join(" > ")}. If a higher-priority item is present, suppress lower-priority prompts.`,
    "",
    "Local state may retain only mode, timestamps, and opaque dismissed-idea fingerprints, never prompts, chain-of-thought, secrets, or telemetry. Run `open-brain free-mode reset` to erase every remembered dismissal.",
    OPENBRAIN_LOADER_END_MARKER,
  );

  return lines.join("\n");
}
