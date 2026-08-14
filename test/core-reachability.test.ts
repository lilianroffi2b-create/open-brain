import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { initVault } from "../src/cli/vault.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { checkVaultHealth } from "../src/core/health.js";
import { auditReachability } from "../src/core/reachability.js";
import { runVaultScan } from "../src/core/scan.js";
import type { CatalogRecord, RoutingDocument, VaultConfig } from "../src/core/types.js";

/**
 * A well-formed catalog says nothing about whether a reader can arrive
 * anywhere. These are the two failures that survive every integrity check:
 * a folder nothing points at, and an index that points at nothing.
 */

function config(): VaultConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.root_label = "ReachVault";
  return value;
}

function record(path: string): CatalogRecord {
  return {
    path: `ReachVault/${path}`,
    layer: "memory",
    domain: "general",
    kind: path.endsWith("_index.md") ? "index" : "note",
    lifecycle: "working",
    tags: [],
    summary: path,
    headings: [],
    links: [],
    sha256: "a".repeat(64),
    size: 1,
    token_estimate: 1,
    read_priority: 10,
    source_state: "working",
    tier: "warm",
  };
}

async function write(root: string, path: string, text: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

test("the audit finds unindexed folders, dead index links, orphans, and unrouted layers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-reach-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await write(
    root,
    "10_memory/_index.md",
    [
      "# Memory",
      "",
      "- [Notes](notes/) - what is written down.",
      "- [Decisions](decisions/) - never created.",
      "- [Upstream](https://example.com/doc) - not a vault path.",
    ].join("\n"),
  );
  await write(root, "10_memory/notes/_index.md", "# Notes\n\n- [One](one.md)\n");
  await write(root, "10_memory/notes/one.md", "# One\n");
  await write(root, "20_contexts/_index.md", "# Contexts\n\nNothing below is listed here.\n");
  await write(root, "20_contexts/client/_index.md", "# Client\n");
  await write(root, "20_contexts/client/brief.md", "# Brief\n");
  await write(root, "30_skills/tool.md", "# Tool\n");
  // An archive is where documents stop being read, so it owes no index.
  await write(root, "90_archive/2025/old.md", "# Old\n");

  const catalog = [
    "10_memory/_index.md",
    "10_memory/notes/_index.md",
    "10_memory/notes/one.md",
    "20_contexts/_index.md",
    "20_contexts/client/_index.md",
    "20_contexts/client/brief.md",
    "30_skills/tool.md",
    "90_archive/2025/old.md",
    // A loader at the vault root belongs to no layer and owes no index.
    "AGENTS.md",
  ].map(record);

  const routing: RoutingDocument = {
    always_read: [],
    routes: {
      default: { triggers: [], read_order: ["10_memory/"] },
      notes: { triggers: ["notes"], read_order: ["10_memory/notes"] },
    },
  };

  const report = await auditReachability(root, config(), catalog, routing);

  assert.deepEqual(report.folders_without_index, ["30_skills"]);
  assert.deepEqual(
    report.dead_index_links,
    [{ index: "10_memory/_index.md", target: "decisions/" }],
  );
  assert.deepEqual(report.orphan_folders, ["20_contexts/client"]);
  assert.deepEqual(report.unrouted_layers, ["20_contexts", "30_skills"]);
  assert.deepEqual(report.default_route_layers, ["10_memory"]);
  assert.deepEqual(report.layers, ["10_memory", "20_contexts", "30_skills"]);
  assert.equal(report.folders_with_index, 4);
  assert.equal(report.folders, 5);
});

test("health reports the reading path as warnings and never as a broken vault", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-reach-health-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await initVault(root, { noGit: true });
  const config = await loadConfig(root);
  await runVaultScan(root, config);

  const quiet = await checkVaultHealth(root, config);
  assert.equal(
    quiet.checks.some((check) => check.name.startsWith("reach:")),
    false,
    "status runs on every session start, so the audit stays off unless asked for",
  );

  const audited = await checkVaultHealth(root, config, { reachability: true });
  const names = audited.checks.filter((check) => check.name.startsWith("reach:")).map((check) => check.name);
  assert.deepEqual(names.sort(), ["reach:index", "reach:links", "reach:orphans", "reach:routes"]);
  assert.equal(
    audited.checks.some((check) => check.name.startsWith("reach:") && check.severity === "error"),
    false,
  );
  assert.equal(audited.healthy, true);
});
