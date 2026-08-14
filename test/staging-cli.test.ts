import assert from "node:assert/strict";
import { runCommand } from "citty";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ContextBudget } from "../src/core/budget.js";
import { guardCommand } from "../src/cli/commands/guard.js";
import { stagingCommand } from "../src/cli/commands/staging.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { compactStaging, transitionCandidate } from "../src/staging/store.js";
import type { ProposalInput } from "../src/staging/types.js";

/**
 * The CLI surface of this lot. Every listing must be capped and must publish
 * what it cost, which is invariant I11 read from the outside.
 */

interface CapturedRun {
  output: unknown;
  raw: string;
  exitCode: number | string | undefined;
}

async function capture(action: () => Promise<unknown>): Promise<CapturedRun> {
  const original = process.stdout.write.bind(process.stdout);
  const previousExitCode = process.exitCode;
  let captured = "";
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;
  const firstBrace = captured.indexOf("{");
  const json = firstBrace === -1 ? "" : captured.slice(firstBrace);
  return {
    output: json.length === 0 ? undefined : (JSON.parse(json.slice(0, json.lastIndexOf("}") + 1)) as unknown),
    raw: captured,
    exitCode,
  };
}

function runStaging(rawArgs: string[]): Promise<CapturedRun> {
  return capture(() => runCommand(stagingCommand, { rawArgs }));
}

function runGuard(rawArgs: string[]): Promise<CapturedRun> {
  return capture(() => runCommand(guardCommand, { rawArgs }));
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "the command should print a JSON object");
  return value as Record<string, unknown>;
}

function budgetOf(value: unknown): ContextBudget {
  const budget = asRecord(asRecord(value).budget);
  const number = (key: string): number => {
    const item = budget[key];
    assert.equal(typeof item, "number", `budget.${key} must be a number`);
    return typeof item === "number" ? item : Number.NaN;
  };
  assert.equal(typeof budget.truncated, "boolean", "budget.truncated must be a boolean");
  return {
    chars: number("chars"),
    token_estimate: number("token_estimate"),
    items_shown: number("items_shown"),
    items_total: number("items_total"),
    truncated: budget.truncated === true,
  };
}

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-staging-cli-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "version: 1\ncapabilities:\n  capture:\n    enabled: true\n",
    "utf8",
  );
  return root;
}

test("staging add stages by hand, and replaying the operation id changes nothing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const added = await runStaging([
    "add",
    "--root",
    root,
    "--quote",
    "Always answer in short structured blocks.",
    "--markers",
    "remember,always",
    "--operation-id",
    "capture-cli-1",
  ]);
  const first = asRecord(added.output);
  assert.equal(first.created, true);
  const candidate = asRecord(first.candidate);
  assert.match(String(candidate.id), /^cand-\d{8}-[0-9a-f]{16}$/u);
  assert.equal(candidate.status, "staged");

  const replayed = asRecord((await runStaging([
    "add",
    "--root",
    root,
    "--quote",
    "Always answer in short structured blocks.",
    "--markers",
    "remember,always",
    "--operation-id",
    "capture-cli-1",
  ])).output);
  assert.equal(replayed.created, false);
  assert.equal(asRecord(replayed.candidate).id, candidate.id);
});

test("invariant I11: a listing is capped, reports its cost, and announces the cut", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 40; index += 1) {
    await runStaging([
      "add",
      "--root",
      root,
      "--quote",
      `Candidate number ${String(index)} with a long enough quote to consume the budget.`,
    ]);
  }

  const full = asRecord((await runStaging(["list", "--root", root])).output);
  assert.equal(full.total, 40);

  const capped = await runStaging(["list", "--root", root, "--max-chars", "600"]);
  const listing = asRecord(capped.output);
  const budget = budgetOf(capped.output);
  assert.equal(listing.total, 40);
  assert.equal(budget.items_total, 40);
  assert.ok(budget.items_shown < 40, "the listing must actually be capped");
  assert.equal(budget.truncated, true);
  assert.ok(budget.chars <= 600, "the listing must respect its character cap");
  assert.ok(budget.token_estimate > 0);
  assert.equal(Array.isArray(listing.candidates) ? listing.candidates.length : -1, budget.items_shown);
  assert.match(String(listing.next), /were not shown/u);

  const status = asRecord((await runStaging(["status", "--root", root])).output);
  assert.equal(status.pending, 40);
  assert.equal(status.capture_enabled, true);
});

test("staging show caps the quote it prints, and drop needs a confirmation", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const added = asRecord((await runStaging([
    "add",
    "--root",
    root,
    "--quote",
    "x".repeat(480),
  ])).output);
  const id = String(asRecord(added.candidate).id);

  const shown = await runStaging(["show", id, "--root", root, "--max-chars", "200"]);
  const budget = budgetOf(shown.output);
  assert.equal(budget.truncated, true);
  assert.ok(budget.chars <= 200);

  await assert.rejects(
    runStaging(["drop", "--root", root, "--id", id]),
    /--yes/u,
  );
  const dropped = asRecord((await runStaging(["drop", "--root", root, "--id", id, "--yes"])).output);
  assert.deepEqual(dropped.dropped, [id]);
  assert.equal(dropped.kept, 0);
});

test("drop --include-archived and --source reach an already-archived candidate", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = {
    ...DEFAULT_CONFIG,
    capabilities: { ...DEFAULT_CONFIG.capabilities, capture: { enabled: true } },
  };

  const added = asRecord((await runStaging(["add", "--root", root, "--quote", "x".repeat(30)])).output);
  const id = String(asRecord(added.candidate).id);

  await transitionCandidate(root, config, {
    id,
    status: "proposed",
    proposal: {
      type: "preference",
      target: "10_memory/preferences/_ledger.json",
      content: "Answer briefly.",
      proposed_weight: 2,
      reason: "Test fixture.",
      proofs: [{ date: "2026-07-26", quote: "x".repeat(30) }],
      weak: false,
      recommendation: "approve",
      evidence_basis: null,
      gate_item_index: 1,
      gate_write_payload: { kind: "preference" },
    } satisfies ProposalInput,
  });
  await transitionCandidate(root, config, { id, status: "rejected" });
  const compacted = await compactStaging(root, config);
  assert.equal(compacted.archived, 1);

  // Without --include-archived, the archived candidate is out of reach.
  const withoutArchive = asRecord((await runStaging([
    "drop", "--root", root, "--source", "manual", "--yes",
  ])).output);
  assert.deepEqual(withoutArchive.dropped, []);
  assert.deepEqual(withoutArchive.archived_dropped, []);

  const withArchive = asRecord((await runStaging([
    "drop", "--root", root, "--source", "manual", "--include-archived", "--reason", "test purge", "--yes",
  ])).output);
  assert.deepEqual(withArchive.archived_dropped, [id]);
  assert.ok(Array.isArray(withArchive.archive_files) && (withArchive.archive_files as unknown[]).length > 0);
});

test("the guard command answers with the verdict and a non-zero exit code on a refusal", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const denied = await runGuard([
    "Bash",
    "--root",
    root,
    "--command",
    "rm 10_memory/preferences/_ledger.json",
  ]);
  const verdict = asRecord(denied.output);
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.rule, "protected-write-target");
  assert.equal(denied.exitCode, 1);
  assert.deepEqual(verdict.protected_paths, [
    "10_memory/preferences/_ledger.json",
    "10_memory/preferences/_core.md",
    ".open-brain/local/prefs-redline.json",
    ".open-brain/local/prefs-redline.jsonl",
    "00_index/vault.config.yml",
    "10_memory/staging/batches",
  ]);

  const allowed = await runGuard([
    "Bash",
    "--root",
    root,
    "--command",
    "git blame 10_memory/preferences/_core.md | tail",
  ]);
  assert.equal(asRecord(allowed.output).decision, "allow");
  assert.equal(allowed.exitCode, undefined);
});
