import assert from "node:assert/strict";
import { runCommand } from "citty";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyCommand } from "../src/cli/commands/classify.js";
import { syncCommand } from "../src/cli/commands/sync.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  createPreferenceLedger,
  savePreferenceLedger,
  writePreferenceCore,
  type Preference,
} from "../src/prefs/index.js";
import { appendCandidate } from "../src/staging/store.js";

/**
 * The gate seen from the outside, through the commands a host CLI actually
 * runs. Each one must print a single parseable JSON document, and the
 * validation command must refuse to guess what the human meant.
 */

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  capabilities: { ...DEFAULT_CONFIG.capabilities, capture: { enabled: true } },
};

interface CapturedRun {
  output: Record<string, unknown>;
  raw: string;
}

async function capture(action: () => Promise<unknown>): Promise<CapturedRun> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  const first = captured.indexOf("{");
  const last = captured.lastIndexOf("}");
  assert.ok(first !== -1 && last > first, `expected one JSON document, got: ${captured}`);
  const parsed: unknown = JSON.parse(captured.slice(first, last + 1));
  assert.ok(typeof parsed === "object" && parsed !== null);
  return { output: parsed as Record<string, unknown>, raw: captured };
}

function runSync(rawArgs: string[]): Promise<CapturedRun> {
  return capture(() => runCommand(syncCommand, { rawArgs }));
}

function preference(id: string): Preference {
  return {
    id,
    weight: 3,
    status: "active",
    domains: ["workflow"],
    statement: `Use ${id}.`,
    why: "Seeded by the test suite.",
    apply: `Apply ${id}.`,
    origin: "2026-07-01",
    last_seen: "2026-07-01",
    evidence: [],
  };
}

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-gate-cli-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  await mkdir(join(root, "10_memory", "notes"), { recursive: true });
  const ledger = createPreferenceLedger([preference("existing-rule")]);
  await savePreferenceLedger(root, ledger, { command: "test seed" });
  await writePreferenceCore(root, ledger, { command: "test seed" });
  return root;
}

test("the whole protocol runs through the CLI and prints one JSON document per step", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const staged = await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: "Answer in short structured blocks.",
    raw_markers: ["remember"],
    harness: "claude-code",
  });

  const pending = await runSync(["pending", "--root", root]);
  assert.deepEqual(pending.output.active_batches, []);
  assert.match(String(pending.output.next), /staged/u);

  const slice = await runSync(["staged", "--root", root]);
  assert.equal(slice.output.count, 1);
  const selectionId = String(slice.output.selection_id);

  const inputPath = join(root, "classification.json");
  await writeFile(inputPath, `${JSON.stringify([{
    id: staged.candidate.id,
    type: "preference",
    target: "short-answers",
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "Asked out loud.",
    proofs: [{ date: "2026-07-20", quote: "Answer in short structured blocks." }],
    status: "proposed",
    domains: ["workflow"],
    why: "Long prose costs time.",
    apply: "Prefer lists.",
  }], null, 2)}\n`, "utf8");

  const prepared = await runSync([
    "prepare",
    "--root", root,
    "--input", inputPath,
    "--selection", selectionId,
  ]);
  const batchId = String(prepared.output.batch_id);
  assert.match(batchId, /^batch-[0-9a-f]{24}$/u);
  assert.match(String(prepared.output.next), /Nothing is written before that command runs/u);

  const shown = await runSync(["show", "--root", root, "--batch", batchId]);
  assert.match(String(shown.output.presentation), /short-answers/u);
  assert.deepEqual(shown.output.decision, null);

  const validated = await runSync([
    "validate",
    "--root", root,
    "--batch", batchId,
    "--approve", "1",
  ]);
  assert.deepEqual(validated.output.approved_indices, [1]);
  assert.equal(validated.output.phase, "complete");
  assert.equal(validated.output.undo_available, true);

  const undone = await runSync(["undo", batchId, "--root", root, "--yes"]);
  assert.equal(undone.output.already_undone, false);
  assert.ok(Array.isArray(undone.output.restored));
});

test("validate refuses to run without an explicit --approve", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => runCommand(syncCommand, {
      rawArgs: ["validate", "--root", root, "--batch", "batch-000000000000000000000000"],
    }),
    (error: unknown) => /needs --approve/u.test(String(error))
      && /no default, on purpose/u.test(String(error)),
  );
});

test("classify prices a disarmed run and never books a call", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: "Answer in short structured blocks.",
    raw_markers: ["remember"],
    harness: "claude-code",
  });

  const dryRun = await capture(() =>
    runCommand(classifyCommand, { rawArgs: ["--root", root, "--dry-run"] }));
  assert.equal(dryRun.output.armed, false);
  assert.equal(dryRun.output.issued, false);
  assert.match(dryRun.raw, /disarmed/u);

  await assert.rejects(
    () => runCommand(classifyCommand, { rawArgs: ["--root", root] }),
    (error: unknown) => /Capability classifier is disabled/u.test(String(error)),
  );
});
