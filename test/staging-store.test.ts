import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { lockPathFor } from "../src/core/lock.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  applyTransition,
  canonicalJson,
  computeBatchId,
  computeContentHash,
  computeSelectionId,
  isCalendarDate,
  normalizeDepositRequest,
  parseCandidateRow,
  sanitizeCandidateUpdates,
} from "../src/staging/candidate.js";
import {
  appendCandidate,
  appendCandidates,
  compactStaging,
  dropCandidates,
  listCandidates,
  readPurgeTombstones,
  readStore,
  stagingPaths,
  stagingStatus,
  transitionCandidate,
} from "../src/staging/store.js";
import {
  CorruptStoreError,
  IdempotencyConflictError,
  InvalidTransitionError,
  StagingStoreError,
  StoreLockTimeoutError,
  type ProposalInput,
} from "../src/staging/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const storeModuleUrl = new URL("../src/staging/store.ts", import.meta.url).href;

function configWith(capture: boolean): VaultConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: {
      ...DEFAULT_CONFIG.capabilities,
      capture: { enabled: capture },
    },
  };
}

const armed = configWith(true);
const disarmed = configWith(false);

async function newVault(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");
  return root;
}

function deposit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "prompt_submit",
    signal: "explicit_request",
    raw_quote: "Always answer in short structured blocks.",
    raw_markers: ["remember"],
    harness: "claude-code",
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    type: "preference",
    target: "10_memory/preferences/_ledger.json",
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "The user asked for it in so many words.",
    proofs: [{ date: "2026-07-20", quote: "Always answer in short structured blocks." }],
    weak: false,
    recommendation: "approve",
    evidence_basis: null,
    gate_item_index: 1,
    gate_write_payload: { kind: "preference" },
    ...overrides,
  };
}

async function candidatesText(root: string): Promise<string> {
  return readFile(stagingPaths(root, armed).candidates, "utf8");
}

// ---------------------------------------------------------------------------
// Deposit, normalization, capability
// ---------------------------------------------------------------------------

test("a deposit is normalized, capped, and refuses unknown fields", async (t) => {
  const root = await newVault("open-brain-staging-normalize-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const normalized = normalizeDepositRequest(
    deposit({ raw_quote: "x".repeat(900), context: "y".repeat(400) }),
  );
  assert.equal(normalized.raw_quote.length, 500);
  assert.equal(normalized.context?.length, 280);
  assert.equal(normalized.harness, "claude-code");
  assert.equal(normalized.session_id, null);

  assert.throws(
    () => normalizeDepositRequest(deposit({ target_path: "somewhere" })),
    (error: unknown) => error instanceof StagingStoreError && /Unknown deposit fields/u.test((error as Error).message),
  );
  assert.throws(() => normalizeDepositRequest(deposit({ signal: "vibes" })), StagingStoreError);
  assert.throws(() => normalizeDepositRequest(deposit({ raw_markers: "one" })), StagingStoreError);
});

test("automatic capture is gated, a manual deposit is not", async (t) => {
  const root = await newVault("open-brain-staging-capability-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    appendCandidate(root, disarmed, deposit({ source: "turn_end" })),
    /Capability capture is disabled/u,
  );
  await assert.rejects(
    appendCandidates(disarmed === armed ? root : root, disarmed, [deposit({ source: "pre_compact" })]),
    /Capability capture is disabled/u,
  );

  const manual = await appendCandidate(root, disarmed, deposit({ source: "manual" }));
  assert.equal(manual.created, true);
  assert.equal(manual.candidate.status, "staged");
  assert.match(manual.candidate.id, /^cand-\d{8}-[0-9a-f]{16}$/u);
  assert.equal(manual.candidate.schema_version, 1);

  const listed = await listCandidates(root, disarmed, {});
  assert.equal(listed.length, 1);
});

// ---------------------------------------------------------------------------
// Invariant 1 and 2: durability and no partial write
// ---------------------------------------------------------------------------

test("invariant 1: a staged candidate survives a crash and no line is ever partial", async (t) => {
  const root = await newVault("open-brain-staging-crash-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, "appender.mjs");
  await writeFile(
    script,
    `
import { appendCandidate } from ${JSON.stringify(storeModuleUrl)};
const [root, configJson] = process.argv.slice(2);
const config = JSON.parse(configJson);
for (let index = 0; index < 400; index += 1) {
  await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: "candidate " + String(index) + " " + "padding".repeat(20),
    raw_markers: ["remember"],
    harness: "unknown",
  });
}
`,
    "utf8",
  );

  const child = spawn(
    process.execPath,
    ["--import", "tsx", script, root, JSON.stringify(armed)],
    { cwd: projectRoot, stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  // The store must still parse: a half-written line would raise here, and the
  // candidates written before the kill must all be complete and readable.
  const snapshot = await readStore(root, armed);
  assert.ok(snapshot.active.length > 0, "the killed child should have staged something");
  for (const row of snapshot.active) {
    assert.equal(row.status, "staged");
    assert.equal(row.status_history.length, 1);
    assert.ok(row.raw_quote.length > 0);
  }
  const text = await candidatesText(root);
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.split("\n").filter((line) => line.length > 0).length, snapshot.active.length);
});

test("invariant 8: concurrent processes lose no candidate and never collide on an id", async (t) => {
  const root = await newVault("open-brain-staging-concurrent-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, "concurrent.mjs");
  await writeFile(
    script,
    `
import { appendCandidate } from ${JSON.stringify(storeModuleUrl)};
const [root, configJson, tag] = process.argv.slice(2);
const config = JSON.parse(configJson);
for (let index = 0; index < 15; index += 1) {
  await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: tag + "-" + String(index),
    raw_markers: [],
    harness: "unknown",
  });
}
`,
    "utf8",
  );

  const children = Array.from({ length: 6 }, (_unused, index) =>
    new Promise<number>((resolveExit, rejectExit) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", script, root, JSON.stringify(armed), `worker${String(index)}`],
        { cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"] },
      );
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code ?? -1));
    }));
  assert.deepEqual(await Promise.all(children), [0, 0, 0, 0, 0, 0]);

  const snapshot = await readStore(root, armed);
  assert.equal(snapshot.active.length, 90);
  assert.equal(new Set(snapshot.active.map((row) => row.id)).size, 90);
  assert.equal(new Set(snapshot.active.map((row) => row.raw_quote)).size, 90);
});

test("invariant 9: waiting on the store lock is bounded and names the holder", async (t) => {
  const root = await newVault("open-brain-staging-lock-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const lockPath = lockPathFor(root, "staging");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquired_at: new Date().toISOString(),
      holder: "another open-brain process",
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    appendCandidate(root, armed, deposit({ source: "manual" })),
    (error: unknown) =>
      error instanceof StoreLockTimeoutError && /another open-brain process/u.test((error as Error).message),
  );
});

// ---------------------------------------------------------------------------
// Invariant 3, 4: corruption stops everything
// ---------------------------------------------------------------------------

test("invariant 3: one corrupt line refuses every mutation without losing data", async (t) => {
  const root = await newVault("open-brain-staging-corrupt-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await appendCandidate(root, armed, deposit({ source: "manual" }));
  const good = await candidatesText(root);

  const cases: Array<[string, string]> = [
    ["invalid JSON", "{not json"],
    ["a non-object line", "[1, 2, 3]"],
    ["an empty id", JSON.stringify({ id: "", status: "staged", ts: "2026-07-20T10:00:00Z" })],
    ["an unknown status", JSON.stringify({ id: "cand-20260720-aaaaaaaaaaaaaaaa", status: "graved", ts: "2026-07-20T10:00:00Z" })],
  ];

  for (const [label, line] of cases) {
    await writeFile(stagingPaths(root, armed).candidates, `${good}${line}\n`, "utf8");
    const damaged = await candidatesText(root);
    await assert.rejects(
      appendCandidate(root, armed, deposit({ source: "manual", raw_quote: "another" })),
      CorruptStoreError,
      `append should refuse ${label}`,
    );
    await assert.rejects(compactStaging(root, armed), CorruptStoreError, `compact should refuse ${label}`);
    await assert.rejects(
      dropCandidates(root, armed, { status: "staged" }),
      CorruptStoreError,
      `drop should refuse ${label}`,
    );
    assert.equal(await candidatesText(root), damaged, `${label} must not be rewritten away`);
  }

  await writeFile(stagingPaths(root, armed).candidates, `${good}${good}`, "utf8");
  await assert.rejects(readStore(root, armed), CorruptStoreError);
});

test("invariant 3: a store that is not valid UTF-8 refuses every mutation", async (t) => {
  const root = await newVault("open-brain-staging-utf8-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = stagingPaths(root, armed);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.candidates, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
  await assert.rejects(appendCandidate(root, armed, deposit({ source: "manual" })), CorruptStoreError);
});

test("invariant 4: a candidate that diverges from its archive stops everything", async (t) => {
  const root = await newVault("open-brain-staging-divergent-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const created = await appendCandidate(root, armed, deposit({ source: "manual" }));
  const paths = stagingPaths(root, armed);
  await mkdir(paths.archive, { recursive: true });
  const forged = { ...created.candidate, raw_quote: "a different story" };
  await writeFile(join(paths.archive, "2026-07_resolved.jsonl"), `${JSON.stringify(forged)}\n`, "utf8");

  await assert.rejects(readStore(root, armed), CorruptStoreError);
});

// ---------------------------------------------------------------------------
// Invariant 5: provenance is immutable
// ---------------------------------------------------------------------------

test("invariant 5: deposit provenance cannot be rewritten, and the status does not move", async (t) => {
  const root = await newVault("open-brain-staging-immutable-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const created = await appendCandidate(root, armed, deposit({ source: "manual" }));

  for (const field of ["raw_quote", "source", "signal", "id", "ts", "deposit_request", "status_history"]) {
    await assert.rejects(
      transitionCandidate(root, armed, {
        id: created.candidate.id,
        status: "proposed",
        proposal: proposal(),
        updates: { [field]: "forged" },
      }),
      (error: unknown) =>
        error instanceof StagingStoreError && /Reserved candidate fields/u.test((error as Error).message),
      `${field} must be refused`,
    );
  }

  const reread = await readStore(root, armed);
  assert.equal(reread.active[0]?.status, "staged");
  assert.equal(reread.active[0]?.raw_quote, created.candidate.raw_quote);

  assert.throws(() => sanitizeCandidateUpdates({ nonsense: 1 }), /Unknown candidate fields/u);
  assert.deepEqual(sanitizeCandidateUpdates({ apply_error: "boom" }), { apply_error: "boom" });
});

// ---------------------------------------------------------------------------
// Invariant 6 and 7: idempotence and all or nothing
// ---------------------------------------------------------------------------

test("invariant 6: replaying a deposit returns the same candidate and writes nothing", async (t) => {
  const root = await newVault("open-brain-staging-idempotent-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const request = deposit({ source: "manual", operation_id: "capture-abc" });

  const first = await appendCandidate(root, armed, request);
  const before = await stat(stagingPaths(root, armed).candidates);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await appendCandidate(root, armed, request);
  const after = await stat(stagingPaths(root, armed).candidates);

  assert.equal(second.created, false);
  assert.equal(second.candidate.id, first.candidate.id);
  assert.equal(after.mtimeMs, before.mtimeMs, "a replay must not rewrite the store");

  await assert.rejects(
    appendCandidate(root, armed, deposit({ source: "manual", operation_id: "capture-abc", raw_quote: "different" })),
    IdempotencyConflictError,
  );
  assert.equal((await readStore(root, armed)).active.length, 1);
});

test("invariant 6: a replay stays a replay after the candidate has been archived", async (t) => {
  const root = await newVault("open-brain-staging-replay-archive-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const request = deposit({ source: "manual", operation_id: "capture-archived" });
  const first = await appendCandidate(root, armed, request);
  await transitionCandidate(root, armed, {
    id: first.candidate.id,
    status: "proposed",
    proposal: proposal(),
  });
  await transitionCandidate(root, armed, { id: first.candidate.id, status: "rejected" });
  assert.deepEqual((await compactStaging(root, armed)).archived, 1);

  const replay = await appendCandidate(root, armed, request);
  assert.equal(replay.created, false);
  assert.equal(replay.candidate.id, first.candidate.id);
  assert.equal((await readStore(root, armed)).active.length, 0);
});

test("invariant 7: a batch deposit is all or nothing and its replay is idempotent", async (t) => {
  const root = await newVault("open-brain-staging-batch-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    appendCandidates(root, armed, [deposit({ source: "manual" }), deposit({ signal: "nope" })]),
    StagingStoreError,
  );
  await assert.rejects(readFile(stagingPaths(root, armed).candidates, "utf8"), /ENOENT/u);

  const batch = await appendCandidates(
    root,
    armed,
    [
      deposit({ source: "pre_compact", raw_quote: "first" }),
      deposit({ source: "pre_compact", raw_quote: "second" }),
      deposit({ source: "pre_compact", raw_quote: "third" }),
    ],
    { operationId: "capture-batch-1" },
  );
  assert.equal(batch.candidates.length, 3);
  assert.deepEqual(batch.candidates.map((row) => row.deposit_batch_index), [0, 1, 2]);
  assert.deepEqual(batch.candidates.map((row) => row.deposit_batch_size), [3, 3, 3]);
  assert.equal(new Set(batch.candidates.map((row) => row.deposit_batch_digest)).size, 1);

  const replay = await appendCandidates(
    root,
    armed,
    [
      deposit({ source: "pre_compact", raw_quote: "first" }),
      deposit({ source: "pre_compact", raw_quote: "second" }),
      deposit({ source: "pre_compact", raw_quote: "third" }),
    ],
    { operationId: "capture-batch-1" },
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.candidates.map((row) => row.id), batch.candidates.map((row) => row.id));
  assert.equal((await readStore(root, armed)).active.length, 3);

  await assert.rejects(
    appendCandidates(root, armed, [deposit({ source: "pre_compact", raw_quote: "changed" })], {
      operationId: "capture-batch-1",
    }),
    IdempotencyConflictError,
  );
  assert.equal((await readStore(root, armed)).active.length, 3);
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test("the state machine refuses every illegal edge and names the legal ones", async (t) => {
  const root = await newVault("open-brain-staging-machine-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const created = await appendCandidate(root, armed, deposit({ source: "manual" }));
  const id = created.candidate.id;

  await assert.rejects(
    transitionCandidate(root, armed, { id, status: "approved" }),
    (error: unknown) =>
      error instanceof InvalidTransitionError && /Legal moves from staged: proposed/u.test((error as Error).message),
  );
  await assert.rejects(
    transitionCandidate(root, armed, { id, status: "applied" }),
    InvalidTransitionError,
  );
  await assert.rejects(
    transitionCandidate(root, armed, { id, status: "staged" }),
    InvalidTransitionError,
  );
  await assert.rejects(
    transitionCandidate(root, armed, { id, status: "proposed" }),
    /cannot become proposed without its classified proposal/u,
  );

  const proposed = await transitionCandidate(root, armed, {
    id,
    status: "proposed",
    proposal: proposal(),
    batchId: "batch-000000000000000000000000",
  });
  assert.equal(proposed.candidate.status, "proposed");
  assert.ok(proposed.candidate.proposed_ts);
  assert.equal(proposed.candidate.target, "10_memory/preferences/_ledger.json");
  assert.equal(proposed.candidate.status_history.length, 2);

  const repeat = await transitionCandidate(root, armed, {
    id,
    status: "proposed",
    proposal: proposal(),
    batchId: "batch-000000000000000000000000",
  });
  assert.equal(repeat.changed, false);
  assert.equal(repeat.candidate.status_history.length, 2);

  await assert.rejects(
    transitionCandidate(root, armed, {
      id,
      status: "proposed",
      proposal: proposal({ reason: "a different reason entirely" }),
      batchId: "batch-000000000000000000000000",
    }),
    IdempotencyConflictError,
  );

  const approved = await transitionCandidate(root, armed, { id, status: "approved" });
  assert.ok(approved.candidate.decided_ts);
  const applying = await transitionCandidate(root, armed, { id, status: "applying" });
  assert.ok(applying.candidate.apply_started_ts);
  const failed = await transitionCandidate(root, armed, {
    id,
    status: "apply_failed",
    applyError: "the destination refused",
  });
  assert.equal(failed.candidate.apply_error, "the destination refused");
  assert.ok(failed.candidate.resolved_ts);

  const retry = await transitionCandidate(root, armed, { id, status: "applying" });
  assert.equal(retry.candidate.resolved_ts, null, "a retry clears the resolution stamp");
  assert.equal(retry.candidate.apply_error, null);

  const applied = await transitionCandidate(root, armed, {
    id,
    status: "applied",
    appliedRef: "preference:short-structured-answers",
  });
  assert.equal(applied.candidate.applied_ref, "preference:short-structured-answers");
  await assert.rejects(
    transitionCandidate(root, armed, { id, status: "rejected" }),
    (error: unknown) =>
      error instanceof InvalidTransitionError && /none, it is terminal/u.test((error as Error).message),
  );
});

test("a reject_only candidate can be rejected but never approved", async (t) => {
  const root = await newVault("open-brain-staging-rejectonly-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const created = await appendCandidate(root, armed, deposit({ source: "manual", signal: "praise_weak" }));
  const id = created.candidate.id;

  await transitionCandidate(root, armed, {
    id,
    status: "proposed",
    proposal: proposal({
      weak: true,
      recommendation: "reject_only",
      evidence_basis: "insufficient",
    }),
  });
  await assert.rejects(
    transitionCandidate(root, armed, { id, status: "approved" }),
    (error: unknown) =>
      error instanceof InvalidTransitionError && /classified reject_only/u.test((error as Error).message),
  );
  const rejected = await transitionCandidate(root, armed, { id, status: "rejected" });
  assert.equal(rejected.candidate.status, "rejected");
});

// ---------------------------------------------------------------------------
// Amendment 10.12: the evidence threshold is validated in the store too
// ---------------------------------------------------------------------------

test("amendment 10.12: a direct store call with insufficient evidence is refused", async (t) => {
  const root = await newVault("open-brain-staging-evidence-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  async function stage(signal: string): Promise<string> {
    const created = await appendCandidate(
      root,
      armed,
      deposit({ source: "manual", signal, raw_quote: `quote for ${signal} ${String(Math.random())}` }),
    );
    return created.candidate.id;
  }

  // A single passive correction cannot be approved: recurrence is required.
  const correction = await stage("correction");
  await assert.rejects(
    transitionCandidate(root, armed, {
      id: correction,
      status: "proposed",
      proposal: proposal({ evidence_basis: "recurrence" }),
    }),
    (error: unknown) => error instanceof StagingStoreError && /needs recurrence/u.test((error as Error).message),
  );

  // Two proofs on the same date are still one occurrence.
  await assert.rejects(
    transitionCandidate(root, armed, {
      id: correction,
      status: "proposed",
      proposal: proposal({
        evidence_basis: "recurrence",
        proofs: [
          { date: "2026-07-20", quote: "first" },
          { date: "2026-07-20", quote: "second" },
        ],
      }),
    }),
    /needs recurrence/u,
  );

  // Recurrence without a declared basis is refused too.
  await assert.rejects(
    transitionCandidate(root, armed, {
      id: correction,
      status: "proposed",
      proposal: proposal({
        evidence_basis: null,
        proofs: [
          { date: "2026-07-20", quote: "first" },
          { date: "2026-07-22", quote: "second" },
        ],
      }),
    }),
    /evidence basis of recurrence or documented_pain/u,
  );

  // With recurrence on two dates and a declared basis, it passes.
  const accepted = await transitionCandidate(root, armed, {
    id: correction,
    status: "proposed",
    proposal: proposal({
      evidence_basis: "recurrence",
      proofs: [
        { date: "2026-07-20", quote: "first" },
        { date: "2026-07-22", quote: "second" },
      ],
    }),
  });
  assert.equal(accepted.candidate.status, "proposed");

  // A weak praise can never be approved, however many proofs are attached.
  const weak = await stage("praise_weak");
  await assert.rejects(
    transitionCandidate(root, armed, {
      id: weak,
      status: "proposed",
      proposal: proposal({
        evidence_basis: "recurrence",
        proofs: [
          { date: "2026-07-20", quote: "first" },
          { date: "2026-07-22", quote: "second" },
          { date: "2026-07-24", quote: "third" },
        ],
      }),
    }),
    /can never be approved/u,
  );

  // A weight bump always needs recurrence or documented pain.
  const explicit = await stage("explicit_request");
  await assert.rejects(
    transitionCandidate(root, armed, {
      id: explicit,
      status: "proposed",
      proposal: proposal({ type: "weight", proposed_weight: 3, evidence_basis: null }),
    }),
    /weight bump needs an evidence basis/u,
  );

  // An explicit request needs a single proof and nothing more.
  const plain = await stage("explicit_request");
  const staged = await transitionCandidate(root, armed, {
    id: plain,
    status: "proposed",
    proposal: proposal(),
  });
  assert.equal(staged.candidate.status, "proposed");
});

test("a proposal is refused when its proofs are malformed", async (t) => {
  const root = await newVault("open-brain-staging-proofs-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const created = await appendCandidate(root, armed, deposit({ source: "manual" }));
  const id = created.candidate.id;

  const bad: Array<[string, Partial<ProposalInput>]> = [
    ["no proof at all", { proofs: [] }],
    ["a date that does not exist", { proofs: [{ date: "2026-02-30", quote: "x" }] }],
    ["a malformed date", { proofs: [{ date: "20-07-2026", quote: "x" }] }],
    ["an empty quote", { proofs: [{ date: "2026-07-20", quote: "  " }] }],
    [
      "a repeated proof",
      {
        proofs: [
          { date: "2026-07-20", quote: "same" },
          { date: "2026-07-20", quote: "same" },
        ],
      },
    ],
    ["a weak flag that contradicts the recommendation", { weak: true }],
    ["an unknown type", { type: "decision" as ProposalInput["type"] }],
  ];

  for (const [label, override] of bad) {
    await assert.rejects(
      transitionCandidate(root, armed, { id, status: "proposed", proposal: proposal(override) }),
      StagingStoreError,
      `${label} must be refused`,
    );
  }
  assert.equal((await readStore(root, armed)).active[0]?.status, "staged");
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-02-28"), true);
});

// ---------------------------------------------------------------------------
// Invariant 10 and 11: compaction and the untouched kernel
// ---------------------------------------------------------------------------

test("invariant 10: compaction archives only terminal candidates and retries cleanly", async (t) => {
  const root = await newVault("open-brain-staging-compact-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const pending = await appendCandidate(root, armed, deposit({ source: "manual", raw_quote: "still pending" }));
  const done = await appendCandidate(root, armed, deposit({ source: "manual", raw_quote: "already decided" }));
  await transitionCandidate(root, armed, {
    id: done.candidate.id,
    status: "proposed",
    proposal: proposal(),
  });
  await transitionCandidate(root, armed, { id: done.candidate.id, status: "rejected" });

  const first = await compactStaging(root, armed);
  assert.equal(first.archived, 1);
  assert.equal(first.kept, 1);
  const second = await compactStaging(root, armed);
  assert.equal(second.archived, 0);

  const snapshot = await readStore(root, armed);
  assert.deepEqual(snapshot.active.map((row) => row.id), [pending.candidate.id]);
  assert.deepEqual(snapshot.archived.map((row) => row.id), [done.candidate.id]);
  assert.equal(snapshot.all.length, 2);

  const status = await stagingStatus(root, armed);
  assert.equal(status.active, 1);
  assert.equal(status.archived, 1);
  assert.equal(status.pending, 1);
  assert.equal(status.capture_enabled, true);
  assert.equal(status.archive_files.length, 1);
});

test("invariant 12: a malformed resolved_ts is refused rather than turned into an archive path", async (t) => {
  const root = await newVault("open-brain-staging-archive-month-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const created = await appendCandidate(root, armed, deposit({ source: "manual", raw_quote: "attempted traversal" }));
  await transitionCandidate(root, armed, { id: created.candidate.id, status: "proposed", proposal: proposal() });
  await transitionCandidate(root, armed, { id: created.candidate.id, status: "rejected" });

  // Nothing that writes resolved_ts validates its shape beyond "a non-empty
  // string or null" (see optionalStoredText in candidate.ts), so a forged or
  // otherwise corrupted timestamp reaches archiveMonth exactly as written.
  const paths = stagingPaths(root, armed);
  const rows = (await readFile(paths.candidates, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const target = rows.find((row) => row.id === created.candidate.id);
  assert.ok(target, "the candidate row must exist");
  target.resolved_ts = "../../../../etc/passwd";
  await writeFile(paths.candidates, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  await assert.rejects(
    compactStaging(root, armed),
    (error: unknown) => error instanceof CorruptStoreError && /archive month/u.test((error as Error).message),
    "a malformed resolved_ts must be refused, not joined into a path",
  );
});

test("invariant 11: a full cycle never touches the preference kernel", async (t) => {
  const root = await newVault("open-brain-staging-kernel-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const kernel = join(root, "10_memory", "preferences");
  await mkdir(kernel, { recursive: true });
  const ledgerPath = join(kernel, "_ledger.json");
  const corePath = join(kernel, "_core.md");
  await writeFile(ledgerPath, `${JSON.stringify({ schema_version: 1, preferences: [] }, null, 2)}\n`, "utf8");
  await writeFile(corePath, "# Preference core\n", "utf8");
  const ledgerBefore = await readFile(ledgerPath);
  const coreBefore = await readFile(corePath);

  const created = await appendCandidate(root, armed, deposit({ source: "manual" }));
  const id = created.candidate.id;
  await transitionCandidate(root, armed, { id, status: "proposed", proposal: proposal() });
  await transitionCandidate(root, armed, { id, status: "approved" });
  await transitionCandidate(root, armed, { id, status: "applying" });
  await transitionCandidate(root, armed, { id, status: "applied", appliedRef: "preference:x" });
  await compactStaging(root, armed);
  await dropCandidates(root, armed, { status: "staged" }).catch(() => undefined);

  assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  assert.deepEqual(await readFile(corePath), coreBefore);
});

// ---------------------------------------------------------------------------
// Privacy and tolerant reads
// ---------------------------------------------------------------------------

test("dropping candidates needs a criterion and never touches archives", async (t) => {
  const root = await newVault("open-brain-staging-drop-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const first = await appendCandidate(root, armed, deposit({ source: "manual", raw_quote: "private one" }));
  await appendCandidate(root, armed, deposit({ source: "manual", raw_quote: "private two" }));

  await assert.rejects(dropCandidates(root, armed, {}), /needs a criterion/u);
  await assert.rejects(dropCandidates(root, armed, { ids: ["cand-20260720-ffffffffffffffff"] }), /Unknown active candidate/u);

  const dropped = await dropCandidates(root, armed, { ids: [first.candidate.id] });
  assert.deepEqual(dropped.dropped, [first.candidate.id]);
  assert.equal(dropped.kept, 1);
  const text = await candidatesText(root);
  assert.equal(text.includes("private one"), false);
  assert.equal(text.includes("private two"), true);
});

// ---------------------------------------------------------------------------
// Purging the archive: privacy wins on the content, never on the trace
// ---------------------------------------------------------------------------

function archiveName(): string {
  return `${new Date().toISOString().slice(0, 7)}_resolved.jsonl`;
}

async function archiveTerminal(root: string, source: string, quotes: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const quote of quotes) {
    const created = await appendCandidate(root, armed, deposit({ source, raw_quote: quote }));
    const id = created.candidate.id;
    await transitionCandidate(root, armed, { id, status: "proposed", proposal: proposal() });
    await transitionCandidate(root, armed, { id, status: "rejected" });
    ids.push(id);
  }
  await compactStaging(root, armed);
  return ids;
}

async function archiveText(root: string): Promise<string> {
  return readFile(join(stagingPaths(root, armed).archive, archiveName()), "utf8");
}

test("a purge erases archived content and leaves a tombstone that carries none", async (t) => {
  const root = await newVault("open-brain-staging-purge-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const archived = await archiveTerminal(root, "turn_end", [
    "the first thing a transcript revealed",
    "the second thing a transcript revealed",
    "the third thing a transcript revealed",
  ]);
  const stillActive = await appendCandidate(
    root,
    armed,
    deposit({ source: "turn_end", raw_quote: "captured but not yet reviewed" }),
  );
  const untouched = await appendCandidate(
    root,
    armed,
    deposit({ source: "manual", raw_quote: "the user typed this one" }),
  );

  const result = await dropCandidates(root, armed, {
    sources: ["turn_end"],
    includeArchived: true,
    reason: "consent to transcripts was revoked",
    command: "open-brain transcripts purge",
  });

  // The report says exactly what was erased, active and archived, and where.
  assert.deepEqual(result.dropped, [stillActive.candidate.id]);
  assert.equal(result.kept, 1);
  assert.deepEqual([...result.archived_dropped].sort(), [...archived].sort());
  assert.deepEqual(result.archive_files, [
    { path: `archive/${archiveName()}`, removed: 3, remaining: 0 },
  ]);

  // The content is gone from the archive, in the file and on disk.
  const remainingArchive = await archiveText(root);
  for (const quote of ["first thing", "second thing", "third thing"]) {
    assert.equal(remainingArchive.includes(quote), false, `${quote} must be erased`);
  }
  assert.equal(remainingArchive.trim(), "");
  const active = await candidatesText(root);
  assert.equal(active.includes("captured but not yet reviewed"), false);
  assert.equal(active.includes("the user typed this one"), true);

  // The trace stays, and it carries no content and no identifier.
  const tombstoneText = await readFile(stagingPaths(root, armed).tombstones, "utf8");
  assert.equal(tombstoneText.split("\n").filter((line) => line.length > 0).length, 1);
  for (const secret of ["transcript revealed", "captured but not yet", ...archived, stillActive.candidate.id]) {
    assert.equal(tombstoneText.includes(secret), false, `the tombstone must not carry ${secret}`);
  }

  const tombstones = await readPurgeTombstones(root, armed);
  assert.equal(tombstones.length, 1);
  const tombstone = tombstones[0];
  assert.equal(tombstone?.active_removed, 1);
  assert.equal(tombstone?.archive_removed, 3);
  assert.equal(tombstone?.reason, "consent to transcripts was revoked");
  assert.equal(tombstone?.command, "open-brain transcripts purge");
  assert.deepEqual(tombstone?.files, [{ path: `archive/${archiveName()}`, removed: 3 }]);
  assert.deepEqual(tombstone?.filters.sources, ["turn_end"]);
  assert.equal(tombstone?.filters.ids, 0);
  assert.deepEqual(tombstone, result.tombstone);

  // The vault the user still has is exactly the one candidate they typed.
  const snapshot = await readStore(root, armed);
  assert.deepEqual(snapshot.all.map((row) => row.id), [untouched.candidate.id]);
});

test("a purged archive stays readable and the store keeps working", async (t) => {
  const root = await newVault("open-brain-staging-purge-coherent-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const archived = await archiveTerminal(root, "pre_compact", ["one", "two", "three"]);
  const survivor = await appendCandidate(
    root,
    armed,
    deposit({ source: "manual", raw_quote: "kept on purpose" }),
  );
  await transitionCandidate(root, armed, {
    id: survivor.candidate.id,
    status: "proposed",
    proposal: proposal(),
  });
  await transitionCandidate(root, armed, { id: survivor.candidate.id, status: "rejected" });
  await compactStaging(root, armed);

  await dropCandidates(root, armed, {
    ids: [archived[0] ?? "", archived[1] ?? ""],
    includeArchived: true,
    reason: "a targeted erasure",
  });

  const snapshot = await readStore(root, armed);
  assert.deepEqual(
    [...snapshot.all.map((row) => row.id)].sort(),
    [archived[2] ?? "", survivor.candidate.id].sort(),
  );
  assert.equal(snapshot.active.length, 0);

  // The store still accepts work, and compaction still merges into the purged file.
  const fresh = await appendCandidate(
    root,
    armed,
    deposit({ source: "manual", raw_quote: "life goes on" }),
  );
  await transitionCandidate(root, armed, {
    id: fresh.candidate.id,
    status: "proposed",
    proposal: proposal(),
  });
  await transitionCandidate(root, armed, { id: fresh.candidate.id, status: "rejected" });
  const compacted = await compactStaging(root, armed);
  assert.equal(compacted.archived, 1);
  assert.equal((await readStore(root, armed)).all.length, 3);

  const status = await stagingStatus(root, armed);
  assert.equal(status.archived, 3);
  assert.equal(status.active, 0);
});

test("an identical second purge is a non-event", async (t) => {
  const root = await newVault("open-brain-staging-purge-replay-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await archiveTerminal(root, "turn_end", ["one", "two"]);

  const params = {
    sources: ["turn_end"] as const,
    includeArchived: true,
    reason: "consent revoked",
  };
  const first = await dropCandidates(root, armed, { ...params, sources: [...params.sources] });
  assert.equal(first.archived_dropped.length, 2);
  const tombstoneAfterFirst = await readFile(stagingPaths(root, armed).tombstones, "utf8");
  const statAfterFirst = await stat(stagingPaths(root, armed).tombstones);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await dropCandidates(root, armed, { ...params, sources: [...params.sources] });
  assert.deepEqual(second.dropped, []);
  assert.deepEqual(second.archived_dropped, []);
  assert.deepEqual(second.archive_files, []);
  assert.equal(second.tombstone, undefined);
  assert.equal(await readFile(stagingPaths(root, armed).tombstones, "utf8"), tombstoneAfterFirst);
  assert.equal(
    (await stat(stagingPaths(root, armed).tombstones)).mtimeMs,
    statAfterFirst.mtimeMs,
    "a purge that erases nothing must not write a second tombstone",
  );
  assert.equal((await readPurgeTombstones(root, armed)).length, 1);
});

test("a drop that does not ask for the archive leaves it byte identical", async (t) => {
  const root = await newVault("open-brain-staging-purge-scope-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await archiveTerminal(root, "turn_end", ["archived and protected"]);
  const active = await appendCandidate(
    root,
    armed,
    deposit({ source: "turn_end", raw_quote: "active and droppable" }),
  );
  const before = await archiveText(root);

  const result = await dropCandidates(root, armed, { sources: ["turn_end"] });
  assert.deepEqual(result.dropped, [active.candidate.id]);
  assert.deepEqual(result.archived_dropped, []);
  assert.equal(await archiveText(root), before);
  await assert.rejects(readFile(stagingPaths(root, armed).tombstones, "utf8"), /ENOENT/u);
});

test("a purge concurrent with deposits loses nothing and duplicates nothing", async (t) => {
  const root = await newVault("open-brain-staging-purge-concurrent-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await archiveTerminal(root, "turn_end", ["read from a transcript", "and another one"]);

  const appender = join(root, "appender.mjs");
  await writeFile(
    appender,
    `
import { appendCandidate } from ${JSON.stringify(storeModuleUrl)};
const [root, configJson, tag] = process.argv.slice(2);
const config = JSON.parse(configJson);
for (let index = 0; index < 10; index += 1) {
  await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: tag + "-" + String(index),
    raw_markers: [],
    harness: "unknown",
  });
}
`,
    "utf8",
  );
  const purger = join(root, "purger.mjs");
  await writeFile(
    purger,
    `
import { dropCandidates } from ${JSON.stringify(storeModuleUrl)};
const [root, configJson] = process.argv.slice(2);
await dropCandidates(root, JSON.parse(configJson), {
  sources: ["turn_end"],
  includeArchived: true,
  reason: "consent revoked",
  command: "open-brain transcripts purge",
});
`,
    "utf8",
  );

  const scripts = [appender, appender, appender, appender, purger];
  const codes = await Promise.all(scripts.map((script, index) =>
    new Promise<number>((resolveExit, rejectExit) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", script, root, JSON.stringify(armed), `worker${String(index)}`],
        { cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"] },
      );
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code ?? -1));
    })));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);

  const snapshot = await readStore(root, armed);
  assert.equal(snapshot.active.length, 40, "no deposit may be lost to a concurrent purge");
  assert.equal(new Set(snapshot.active.map((row) => row.id)).size, 40);
  assert.equal(new Set(snapshot.active.map((row) => row.raw_quote)).size, 40);
  assert.equal(snapshot.archived.length, 0, "the purged archive must be empty");
  assert.equal((await archiveText(root)).trim(), "");
  assert.equal((await readPurgeTombstones(root, armed)).length, 1);
});

test("a row written by an older version still loads, with its gaps defaulted", () => {
  const row = parseCandidateRow(
    {
      id: "cand-20260720-0123456789abcdef",
      ts: "2026-07-20T10:00:00Z",
      status: "staged",
      source: "manual",
      signal: "explicit_request",
      raw_quote: "from an older schema",
    },
    "candidates.jsonl:1",
  );
  assert.equal(row.schema_version, 1);
  assert.equal(row.harness, "unknown");
  assert.deepEqual(row.raw_markers, []);
  assert.equal(row.deposit_request.raw_quote, "from an older schema");
  assert.equal(row.status_history.length, 1);
  assert.equal(row.last_transition_ts, "2026-07-20T10:00:00Z");
});

test("the derivations the gate builds on are stable and content addressed", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] }), '{"a":[3,{"c":5,"d":4}],"b":1}');
  assert.equal(computeSelectionId(["b", "a"]), computeSelectionId(["a", "b"]));
  assert.match(computeSelectionId(["a"]), /^selection-[0-9a-f]{24}$/u);
  // A fixed key, so the assertion is about the derivation and not about which
  // vault it ran in. The real one is read from outside the vault; see core/secret.ts.
  const secret = { id: "test", path: "test", key: Buffer.alloc(32, 7) };
  const hash = computeContentHash(
    { items: [1], batch_id: "ignored", content_hash: "ignored" },
    secret,
  );
  assert.equal(
    hash,
    computeContentHash({ items: [1], batch_id: "other", content_hash: "other" }, secret),
  );
  assert.match(computeBatchId(hash), /^batch-[0-9a-f]{24}$/u);
});

test("a transition is pure at the row level and appends exactly one history entry", () => {
  const request = normalizeDepositRequest(deposit({ source: "manual" }));
  const row = parseCandidateRow(
    JSON.parse(
      JSON.stringify({
        id: "cand-20260720-0123456789abcdef",
        ts: "2026-07-20T10:00:00Z",
        status: "staged",
        source: request.source,
        signal: request.signal,
        raw_quote: request.raw_quote,
        raw_markers: request.raw_markers,
        harness: request.harness,
        deposit_request: request,
        last_transition_ts: "2026-07-20T10:00:00Z",
        status_history: [
          { status: "staged", ts: "2026-07-20T10:00:00Z", operation_id: null, batch_id: null },
        ],
      }),
    ) as unknown,
    "memory",
  );
  const first = applyTransition(row, { status: "proposed", proposal: proposal() }, "2026-07-21T09:00:00Z");
  assert.equal(first.changed, true);
  assert.equal(row.status, "staged", "the input row is never mutated");
  assert.equal(first.row.status_history.length, 2);
  assert.equal(first.row.status_history[1]?.ts, "2026-07-21T09:00:00Z");
});
