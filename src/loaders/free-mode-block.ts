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
    "Calibrated Free Mode is proactive assistant behaviour, not a bundled free model or provider tier.",
    "Ask before acting only when a concrete, evidence-backed alternative materially changes outcome, scope, reversibility, external impact, cost, security, or maintenance.",
    "Ask at most once per request and only at a safe boundary. Do not interrupt for routine or cosmetic choices.",
    "With explicit carte blanche, choose the better safe route and disclose it at handoff. Safety, destructive, privacy, legal, and publication confirmations still require a checkpoint.",
    "",
    `Checkpoint template: ${FREE_MODE_CHECK_TEMPLATE}`,
    "",
    "After completing work, offer at most one optional idea per session. It must be novel, directly supported by discoveries, material, and safely deferrable. Do not repeat a dismissed idea without materially new evidence.",
    `Optional idea template: ${OPTIONAL_IDEA_TEMPLATE}`,
    "",
    `Shared attention priority: ${FREE_MODE_ATTENTION_PRIORITY.join(" > ")}. If a higher-priority item is present, suppress lower-priority prompts.`,
    "",
    "Local state may retain only mode, timestamps, and opaque dismissed-idea fingerprints. Never retain prompts, chain-of-thought, secrets, or telemetry.",
    OPENBRAIN_LOADER_END_MARKER,
  );

  return lines.join("\n");
}
