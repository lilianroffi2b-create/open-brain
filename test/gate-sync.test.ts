import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseClassification,
  type ClassificationItem,
} from "../src/classifier/contract.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import { validateApply, resumeBatch, parseApprovedIndices } from "../src/gate/apply.js";
import { renderReview } from "../src/gate/render.js";
import {
  batchFreshness,
  batchPaths,
  loadBatch,
  loadBatchState,
  prepareBatch,
  showBatch,
  syncPending,
  syncStaged,
} from "../src/gate/review.js";
import { SyncGateError, type ValidateResult } from "../src/gate/types.js";
import {
  createPreferenceLedger,
  loadPreferenceLedger,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  savePreferenceLedger,
  writePreferenceCore,
  type Preference,
} from "../src/prefs/index.js";
import { appendCandidate, listCandidates, readStore } from "../src/staging/store.js";
import { transitionCandidate } from "../src/staging/store.js";
import { StagingStoreError, type ProposalInput } from "../src/staging/types.js";

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  capabilities: {
    ...DEFAULT_CONFIG.capabilities,
    capture: { enabled: true },
  },
};

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

interface StageOptions {
  signal?: "explicit_request" | "correction" | "praise" | "praise_weak";
  source?: "manual" | "turn_end" | "prompt_submit" | "pre_compact";
  quote?: string;
}

async function stage(root: string, options: StageOptions = {}): Promise<string> {
  const result = await appendCandidate(root, config, {
    source: options.source ?? "manual",
    signal: options.signal ?? "explicit_request",
    raw_quote: options.quote ?? "Always answer in short structured blocks.",
    raw_markers: ["remember"],
    harness: "claude-code",
  });
  return result.candidate.id;
}

/**
 * A decision made the way a human makes one: the batch is presented, the token
 * that presentation printed is retyped, and standard input is a terminal.
 *
 * The gate has no default for any of that on purpose, so every test that
 * decides a batch has to say which proof it is exercising. A test that could
 * quietly omit the proof would be a test that stops noticing when the proof
 * stops being required.
 */
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

function preferenceItem(id: string, target: string): ClassificationItem {
  return parseClassification([{
    id,
    type: "preference",
    target,
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "The user asked for it in so many words.",
    proofs: [{ date: "2026-07-20", quote: "Always answer in short structured blocks." }],
    status: "proposed",
    domains: ["workflow"],
    why: "Long prose costs the user time.",
    apply: "Prefer lists and short headings.",
  }])[0] as ClassificationItem;
}

function weakItem(id: string): ClassificationItem {
  return parseClassification([{
    id,
    type: "preference",
    target: "vague-idea",
    content: "Maybe be nicer.",
    proposed_weight: 2,
    reason: "A single passive compliment, nothing to act on.",
    proofs: [{ date: "2026-07-20", quote: "nice one" }],
    status: "proposed",
    weak: true,
    recommendation: "reject_only",
    evidence_basis: "insufficient",
    domains: ["tone"],
    why: "Not enough evidence.",
    apply: "Nothing yet.",
  }])[0] as ClassificationItem;
}

function memoryItem(id: string, name: string): ClassificationItem {
  return parseClassification([{
    id,
    type: "memory",
    target: `10_memory/notes/${name}`,
    content: "---\nlifecycle: working\n---\n\n# Note\n\nA durable fact.\n",
    proposed_weight: null,
    reason: "A durable fact worth keeping.",
    proofs: [{ date: "2026-07-20", quote: "Remember that the deploy target is staging." }],
    status: "proposed",
  }])[0] as ClassificationItem;
}

async function kernelBytes(root: string): Promise<{ ledger: string; core: string }> {
  return {
    ledger: await readFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "utf8"),
    core: await readFile(join(root, PREFERENCE_CORE_RELATIVE_PATH), "utf8"),
  };
}

test("preparing a batch writes nothing to the preference kernel", async (t) => {
  const root = await newVault("open-brain-gate-i1-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const before = await kernelBytes(root);
  const slice = await syncStaged(root, config);
  assert.equal(slice.count, 1);
  assert.deepEqual(slice.candidate_ids, [id]);

  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });
  assert.equal(prepared.created, true);
  assert.equal(prepared.proposed, 1);

  const after = await kernelBytes(root);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.core, before.core);
});

test("rejecting everything writes nothing, and the kernel stays byte identical", async (t) => {
  const root = await newVault("open-brain-gate-reject-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });
  const before = await kernelBytes(root);

  const result = await validateAsHuman(root, prepared.batch_id, "");
  assert.deepEqual(result.approved_indices, []);
  assert.deepEqual(result.rejected_indices, [1]);
  assert.equal(result.phase, "complete");

  const after = await kernelBytes(root);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.core, before.core);

  const rows = await listCandidates(root, config, { includeArchived: true });
  assert.equal(rows[0]?.status, "rejected");
});

test("an approved item is written and an unchecked one is rejected, with no abstention", async (t) => {
  const root = await newVault("open-brain-gate-approve-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const first = await stage(root, { quote: "Always answer in short structured blocks." });
  const second = await stage(root, { quote: "Always sign off with the next step." });
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [
      preferenceItem(slice.candidate_ids[0] ?? first, "short-answers"),
      preferenceItem(slice.candidate_ids[1] ?? second, "next-step"),
    ],
    selectionId: slice.selection_id,
  });
  assert.equal(prepared.items, 2);

  const result = await validateAsHuman(root, prepared.batch_id, "1");
  assert.deepEqual(result.approved_indices, [1]);
  assert.deepEqual(result.rejected_indices, [2]);

  const ledger = await loadPreferenceLedger(root);
  assert.deepEqual(ledger.preferences.map((entry) => entry.id).sort(), [
    "existing-rule",
    "short-answers",
  ]);

  const rows = await listCandidates(root, config, { includeArchived: true });
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  assert.equal(byId.get(slice.candidate_ids[0] ?? first), "applied");
  assert.equal(byId.get(slice.candidate_ids[1] ?? second), "rejected");
});

test("a validated preference reaches the registry with its domains, why, and apply", async (t) => {
  const root = await newVault("open-brain-gate-fields-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root, { quote: "Always answer in short structured blocks." });
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(slice.candidate_ids[0] ?? id, "short-answers")],
    selectionId: slice.selection_id,
  });

  const result = await validateAsHuman(root, prepared.batch_id, "1");
  assert.deepEqual(result.approved_indices, [1]);
  assert.deepEqual(result.warnings, []);

  const ledger = await loadPreferenceLedger(root);
  const created = ledger.preferences.find((entry) => entry.id === "short-answers");
  if (!created) {
    throw new Error("expected the preference short-answers to be created");
  }
  assert.deepEqual(created.domains, ["workflow"]);
  assert.equal(created.why, "Long prose costs the user time.");
  assert.equal(created.apply, "Prefer lists and short headings.");
  assert.equal(created.source, "open-brain-sync");
  assert.equal(created.evidence.length, 1);
  assert.equal(created.evidence[0]?.quote, "Always answer in short structured blocks.");
});

test("a recorded rejection can never be approved", async (t) => {
  const root = await newVault("open-brain-gate-rejectonly-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const strong = await stage(root, { quote: "Always answer in short structured blocks." });
  const weak = await stage(root, { quote: "nice one" });
  const slice = await syncStaged(root, config);
  const ids = slice.candidate_ids;
  const items = [
    preferenceItem(ids[0] ?? strong, "short-answers"),
    weakItem(ids[1] ?? weak),
  ];
  const prepared = await prepareBatch(root, config, { items, selectionId: slice.selection_id });
  assert.deepEqual(prepared.reject_only_indices, [2]);

  await assert.rejects(
    () => validateAsHuman(root, prepared.batch_id, "1,2"),
    (error: unknown) => error instanceof SyncGateError && /recorded rejection/u.test(String(error)),
  );

  const state = await loadBatchState(root, config, prepared.batch_id);
  assert.equal(state?.phase, "proposed");
  assert.equal(state?.decision, null);
});

test("a batch that is already decided is never decided a second way", async (t) => {
  const root = await newVault("open-brain-gate-frozen-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const first = await stage(root, { quote: "Always answer in short structured blocks." });
  const second = await stage(root, { quote: "Always sign off with the next step." });
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [
      preferenceItem(slice.candidate_ids[0] ?? first, "short-answers"),
      preferenceItem(slice.candidate_ids[1] ?? second, "next-step"),
    ],
    selectionId: slice.selection_id,
  });

  await validateAsHuman(root, prepared.batch_id, "1");
  await assert.rejects(
    () => validateAsHuman(root, prepared.batch_id, "1,2"),
    (error: unknown) => error instanceof SyncGateError && /already decided|frozen once/u.test(String(error)),
  );

  const ledger = await loadPreferenceLedger(root);
  assert.equal(ledger.preferences.some((entry) => entry.id === "next-step"), false);
});

test("replaying the same decision has no second effect", async (t) => {
  const root = await newVault("open-brain-gate-replay-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });

  await validateAsHuman(root, prepared.batch_id, "1");
  const afterFirst = await kernelBytes(root);

  const second = await validateAsHuman(root, prepared.batch_id, "1");
  assert.equal(second.phase, "complete");
  const afterSecond = await kernelBytes(root);
  assert.equal(afterSecond.ledger, afterFirst.ledger);
  assert.equal(afterSecond.core, afterFirst.core);

  const third = await resumeBatch(root, config, prepared.batch_id);
  assert.equal(third.result?.phase, "complete");
  const afterThird = await kernelBytes(root);
  assert.equal(afterThird.ledger, afterFirst.ledger);
});

test("the gate refuses a decision nothing ties to a human, and writes nothing", async (t) => {
  const root = await newVault("open-brain-gate-presence-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });
  const before = await kernelBytes(root);
  const shown = await showBatch(root, config, prepared.batch_id);

  // No terminal, no waiver: the flag says nothing about who typed it.
  await assert.rejects(
    () => validateApply(root, config, {
      batchId: prepared.batch_id,
      approve: "1",
      proof: {
        kind: "human",
        confirm: shown.confirmation_token,
        presence: { interactive: false, unattended: false },
      },
    }),
    (error: unknown) => /not a terminal/u.test(String(error)),
  );

  // A terminal, but a token nobody was given.
  await assert.rejects(
    () => validateApply(root, config, {
      batchId: prepared.batch_id,
      approve: "1",
      proof: {
        kind: "human",
        confirm: "deadbeef",
        presence: { interactive: true, unattended: false },
      },
    }),
    (error: unknown) => error instanceof SyncGateError && /does not match/u.test(String(error)),
  );

  // A replay claimed for a decision that was never frozen.
  await assert.rejects(
    () => validateApply(root, config, {
      batchId: prepared.batch_id,
      approve: "1",
      proof: { kind: "replay" },
    }),
    (error: unknown) => error instanceof SyncGateError && /nothing to replay/u.test(String(error)),
  );

  const after = await kernelBytes(root);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.core, before.core);
  assert.equal((await loadBatchState(root, config, prepared.batch_id))?.decision, null);
});

test("a batch that was never presented has no token to retype", async (t) => {
  const root = await newVault("open-brain-gate-unpresented-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });

  await assert.rejects(
    () => validateApply(root, config, {
      batchId: prepared.batch_id,
      approve: "1",
      proof: {
        kind: "human",
        confirm: "",
        presence: { interactive: true, unattended: false },
      },
    }),
    (error: unknown) => error instanceof SyncGateError && /never presented/u.test(String(error)),
  );

  // Presenting it twice hands out the same token, so a reader who scrolled
  // away is never told a different thing the second time.
  const first = await showBatch(root, config, prepared.batch_id);
  const second = await showBatch(root, config, prepared.batch_id);
  assert.equal(first.confirmation_token, second.confirmation_token);
  assert.match(first.confirmation_token, /^[0-9a-f]{8}$/u);
});

test("the evidence threshold is enforced by the gate and, independently, by the store", async (t) => {
  const root = await newVault("open-brain-gate-evidence-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root, { source: "turn_end", signal: "correction", quote: "no, shorter" });
  const slice = await syncStaged(root, config);

  const insufficient = parseClassification([{
    id,
    type: "preference",
    target: "short-answers",
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "One passive correction, read once.",
    proofs: [{ date: "2026-07-20", quote: "no, shorter" }],
    status: "proposed",
    evidence_basis: "recurrence",
    domains: ["workflow"],
    why: "Long prose costs time.",
    apply: "Prefer lists.",
  }]) as ClassificationItem[];

  // Side one: the gate refuses before anything is persisted.
  await assert.rejects(
    () => prepareBatch(root, config, { items: insufficient, selectionId: slice.selection_id }),
    (error: unknown) => error instanceof SyncGateError && /recurrence/u.test(String(error)),
  );

  // Side two: calling the store directly, with the gate entirely out of the
  // picture, is refused just the same.
  const proposal: ProposalInput = {
    type: "preference",
    target: "short-answers",
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "One passive correction, read once.",
    proofs: [{ date: "2026-07-20", quote: "no, shorter" }],
    weak: false,
    recommendation: "approve",
    evidence_basis: "recurrence",
    gate_item_index: 1,
    gate_write_payload: { kind: "preference" },
  };
  await assert.rejects(
    () => transitionCandidate(root, config, { id, status: "proposed", proposal }),
    (error: unknown) => error instanceof StagingStoreError && /recurrence/u.test(String(error)),
  );

  const snapshot = await readStore(root, config);
  assert.equal(snapshot.active[0]?.status, "staged");
});

test("a praise_weak candidate can never be laundered by merging it with a strong one", async (t) => {
  const root = await newVault("open-brain-gate-launder-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const strong = await stage(root, { quote: "Always answer in short structured blocks." });
  const weak = await stage(root, {
    source: "turn_end",
    signal: "praise_weak",
    quote: "nice",
  });
  const slice = await syncStaged(root, config);
  const merged = parseClassification([{
    id: strong,
    merged_ids: [strong, weak],
    type: "preference",
    target: "short-answers",
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "Merged with a compliment to reach the bar.",
    proofs: [
      { date: "2026-07-19", quote: "nice" },
      { date: "2026-07-20", quote: "Always answer in short structured blocks." },
    ],
    status: "proposed",
    evidence_basis: "recurrence",
    domains: ["workflow"],
    why: "Long prose costs time.",
    apply: "Prefer lists.",
  }]) as ClassificationItem[];

  await assert.rejects(
    () => prepareBatch(root, config, { items: merged, selectionId: slice.selection_id }),
    (error: unknown) => error instanceof SyncGateError && /praise_weak/u.test(String(error)),
  );
});

test("a broken precondition leaves the store, the state and the kernel byte identical", async (t) => {
  const root = await newVault("open-brain-gate-preflight-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root, { quote: "existing-rule matters a lot to me" });
  const slice = await syncStaged(root, config);
  const item = parseClassification([{
    id,
    type: "weight",
    target: "existing-rule",
    content: "Raise the weight of existing-rule.",
    proposed_weight: 4,
    reason: "Asked for explicitly, twice.",
    proofs: [
      { date: "2026-07-19", quote: "existing-rule matters" },
      { date: "2026-07-20", quote: "existing-rule matters a lot to me" },
    ],
    status: "proposed",
    evidence_basis: "recurrence",
  }]) as ClassificationItem[];
  const prepared = await prepareBatch(root, config, { items: item, selectionId: slice.selection_id });

  // The weight moves under the batch, between prepare and validate.
  const ledger = await loadPreferenceLedger(root);
  const moved = {
    ...ledger,
    preferences: ledger.preferences.map((entry) =>
      entry.id === "existing-rule" ? { ...entry, weight: 2 as const, status: "proposed" as const } : entry),
  };
  await savePreferenceLedger(root, moved, { command: "test drift" });

  const beforeLedger = await readFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "utf8");
  const beforeStore = await readFile(
    join(root, "10_memory", "staging", "candidates.jsonl"),
    "utf8",
  );
  const beforeState = await readFile(
    batchPaths(root, config, prepared.batch_id).state,
    "utf8",
  );

  await assert.rejects(
    () => validateAsHuman(root, prepared.batch_id, "1"),
    (error: unknown) => error instanceof SyncGateError && /weighs 2 now/u.test(String(error)),
  );

  assert.equal(await readFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "utf8"), beforeLedger);
  assert.equal(
    await readFile(join(root, "10_memory", "staging", "candidates.jsonl"), "utf8"),
    beforeStore,
  );
  assert.equal(
    await readFile(batchPaths(root, config, prepared.batch_id).state, "utf8"),
    beforeState,
  );
});

test("a tampered batch and a tampered state are both detected", async (t) => {
  const root = await newVault("open-brain-gate-tamper-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });
  const paths = batchPaths(root, config, prepared.batch_id);

  const state = await readFile(paths.state, "utf8");
  await writeFile(paths.state, state.replace("\"phase\": \"proposed\"", "\"phase\": \"complete\""), "utf8");
  await assert.rejects(
    () => loadBatchState(root, config, prepared.batch_id),
    (error: unknown) => error instanceof SyncGateError && /state hash/u.test(String(error)),
  );
  await writeFile(paths.state, state, "utf8");

  const batch = await readFile(paths.batch, "utf8");
  await writeFile(paths.batch, batch.replace("short-answers", "other-answers"), "utf8");
  await assert.rejects(
    () => loadBatch(root, config, prepared.batch_id),
    (error: unknown) => error instanceof SyncGateError && /content hash/u.test(String(error)),
  );
});

test("a memory target may not traverse, may not be a symlink, and must be a note", async (t) => {
  const root = await newVault("open-brain-gate-memory-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root, { quote: "Remember that the deploy target is staging." });
  const slice = await syncStaged(root, config);

  const traversal = parseClassification([{
    ...JSON.parse(JSON.stringify({
      id,
      type: "memory",
      target: "10_memory/notes/../preferences/_core.md",
      content: "---\nlifecycle: working\n---\n\n# Note\n",
      proposed_weight: null,
      reason: "Trying to reach the kernel through a note.",
      proofs: [{ date: "2026-07-20", quote: "Remember that the deploy target is staging." }],
      status: "proposed",
    })) as Record<string, unknown>,
  }]) as ClassificationItem[];
  await assert.rejects(
    () => prepareBatch(root, config, { items: traversal, selectionId: slice.selection_id }),
    (error: unknown) => error instanceof SyncGateError && /traversal/u.test(String(error)),
  );

  await symlink(
    join(root, PREFERENCE_CORE_RELATIVE_PATH),
    join(root, "10_memory", "notes", "project_link.md"),
  );
  await assert.rejects(
    () => prepareBatch(root, config, {
      items: [memoryItem(id, "project_link.md")],
      selectionId: slice.selection_id,
    }),
    (error: unknown) => error instanceof SyncGateError && /symbolic link/u.test(String(error)),
  );

  await assert.rejects(
    () => prepareBatch(root, config, {
      items: [memoryItem(id, "notes.md")],
      selectionId: slice.selection_id,
    }),
    (error: unknown) => error instanceof SyncGateError && /must start with one of/u.test(String(error)),
  );
});

test("a memory note is written, verified, and its candidate is archived", async (t) => {
  const root = await newVault("open-brain-gate-note-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root, { quote: "Remember that the deploy target is staging." });
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [memoryItem(id, "project_deploy.md")],
    selectionId: slice.selection_id,
  });

  const result = await validateAsHuman(root, prepared.batch_id, "1");
  assert.equal(result.phase, "complete");
  assert.equal(result.refs["1"], "10_memory/notes/project_deploy.md");
  assert.deepEqual(result.warnings, []);
  // A note really reached the vault, so the index is refreshed exactly once.
  assert.equal(result.reindexed, true);
  const replay = await validateAsHuman(root, prepared.batch_id, "1");
  assert.equal(replay.reindexed, false);

  const note = await readFile(join(root, "10_memory", "notes", "project_deploy.md"), "utf8");
  assert.match(note, /lifecycle: working/u);
});

test("a batch that writes no note never reindexes", async (t) => {
  const root = await newVault("open-brain-gate-noscan-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });
  const result = await validateAsHuman(root, prepared.batch_id, "1");
  assert.equal(result.reindexed, false);
});

test("the presentation is capped, reports its cost, and says what it hid", async (t) => {
  const root = await newVault("open-brain-gate-budget-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const ids: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    ids.push(await stage(root, { quote: `Rule number ${String(index)} the user stated out loud.` }));
  }
  const slice = await syncStaged(root, config);
  const items = slice.candidate_ids.map((id, index) =>
    preferenceItem(id, `rule-number-${String(index)}`));
  const prepared = await prepareBatch(root, config, {
    items,
    selectionId: slice.selection_id,
  });

  const presentation = renderReview(
    (await loadBatch(root, config, prepared.batch_id)).items,
    { maxChars: 1_500 },
  );
  assert.equal(presentation.budget.items_total, 12);
  assert.ok(presentation.budget.items_shown < 12);
  assert.equal(presentation.budget.truncated, true);
  assert.ok(presentation.budget.token_estimate > 0);
  assert.match(presentation.text, /TRUNCATED/u);
  assert.match(String(presentation.next), /--from/u);

  const shown = await showBatch(root, config, prepared.batch_id, { maxChars: 1_500 });
  assert.equal(shown.budget.truncated, true);
  const rest = await showBatch(root, config, prepared.batch_id, {
    maxChars: 1_500,
    from: shown.budget.items_shown,
  });
  assert.ok(rest.budget.items_shown > 0);
});

test("pending is the token gate: an active batch is resumed, never reclassified", async (t) => {
  const root = await newVault("open-brain-gate-pending-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal((await syncPending(root, config)).active_batches.length, 0);

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });

  const pending = await syncPending(root, config);
  assert.equal(pending.active_batches.length, 1);
  assert.equal(pending.active_batches[0]?.batch_id, prepared.batch_id);
  assert.equal(pending.active_batches[0]?.phase, "proposed");
  assert.match(String(pending.next), /never reclassified/u);

  // Preparing the same classification again lands on the same batch.
  const again = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });
  assert.equal(again.batch_id, prepared.batch_id);
  assert.equal(again.created, false);
  assert.equal(again.proposed, 0);

  // A resume with no decision hands the batch back to the human.
  const resumed = await resumeBatch(root, config, prepared.batch_id);
  assert.equal(resumed.result, null);
  assert.match(resumed.next, /never decided/u);

  // A second, different batch is refused while this one waits.
  const other = await stage(root, { quote: "Always sign off with the next step." });
  const nextSlice = await syncStaged(root, config);
  await assert.rejects(
    () => prepareBatch(root, config, {
      items: [preferenceItem(other, "next-step")],
      selectionId: nextSlice.selection_id,
    }),
    (error: unknown) => error instanceof SyncGateError && /already waiting for your decision/u.test(String(error)),
  );
});

test("a slice that moved under the classifier is refused", async (t) => {
  const root = await newVault("open-brain-gate-selection-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  await assert.rejects(
    () => prepareBatch(root, config, {
      items: [preferenceItem(id, "short-answers")],
      selectionId: "selection-000000000000000000000000",
    }),
    (error: unknown) => error instanceof SyncGateError && /reclassify that slice/u.test(String(error)),
  );
});

test("a batch carries its age, and an old one says so before it is presented", async (t) => {
  const root = await newVault("open-brain-gate-freshness-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const id = await stage(root);
  const slice = await syncStaged(root, config);
  const prepared = await prepareBatch(root, config, {
    items: [preferenceItem(id, "short-answers")],
    selectionId: slice.selection_id,
  });

  const fresh = await syncPending(root, config);
  assert.equal(fresh.stale_count, 0);
  const young = fresh.active_batches[0];
  assert.equal(typeof young?.prepared_at, "string");
  assert.equal(young?.age_days, 0);
  assert.equal(young?.stale, false);
  assert.equal(young?.stale_warning, undefined);

  // Ageing the stamp on disk is enough, which is also the proof that it sits
  // outside the signature: the batch still verifies after the edit.
  const paths = batchPaths(root, config, prepared.batch_id);
  const stored = JSON.parse(await readFile(paths.batch, "utf8")) as Record<string, unknown>;
  const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z");
  await writeFile(
    paths.batch,
    `${JSON.stringify({ ...stored, prepared_at: nineDaysAgo }, null, 2)}\n`,
    "utf8",
  );

  const loaded = await loadBatch(root, config, prepared.batch_id);
  assert.equal(loaded.prepared_at, nineDaysAgo);

  const aged = await syncPending(root, config);
  assert.equal(aged.stale_count, 1);
  const old = aged.active_batches[0];
  assert.equal(old?.stale, true);
  assert.equal(old?.age_days, 9);
  assert.match(String(old?.stale_warning), /10_memory\/_state\.md/u);
  assert.match(String(old?.stale_warning), /never as one more neutral option/u);

  const shown = await showBatch(root, config, prepared.batch_id);
  assert.equal(shown.stale, true);
  assert.equal(shown.age_days, 9);
  assert.equal(shown.prepared_at, nineDaysAgo);
  assert.match(String(shown.stale_warning), /in full/u);

  // A batch written before the stamp existed, and one carrying a stamp nobody
  // can read, are both out of date rather than brand new: an unknown age is not
  // a young one.
  for (const stamp of [null, "last tuesday"]) {
    const unknown = batchFreshness({ ...loaded, prepared_at: stamp }, config);
    assert.equal(unknown.stale, true);
    assert.equal(unknown.age_days, null);
    assert.equal(unknown.prepared_at, null);
    assert.match(String(unknown.stale_warning), /no readable preparation date/u);
  }

  // Two days is the line, and the age is reported to one decimal.
  const almost = batchFreshness(
    { ...loaded, prepared_at: nineDaysAgo },
    config,
    Date.parse(nineDaysAgo) + 1.95 * 24 * 60 * 60 * 1_000,
  );
  assert.equal(almost.stale, false);
  assert.equal(almost.age_days, 2);
  assert.equal(almost.stale_warning, undefined);
});

test("approved indices are parsed strictly and never default to everything", () => {
  assert.deepEqual(parseApprovedIndices("", 3), []);
  assert.deepEqual(parseApprovedIndices("3,1", 3), [1, 3]);
  assert.throws(() => parseApprovedIndices("1,1", 3), SyncGateError);
  assert.throws(() => parseApprovedIndices("0", 3), SyncGateError);
  assert.throws(() => parseApprovedIndices("4", 3), SyncGateError);
  assert.throws(() => parseApprovedIndices("all", 3), SyncGateError);
});
