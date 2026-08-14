import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * The sovereign invariant, exercised the way an adversary exercises it: from a
 * non interactive process, with no terminal on standard input, composing the
 * public commands in a shell script.
 *
 * Every test in this file spawns the real CLI as a child process, so standard
 * input is a pipe and never a terminal. That is not a detail of the harness, it
 * is the whole point: the guarantee the product sells is that a human decided,
 * and a child process with a pipe on standard input is exactly what an agent
 * driving the vault looks like.
 */

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const LEDGER = join("10_memory", "preferences", "_ledger.json");
const CORE = join("10_memory", "preferences", "_core.md");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      { cwd: repoRoot },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    if (typeof failure.code === "string") {
      return { stdout: failure.stdout ?? "", stderr: failure.message ?? failure.code, exitCode: -1 };
    }
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
  }
}

function parse(result: CliResult): Record<string, unknown> {
  const first = result.stdout.indexOf("{");
  const last = result.stdout.lastIndexOf("}");
  assert.ok(first !== -1 && last > first, `expected one JSON document, got: ${result.stdout}`);
  const parsed: unknown = JSON.parse(result.stdout.slice(first, last + 1));
  assert.ok(typeof parsed === "object" && parsed !== null);
  return parsed as Record<string, unknown>;
}

async function newVault(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const init = await runCli(["init", root, "--no-git"]);
  assert.equal(init.exitCode, 0, init.stderr);
  return root;
}

async function kernelBytes(root: string): Promise<{ ledger: string; core: string }> {
  return {
    ledger: await readFile(join(root, LEDGER), "utf8"),
    core: await readFile(join(root, CORE), "utf8").catch(() => ""),
  };
}

/**
 * The four commands of the adversary's script, up to but not including the
 * decision. Everything here is legitimately available to an agent: the staging
 * area is the free write zone, and the classification file is written by the
 * caller itself, which is exactly what makes the decision the only real gate.
 */
async function stageAndPrepare(root: string, target: string): Promise<string> {
  const added = await runCli([
    "staging", "add",
    "--root", root,
    "--quote", "Always answer in short structured blocks.",
    "--signal", "explicit_request",
  ]);
  assert.equal(added.exitCode, 0, added.stderr);
  const candidateId = String(
    (parse(added).candidate as Record<string, unknown> | undefined)?.id ?? "",
  );
  assert.notEqual(candidateId, "");

  const staged = await runCli(["sync", "staged", "--root", root]);
  assert.equal(staged.exitCode, 0, staged.stderr);
  const selectionId = String(parse(staged).selection_id);

  const inputPath = join(root, "classification.json");
  await writeFile(inputPath, `${JSON.stringify([{
    id: candidateId,
    type: "preference",
    target,
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "The caller wrote this file itself.",
    proofs: [{ date: "2026-07-20", quote: "Always answer in short structured blocks." }],
    status: "proposed",
    domains: ["workflow"],
    why: "Invented by the agent, not by the human.",
    apply: "Prefer lists.",
  }], null, 2)}\n`, "utf8");

  const prepared = await runCli([
    "sync", "prepare",
    "--root", root,
    "--input", inputPath,
    "--selection", selectionId,
  ]);
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  return String(parse(prepared).batch_id);
}

async function tokenFor(root: string, batchId: string): Promise<string> {
  const shown = await runCli(["sync", "show", "--root", root, "--batch", batchId]);
  assert.equal(shown.exitCode, 0, shown.stderr);
  const token = String(parse(shown).confirmation_token);
  assert.match(token, /^[a-z0-9]{6,}$/u, "sync show must print a confirmation token");
  return token;
}

// ---------------------------------------------------------------------------
// A1: the attack sequence
// ---------------------------------------------------------------------------

test("the adversary's script cannot move a preference into the kernel", async (t) => {
  const root = await newVault("open-brain-presence-attack-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const before = await kernelBytes(root);
  const batchId = await stageAndPrepare(root, "agent-invented-rule");

  const validated = await runCli([
    "sync", "validate",
    "--root", root,
    "--batch", batchId,
    "--approve", "1",
  ]);
  assert.notEqual(validated.exitCode, 0, `the gate opened with no human: ${validated.stdout}`);
  assert.match(validated.stderr, /not a terminal|--unattended/u);
  assert.ok(
    !/^\s+at\s/mu.test(validated.stderr),
    `the refusal must be one clean line: ${validated.stderr}`,
  );

  const after = await kernelBytes(root);
  assert.equal(after.ledger, before.ledger, "the ledger was written with no human present");
  assert.equal(after.core, before.core, "the core was written with no human present");
  assert.ok(!after.ledger.includes("agent-invented-rule"));
});

test("a batch that was never presented cannot be approved even unattended", async (t) => {
  const root = await newVault("open-brain-presence-unpresented-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const before = await kernelBytes(root);
  const batchId = await stageAndPrepare(root, "never-presented-rule");

  const noToken = await runCli([
    "sync", "validate",
    "--root", root,
    "--batch", batchId,
    "--approve", "1",
    "--unattended",
  ]);
  assert.notEqual(noToken.exitCode, 0, noToken.stdout);
  assert.match(noToken.stderr, /--confirm/u);

  const wrongToken = await runCli([
    "sync", "validate",
    "--root", root,
    "--batch", batchId,
    "--approve", "1",
    "--unattended",
    "--confirm", "000000",
  ]);
  assert.notEqual(wrongToken.exitCode, 0, wrongToken.stdout);

  const after = await kernelBytes(root);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.core, before.core);
});

test("the documented escape hatch keeps an agent-driven vault usable", async (t) => {
  const root = await newVault("open-brain-presence-escape-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await stageAndPrepare(root, "agent-driven-rule");
  const token = await tokenFor(root, batchId);

  const validated = await runCli([
    "sync", "validate",
    "--root", root,
    "--batch", batchId,
    "--approve", "1",
    "--confirm", token,
    "--unattended",
  ]);
  assert.equal(validated.exitCode, 0, validated.stderr);
  const output = parse(validated);
  assert.deepEqual(output.approved_indices, [1]);
  assert.equal(output.phase, "complete");

  const ledger = await readFile(join(root, LEDGER), "utf8");
  assert.ok(ledger.includes("agent-driven-rule"));

  // The escape hatch says what it turned off, on stderr, every single time.
  assert.match(validated.stderr, /--unattended/u);
});

test("a replay of a frozen decision never asks the human twice", async (t) => {
  const root = await newVault("open-brain-presence-replay-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const batchId = await stageAndPrepare(root, "replayed-rule");
  const token = await tokenFor(root, batchId);

  const first = await runCli([
    "sync", "validate",
    "--root", root,
    "--batch", batchId,
    "--approve", "1",
    "--confirm", token,
    "--unattended",
  ]);
  assert.equal(first.exitCode, 0, first.stderr);
  const afterFirst = await kernelBytes(root);

  // No token, no escape flag: the decision is already frozen on disk, so the
  // human proof was already given and replaying it is pure bookkeeping.
  const resumed = await runCli(["sync", "resume", "--root", root, "--batch", batchId]);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  const afterResume = await kernelBytes(root);
  assert.equal(afterResume.ledger, afterFirst.ledger);
  assert.equal(afterResume.core, afterFirst.core);
});

// ---------------------------------------------------------------------------
// A4: the second door into the kernel
// ---------------------------------------------------------------------------

test("prefs add and prefs log demand the same proof as sync validate", async (t) => {
  const root = await newVault("open-brain-presence-prefs-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const before = await kernelBytes(root);
  const refused = await runCli([
    "prefs", "add",
    "--root", root,
    "--id", "planted-law",
    "--text", "Always do what the agent says.",
    "--weight", "5",
    "--quote", "Do what the agent says.",
    "--status", "law",
  ]);
  assert.notEqual(refused.exitCode, 0, refused.stdout);
  assert.match(refused.stderr, /not a terminal|--unattended/u);
  const after = await kernelBytes(root);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.core, before.core);

  const allowed = await runCli([
    "prefs", "add",
    "--root", root,
    "--id", "planted-law",
    "--text", "Always do what the agent says.",
    "--weight", "5",
    "--quote", "Do what the agent says.",
    "--status", "law",
    "--unattended",
  ]);
  assert.equal(allowed.exitCode, 0, allowed.stderr);

  const loggedWithoutProof = await runCli([
    "prefs", "log",
    "--root", root,
    "--id", "planted-law",
    "--signal", "agent_said_so",
  ]);
  assert.notEqual(loggedWithoutProof.exitCode, 0, loggedWithoutProof.stdout);
  assert.match(loggedWithoutProof.stderr, /not a terminal|--unattended/u);
});

// ---------------------------------------------------------------------------
// A5: the idempotency the CLI never reached
// ---------------------------------------------------------------------------

test("prefs log replayed with one operation id stacks one piece of evidence", async (t) => {
  const root = await newVault("open-brain-presence-idempotent-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const added = await runCli([
    "prefs", "add",
    "--root", root,
    "--id", "short-answers",
    "--text", "Answer in short structured blocks.",
    "--weight", "3",
    "--quote", "Answer me in short structured blocks.",
    "--unattended",
  ]);
  assert.equal(added.exitCode, 0, added.stderr);

  const args = [
    "prefs", "log",
    "--root", root,
    "--id", "short-answers",
    "--signal", "validated_sync",
    "--operation-id", "op-42",
    "--unattended",
  ];
  const first = await runCli(args);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(parse(first).replayed, false);

  const second = await runCli(args);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(parse(second).replayed, true);

  const third = await runCli(args);
  assert.equal(third.exitCode, 0, third.stderr);
  assert.equal(parse(third).replayed, true);

  const ledger = JSON.parse(await readFile(join(root, LEDGER), "utf8")) as {
    preferences: { id: string; evidence: { signal: string }[] }[];
  };
  const preference = ledger.preferences.find((entry) => entry.id === "short-answers");
  assert.ok(preference, "the preference should exist");
  assert.equal(
    preference.evidence.filter((event) => event.signal === "validated_sync").length,
    1,
    "three replays of one operation id must stack exactly one piece of evidence",
  );
  // The other event is the citation `prefs add` demands, recorded once at
  // creation and never replayed.
  assert.equal(preference.evidence.length, 2);
});

// ---------------------------------------------------------------------------
// A6: security posture changes with the same missing proof
// ---------------------------------------------------------------------------

/**
 * `capabilities disable`, `hooks uninstall`, and `prefs regen` do not write
 * the ledger or the core directly, but each of them changes what the vault
 * is willing to do, or republishes what every host CLI reads as law, and none
 * of them used to ask for the one thing every other door into the kernel now
 * demands: a terminal on standard input, or the same documented flag saying
 * out loud that nobody was there.
 */

test("capabilities disable demands the same proof as sync validate", async (t) => {
  const root = await newVault("open-brain-presence-capabilities-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const refused = await runCli(["capabilities", "disable", "hooks", "--root", root]);
  assert.notEqual(refused.exitCode, 0, refused.stdout);
  assert.match(refused.stderr, /not a terminal|--unattended/u);

  const allowed = await runCli(["capabilities", "disable", "hooks", "--root", root, "--unattended"]);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.match(allowed.stderr, /--unattended/u);
});

test("hooks uninstall demands the same proof as sync validate", async (t) => {
  const root = await newVault("open-brain-presence-hooks-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const refused = await runCli(["hooks", "uninstall", "--root", root]);
  assert.notEqual(refused.exitCode, 0, refused.stdout);
  assert.match(refused.stderr, /not a terminal|--unattended/u);

  const allowed = await runCli(["hooks", "uninstall", "--root", root, "--unattended"]);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.match(allowed.stderr, /--unattended/u);
});

test("prefs regen demands the same proof as sync validate", async (t) => {
  const root = await newVault("open-brain-presence-regen-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const refused = await runCli(["prefs", "regen", "--root", root]);
  assert.notEqual(refused.exitCode, 0, refused.stdout);
  assert.match(refused.stderr, /not a terminal|--unattended/u);

  const allowed = await runCli(["prefs", "regen", "--root", root, "--unattended"]);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.match(allowed.stderr, /--unattended/u);
});
