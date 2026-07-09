import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadCatalog,
  recordsFromCatalog,
} from "../src/core/catalog.js";
import { loadConfig } from "../src/core/config.js";
import { writeIndexArtifacts } from "../src/core/index-writer.js";
import { routeVault } from "../src/core/route.js";
import { scanVault } from "../src/core/scan.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(testDirectory, "fixtures", "core-vault");
const fixedNow = new Date("2026-01-20T00:00:00.000Z");
const fixedGitTimes = new Map([
  ["00_index/routing.yml", 1_704_067_200],
  ["00_index/vault.config.yml", 1_704_067_200],
  ["10_memory/alpha.md", 1_704_067_200],
  ["10_memory/old-2020-01-01.md", 1_704_067_200],
  ["20_contexts/beta.md", 1_704_067_200],
  ["40_sources/source.txt", 1_704_067_200],
]);

test("catalog readers accept object envelopes and legacy arrays", async (t) => {
  const vaultRoot = await mkdtemp(join(tmpdir(), "open-brain-core-"));
  t.after(async () => rm(vaultRoot, { recursive: true, force: true }));
  await cp(fixtureRoot, vaultRoot, { recursive: true });

  const config = await loadConfig(vaultRoot);
  const scan = await scanVault(vaultRoot, config, {
    now: fixedNow,
    gitTimes: fixedGitTimes,
  });
  await writeIndexArtifacts(vaultRoot, config, scan, {
    now: fixedNow,
    writeDelta: false,
  });

  const catalogJson = JSON.parse(
    await readFile(join(vaultRoot, "00_index", "catalog.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(Array.isArray(catalogJson), false);
  assert.equal(catalogJson.schema_version, 1);
  assert.equal((await loadCatalog(vaultRoot, config)).length, 6);
  assert.equal((await loadCatalog(vaultRoot, config, ["10_memory"])).length, 2);

  const legacyPath = join(vaultRoot, "legacy-catalog.json");
  await writeFile(legacyPath, JSON.stringify([scan.catalog.records[0]]), "utf8");
  assert.equal(
    recordsFromCatalog(JSON.parse(await readFile(legacyPath, "utf8"))).length,
    1,
  );

  const routed = await routeVault(vaultRoot, config, "planning beta");
  assert.equal(routed.route, "planning");
  assert.equal(routed.files[0]?.baseline, true);
  assert.equal(
    routed.files.some((file) => file.path.endsWith("20_contexts/beta.md")),
    true,
  );
  assert.equal(
    routed.files.some((file) => file.path.endsWith("40_sources/source.txt")),
    false,
  );
});
