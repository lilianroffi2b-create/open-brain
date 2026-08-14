import assert from "node:assert/strict";
import { runCommand } from "citty";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { learnCommand } from "../src/cli/commands/learn.js";
import { loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import { computeMove } from "../src/learning/confidence.js";
import { buildDecision, writeEntry } from "../src/learning/journal.js";
import { addBelief, applyBeliefApplications, beliefsPath } from "../src/learning/store.js";
import { createBelief, type ApplicationCause, type Belief } from "../src/learning/types.js";

/**
 * The command surface of the learning layer. What is tested here is what a user
 * can and cannot make it do: read within a cap, see what the cap dropped, and
 * never write by accident, by typo, or by a flag that approves everything.
 */

interface Vault {
  root: string;
  config: VaultConfig;
}

async function vaultWith(prefix: string, capabilities: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), capabilities, "utf8");
  return { root, config: await loadConfig(root) };
}

async function capture(action: () => Promise<unknown>): Promise<string> {
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
  return captured;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected a JSON object");
  return value as Record<string, unknown>;
}

async function runText(rawArgs: string[]): Promise<string> {
  return await capture(() => runCommand(learnCommand, { rawArgs }));
}

async function runJson(rawArgs: string[]): Promise<Record<string, unknown>> {
  const raw = await runText(rawArgs);
  const start = raw.indexOf("{");
  assert.ok(start > -1, `expected JSON output, got: ${raw}`);
  return asRecord(JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1)) as unknown);
}

function belief(statement: string, domain: string, created: string): Belief {
  return createBelief({
    statement,
    domain,
    evidence: { occurrences: 1, refs: ["test:fixture"], quote: statement },
    now: created,
  });
}

async function move(
  vault: Vault,
  id: string,
  cause: ApplicationCause,
  ref: string,
  at: string,
): Promise<void> {
  const raw = await readFile(beliefsPath(vault.config, vault.root), "utf8");
  const parsed = JSON.parse(raw) as { beliefs: Belief[] };
  const target = parsed.beliefs.find((candidate) => candidate.id === id);
  assert.ok(target, `fixture belief ${id} must exist`);
  await applyBeliefApplications(
    vault.config,
    vault.root,
    [{ belief_id: id, cause, ref, confidence: computeMove(target, cause, at).to, at }],
    { now: at },
  );
}

async function populatedVault(prefix: string): Promise<Vault> {
  const vault = await vaultWith(
    prefix,
    "capabilities:\n  learning:\n    enabled: true\n    evaluate: true\n",
  );
  const { config, root } = vault;
  await addBelief(config, root, belief(
    "Load a bounded context and report its token cost.",
    "agentic coding",
    "2026-07-01T09:00:00Z",
  ));
  await addBelief(config, root, belief(
    "Answer in short sentences and skip the preamble.",
    "writing",
    "2026-07-02T09:00:00Z",
  ));
  // Retracted then engraved by hand, so a date between the two is a state the
  // way back can actually express: it is the only shape a revert can restore.
  await move(
    vault,
    "b_load_a_bounded_context_and_report_its_token",
    "human_retract",
    "human:retract",
    "2026-07-10T09:00:00Z",
  );
  await move(
    vault,
    "b_load_a_bounded_context_and_report_its_token",
    "human_engrave",
    "human:engrave",
    "2026-07-20T09:00:00Z",
  );
  await move(
    vault,
    "b_answer_in_short_sentences_and_skip_the",
    "application_confirmed",
    "dec_20260722T0900_bbbb2222",
    "2026-07-22T09:00:00Z",
  );
  await writeEntry(config, root, buildDecision({
    id: "dec_20260722T0900_bbbb2222",
    ts: "2026-07-22T09:00:00Z",
    session: "s1",
    type: "route",
    input: { summary: "route a request about agentic coding" },
    choice: "agentic coding",
  }));
  await writeEntry(config, root, buildDecision({
    id: "dec_20260723T1000_dddd4444",
    ts: "2026-07-23T10:00:00Z",
    session: "s2",
    type: "route",
    input: { summary: "route a request about writing" },
    choice: "writing",
  }));
  return vault;
}

test("status names what is armed, what is built and what is absent", async (t) => {
  const vault = await vaultWith("open-brain-learn-status-", "capabilities: {}\n");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const status = await runJson(["status", "--root", vault.root]);
  assert.equal(status.layer_inactive, true);
  assert.equal(status.belief_store_present, false);
  assert.equal(status.organs_absent, 4);
  assert.ok(Array.isArray(status.rules_disarmed));
  const budget = asRecord(status.budget);
  assert.ok(Number(budget.chars) > 0);
  assert.ok(Number(budget.token_estimate) > 0);
});

test("an unknown flag is refused, and nothing is read or written", async (t) => {
  const vault = await populatedVault("open-brain-learn-unknown-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  await assert.rejects(
    async () => runText(["mirror", "--root", vault.root, "--max-char", "900"]),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Unknown flag --max-char/u);
      assert.match(error.message, /Nothing was read and nothing was written/u);
      return true;
    },
  );

  await assert.rejects(
    async () => runText(["beliefs", "--root", vault.root, "b_something"]),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /takes no positional argument/u);
      return true;
    },
  );
});

test("mirror renders for a human by default and structured on demand", async (t) => {
  const vault = await populatedVault("open-brain-learn-mirror-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const human = await runText(["mirror", "--root", vault.root]);
  assert.match(human, /Open Brain, the learning mirror/u);
  assert.match(human, /6\. What I cannot do yet/u);
  assert.match(human, /What this mirror cost you/u);

  const structured = await runJson(["mirror", "--root", vault.root, "--json"]);
  assert.equal(structured.learning_enabled, true);
  assert.ok(Array.isArray(structured.sections));
  assert.equal((structured.sections as unknown[]).length, 6);

  // One number to turn, and it really bites.
  const squeezed = await runJson([
    "mirror",
    "--root",
    vault.root,
    "--json",
    "--max-chars",
    "1200",
  ]);
  const wide = asRecord(structured.budget);
  const tight = asRecord(squeezed.budget);
  assert.ok(Number(tight.chars) < Number(wide.chars));
  assert.equal(tight.truncated, true);
});

test("journal and beliefs cap their listing and report what it cost", async (t) => {
  const vault = await populatedVault("open-brain-learn-reads-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const journal = await runJson(["journal", "--root", vault.root, "--limit", "1"]);
  assert.equal((journal.entries as unknown[]).length, 1);
  const journalBudget = asRecord(journal.budget);
  assert.equal(journalBudget.items_shown, 1);
  assert.ok(Number(journalBudget.token_estimate) > 0);

  const capped = await runJson([
    "journal",
    "--root",
    vault.root,
    "--limit",
    "10",
    "--max-chars",
    "500",
  ]);
  const cappedBudget = asRecord(capped.budget);
  assert.equal(cappedBudget.truncated, true);
  assert.match(String(capped.next), /Raise --limit or --max-chars/u);

  const beliefs = await runJson(["beliefs", "--root", vault.root]);
  assert.equal((beliefs.beliefs as unknown[]).length, 2);
  assert.equal(beliefs.total, 2);

  const one = await runJson([
    "beliefs",
    "--root",
    vault.root,
    "--id",
    "b_answer_in_short_sentences_and_skip_the",
  ]);
  const summary = asRecord(one.belief);
  assert.equal(summary.confidence, 4);
  assert.equal(summary.locked, false);
  assert.equal(one.history_total, 2);
});

test("a read never writes: the vault is untouched by status, mirror, journal and beliefs", async (t) => {
  const vault = await populatedVault("open-brain-learn-readonly-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const path = beliefsPath(vault.config, vault.root);
  const before = { bytes: await readFile(path), mtime: (await stat(path)).mtimeMs };

  await runText(["status", "--root", vault.root]);
  await runText(["mirror", "--root", vault.root]);
  await runText(["journal", "--root", vault.root]);
  await runText(["beliefs", "--root", vault.root]);
  await runText(["sensors", "--root", vault.root]);
  await runText(["rollback", "--root", vault.root, "--date", "2026-07-21T09:00:00Z"]);

  const after = { bytes: await readFile(path), mtime: (await stat(path)).mtimeMs };
  assert.equal(after.bytes.equals(before.bytes), true, "no read may rewrite the belief store");
  assert.equal(after.mtime, before.mtime);
});

test("rollback plans first, and applying it demands its own confirmation", async (t) => {
  const vault = await populatedVault("open-brain-learn-rollback-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const plan = await runJson([
    "rollback",
    "--root",
    vault.root,
    "--date",
    "2026-07-15T09:00:00Z",
  ]);
  assert.equal(plan.written, false);
  const entries = asRecord(plan.plan).entries as unknown[];
  assert.ok(entries.length >= 1, "the plan must say what would move");
  assert.match(String(plan.next), /--apply --confirm 2026-07-15T09:00:00Z/u);

  // --apply alone is not enough, and no global --yes exists to grant it.
  await assert.rejects(
    async () => runText([
      "rollback",
      "--root",
      vault.root,
      "--date",
      "2026-07-15T09:00:00Z",
      "--apply",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /--confirm 2026-07-15T09:00:00Z/u);
      assert.match(error.message, /A global --yes never grants it/u);
      return true;
    },
  );

  // A malformed date is refused before anything is read.
  await assert.rejects(
    async () => runText(["rollback", "--root", vault.root, "--date", "yesterday"]),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /YYYY-MM-DDTHH:MM:SSZ/u);
      return true;
    },
  );

  const applied = await runJson([
    "rollback",
    "--root",
    vault.root,
    "--date",
    "2026-07-15T09:00:00Z",
    "--apply",
    "--confirm",
    "2026-07-15T09:00:00Z",
  ]);
  assert.equal(applied.written, true);
});

test("consolidate refuses without its own capability and names what would arm it", async (t) => {
  const vault = await populatedVault("open-brain-learn-consolidate-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  await assert.rejects(
    async () => runText([
      "consolidate",
      "--root",
      vault.root,
      "--document",
      "10_memory/_state.md",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /learning\.consolidate is disabled/u);
      assert.match(error.message, /capabilities enable learning\.consolidate/u);
      return true;
    },
  );
});

test("consolidate shows the state of its safety catch before it agrees to act", async (t) => {
  const vault = await vaultWith(
    "open-brain-learn-consolidate-armed-",
    "capabilities:\n  learning:\n    enabled: true\n    consolidate: true\n",
  );
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const document = "10_memory/_state.md";
  await mkdir(join(vault.root, "10_memory"), { recursive: true });
  await writeFile(
    join(vault.root, document),
    [
      "---",
      "lifecycle: working",
      "load_max: 400",
      "load_policy: dated_rotation",
      "load_archive: 90_archive/consolidation/",
      "load_boundary: '^## '",
      "---",
      "",
      "# Living state",
      "",
      "## 2026-07-20 first",
      "",
      "Something that happened.",
      "",
      "## 2026-07-21 second",
      "",
      "Something else that happened.",
      "",
    ].join("\n"),
    "utf8",
  );

  const before = await readFile(join(vault.root, document), "utf8");
  const preflight = await runJson([
    "consolidate",
    "--root",
    vault.root,
    "--document",
    document,
  ]);

  assert.equal(preflight.written, false);
  const proof = asRecord(preflight.reversibility);
  assert.equal(proof.ok, true, "the byte exact way back must be proven before acting");
  assert.ok(Array.isArray(proof.cases));
  assert.ok((proof.cases as unknown[]).length > 0);
  assert.equal(preflight.pending_transaction, null);
  assert.match(String(preflight.next), /--confirm 10_memory\/_state\.md/u);
  assert.match(String(preflight.next), /A global --yes never grants it/u);

  const after = await readFile(join(vault.root, document), "utf8");
  assert.equal(after, before, "a preflight never touches the document it describes");
});

test("sensors lists what is built, what is declared unbuilt, and caps its reading", async (t) => {
  const vault = await populatedVault("open-brain-learn-sensors-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const sensors = await runJson(["sensors", "--root", vault.root]);
  const built = sensors.sensors_built as Array<Record<string, unknown>>;
  assert.equal(built.length, 1);
  assert.equal(built[0]?.name, "circulation");
  assert.match(String(built[0]?.caveat), /floor, never a total/u);
  assert.deepEqual(sensors.sensors_declared_unbuilt, []);
  assert.deepEqual(sensors.observations, []);
  assert.equal(asRecord(sensors.budget).items_total, 0);
});

test("evaluate refuses while its own capability is disarmed", async (t) => {
  const vault = await vaultWith(
    "open-brain-learn-evaluate-",
    "capabilities:\n  learning:\n    enabled: true\n",
  );
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  await assert.rejects(
    async () => runText(["evaluate", "--root", vault.root]),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /learning\.evaluate is disabled/u);
      return true;
    },
  );

  // Reading the verdicts already on record needs only the parent capability.
  const shown = await runJson(["evaluate", "--root", vault.root, "--show"]);
  assert.deepEqual(shown.verdicts, []);
  assert.equal(asRecord(shown.budget).items_total, 0);
});
