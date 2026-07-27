import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { CatalogRecord, VaultConfig } from "../src/core/types.js";
import {
  OFF_FLAG_FILENAME,
  buildPopulation,
  disableLearning,
  enableLearning,
  isInPopulation,
  isLearningDisabled,
  offFlagPath,
  readPopulation,
  writePopulation,
} from "../src/learning/population.js";
import { learningDirectory } from "../src/learning/store.js";

interface Vault {
  root: string;
  config: VaultConfig;
}

async function armedVault(prefix: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "capabilities:\n  learning:\n    enabled: true\n",
    "utf8",
  );
  return { root, config: await loadConfig(root) };
}

function record(path: string): CatalogRecord {
  return {
    path,
    layer: "memory",
    domain: "general",
    kind: "note",
    lifecycle: "working",
    tags: [],
    summary: "",
    headings: [],
    links: [],
    sha256: "0".repeat(64),
    size: 10,
    token_estimate: 3,
    read_priority: 1,
    source_state: "clean",
    tier: "hot",
  };
}

test("the scope keeps the layer from measuring its own traces", () => {
  const config = DEFAULT_CONFIG;
  const label = config.root_label;
  const population = buildPopulation(config, [
    record(`${label}/10_memory/_state.md`),
    record(`${label}/20_contexts/project.md`),
    // Written by the layer itself: counting it would make a file show up with
    // zero circulation and become a candidate for its own removal.
    record(`${label}/10_memory/learning/beliefs.json`),
    record(`${label}/10_memory/learning/journal/journal-2026-07.jsonl`),
    // Archived on purpose, so no longer part of what circulates.
    record(`${label}/90_archive/old-note.md`),
    // Injected into every session, so it would look infinitely circulated.
    record(`${label}/CLAUDE.md`),
    record(`${label}/AGENTS.md`),
  ], { now: "2026-07-20T09:00:00Z" });

  assert.deepEqual(population.documents, [
    `${label}/10_memory/_state.md`,
    `${label}/20_contexts/project.md`,
  ]);
  assert.equal(population.total, 2);
  assert.equal(population.schema_version, 1);
  assert.equal(population.updated_at, "2026-07-20T09:00:00Z");
  assert.equal(isInPopulation(population, `${label}/10_memory/_state.md`), true);
  assert.equal(isInPopulation(population, `${label}/90_archive/old-note.md`), false);
});

test("the scope takes extra exclusions and never repeats a document", () => {
  const config = DEFAULT_CONFIG;
  const label = config.root_label;
  const population = buildPopulation(
    config,
    [
      record(`${label}/10_memory/auto/20260720_note.md`),
      record(`${label}/20_contexts/project.md`),
      record(`${label}/20_contexts/project.md`),
    ],
    { exclude: ["10_memory/auto/"] },
  );
  assert.deepEqual(population.documents, [`${label}/20_contexts/project.md`]);
});

test("the scope survives a round trip through disk", async (t) => {
  const { root, config } = await armedVault("open-brain-population-io-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal(await readPopulation(config, root), undefined);
  const population = buildPopulation(config, [record(`${config.root_label}/20_contexts/a.md`)]);
  await writePopulation(config, root, population);
  assert.deepEqual(await readPopulation(config, root), population);
});

test("the OFF sentinel answers without reading anything while the capability is off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-population-off-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  // A disarmed layer is a disabled layer, and saying so costs no disk read.
  assert.equal(await isLearningDisabled(DEFAULT_CONFIG, root), true);
  await assert.rejects(stat(learningDirectory(DEFAULT_CONFIG, root)));

  for (const run of [
    async () => readPopulation(DEFAULT_CONFIG, root),
    async () => disableLearning(DEFAULT_CONFIG, root),
    async () => enableLearning(DEFAULT_CONFIG, root),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning is disabled/u);
      return true;
    });
  }
});

test("the OFF sentinel switches the armed layer off and back on", async (t) => {
  const { root, config } = await armedVault("open-brain-population-sentinel-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal(await isLearningDisabled(config, root), false);
  await disableLearning(config, root);
  assert.equal(await isLearningDisabled(config, root), true);
  await enableLearning(config, root);
  assert.equal(await isLearningDisabled(config, root), false);

  // Defence in depth: the sentinel suffix is outside the text suffixes the
  // scanner accepts, so it stays out of the catalog even if a directory
  // exclusion ever changed.
  assert.ok(offFlagPath(config, root).endsWith(OFF_FLAG_FILENAME));
  assert.equal(config.text_extensions.includes(".flag"), false);
});
