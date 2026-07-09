import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalog } from "../../src/core/catalog.js";
import { loadConfig } from "../../src/core/config.js";
import { proposeGc } from "../../src/core/gc.js";
import { buildGraph } from "../../src/core/graph.js";
import { checkVaultHealth } from "../../src/core/health.js";
import { writeIndexArtifacts } from "../../src/core/index-writer.js";
import { loadRouting, routeVault } from "../../src/core/route.js";
import { scanVault } from "../../src/core/scan.js";
import { getVaultStatus } from "../../src/core/status.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(testDirectory, "..", "fixtures", "core-vault");
const goldenPath = join(testDirectory, "core-artifacts.json");
const fixedNow = new Date("2026-01-20T00:00:00.000Z");
const fixedGitTimes = new Map([
  ["00_index/routing.yml", 1_704_067_200],
  ["00_index/vault.config.yml", 1_704_067_200],
  ["10_memory/alpha.md", 1_704_067_200],
  ["10_memory/old-2020-01-01.md", 1_704_067_200],
  ["20_contexts/beta.md", 1_704_067_200],
  ["40_sources/source.txt", 1_704_067_200],
]);

async function pinTree(directory: string, when: Date): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await pinTree(path, when);
    } else {
      await utimes(path, when, when);
    }
  }
}

test("route, gc propose, health, and status stay locked on the fixture vault", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-artifacts-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await cp(fixtureRoot, root, { recursive: true });

  const config = await loadConfig(root);
  const scan = await scanVault(root, config, { now: fixedNow, gitTimes: fixedGitTimes });
  await writeIndexArtifacts(root, config, scan, { now: fixedNow, writeDelta: false });
  // Pin content mtimes below the scan clock so the freshness signal is stable.
  await pinTree(root, new Date("2026-01-01T00:00:00.000Z"));

  const route = await routeVault(root, config, "planning beta");
  const records = await loadCatalog(root, config);
  const routing = await loadRouting(root, config);
  const proposal = proposeGc(records, config, {
    graph: buildGraph(records, config.root_label),
    routing,
    now: fixedNow,
  });
  const health = await checkVaultHealth(root, config, { now: fixedNow });
  const status = await getVaultStatus(root, config, { now: fixedNow });

  const artifacts = {
    route,
    gc_candidates: proposal.candidates.map((candidate) => ({
      path: candidate.path,
      reason: candidate.reason,
      tier: candidate.tier,
      lifecycle: candidate.lifecycle,
    })),
    health: {
      healthy: health.healthy,
      stale: health.stale,
      index_available: health.index_available,
      checks: health.checks.map((check) => ({ name: check.name, severity: check.severity })),
    },
    status: {
      rescanned: status.rescanned,
      healthy: status.health.healthy,
      stale: status.health.stale,
    },
  };

  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as unknown;
  assert.deepEqual(artifacts, golden);
});
