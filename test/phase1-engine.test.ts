import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import {
  applyReviewedGcProposal,
  proposeGc,
  reviewGcProposal,
} from "../src/core/gc.js";
import { checkVaultHealth } from "../src/core/health.js";
import {
  extractChatGptConversations,
  extractIngestDocuments,
  ingestInbox,
} from "../src/core/ingest.js";
import { writeIndexArtifacts } from "../src/core/index-writer.js";
import { scanVault } from "../src/core/scan.js";
import { getVaultStatus } from "../src/core/status.js";
import type { CatalogRecord, VaultConfig } from "../src/core/types.js";

function createConfig(rootLabel = "TestVault"): VaultConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.root_label = rootLabel;
  config.paliers = {
    ...config.paliers,
    p1_max: 2,
    p2_max: 20,
    p3_max: 100,
    shard_from: "P1",
  };
  return config;
}

async function createVault(config: VaultConfig): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-phase1-"));
  await Promise.all(
    config.canonical_dirs.map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  );
  return root;
}

function record(
  path: string,
  overrides: Partial<CatalogRecord> = {},
): CatalogRecord {
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

test("GC proposes safely and applies only approved reviews without deleting content", async (t) => {
  const config = createConfig();
  const root = await createVault(config);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const coldPath = `${config.root_label}/10_memory/cold.md`;
  const sourcePath = join(root, "10_memory", "cold.md");
  await writeFile(sourcePath, "Keep this source file.", "utf8");

  const proposal = proposeGc([
    record(coldPath, { tier: "cold" }),
    record(`${config.root_label}/10_memory/expired.md`, {
      lifecycle: "ephemeral",
      expires: "2020-01-01",
    }),
    record(`${config.root_label}/10_memory/master.md`, {
      lifecycle: "master",
      tier: "cold",
    }),
    record(`${config.root_label}/00_index/catalog.json`, { tier: "cold" }),
  ], config, { now: new Date("2026-07-09T12:00:00.000Z") });

  assert.deepEqual(
    proposal.candidates.map((candidate) => candidate.path),
    [`${config.root_label}/10_memory/cold.md`, `${config.root_label}/10_memory/expired.md`],
  );
  await assert.rejects(
    applyReviewedGcProposal(root, config, proposal, [record(coldPath)]),
    /approved/,
  );

  const reviewed = reviewGcProposal(
    proposal,
    "approved",
    "synthetic-review",
    new Date("2026-07-09T12:01:00.000Z"),
  );
  const applied = await applyReviewedGcProposal(
    root,
    config,
    reviewed,
    [record(coldPath)],
    new Date("2026-07-09T12:02:00.000Z"),
  );

  assert.equal(applied.deleted_count, 0);
  assert.equal(await readFile(sourcePath, "utf8"), "Keep this source file.");
  assert.equal(
    (await readFile(join(root, applied.report_path), "utf8")).includes("synthetic-review"),
    true,
  );
});

test("health validates canonical directories, freshness, shard integrity, and status can repair indexes", async (t) => {
  const config = createConfig();
  const root = await createVault(config);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const now = new Date("2026-07-09T12:00:00.000Z");

  await writeFile(
    join(root, "10_memory", "note.md"),
    "---\nlifecycle: working\n---\n# A test note\n",
    "utf8",
  );
  const scan = await scanVault(root, config, { now, gitTimes: new Map() });
  await writeIndexArtifacts(root, config, scan, { now, writeDelta: false });

  const healthy = await checkVaultHealth(root, config, { now });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.stale, false);
  assert.equal(healthy.checks.some((check) => check.name === "shards" && check.severity === "ok"), true);

  await writeFile(join(root, config.paths.catalog_shards, "10_memory.json"), "{}\n", "utf8");
  const corrupted = await checkVaultHealth(root, config, { now });
  assert.equal(corrupted.healthy, false);

  const status = await getVaultStatus(root, config, { auto: true, now });
  assert.equal(status.rescanned, true);
  assert.equal(status.health.healthy, true);
});

test("ingest archives supported inputs, produces generic briefs, and clears inbox only after success", async (t) => {
  const config = createConfig();
  const root = await createVault(config);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inbox = join(root, config.paths.inbox);
  const conversation = {
    title: "Synthetic conversation",
    mapping: {
      root: { children: ["user"] },
      user: {
        message: {
          author: { role: "user" },
          content: { parts: ["First message."] },
        },
        children: ["assistant"],
      },
      assistant: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Second message."] },
        },
        children: [],
      },
    },
  };
  await writeFile(join(inbox, "note.txt"), "A plain imported note.", "utf8");
  await writeFile(join(inbox, "conversation.json"), JSON.stringify(conversation), "utf8");

  const extracted = extractChatGptConversations(conversation);
  assert.equal(extracted.length, 1);
  const extractedConversation = extracted[0];
  assert.ok(extractedConversation);
  assert.equal(extractedConversation.body.includes("First message."), true);
  assert.equal(extractedConversation.body.includes("Second message."), true);
  assert.equal(
    extractIngestDocuments("guide.md", "# Markdown title\n\nMarkdown body.")[0]?.kind,
    "text",
  );
  assert.equal(
    extractIngestDocuments("data.json", JSON.stringify({ key: "value" }))[0]?.kind,
    "json",
  );

  const report = await ingestInbox(root, config, {
    now: new Date("2026-07-09T12:00:00.000Z"),
    batchId: "synthetic-batch",
  });
  assert.equal(report.failures.length, 0);
  assert.equal(report.imported.length, 2);
  assert.equal(report.inbox_cleared, 2);
  await assert.rejects(readFile(join(inbox, "note.txt"), "utf8"));
  await assert.rejects(readFile(join(inbox, "conversation.json"), "utf8"));

  const importedConversation = report.imported.find(
    (item) => item.source_path === "conversation.json",
  );
  assert.ok(importedConversation);
  assert.equal(
    (await readFile(join(root, importedConversation.archive_path), "utf8")).includes("Synthetic conversation"),
    true,
  );
  const firstBriefPath = importedConversation.brief_paths[0];
  assert.ok(firstBriefPath);
  const brief = await readFile(join(root, firstBriefPath), "utf8");
  assert.equal(brief.includes("First message."), true);
  assert.equal(brief.includes("Second message."), true);

  await writeFile(join(inbox, "invalid.json"), "not valid json", "utf8");
  const failed = await ingestInbox(root, config, { batchId: "failed-batch" });
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.inbox_cleared, 0);
  assert.equal(await readFile(join(inbox, "invalid.json"), "utf8"), "not valid json");
});
