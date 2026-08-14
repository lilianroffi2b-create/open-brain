import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import {
  ingestInbox,
  extractChatGptConversations,
  MAX_CONVERSATION_NODES,
  MAX_INGEST_DEPTH,
} from "../src/core/ingest.js";
import { lockPathFor, withLock } from "../src/core/lock.js";
import { isInsideVault, scanVault } from "../src/core/scan.js";
import type { VaultConfig } from "../src/core/types.js";

function config(label: string): VaultConfig {
  return { ...structuredClone(DEFAULT_CONFIG), root_label: label };
}

test("isInsideVault refuses a sibling, a parent, and the vault itself", () => {
  assert.equal(isInsideVault("/vault", "/vault/10_memory/a.md"), true);
  assert.equal(isInsideVault("/vault", "/vault"), false);
  assert.equal(isInsideVault("/vault", "/vault-next/a.md"), false);
  assert.equal(isInsideVault("/vault", "/etc/passwd"), false);
  assert.equal(isInsideVault("/vault", "/"), false);
});

test("a symlink pointing outside the vault is refused and counted, never indexed", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-outside-"));
  const root = await mkdtemp(join(tmpdir(), "open-brain-symlink-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const secretPath = join(outside, "secret.md");
  await writeFile(secretPath, "# Secret material\n", "utf8");
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "10_memory", "own.md"), "# Own\n", "utf8");
  await symlink(secretPath, join(root, "10_memory", "leak.md"));
  await symlink(outside, join(root, "10_memory", "elsewhere"));
  // A link that stays inside the vault is still followed.
  await symlink(join(root, "10_memory", "own.md"), join(root, "10_memory", "alias.md"));

  const scan = await scanVault(root, config("SymlinkVault"), {
    now: new Date("2026-06-01T00:00:00.000Z"),
    gitTimes: new Map(),
  });

  const paths = scan.catalog.records.map((record) => record.path).sort();
  assert.deepEqual(paths, [
    "SymlinkVault/10_memory/alias.md",
    "SymlinkVault/10_memory/own.md",
  ]);
  assert.equal(scan.freshness.scan_stats.skipped.symlink_outside_vault, 2);
  assert.ok(
    !JSON.stringify(scan.catalog).includes("Secret material"),
    "content from outside the vault must never reach the catalog",
  );
});

test("the lock file of a running scan is invisible to that scan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lockscan-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "10_memory", "note.md"), "# Note\n", "utf8");

  const vault = config("LockVault");
  const scan = await withLock(lockPathFor(root, "scan"), async () =>
    scanVault(root, vault, { now: new Date("2026-06-01T00:00:00.000Z"), gitTimes: new Map() }));

  assert.deepEqual(
    scan.catalog.records.map((record) => record.path),
    ["LockVault/10_memory/note.md"],
  );
  assert.equal(scan.freshness.scan_stats.skipped.unrecognized_suffix, undefined);
});

test("a deep conversation graph is imported partially instead of overflowing the stack", () => {
  // A chain long enough that the previous recursive walk raised a RangeError.
  const nodeCount = 60_000;
  const mapping: Record<string, unknown> = {};
  for (let index = 0; index < nodeCount; index += 1) {
    mapping[`node-${String(index)}`] = {
      message: {
        author: { role: "user" },
        content: { parts: [`line ${String(index)}`] },
      },
      children: index + 1 < nodeCount ? [`node-${String(index + 1)}`] : [],
    };
  }

  const documents = extractChatGptConversations([{ title: "Long", mapping }]);
  assert.equal(documents.length, 1);
  const document = documents[0];
  assert.ok(document);
  assert.equal(document.truncated, undefined, "60000 nodes stay under the bound");
  assert.ok(document.body.includes("line 0"));
  assert.ok(document.body.includes(`line ${String(nodeCount - 1)}`));
  assert.ok(MAX_CONVERSATION_NODES > nodeCount);

  // Past the bound the walk stops, keeps what it read, and says how much it left.
  const bounded = extractChatGptConversations([{ title: "Long", mapping }], { maxNodes: 10 });
  const partial = bounded[0];
  assert.ok(partial);
  assert.equal(partial.truncated, nodeCount - 10);
  assert.ok(partial.body.includes("line 9"));
  assert.ok(!partial.body.includes("line 10\n"));
});

test("an inbox nested past the depth bound is refused with a readable error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-ingest-depth-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const vault = config("DepthVault");

  const segments = Array.from({ length: MAX_INGEST_DEPTH + 2 }, (_, index) => `d${String(index)}`);
  const deep = join(root, vault.paths.inbox, ...segments);
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "note.md"), "# Deep\n", "utf8");

  await assert.rejects(
    ingestInbox(root, vault),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /nests deeper than/u);
      return true;
    },
  );
});

test("the inbox never follows a symlink that leaves the vault", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-ingest-outside-"));
  const root = await mkdtemp(join(tmpdir(), "open-brain-ingest-symlink-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const vault = config("IngestVault");
  await writeFile(join(outside, "external.md"), "# External material\n", "utf8");
  const inbox = join(root, vault.paths.inbox);
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, "own.md"), "# Own material\n", "utf8");
  await symlink(join(outside, "external.md"), join(inbox, "external.md"));
  await symlink(outside, join(inbox, "elsewhere"));

  const report = await ingestInbox(root, vault, { batchId: "guarded" });

  assert.deepEqual(report.imported.map((entry) => entry.source_path), ["own.md"]);
  assert.equal(report.truncated, 0);
  assert.deepEqual(report.notices, []);
  assert.deepEqual(report.failures, []);
});
