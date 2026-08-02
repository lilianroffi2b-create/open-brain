import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseClassification, type ClassificationItem } from "../src/classifier/contract.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import { resumeBatch, validateApply } from "../src/gate/apply.js";
import {
  batchPaths,
  loadBatchState,
  prepareBatch,
  showBatch,
  syncPending,
  syncStaged,
} from "../src/gate/review.js";
import { SyncGateError, type ValidateResult } from "../src/gate/types.js";
import { undoBatch } from "../src/gate/undo.js";
import {
  createPreferenceLedger,
  loadPreferenceLedger,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  savePreferenceLedger,
  writePreferenceCore,
  type Preference,
} from "../src/prefs/index.js";
import { appendCandidate } from "../src/staging/store.js";

/**
 * The write half of the gate, tested where it decides what may be written at
 * all: one destination per approval, a precondition checked against the disk
 * rather than against a memory of it, and a batch that was reversed staying
 * reversed.
 */

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  capabilities: { ...DEFAULT_CONFIG.capabilities, capture: { enabled: true } },
};

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const prefsModuleUrl = new URL("../src/prefs/index.ts", import.meta.url).href;

/**
 * Holds the preference lock from another process, so the gate really blocks on
 * its first item instead of racing an in-process fiction. Reentrant locking is
 * refused outright, so this cannot be done from the test process itself.
 */
const LOCK_HOLDER_SCRIPT = `
import { access, writeFile } from "node:fs/promises";
import { withPreferenceLock } from ${JSON.stringify(prefsModuleUrl)};

const [root, readyPath, goPath] = process.argv.slice(2);
await withPreferenceLock(root, async () => {
  await writeFile(readyPath, "held", "utf8");
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      await access(goPath);
      return;
    } catch {
      if (Date.now() > deadline) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});
`;

const NOTE_RELATIVE_PATH = join("10_memory", "notes", "project_deploy.md");

function preference(id: string, weight: 1 | 2 | 3 | 4 | 5): Preference {
  return {
    id,
    weight,
    status: weight >= 3 ? "active" : "proposed",
    domains: ["workflow"],
    statement: `Use ${id}.`,
    why: "Seeded by the test suite.",
    apply: `Apply ${id}.`,
    origin: "2026-07-01",
    last_seen: "2026-07-01",
    evidence: [],
  };
}

async function newVault(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  await mkdir(join(root, "10_memory", "notes"), { recursive: true });
  const ledger = createPreferenceLedger([preference("existing-rule", 3)]);
  await savePreferenceLedger(root, ledger, { command: "test seed" });
  await writePreferenceCore(root, ledger, { command: "test seed" });
  return root;
}

async function stage(root: string, quote: string): Promise<string> {
  const result = await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: quote,
    raw_markers: ["remember"],
    harness: "claude-code",
  });
  return result.candidate.id;
}

/** Stages two candidates and returns their ids in the order the slice fixes. */
async function stageTwo(root: string): Promise<[string, string]> {
  await stage(root, "the first thing to remember");
  await stage(root, "the second thing to remember");
  const slice = await syncStaged(root, config);
  const [first, second] = slice.candidate_ids;
  assert.ok(first !== undefined && second !== undefined);
  return [first, second];
}

function selection(root: string): Promise<string> {
  return syncStaged(root, config).then((slice) => slice.selection_id);
}

/** A decision with the proof a human leaves behind. See gate/presence.ts. */
async function validateAsHuman(
  root: string,
  batchId: string,
  approve: string,
): Promise<ValidateResult> {
  const shown = await showBatch(root, config, batchId);
  return validateApply(root, config, {
    batchId,
    approve,
    proof: {
      kind: "human",
      confirm: shown.confirmation_token,
      presence: { interactive: true, unattended: false },
    },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function noteItem(id: string, body: string): Record<string, unknown> {
  return {
    id,
    type: "memory",
    target: "10_memory/notes/project_deploy.md",
    content: `---\nlifecycle: working\n---\n\n# Deploy\n\n${body}\n`,
    proposed_weight: null,
    reason: "A durable fact.",
    proofs: [{ date: "2026-07-20", quote: "remember the deploy target" }],
    status: "proposed",
  };
}

function preferenceItem(id: string, statement: string): Record<string, unknown> {
  return {
    id,
    type: "preference",
    target: "answer-in-french",
    content: statement,
    proposed_weight: 2,
    reason: "Asked for it outright.",
    proofs: [{ date: "2026-07-20", quote: "always answer in french" }],
    status: "proposed",
    domains: ["writing"],
    why: "Asked for it in writing.",
    apply: "Write every answer in French.",
  };
}

test("two approved items that write to one preference are refused, and nothing is frozen", async (t) => {
  const root = await newVault("open-brain-apply-dup-pref-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const [first, second] = await stageTwo(root);
  const prepared = await prepareBatch(root, config, {
    items: parseClassification([
      preferenceItem(first, "Always answer in French."),
      preferenceItem(second, "Always answer in French, without exception."),
    ]) as ClassificationItem[],
    selectionId: await selection(root),
  });

  await assert.rejects(
    () => validateAsHuman(root, prepared.batch_id, "1,2"),
    (error: unknown) => error instanceof SyncGateError
      && /both write to preference answer-in-french/u.test(String(error))
      && /Nothing was applied and no decision was recorded/u.test(String(error)),
  );

  // The refusal has to leave the batch exactly where it was: a decision frozen
  // half way through is a batch nobody can finish and nobody can reverse.
  const paths = batchPaths(root, config, prepared.batch_id);
  assert.equal(await pathExists(paths.decision), false, "no decision was frozen");
  assert.equal(await pathExists(paths.undo), false, "no undo record was opened");
  assert.equal((await loadBatchState(root, config, prepared.batch_id))?.phase, "proposed");
  const ledger = await loadPreferenceLedger(root);
  assert.equal(ledger.preferences.some((entry) => entry.id === "answer-in-french"), false);

  // And the batch is still decidable, which is what wedging used to destroy.
  const resumed = await resumeBatch(root, config, prepared.batch_id);
  assert.equal(resumed.result, null);
  assert.match(resumed.next, /was never decided/u);

  const applied = await validateAsHuman(root, prepared.batch_id, "1");
  assert.equal(applied.phase, "complete");
  const after = await loadPreferenceLedger(root);
  assert.equal(
    after.preferences.find((entry) => entry.id === "answer-in-french")?.statement,
    "Always answer in French.",
  );
});

test("two approved items that write to one note are refused rather than collapsed", async (t) => {
  const root = await newVault("open-brain-apply-dup-note-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const [first, second] = await stageTwo(root);
  const prepared = await prepareBatch(root, config, {
    items: parseClassification([
      noteItem(first, "The deploy target is staging."),
      noteItem(second, "The deploy target is production."),
    ]) as ClassificationItem[],
    selectionId: await selection(root),
  });

  await assert.rejects(
    () => validateAsHuman(root, prepared.batch_id, "1,2"),
    (error: unknown) => error instanceof SyncGateError
      && /both write to note 10_memory\/notes\/project_deploy\.md/u.test(String(error)),
  );

  assert.equal(
    await pathExists(join(root, NOTE_RELATIVE_PATH)),
    false,
    "neither contradictory body was written",
  );

  // One of them, on the other hand, is a perfectly ordinary approval.
  const applied = await validateAsHuman(root, prepared.batch_id, "2");
  assert.equal(applied.phase, "complete");
  const note = await readFile(join(root, NOTE_RELATIVE_PATH), "utf8");
  assert.ok(note.includes("The deploy target is production."), note);
});

test("a note that moved between the preflight and the write is not overwritten", async (t) => {
  const root = await newVault("open-brain-apply-toctou-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const [first, second] = await stageTwo(root);
  const prepared = await prepareBatch(root, config, {
    items: parseClassification([
      // Item 1 writes the kernel, so it blocks on the preference lock. Item 2
      // is preflighted before that block and written after it.
      preferenceItem(first, "Always answer in French."),
      noteItem(second, "The deploy target is staging."),
    ]) as ClassificationItem[],
    selectionId: await selection(root),
  });

  const readyPath = join(root, "lock-held");
  const goPath = join(root, "lock-release");
  const holder = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", LOCK_HOLDER_SCRIPT, "--", root, readyPath, goPath],
    { cwd: projectRoot, stdio: "ignore" },
  );
  t.after(() => {
    holder.kill();
  });

  const exited = new Promise<void>((resolve) => {
    holder.once("exit", () => {
      resolve();
    });
  });
  for (let attempt = 0; attempt < 400 && !await pathExists(readyPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await pathExists(readyPath), "the other process holds the preference lock");

  // Kept as a settled value rather than a floating rejection: the run has to
  // reach the note long after this line.
  const applying = validateAsHuman(root, prepared.batch_id, "1,2").then(
    () => null,
    (error: unknown) => error,
  );
  const paths = batchPaths(root, config, prepared.batch_id);
  // The undo record is written after every preflight and before the first
  // destination, so its arrival is the proof that item 2 was already checked.
  for (let attempt = 0; attempt < 200 && !await pathExists(paths.undo); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(await pathExists(paths.undo), "every item was preflighted");

  const foreign = "---\nlifecycle: working\n---\n\n# Deploy\n\nWritten by somebody else.\n";
  await writeFile(join(root, NOTE_RELATIVE_PATH), foreign, "utf8");
  await writeFile(goPath, "go", "utf8");
  await exited;

  const failure = await applying;
  assert.ok(failure instanceof SyncGateError, String(failure));
  assert.match(
    String(failure),
    /was to be created by this item, and it exists now with other content/u,
  );
  assert.equal(
    await readFile(join(root, NOTE_RELATIVE_PATH), "utf8"),
    foreign,
    "the file somebody else wrote is still theirs",
  );
});

test("an unreadable ledger is reported as unreadable, not as a ledger that is absent", async (t) => {
  const root = await newVault("open-brain-apply-unreadable-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const [first, second] = await stageTwo(root);
  const prepared = await prepareBatch(root, config, {
    items: parseClassification([
      preferenceItem(first, "Always answer in French."),
      noteItem(second, "The deploy target is staging."),
    ]) as ClassificationItem[],
    selectionId: await selection(root),
  });

  // What a half finished write, or an editor with an opinion about encodings,
  // leaves behind. The gate used to swallow it and tell the human there was no
  // ledger at all, which sends them to two commands that cannot help.
  await writeFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "", "utf8");

  await assert.rejects(
    () => validateAsHuman(root, prepared.batch_id, "1"),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /_ledger\.json is empty/u);
      assert.doesNotMatch(message, /no preference ledger exists in this vault/u);
      return true;
    },
  );
  assert.equal(
    await pathExists(batchPaths(root, config, prepared.batch_id).decision),
    false,
    "and it refuses before freezing anything",
  );
});

test("a batch that was applied and then reversed is never replayed by a resume", async (t) => {
  const root = await newVault("open-brain-apply-undone-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const [first, second] = await stageTwo(root);
  const prepared = await prepareBatch(root, config, {
    items: parseClassification([
      preferenceItem(first, "Always answer in French."),
      noteItem(second, "The deploy target is staging."),
    ]) as ClassificationItem[],
    selectionId: await selection(root),
  });
  assert.equal((await validateAsHuman(root, prepared.batch_id, "1,2")).phase, "complete");

  const shown = await showBatch(root, config, prepared.batch_id);
  await undoBatch(root, config, prepared.batch_id, {
    yes: true,
    proof: {
      kind: "human",
      confirm: shown.confirmation_token,
      presence: { interactive: true, unattended: false },
    },
  });

  // The documented sequence that used to regress the batch to applying and then
  // throw on every run afterwards.
  await assert.rejects(
    () => resumeBatch(root, config, prepared.batch_id),
    (error: unknown) => error instanceof SyncGateError
      && /applied and then reversed/u.test(String(error)),
  );

  assert.equal(
    (await loadBatchState(root, config, prepared.batch_id))?.phase,
    "complete",
    "a settled batch is not walked backwards by a refused resume",
  );
  const ledger = await loadPreferenceLedger(root);
  assert.equal(ledger.preferences.some((entry) => entry.id === "answer-in-french"), false);
  assert.equal(await pathExists(join(root, NOTE_RELATIVE_PATH)), false);

  const pending = await syncPending(root, config);
  assert.deepEqual(pending.active_batches, [], "nothing is left asking for the human");
  assert.equal(pending.completed_batches, 1);
});
