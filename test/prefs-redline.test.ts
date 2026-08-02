import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPreferenceLedger,
  loadPreferenceLedger,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  readRedlineJournal,
  readRedlineState,
  REDLINE_JOURNAL_RELATIVE_PATH,
  REDLINE_STATE_RELATIVE_PATH,
  runPreferenceOperation,
  savePreferenceLedger,
  verifyRedline,
  writePreferenceCore,
  writeThroughRedline,
  type Preference,
} from "../src/prefs/index.js";

function preference(id: string, overrides: Partial<Preference> = {}): Preference {
  return {
    id,
    weight: 4,
    status: "active",
    domains: ["workflow"],
    statement: `Use ${id}.`,
    why: "Synthetic test preference.",
    apply: `Apply ${id}.`,
    origin: "2026-07-01",
    last_seen: "2026-07-01",
    evidence: [],
    ...overrides,
  };
}

async function seedVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-redline-"));
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  const ledger = createPreferenceLedger([preference("first-rule")]);
  await savePreferenceLedger(root, ledger, { command: "test seed" });
  await writePreferenceCore(root, ledger, { command: "test seed" });
  return root;
}

test("a write through a known path is accepted, recorded, and verifies clean", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const state = await readRedlineState(root);
  assert.equal(state.targets.ledger?.command, "test seed");
  assert.equal(state.targets.ledger?.validation, "assertValidPreferenceLedger");
  assert.equal(state.targets.core?.validation, "renderPreferenceCore");

  const report = await verifyRedline(root);
  assert.equal(report.tampered, false);
  assert.deepEqual(
    report.checks.map((check) => check.verdict).sort(),
    ["match", "match"],
  );
  for (const check of report.checks) {
    assert.ok(!check.detail.toLowerCase().includes("impossible"));
  }
});

test("a change made outside the recorded write paths is detected", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  // Exactly what a hookless CLI cannot prevent: a direct edit of the kernel.
  const ledgerPath = join(root, PREFERENCE_LEDGER_RELATIVE_PATH);
  const tampered = JSON.parse(await readFile(ledgerPath, "utf8")) as {
    preferences: Preference[];
  };
  const first = tampered.preferences[0];
  assert.ok(first);
  first.statement = "Injected without review.";
  await writeFile(ledgerPath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

  const report = await verifyRedline(root);
  assert.equal(report.tampered, true);
  const ledgerCheck = report.checks.find((check) => check.target === "ledger");
  assert.ok(ledgerCheck);
  assert.equal(ledgerCheck.verdict, "modified");
  assert.match(ledgerCheck.detail, /detected, not prevented/u);
  assert.notEqual(ledgerCheck.actual_sha256, ledgerCheck.expected_sha256);

  const coreCheck = report.checks.find((check) => check.target === "core");
  assert.ok(coreCheck);
  assert.equal(coreCheck.verdict, "match", "an untouched target must not be a false positive");
});

test("a deleted kernel file is detected rather than reported as clean", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await unlink(join(root, PREFERENCE_CORE_RELATIVE_PATH));

  const report = await verifyRedline(root);
  assert.equal(report.tampered, true);
  assert.equal(report.checks.find((check) => check.target === "core")?.verdict, "missing");
});

/** The tamper every one of the next tests performs, on the ledger alone. */
async function tamperLedger(root: string): Promise<void> {
  const path = join(root, PREFERENCE_LEDGER_RELATIVE_PATH);
  const ledger = JSON.parse(await readFile(path, "utf8")) as { preferences: Preference[] };
  const first = ledger.preferences[0];
  assert.ok(first);
  first.statement = "Injected without review.";
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

test("deleting the record next to the kernel does not hide a change to it", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await tamperLedger(root);
  await unlink(join(root, REDLINE_STATE_RELATIVE_PATH));

  const report = await verifyRedline(root);
  assert.equal(report.tampered, true, "the journal still holds the hash of the last real write");
  const ledgerCheck = report.checks.find((check) => check.target === "ledger");
  assert.equal(ledgerCheck?.verdict, "modified");
  assert.equal(ledgerCheck?.source, "journal");
  assert.match(String(ledgerCheck?.detail), /provenance journal/u);
  assert.equal(report.checks.find((check) => check.target === "core")?.verdict, "match");
});

test("a record corrupted, truncated or emptied is not a record that says nothing", async (t) => {
  for (const [label, content] of [
    ["one byte of corruption", "{oops"],
    ["an empty file", ""],
    ["an empty object", "{}"],
    ["an array", "[]"],
  ] as const) {
    const root = await seedVault();
    t.after(async () => rm(root, { recursive: true, force: true }));

    await tamperLedger(root);
    await writeFile(join(root, REDLINE_STATE_RELATIVE_PATH), content, "utf8");

    const report = await verifyRedline(root);
    assert.equal(report.tampered, true, `${label} must not turn a modified kernel into a clean one`);
    assert.equal(report.checks.find((check) => check.target === "ledger")?.source, "journal");
  }
});

test("a kernel nothing has recorded is unverifiable, which is not the same as clean", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-redline-fresh-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });

  // Exactly what a vault seeded from templates looks like before its first
  // recorded write: a ledger on disk that no write path here has ever seen.
  await writeFile(
    join(root, PREFERENCE_LEDGER_RELATIVE_PATH),
    `${JSON.stringify(createPreferenceLedger([preference("seeded-rule")]), null, 2)}\n`,
    "utf8",
  );

  const report = await verifyRedline(root);
  assert.equal(report.tampered, false, "an absent record is not evidence of tampering");
  assert.equal(report.unverified, true, "and it is not evidence of anything else either");
  const ledgerCheck = report.checks.find((check) => check.target === "ledger");
  assert.equal(ledgerCheck?.verdict, "unverifiable");
  assert.match(String(ledgerCheck?.detail), /absence of evidence, not a clean result/u);

  // The core is not there at all, which is a third thing again.
  const coreCheck = report.checks.find((check) => check.target === "core");
  assert.equal(coreCheck?.verdict, "unrecorded");
  assert.equal(report.unverified, true);
});

test("the first recorded write is what turns unverifiable into verified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-redline-seeded-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  const ledger = createPreferenceLedger([preference("seeded-rule")]);
  await writeFile(
    join(root, PREFERENCE_LEDGER_RELATIVE_PATH),
    `${JSON.stringify(ledger, null, 2)}\n`,
    "utf8",
  );
  assert.equal((await verifyRedline(root)).unverified, true);

  await savePreferenceLedger(root, ledger, { command: "test seed" });
  await writePreferenceCore(root, ledger, { command: "test seed" });

  const report = await verifyRedline(root);
  assert.equal(report.unverified, false);
  assert.deepEqual(report.checks.map((check) => check.verdict).sort(), ["match", "match"]);
});

test("a write rebuilds a comparison point that could not be read", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, REDLINE_STATE_RELATIVE_PATH), "{oops", "utf8");
  await runPreferenceOperation(root, {
    kind: "log",
    id: "first-rule",
    signal: "after-the-corruption",
    operationId: "op-after",
  });

  // Writing the ledger must not be what makes the core unverifiable.
  const state = await readRedlineState(root);
  assert.equal(state.status, "loaded");
  assert.ok(state.targets.core, "the other target came back from the journal");
  const report = await verifyRedline(root);
  assert.equal(report.tampered, false);
  assert.equal(report.unverified, false);
  assert.deepEqual(report.checks.map((check) => check.source), ["state", "state"]);
});

test("consecutive legitimate writes never produce a false positive", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 5; index += 1) {
    const outcome = await runPreferenceOperation(root, {
      kind: "log",
      id: "first-rule",
      signal: `round-${String(index)}`,
      operationId: `op-${String(index)}`,
    });
    assert.equal(outcome.outcome.kind, "applied");
    const report = await verifyRedline(root);
    assert.equal(report.tampered, false, `round ${String(index)} must verify clean`);
  }

  const ledger = await loadPreferenceLedger(root);
  assert.equal(ledger.preferences[0]?.evidence.length, 5);
});

test("the provenance journal never loses an entry", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const seeded = await readRedlineJournal(root);
  assert.equal(seeded.total, 2, "the seed wrote the ledger and the core");

  const writes = 25;
  await Promise.all(
    Array.from({ length: writes }, async (_, index) =>
      writeThroughRedline(root, {
        target: "core",
        relativePath: PREFERENCE_CORE_RELATIVE_PATH,
        content: `# Core ${String(index)}\n`,
        command: "test parallel",
        validation: "none",
        operationId: `op-${String(index)}`,
      })),
  );

  const journal = await readRedlineJournal(root);
  assert.equal(journal.total, seeded.total + writes);
  assert.equal(journal.unreadable, 0);
  const recordedIds = new Set(
    journal.entries
      .map((entry) => entry.operation_id)
      .filter((id): id is string => id !== undefined),
  );
  assert.equal(recordedIds.size, writes, "every concurrent write kept its own line");

  const bounded = await readRedlineJournal(root, { limit: 5 });
  assert.equal(bounded.entries.length, 5);
  assert.equal(bounded.total, journal.total);
  assert.equal(bounded.truncated, true, "a bounded read says that it is bounded");
});

test("the integrity record lives outside the indexed vault", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const relativePath of [REDLINE_STATE_RELATIVE_PATH, REDLINE_JOURNAL_RELATIVE_PATH]) {
    assert.ok(
      relativePath.startsWith(".open-brain"),
      `${relativePath} must sit under the excluded, gitignored local directory`,
    );
    await readFile(join(root, relativePath), "utf8");
  }
});
