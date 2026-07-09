import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFreeModeLocalState,
  dismissIdea,
  fingerprintIdea,
  getFreeModeStatePath,
  loadFreeModeLocalState,
  parseFreeMode,
  readFreeMode,
  saveFreeModeLocalState,
  setFreeMode,
  validateFreeModeLocalState,
  type VaultConfigLike,
} from "../src/free-mode/index.js";
import {
  checkIdeaInVault,
  dismissIdeaInVault,
  pathExists,
  resetFreeModeState,
} from "../src/cli/vault.js";

async function makeVault(freeMode: "off" | "calibrated"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-free-mode-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    ["interaction:", `  free_mode: ${freeMode}`, ""].join("\n"),
    "utf8",
  );
  return root;
}

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

test("dismiss records an opaque fingerprint, check reads it, reset erases the file", async (t) => {
  const root = await makeVault("calibrated");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const idea = "Add a reusable source-quality check";
  const statePath = getFreeModeStatePath(root);

  assert.equal(await pathExists(statePath), false);
  assert.deepEqual(await checkIdeaInVault(root, idea), { dismissed: false });
  assert.equal(await pathExists(statePath), false);

  const dismissed = await dismissIdeaInVault(root, idea);
  assert.equal(dismissed.mode, "calibrated");
  assert.equal(dismissed.dismissedIdeaCount, 1);

  const raw = await readFile(statePath, "utf8");
  const stored = JSON.parse(raw) as { dismissedIdeaFingerprints: string[] };
  assert.equal(raw.includes(idea), false);
  assert.match(stored.dismissedIdeaFingerprints[0] ?? "", /^[a-f0-9]{64}$/);
  assert.equal(stored.dismissedIdeaFingerprints[0], fingerprintIdea(idea));

  assert.deepEqual(await checkIdeaInVault(root, idea), { dismissed: true });

  const firstReset = await resetFreeModeState(root);
  assert.equal(firstReset.removed, true);
  assert.equal(await pathExists(statePath), false);

  assert.deepEqual(await checkIdeaInVault(root, idea), { dismissed: false });
  assert.equal(await pathExists(statePath), false);

  const secondReset = await resetFreeModeState(root);
  assert.equal(secondReset.removed, false);
});
