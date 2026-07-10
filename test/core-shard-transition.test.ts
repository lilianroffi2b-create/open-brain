import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCatalog } from "../src/core/catalog.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { writeIndexArtifacts } from "../src/core/index-writer.js";
import { scanVault } from "../src/core/scan.js";
import type { VaultConfig } from "../src/core/types.js";

// A vault that shards from P2 with a tiny P1 boundary: three docs shard,
// dropping to one doc falls back to P1 and must be unsharded.
function transitionConfig(): VaultConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.root_label = "TransitionVault";
  config.paliers.p1_max = 2;
  config.paliers.shard_from = "P2";
  return config;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("scan self-heals stale shard artifacts when a vault shrinks below the shard threshold", async (t) => {
  const config = transitionConfig();
  const root = await mkdtemp(join(tmpdir(), "open-brain-shard-transition-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const memory = join(root, "10_memory");
  await mkdir(memory, { recursive: true });
  const docs = ["alpha.md", "beta.md", "gamma.md"];
  for (const name of docs) {
    await writeFile(join(memory, name), `# ${name}\n`, "utf8");
  }

  const shardedScan = await scanVault(root, config, {
    now: new Date("2026-04-01T00:00:00.000Z"),
    gitTimes: new Map(),
  });
  assert.equal(shardedScan.freshness.sharded, true);
  await writeIndexArtifacts(root, config, shardedScan, {
    now: new Date("2026-04-01T00:00:00.000Z"),
    writeDelta: false,
  });

  const indexPath = join(root, config.paths.catalog_index);
  const shardPath = join(root, config.paths.catalog_shards, "10_memory.json");
  assert.equal(await fileExists(indexPath), true, "shard index should exist while sharded");
  assert.equal(await fileExists(shardPath), true, "layer shard should exist while sharded");
  assert.equal((await loadCatalog(root, config, ["10_memory"])).length, 3);

  // Drop below the shard boundary, then rescan.
  await unlink(join(memory, "beta.md"));
  await unlink(join(memory, "gamma.md"));

  const previousRecords = await loadCatalog(root, config);
  const unshardedScan = await scanVault(root, config, {
    now: new Date("2026-04-02T00:00:00.000Z"),
    gitTimes: new Map(),
    previousRecords,
  });
  assert.equal(unshardedScan.freshness.sharded, false);
  await writeIndexArtifacts(root, config, unshardedScan, {
    now: new Date("2026-04-02T00:00:00.000Z"),
    writeDelta: false,
  });

  // The stale shard index and per-layer shard file must be gone.
  assert.equal(await fileExists(indexPath), false, "shard index should be removed after unsharding");
  assert.equal(await fileExists(shardPath), false, "layer shard should be removed after unsharding");

  // Scoped loadCatalog must no longer return the deleted files.
  const scoped = await loadCatalog(root, config, ["10_memory"]);
  assert.deepEqual(
    scoped.map((record) => record.path).sort(),
    ["TransitionVault/10_memory/alpha.md"],
  );
});
