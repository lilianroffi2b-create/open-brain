import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../src/core/config.js";
import { scanVault } from "../../src/core/scan.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(testDirectory, "..", "fixtures", "core-vault");
const goldenPath = join(testDirectory, "scan-summary.json");
const fixedNow = new Date("2026-01-20T00:00:00.000Z");
const fixedGitTimes = new Map([
  ["00_index/routing.yml", 1_704_067_200],
  ["00_index/vault.config.yml", 1_704_067_200],
  ["10_memory/alpha.md", 1_704_067_200],
  ["10_memory/old-2020-01-01.md", 1_704_067_200],
  ["20_contexts/beta.md", 1_704_067_200],
  ["40_sources/source.txt", 1_704_067_200],
]);

interface ScanGolden {
  record_paths: string[];
  edge_pairs: string[];
  lifecycle_counts: Record<string, number>;
  tier_by_path: Record<string, string>;
  delta: {
    added_count: number;
    modified_count: number;
    removed_count: number;
  };
}

test("scan creates a versioned catalog and stable graph from synthetic material", async () => {
  const config = await loadConfig(fixtureRoot);
  const result = await scanVault(fixtureRoot, config, {
    now: fixedNow,
    gitTimes: fixedGitTimes,
  });
  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as ScanGolden;

  assert.equal(result.catalog.schema_version, 1);
  assert.equal(result.graph.schema_version, 1);
  assert.equal(result.freshness.schema_version, 1);
  assert.deepEqual(
    result.catalog.records.map((record) => record.path),
    golden.record_paths,
  );
  assert.deepEqual(
    result.graph.edges.map((edge) => edge.source + "->" + edge.target),
    golden.edge_pairs,
  );
  assert.deepEqual(result.freshness.lifecycle_counts, golden.lifecycle_counts);
  assert.deepEqual(
    Object.fromEntries(
      result.catalog.records
        .filter((record) => Object.hasOwn(golden.tier_by_path, record.path))
        .map((record) => [record.path, record.tier]),
    ),
    golden.tier_by_path,
  );
  assert.deepEqual(result.freshness.delta, golden.delta);
  assert.match(result.freshness.catalog_sha256, /^[a-f0-9]{64}$/);
});
