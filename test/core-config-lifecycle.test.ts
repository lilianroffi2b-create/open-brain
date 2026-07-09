import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  deepMerge,
  findVaultConfigPath,
  loadConfig,
  palier,
  shardsEnabled,
} from "../src/core/config.js";
import {
  filenameDateTimestamp,
  isExpired,
  thermalTier,
} from "../src/core/lifecycle.js";

test("configuration deep-merges generic overrides and keeps tier boundaries stable", () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    root_label: "Example",
    paliers: { p1_max: 3, shard_from: "P2" },
    activity: { active_paths: ["10_memory/example.md"] },
  });

  assert.equal(merged.root_label, "Example");
  assert.equal(merged.paliers.p1_max, 3);
  assert.equal(merged.paliers.p2_max, 2_000);
  assert.deepEqual(merged.activity.active_paths, ["10_memory/example.md"]);
  assert.deepEqual(merged.activity.active_dir_prefixes, []);
  assert.equal(palier(2, merged), "P1");
  assert.equal(palier(3, merged), "P2");
  assert.equal(shardsEnabled(3, merged), true);
});

test("lifecycle helpers preserve date, expiry, and thermal contracts", () => {
  assert.equal(
    filenameDateTimestamp("10_memory/note-2024-02-29.md"),
    Math.floor(Date.UTC(2024, 1, 29) / 1000),
  );
  assert.equal(filenameDateTimestamp("10_memory/note-2024-02-30.md"), undefined);
  assert.equal(isExpired("2026-01-01", new Date("2026-01-02T12:00:00.000Z")), true);
  assert.equal(isExpired("2026-01-02", new Date("2026-01-02T12:00:00.000Z")), false);
  assert.equal(thermalTier(1, false, "working", false, DEFAULT_CONFIG), "hot");
  assert.equal(thermalTier(200, false, "working", false, DEFAULT_CONFIG), "cold");
  assert.equal(thermalTier(200, false, "master", false, DEFAULT_CONFIG), "warm");
});

test("configuration discovery supports a generic skin-specific index directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "00_map", "vault.config.yml");
  await mkdir(join(root, "00_map"), { recursive: true });
  await writeFile(configPath, "root_label: SkinExample\n", "utf8");

  assert.equal(await findVaultConfigPath(root), configPath);
  assert.equal((await loadConfig(root)).root_label, "SkinExample");
});
