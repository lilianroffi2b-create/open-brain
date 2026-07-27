import assert from "node:assert/strict";
import { readdir, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseClassification, type ClassificationItem } from "../src/classifier/contract.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { sha256 } from "../src/core/text.js";
import type { VaultConfig } from "../src/core/types.js";
import { validateApply } from "../src/gate/apply.js";
import { batchPaths, prepareBatch, showBatch, syncStaged } from "../src/gate/review.js";
import { SyncGateError, type ValidateResult } from "../src/gate/types.js";
import { undoBatch } from "../src/gate/undo.js";
import { DEFAULT_LOADER_FILENAMES } from "../src/loaders/markers.js";
import {
  createPreferenceLedger,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  readRedlineJournal,
  savePreferenceLedger,
  verifyRedline,
  writePreferenceCore,
  type Preference,
} from "../src/prefs/index.js";
import { appendCandidate } from "../src/staging/store.js";

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  capabilities: { ...DEFAULT_CONFIG.capabilities, capture: { enabled: true } },
};

/** Every file the gate can touch, so a comparison covers the whole surface. */
const WATCHED_FILES = [
  PREFERENCE_LEDGER_RELATIVE_PATH,
  PREFERENCE_CORE_RELATIVE_PATH,
  ...DEFAULT_LOADER_FILENAMES,
  join("10_memory", "notes", "project_deploy.md"),
];

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

/** A byte for byte fingerprint of the whole writable surface. */
async function fingerprint(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const relative of WATCHED_FILES) {
    try {
      const content = await readFile(join(root, relative), "utf8");
      snapshot[relative] = `${sha256(content)}:${String(Buffer.byteLength(content, "utf8"))}`;
    } catch {
      snapshot[relative] = "absent";
    }
  }
  return snapshot;
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

function items(weightId: string, memoryId: string): ClassificationItem[] {
  return parseClassification([
    {
      id: weightId,
      type: "weight",
      target: "existing-rule",
      content: "Raise the weight of existing-rule to 4.",
      proposed_weight: 4,
      reason: "Stated twice, on two different days.",
      proofs: [
        { date: "2026-07-19", quote: "existing-rule matters" },
        { date: "2026-07-20", quote: "existing-rule really matters" },
      ],
      status: "proposed",
      evidence_basis: "recurrence",
    },
    {
      id: memoryId,
      type: "memory",
      target: "10_memory/notes/project_deploy.md",
      content: "---\nlifecycle: working\n---\n\n# Deploy\n\nThe deploy target is staging.\n",
      proposed_weight: null,
      reason: "A durable fact.",
      proofs: [{ date: "2026-07-20", quote: "Remember that the deploy target is staging." }],
      status: "proposed",
    },
  ]) as ClassificationItem[];
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

async function applyBoth(root: string): Promise<string> {
  const weightId = await stage(root, "existing-rule really matters");
  const memoryId = await stage(root, "Remember that the deploy target is staging.");
  const slice = await syncStaged(root, config);
  const ordered = slice.candidate_ids;
  const weight = ordered.includes(weightId) ? weightId : ordered[0] ?? weightId;
  const memory = ordered.includes(memoryId) ? memoryId : ordered[1] ?? memoryId;
  const prepared = await prepareBatch(root, config, {
    items: items(weight, memory),
    selectionId: slice.selection_id,
  });
  const result = await validateAsHuman(root, prepared.batch_id, "1,2");
  assert.equal(result.phase, "complete");
  assert.equal(result.undo_available, true);
  return prepared.batch_id;
}

test("applying then undoing leaves every touched file byte for byte identical", async (t) => {
  const root = await newVault("open-brain-undo-exact-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const before = await fingerprint(root);
  const batchId = await applyBoth(root);

  const applied = await fingerprint(root);
  const changed = Object.keys(before).filter((path) => before[path] !== applied[path]);
  // The ledger, the rendered core, all three loader mirrors, and the new note.
  assert.deepEqual(changed.sort(), [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    join("10_memory", "notes", "project_deploy.md"),
    PREFERENCE_CORE_RELATIVE_PATH,
    PREFERENCE_LEDGER_RELATIVE_PATH,
  ].sort());

  const result = await undoBatch(root, config, batchId, { yes: true });
  assert.equal(result.already_undone, false);
  assert.deepEqual(result.removed.sort(), [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "10_memory/notes/project_deploy.md",
  ].sort());
  assert.deepEqual(result.restored.sort(), [
    PREFERENCE_CORE_RELATIVE_PATH,
    PREFERENCE_LEDGER_RELATIVE_PATH,
  ].map((path) => path.split("\\").join("/")).sort());

  const after = await fingerprint(root);
  assert.deepEqual(after, before);
});

test("undo is refused when anything moved after the batch was applied", async (t) => {
  const root = await newVault("open-brain-undo-drift-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await applyBoth(root);
  const notePath = join(root, "10_memory", "notes", "project_deploy.md");
  const note = await readFile(notePath, "utf8");
  await writeFile(notePath, `${note}\nEdited by hand afterwards.\n`, "utf8");
  const edited = await readFile(notePath, "utf8");

  await assert.rejects(
    () => undoBatch(root, config, batchId, { yes: true }),
    (error: unknown) => error instanceof SyncGateError
      && /changed after the batch was applied/u.test(String(error))
      && /project_deploy\.md/u.test(String(error)),
  );

  assert.equal(await readFile(notePath, "utf8"), edited);
});

test("undo needs an explicit yes and states what it would rewrite", async (t) => {
  const root = await newVault("open-brain-undo-consent-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await applyBoth(root);
  const before = await fingerprint(root);
  await assert.rejects(
    () => undoBatch(root, config, batchId),
    (error: unknown) => error instanceof SyncGateError && /Re-run with --yes/u.test(String(error)),
  );
  assert.deepEqual(await fingerprint(root), before);
});

test("undoing twice is refused politely and changes nothing the second time", async (t) => {
  const root = await newVault("open-brain-undo-twice-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await applyBoth(root);
  await undoBatch(root, config, batchId, { yes: true });
  const after = await fingerprint(root);

  const again = await undoBatch(root, config, batchId, { yes: true });
  assert.equal(again.already_undone, true);
  assert.deepEqual(again.restored, []);
  assert.deepEqual(await fingerprint(root), after);
});

test("the reversal itself is recorded in the redline, and the kernel verifies clean", async (t) => {
  const root = await newVault("open-brain-undo-redline-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await applyBoth(root);
  await undoBatch(root, config, batchId, { yes: true });

  const report = await verifyRedline(root);
  assert.equal(report.tampered, false);

  const journal = await readRedlineJournal(root);
  const commands = journal.entries.map((entry) => entry.command);
  assert.ok(commands.includes("sync validate"));
  assert.ok(commands.includes("sync undo"));
});

test("undo is refused on a batch whose apply never finished", async (t) => {
  const root = await newVault("open-brain-undo-unsealed-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await applyBoth(root);
  await rm(batchPaths(root, config, batchId).seal);

  await assert.rejects(
    () => undoBatch(root, config, batchId, { yes: true }),
    (error: unknown) => error instanceof SyncGateError && /never sealed/u.test(String(error)),
  );
});

/** Strips comments so the assertion is about code, not about prose. */
function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/u, ""))
    .join("\n");
}

test("the gate never shells out: reversibility is the record, not the repository", async () => {
  const gateDirectory = fileURLToPath(new URL("../src/gate/", import.meta.url));
  const files = (await readdir(gateDirectory)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 5);
  for (const name of files) {
    const code = executableSource(await readFile(join(gateDirectory, name), "utf8"));
    assert.equal(
      /\bgit\b/iu.test(code),
      false,
      `${name} runs or names git in code; undo must never depend on a repository being there.`,
    );
    assert.equal(
      /child_process|execFile|spawnSync|\bspawn\(/u.test(code),
      false,
      `${name} spawns a process; the gate reverses from its own record only.`,
    );
  }
});
