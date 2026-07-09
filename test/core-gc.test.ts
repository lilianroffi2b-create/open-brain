import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import {
  applyReviewedGcProposal,
  proposeGc,
  reviewGcProposal,
} from "../src/core/gc.js";
import type {
  CatalogRecord,
  GraphEnvelope,
  RoutingDocument,
  VaultConfig,
} from "../src/core/types.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function config(rootLabel = "GuardVault"): VaultConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.root_label = rootLabel;
  value.activity.active_paths = ["10_memory/active.md"];
  return value;
}

function record(path: string, overrides: Partial<CatalogRecord> = {}): CatalogRecord {
  return {
    path,
    layer: "memory",
    domain: "general",
    kind: "note",
    lifecycle: "working",
    tags: [],
    summary: "Synthetic record.",
    headings: [],
    links: [],
    sha256: "a".repeat(64),
    size: 1,
    token_estimate: 1,
    read_priority: 10,
    source_state: "working",
    tier: "warm",
    ...overrides,
  };
}

test("gc propose filters every candidate through the structural guardrails", () => {
  const vault = config();
  const label = vault.root_label;
  const graph: GraphEnvelope = {
    schema_version: 1,
    generated_at: NOW.toISOString(),
    root_label: label,
    nodes: [],
    edges: [{ source: `${label}/10_memory/alpha.md`, target: `${label}/10_memory/linked.md`, kind: "link" }],
  };
  const routing: RoutingDocument = {
    always_read: ["10_memory/keep.md"],
    routes: {},
  };

  const proposal = proposeGc(
    [
      record(`${label}/10_memory/cold.md`, { tier: "cold" }),
      record(`${label}/10_memory/expired.md`, { lifecycle: "ephemeral", expires: "2020-01-01" }),
      record(`${label}/10_memory/master.md`, { lifecycle: "master", tier: "cold" }),
      record(`${label}/00_index/stale.md`, { tier: "cold" }),
      record(`${label}/10_memory/preferences/pref.md`, { tier: "cold" }),
      record(`${label}/20_contexts/_index.md`, { kind: "index", tier: "cold" }),
      record(`${label}/90_archive/old.md`, { tier: "cold" }),
      record(`${label}/10_memory/keep.md`, { tier: "cold" }),
      record(`${label}/10_memory/active.md`, { tier: "cold" }),
      record(`${label}/10_memory/linked.md`, { tier: "cold" }),
    ],
    vault,
    { now: NOW, graph, routing },
  );

  assert.deepEqual(
    proposal.candidates.map((candidate) => `${candidate.path}::${candidate.reason}`),
    [
      `${label}/10_memory/cold.md::cold_unreferenced`,
      `${label}/10_memory/expired.md::expired_ephemeral`,
    ],
  );
});

test("gc apply re-verifies each candidate and refuses drift, mismatch, and guarded docs", async (t) => {
  const vault = config("ApplyVault");
  const label = vault.root_label;
  const root = await mkdtemp(join(tmpdir(), "open-brain-gc-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory"), { recursive: true });

  const shaA = "a".repeat(64);
  const shaB = "b".repeat(64);
  const shaC = "c".repeat(64);
  await writeFile(join(root, "10_memory", "a.md"), "Archive me.", "utf8");
  await writeFile(join(root, "10_memory", "b.md"), "I changed since the proposal.", "utf8");
  await writeFile(join(root, "10_memory", "c.md"), "I became a master since the proposal.", "utf8");

  const proposal = proposeGc(
    [
      record(`${label}/10_memory/a.md`, { tier: "cold", sha256: shaA }),
      record(`${label}/10_memory/b.md`, { tier: "cold", sha256: shaB }),
      record(`${label}/10_memory/c.md`, { tier: "cold", sha256: shaC }),
    ],
    vault,
    { now: NOW },
  );
  const reviewed = reviewGcProposal(proposal, "approved", "reviewer", NOW);

  const applied = await applyReviewedGcProposal(
    root,
    vault,
    reviewed,
    [
      record(`${label}/10_memory/a.md`, { tier: "cold", sha256: shaA }),
      record(`${label}/10_memory/b.md`, { tier: "cold", sha256: "d".repeat(64) }),
      record(`${label}/10_memory/c.md`, { lifecycle: "master", tier: "cold", sha256: shaC }),
    ],
    NOW,
  );

  assert.equal(applied.archived_count, 1);
  assert.equal(applied.sha_mismatch_count, 1);
  assert.equal(applied.refused_guard_count, 1);
  assert.equal(applied.missing_count, 0);

  // Only a.md is archived; b.md and c.md are untouched on disk.
  assert.equal(
    await readFile(join(root, "90_archive", "2026", "10_memory", "a.md"), "utf8"),
    "Archive me.",
  );
  await assert.rejects(readFile(join(root, "10_memory", "a.md"), "utf8"));
  assert.equal(await readFile(join(root, "10_memory", "b.md"), "utf8"), "I changed since the proposal.");
  assert.equal(
    await readFile(join(root, "10_memory", "c.md"), "utf8"),
    "I became a master since the proposal.",
  );

  const outcomes = Object.fromEntries(applied.candidates.map((c) => [c.path.split("/").at(-1), c.detail]));
  assert.equal(outcomes["a.md"], "cold_unreferenced");
  assert.equal(outcomes["b.md"], "sha_mismatch");
  assert.equal(outcomes["c.md"], "guard:lifecycle_master");
});
