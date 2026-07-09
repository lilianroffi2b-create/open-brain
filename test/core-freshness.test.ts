import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { writeIndexArtifacts } from "../src/core/index-writer.js";
import { countChangedSince, scanVault } from "../src/core/scan.js";
import { getVaultStatus } from "../src/core/status.js";
import type { VaultConfig } from "../src/core/types.js";

function config(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return { ...structuredClone(DEFAULT_CONFIG), root_label: "FreshVault", ...overrides };
}

function deltaName(now: Date): string {
  return "scan-delta-" + now.toISOString().replace(/[:.]/gu, "").replace("T", "_").replace("Z", "") + ".md";
}

test("countChangedSince counts human edits and ignores generated index artifacts", async (t) => {
  const vault = config();
  const root = await mkdtemp(join(tmpdir(), "open-brain-fresh-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory"), { recursive: true });
  await mkdir(join(root, "00_index"), { recursive: true });

  const contentPath = join(root, "10_memory", "x.md");
  await writeFile(contentPath, "# Content\n", "utf8");
  const contentEdit = new Date("2026-01-10T00:00:00.000Z");
  await utimes(contentPath, contentEdit, contentEdit);

  // A generated index artifact touched in the future must never count as an edit.
  const generatedPath = join(root, "00_index", "catalog.json");
  await writeFile(generatedPath, "{}\n", "utf8");
  const future = new Date("2026-12-31T00:00:00.000Z");
  await utimes(generatedPath, future, future);

  assert.equal(await countChangedSince(root, vault, new Date("2026-01-05T00:00:00.000Z")), 1);
  assert.equal(await countChangedSince(root, vault, new Date("2026-01-20T00:00:00.000Z")), 0);
});

test("delta rotation purges older notes and honours deltas.retention", async (t) => {
  const vault = config();
  vault.deltas.retention = 2;
  const root = await mkdtemp(join(tmpdir(), "open-brain-delta-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "10_memory", "note.md"), "# Note\n", "utf8");

  const scan = await scanVault(root, vault, {
    now: new Date("2026-03-01T00:00:00.000Z"),
    gitTimes: new Map(),
  });

  const stamps = [
    new Date("2026-03-01T00:00:01.001Z"),
    new Date("2026-03-01T00:00:02.002Z"),
    new Date("2026-03-01T00:00:03.003Z"),
    new Date("2026-03-01T00:00:04.004Z"),
  ];
  for (const now of stamps) {
    await writeIndexArtifacts(root, vault, scan, { now });
  }

  const present = (await readdir(join(root, vault.paths.deltas)))
    .filter((entry) => /^scan-delta-\d{4}-\d{2}-\d{2}_\d{9}\.md$/u.test(entry))
    .sort();

  assert.deepEqual(present, [deltaName(stamps[2]!), deltaName(stamps[3]!)]);
});

test("status --auto rescans when the change signal fires with no other staleness", async (t) => {
  const vault = config();
  const root = await mkdtemp(join(tmpdir(), "open-brain-auto-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all(vault.canonical_dirs.map((dir) => mkdir(join(root, dir), { recursive: true })));

  const notePath = join(root, "10_memory", "note.md");
  await writeFile(notePath, "---\nlifecycle: working\n---\n# Note\n", "utf8");
  const scanClock = new Date("2026-05-01T00:00:00.000Z");
  const scan = await scanVault(root, vault, { now: scanClock, gitTimes: new Map() });
  await writeIndexArtifacts(root, vault, scan, { now: scanClock, writeDelta: false });

  // A later edit within the freshness window: the only reason to rescan is the change.
  const editClock = new Date("2026-05-01T06:00:00.000Z");
  await utimes(notePath, editClock, editClock);

  const status = await getVaultStatus(root, vault, {
    auto: true,
    now: new Date("2026-05-01T12:00:00.000Z"),
  });
  assert.equal(status.rescanned, true);
  assert.equal(status.health.healthy, true);
});
