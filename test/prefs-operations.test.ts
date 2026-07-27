import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lockPathFor } from "../src/core/lock.js";
import {
  addPreference,
  applyPreferenceOperation,
  createPreferenceLedger,
  loadPreferenceLedger,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_CREATION_SIGNAL,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  PREFERENCE_LEDGER_SCHEMA_VERSION,
  PREFERENCE_LOCK_NAME,
  readPreferenceOperations,
  runPreferenceOperation,
  savePreferenceLedger,
  validatePreferenceLedger,
  verifyRedline,
  type Preference,
  type PreferenceAddOperation,
  type PreferenceLedger,
} from "../src/prefs/index.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const prefsModuleUrl = new URL("../src/prefs/index.ts", import.meta.url).href;

const CHILD_LOG_SCRIPT = `
import { runPreferenceOperation } from ${JSON.stringify(prefsModuleUrl)};

const options = JSON.parse(process.argv[2]);
try {
  await runPreferenceOperation(
    options.root,
    {
      kind: "log",
      id: "shared",
      signal: "concurrent-" + options.index,
      operationId: "op-" + options.index,
    },
    { lock: { timeoutMs: 20000 } },
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(3);
}
`;

function preference(id: string, overrides: Partial<Preference> = {}): Preference {
  return {
    id,
    weight: 3,
    status: "active",
    domains: ["workflow"],
    statement: `Use ${id}.`,
    why: "Synthetic test preference.",
    apply: `Apply ${id}.`,
    origin: "2026-07-01",
    last_seen: "2026-07-01",
    evidence: [],
    core: false,
    ...overrides,
  };
}

async function seedVault(preferences: Preference[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-prefs-ops-"));
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  await savePreferenceLedger(root, createPreferenceLedger(preferences), {
    command: "test seed",
  });
  return root;
}

function runChild(scriptPath: string, payload: unknown): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, JSON.stringify(payload)],
      { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
}

test("without an operation id nothing is recorded and the mutation behaves as before", () => {
  const ledger = createPreferenceLedger([preference("legacy")]);
  const outcome = applyPreferenceOperation(
    ledger,
    { kind: "log", id: "legacy", signal: "manual" },
    new Date("2026-07-10T00:00:00.000Z"),
  );

  assert.equal(outcome.kind, "applied");
  assert.ok(outcome.kind === "applied");
  assert.deepEqual(readPreferenceOperations(outcome.ledger), []);
  assert.equal(outcome.ledger.operations, undefined);
  assert.equal(outcome.preference.evidence.length, 1);
});

test("the idempotency check runs before the default date and before the derived weight", () => {
  const first = applyPreferenceOperation(
    createPreferenceLedger([preference("target", { weight: 3 })]),
    { kind: "log", id: "target", signal: "validated", operationId: "op-1" },
    new Date("2026-07-10T09:00:00.000Z"),
  );
  assert.ok(first.kind === "applied");
  const applied = first.ledger;

  // The day has moved on, and the weight was changed by hand in between. Both
  // are exactly the inputs a naive port would fold in before checking, and both
  // would make the replay look like a different request.
  const mutated: PreferenceLedger = {
    ...applied,
    preferences: applied.preferences.map((entry) =>
      entry.id === "target" ? { ...entry, weight: 5, status: "law" } : entry),
  };

  const replay = applyPreferenceOperation(
    mutated,
    { kind: "log", id: "target", signal: "validated", operationId: "op-1" },
    new Date("2026-09-30T23:59:00.000Z"),
  );

  assert.equal(replay.kind, "replayed");
  assert.ok(replay.kind === "replayed");
  assert.match(replay.message, /already applied/u);
  const target = mutated.preferences.find((entry) => entry.id === "target");
  assert.ok(target);
  assert.equal(target.evidence.length, 1, "a replay adds no evidence");
});

test("the same operation id with a different payload is reported, never overwritten", () => {
  const first = applyPreferenceOperation(
    createPreferenceLedger([preference("target")]),
    { kind: "log", id: "target", signal: "validated", operationId: "op-1" },
    new Date("2026-07-10T09:00:00.000Z"),
  );
  assert.ok(first.kind === "applied");

  const conflict = applyPreferenceOperation(
    first.ledger,
    { kind: "log", id: "target", signal: "different signal", operationId: "op-1" },
    new Date("2026-07-10T10:00:00.000Z"),
  );

  assert.equal(conflict.kind, "conflict");
  assert.ok(conflict.kind === "conflict");
  assert.match(conflict.detail, /op-1/u);
  assert.match(conflict.detail, /Nothing was written/u);
});

test("a replay through the vault leaves the ledger byte for byte identical", async (t) => {
  const root = await seedVault([preference("target", { weight: 4, core: true })]);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledgerPath = join(root, PREFERENCE_LEDGER_RELATIVE_PATH);

  const applied = await runPreferenceOperation(root, {
    kind: "log",
    id: "target",
    signal: "validated",
    operationId: "op-replay",
  });
  assert.equal(applied.outcome.kind, "applied");
  assert.equal(applied.regenerated, true, "a core preference regenerates the rendered core");
  const afterApply = await readFile(ledgerPath, "utf8");

  const replay = await runPreferenceOperation(root, {
    kind: "log",
    id: "target",
    signal: "validated",
    operationId: "op-replay",
  });
  assert.equal(replay.outcome.kind, "replayed");
  assert.equal(replay.regenerated, false);
  assert.equal(await readFile(ledgerPath, "utf8"), afterApply);

  const conflict = await runPreferenceOperation(root, {
    kind: "log",
    id: "target",
    signal: "something else",
    operationId: "op-replay",
  });
  assert.equal(conflict.outcome.kind, "conflict");
  assert.equal(await readFile(ledgerPath, "utf8"), afterApply, "a conflict writes nothing");
});

test("concurrent processes each land their evidence under the preference lock", async (t) => {
  const root = await seedVault([preference("shared", { weight: 2 })]);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptPath = join(root, "logger.mjs");
  await writeFile(scriptPath, CHILD_LOG_SCRIPT, "utf8");

  const results = await Promise.all(
    [0, 1, 2, 3].map(async (index) => runChild(scriptPath, { root, index })),
  );
  for (const result of results) {
    assert.equal(result.code, 0, `child should have logged; stderr: ${result.stderr}`);
  }

  const ledger = await loadPreferenceLedger(root);
  const target = ledger.preferences.find((entry) => entry.id === "shared");
  assert.ok(target);
  assert.equal(
    target.evidence.length,
    4,
    "a lost update would leave fewer events than processes",
  );
  assert.deepEqual(
    readPreferenceOperations(ledger).map((record) => record.operation_id).sort(),
    ["op-0", "op-1", "op-2", "op-3"],
  );
  // Nothing holds the lock once every process is done.
  await assert.rejects(readFile(lockPathFor(root, PREFERENCE_LOCK_NAME), "utf8"));
});

test("a preference entering at weight 5 enters as law, not as an active one", async (t) => {
  const root = await seedVault([]);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await runPreferenceOperation(root, {
    kind: "add",
    id: "never-delete-silently",
    text: "Confirm before deleting anything.",
    weight: 5,
    operationId: "op-add-law",
  });

  assert.ok(result.preference);
  assert.equal(result.preference.status, "law");
});

test("a creation keeps the domains, the rationale, the how, the source, and the quote", () => {
  const next = addPreference(
    createPreferenceLedger([]),
    {
      id: "short-answers",
      text: "Answer in short structured blocks.",
      weight: 4,
      domains: ["writing", "review"],
      why: "Long prose buries the decision the reader came for.",
      apply: "Lead with the verdict, then at most three supporting lines.",
      source: "sync batch 2026-07-26-001",
      quote: "Just tell me the answer first.",
    },
    new Date("2026-07-26T00:00:00.000Z"),
  );

  const created = next.preferences[0];
  assert.ok(created);
  assert.deepEqual(created.domains, ["writing", "review"]);
  assert.equal(created.why, "Long prose buries the decision the reader came for.");
  assert.equal(created.apply, "Lead with the verdict, then at most three supporting lines.");
  assert.equal(created.source, "sync batch 2026-07-26-001");
  assert.deepEqual(created.evidence, [{
    date: "2026-07-26",
    weight_set: 4,
    signal: PREFERENCE_CREATION_SIGNAL,
    quote: "Just tell me the answer first.",
  }]);
  assert.equal(validatePreferenceLedger(next).valid, true);
});

test("a creation without the extra fields keeps the previous defaults exactly", () => {
  const next = addPreference(
    createPreferenceLedger([]),
    { id: "plain", text: "Stay concise.", weight: 4 },
    new Date("2026-07-26T00:00:00.000Z"),
  );

  const created = next.preferences[0];
  assert.ok(created);
  assert.deepEqual(created.domains, ["general"]);
  assert.equal(created.why, "Stay concise.");
  assert.equal(created.apply, "Stay concise.");
  assert.equal(created.source, undefined);
  assert.deepEqual(created.evidence, []);
});

test("an empty or malformed personalisation field is refused instead of silently dropped", () => {
  const base = createPreferenceLedger([]);
  const input = { id: "guarded", text: "Stay concise.", weight: 4 } as const;

  assert.throws(() => addPreference(base, { ...input, domains: [] }), /domains/u);
  assert.throws(() => addPreference(base, { ...input, domains: ["  "] }), /domains/u);
  assert.throws(() => addPreference(base, { ...input, why: "   " }), /why/u);
  assert.throws(() => addPreference(base, { ...input, apply: "" }), /apply/u);
  assert.throws(() => addPreference(base, { ...input, source: "" }), /source/u);
});

test("the personalisation survives the write, the reload, and the rendered core", async (t) => {
  const root = await seedVault([]);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await runPreferenceOperation(root, {
    kind: "add",
    id: "short-answers",
    text: "Answer in short structured blocks.",
    weight: 5,
    domains: ["writing", "review"],
    why: "Long prose buries the decision the reader came for.",
    apply: "Lead with the verdict, then at most three supporting lines.",
    source: "sync batch 2026-07-26-001",
    quote: "Just tell me the answer first.",
    operationId: "op-rich",
  }, { command: "sync validate" });
  assert.equal(result.outcome.kind, "applied");

  const reloaded = await loadPreferenceLedger(root);
  const stored = reloaded.preferences.find((entry) => entry.id === "short-answers");
  assert.ok(stored);
  assert.deepEqual(stored.domains, ["writing", "review"]);
  assert.equal(stored.why, "Long prose buries the decision the reader came for.");
  assert.equal(stored.apply, "Lead with the verdict, then at most three supporting lines.");
  assert.equal(stored.source, "sync batch 2026-07-26-001");
  assert.equal(stored.evidence[0]?.quote, "Just tell me the answer first.");

  const core = await readFile(join(root, PREFERENCE_CORE_RELATIVE_PATH), "utf8");
  assert.ok(core.includes("(writing, review)"), core);
  assert.ok(core.includes("_Why:_ Long prose buries the decision"), core);
  assert.ok(core.includes("_Apply:_ Lead with the verdict"), core);

  // Both writes went through the redline, so the kernel is still traceable.
  const report = await verifyRedline(root);
  assert.equal(report.tampered, false);
  assert.deepEqual(report.checks.map((check) => check.verdict).sort(), ["match", "match"]);
});

test("a replay of a rich creation is still a replay, and a changed field is a conflict", async (t) => {
  const root = await seedVault([]);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const input: PreferenceAddOperation = {
    kind: "add",
    id: "short-answers",
    text: "Answer in short structured blocks.",
    weight: 4,
    domains: ["writing", "review"],
    why: "Long prose buries the decision.",
    apply: "Verdict first.",
    source: "sync batch 001",
    quote: "Just tell me the answer first.",
    operationId: "op-rich",
  };

  assert.equal((await runPreferenceOperation(root, { ...input })).outcome.kind, "applied");
  const afterApply = await readFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "utf8");

  assert.equal((await runPreferenceOperation(root, { ...input })).outcome.kind, "replayed");
  assert.equal(await readFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "utf8"), afterApply);

  const conflict = await runPreferenceOperation(root, {
    ...input,
    domains: ["writing"],
  });
  assert.equal(conflict.outcome.kind, "conflict", "the domains are part of what was approved");
  assert.equal(await readFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), "utf8"), afterApply);
});

test("a ledger written before these fields existed loads, replays, and mutates without loss", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-prefs-legacy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });

  // Written by an earlier build: no source on the preference, and an operation
  // record whose frozen request predates domains, why, apply, and source.
  const legacy = {
    schema_version: PREFERENCE_LEDGER_SCHEMA_VERSION,
    preferences: [{
      id: "legacy-rule",
      weight: 4,
      status: "active",
      domains: ["general"],
      statement: "Stay concise.",
      why: "Stay concise.",
      apply: "Stay concise.",
      origin: "2026-07-01",
      last_seen: "2026-07-01",
      evidence: [],
    }],
    operations: [{
      operation_id: "op-legacy",
      applied_at: "2026-07-01T10:00:00.000Z",
      target_id: "legacy-rule",
      request: {
        schema: "open-brain-prefs-operation-request/v1",
        kind: "log",
        id: "legacy-rule",
        text: null,
        date: null,
        weight: null,
        signal: "validated",
        quote: null,
        status: null,
        core: null,
      },
    }],
  };
  await writeFile(
    join(root, PREFERENCE_LEDGER_RELATIVE_PATH),
    JSON.stringify(legacy, null, 2) + "\n",
    "utf8",
  );

  const loaded = await loadPreferenceLedger(root);
  assert.equal(validatePreferenceLedger(loaded).valid, true);
  assert.equal(readPreferenceOperations(loaded).length, 1);

  // An operation frozen before the new fields existed still replays cleanly.
  const replay = await runPreferenceOperation(root, {
    kind: "log",
    id: "legacy-rule",
    signal: "validated",
    operationId: "op-legacy",
  });
  assert.equal(replay.outcome.kind, "replayed");

  // And a new rich creation lands beside it without disturbing the old record.
  const added = await runPreferenceOperation(root, {
    kind: "add",
    id: "new-rule",
    text: "Lead with the verdict.",
    weight: 4,
    domains: ["writing"],
    why: "The reader wants the decision first.",
    apply: "Verdict, then evidence.",
    operationId: "op-new",
  });
  assert.equal(added.outcome.kind, "applied");

  const final = await loadPreferenceLedger(root);
  const legacyRule = final.preferences.find((entry) => entry.id === "legacy-rule");
  assert.ok(legacyRule);
  assert.deepEqual(legacyRule.domains, ["general"]);
  assert.equal(legacyRule.evidence.length, 0, "the replay added nothing");
  assert.deepEqual(
    readPreferenceOperations(final).map((record) => record.operation_id),
    ["op-legacy", "op-new"],
  );
});
