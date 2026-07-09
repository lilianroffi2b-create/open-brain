import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canShowFreeModeCheckpoint,
  chooseAttentionPrompt,
  createFreeModeLocalState,
  createFreeModeRequestBudget,
  dismissIdea,
  evaluateOptionalIdea,
  fingerprintIdea,
  getFreeModeStatePath,
  loadFreeModeLocalState,
  markFreeModeCheckpointShown,
  OptionalIdeaSession,
  parseFreeMode,
  readFreeMode,
  saveFreeModeLocalState,
  setFreeMode,
  validateFreeModeLocalState,
  type VaultConfigLike,
} from "../src/free-mode/index.js";

test("Free Mode config defaults off and updates immutably", () => {
  const original: VaultConfigLike = {
    name: "example vault",
    interaction: { language: "en" },
  };

  assert.equal(readFreeMode({}), "off");
  assert.equal(readFreeMode({ interaction: { free_mode: "calibrated" } }), "calibrated");
  assert.equal(parseFreeMode(undefined), "off");
  assert.throws(() => parseFreeMode("always-on"), /off.*calibrated/);

  const updated = setFreeMode(original, "calibrated");
  assert.equal(updated.interaction.free_mode, "calibrated");
  assert.equal(updated.interaction.language, "en");
  assert.equal(readFreeMode(original), "off");
});

test("local state persists only safe metadata and opaque dismissed fingerprints", async (t) => {
  const vaultRoot = await mkdtemp(join(tmpdir(), "open-brain-free-mode-"));
  t.after(async () => rm(vaultRoot, { recursive: true, force: true }));

  const idea = "Add a reusable source-quality check";
  const start = new Date("2026-07-09T12:00:00.000Z");
  const dismissedAt = new Date("2026-07-09T12:01:00.000Z");
  const initial = createFreeModeLocalState("calibrated", start);
  const state = dismissIdea(initial, idea, dismissedAt);

  await saveFreeModeLocalState(vaultRoot, state);

  const raw = await readFile(getFreeModeStatePath(vaultRoot), "utf8");
  const stored = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), [
    "createdAt",
    "dismissedIdeaFingerprints",
    "mode",
    "schemaVersion",
    "updatedAt",
  ]);
  assert.equal(raw.includes(idea), false);
  assert.equal(raw.includes("prompt"), false);
  assert.equal(raw.includes("telemetry"), false);
  const fingerprints = stored.dismissedIdeaFingerprints;
  assert.equal(Array.isArray(fingerprints), true);
  const fingerprint = Array.isArray(fingerprints) ? fingerprints[0] : undefined;
  if (typeof fingerprint !== "string") {
    throw new Error("Expected one dismissed idea fingerprint.");
  }
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, fingerprintIdea(idea));

  const restored = await loadFreeModeLocalState(vaultRoot, "off");
  assert.deepEqual(restored, state);
  assert.throws(
    () =>
      validateFreeModeLocalState({
        ...stored,
        prompt: "This must never be persisted",
      }),
    /unsupported fields/,
  );
});

test("optional ideas are disabled off, once per session, and never repeated after dismissal", () => {
  const candidate = {
    idea: "Add a reusable source-quality check",
    isNovel: true,
    isDirectlySupported: true,
    isMaterial: true,
    isSafelyDeferrable: true,
  };
  const state = createFreeModeLocalState("calibrated");
  const session = new OptionalIdeaSession();

  assert.equal(
    evaluateOptionalIdea("off", session, state, candidate).reason,
    "free_mode_off",
  );

  assert.equal(
    evaluateOptionalIdea("calibrated", session, state, candidate).eligible,
    true,
  );
  session.markOptionalIdeaOffered();
  assert.equal(
    evaluateOptionalIdea("calibrated", session, state, candidate).reason,
    "already_offered_this_session",
  );

  const dismissed = dismissIdea(state, candidate.idea);
  assert.equal(
    evaluateOptionalIdea(
      "calibrated",
      new OptionalIdeaSession(),
      dismissed,
      candidate,
    ).reason,
    "dismissed",
  );
});

test("Free Mode checkpoints require material evidence and obey the shared attention priority", () => {
  const budget = createFreeModeRequestBudget();
  assert.equal(
    canShowFreeModeCheckpoint({
      mode: "calibrated",
      budget,
      materialAlternative: true,
      atSafeBoundary: true,
    }),
    true,
  );
  assert.equal(
    canShowFreeModeCheckpoint({
      mode: "calibrated",
      budget,
      materialAlternative: false,
      atSafeBoundary: true,
    }),
    false,
  );
  assert.equal(
    canShowFreeModeCheckpoint({
      mode: "off",
      budget,
      materialAlternative: true,
      atSafeBoundary: true,
    }),
    false,
  );
  assert.equal(
    canShowFreeModeCheckpoint({
      mode: "calibrated",
      budget: markFreeModeCheckpointShown(budget),
      materialAlternative: true,
      atSafeBoundary: true,
    }),
    false,
  );

  const base = {
    mode: "calibrated" as const,
    safetyConfirmationRequired: false,
    materialFreeModeAlternative: true,
    atSafeBoundary: true,
    freeModeCheckpointAlreadyShown: false,
    hermesNudgeAvailable: true,
    optionalIdeaAvailable: true,
  };

  assert.equal(
    chooseAttentionPrompt({ ...base, safetyConfirmationRequired: true }),
    "safety-confirmation",
  );
  assert.equal(chooseAttentionPrompt(base), "free-mode-checkpoint");
  assert.equal(
    chooseAttentionPrompt({ ...base, freeModeCheckpointAlreadyShown: true }),
    "hermes-preference-nudge",
  );
  assert.equal(
    chooseAttentionPrompt({
      ...base,
      freeModeCheckpointAlreadyShown: true,
      hermesNudgeAvailable: false,
    }),
    "optional-idea",
  );
});
