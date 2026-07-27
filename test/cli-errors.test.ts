import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// The gitignored bundle is built once by scripts/run-tests.mjs before the
// parallel test processes start; building here would race other test files
// that spawn the same bundle.
const builtCli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runBuiltCli(args: string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [builtCli, ...args],
      { cwd },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

test("bare invocation renders full usage with a help pointer and exits 1", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-bare-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const result = await runBuiltCli([], outside);

  assert.equal(result.exitCode, 1);
  assert.ok(result.stdout.includes("USAGE"), `stdout should render usage; stdout: ${result.stdout}`);
  assert.ok(result.stdout.includes("COMMANDS"), `stdout should list commands; stdout: ${result.stdout}`);
  assert.ok(
    result.stdout.includes("for more information about a command."),
    `stdout should point to per-command help; stdout: ${result.stdout}`,
  );
  const message = "No command specified";
  const occurrences = (result.stdout + result.stderr).split(message).length - 1;
  assert.equal(occurrences, 1, `message should appear exactly once; stderr: ${result.stderr}`);
  assert.ok(!/^\s+at\s/mu.test(result.stderr), `stderr should not include stack frames; stderr: ${result.stderr}`);
});

test("unknown command renders full usage with a help pointer and exits 1", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-unknown-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const result = await runBuiltCli(["bogus"], outside);

  assert.equal(result.exitCode, 1);
  assert.ok(result.stdout.includes("USAGE"), `stdout should render usage; stdout: ${result.stdout}`);
  assert.ok(
    result.stdout.includes("for more information about a command."),
    `stdout should point to per-command help; stdout: ${result.stdout}`,
  );
  const message = "Unknown command";
  const occurrences = (result.stdout + result.stderr).split(message).length - 1;
  assert.equal(occurrences, 1, `message should appear exactly once; stderr: ${result.stderr}`);
  assert.ok(!/^\s+at\s/mu.test(result.stderr), `stderr should not include stack frames; stderr: ${result.stderr}`);
});

test("expected errors print a single clean line without stack frames", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-no-vault-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  assert.equal(await pathExists(builtCli), true, "built CLI bundle should exist");

  const result = await runBuiltCli(["scan"], outside);

  assert.equal(result.exitCode, 1);
  const message = "No OpenBrain vault was found";
  const occurrences = result.stderr.split(message).length - 1;
  assert.equal(occurrences, 1, `message should appear exactly once; stderr: ${result.stderr}`);
  assert.ok(!result.stderr.includes("bin/cli.js:"), `stderr should not include bundle stack frames; stderr: ${result.stderr}`);
  assert.ok(!/^\s+at\s/mu.test(result.stderr), `stderr should not include stack frames; stderr: ${result.stderr}`);
});

/**
 * Twelve error paths were found to leak a raw Node stack trace instead of the
 * clean single-line refusal every other command gives. Seven of them were
 * fixable from this lot's file perimeter (the throw sites lived in
 * src/prefs/ledger.ts, src/prefs/validation.ts, src/core/gc.ts, or the numeric
 * flag parsing of src/cli/commands/learn.ts). The remaining five threw from
 * src/cli/vault.ts and src/cli/main.ts (`gc`'s JSON reading and `skin`'s name
 * check); they are now covered below.
 */
function assertCleanRefusal(result: CliResult, context: string): void {
  assert.equal(result.exitCode, 1, `${context} should exit 1; stdout: ${result.stdout}`);
  assert.ok(
    !result.stderr.includes("bin/cli.js:"),
    `${context} should not include a bundle stack frame; stderr: ${result.stderr}`,
  );
  assert.ok(
    !/^\s+at\s/mu.test(result.stderr),
    `${context} should not include a stack trace; stderr: ${result.stderr}`,
  );
  assert.ok(
    !/^(TypeError|RangeError|Error):/mu.test(result.stderr),
    `${context} should not print a raw JS error name; stderr: ${result.stderr}`,
  );
}

test("twelve former stack traces: the seven fixable from this lot's perimeter are now clean refusals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-clean-errors-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const init = await runBuiltCli(["init", root, "--no-git"], root);
  assert.equal(init.exitCode, 0, `init should succeed; stderr: ${init.stderr}`);
  const scan = await runBuiltCli(["scan", "--root", root], root);
  assert.equal(scan.exitCode, 0, `scan should succeed; stderr: ${scan.stderr}`);

  // prefs add --id malformed
  const badId = await runBuiltCli(
    ["prefs", "add", "--id", "Not Valid ID!", "--text", "x", "--weight", "3", "--root", root, "--unattended"],
    root,
  );
  assertCleanRefusal(badId, "prefs add with a malformed id");
  assert.match(badId.stderr, /kebab-case/u);

  // prefs add --id already existing
  const firstAdd = await runBuiltCli(
    ["prefs", "add", "--id", "seed-pref", "--text", "Seed preference.", "--weight", "3", "--root", root, "--unattended"],
    root,
  );
  assert.equal(firstAdd.exitCode, 0, `seeding a preference should succeed; stderr: ${firstAdd.stderr}`);
  const dupeId = await runBuiltCli(
    ["prefs", "add", "--id", "seed-pref", "--text", "y", "--weight", "3", "--root", root, "--unattended"],
    root,
  );
  assertCleanRefusal(dupeId, "prefs add with a duplicate id");
  assert.match(dupeId.stderr, /already exists/u);

  // prefs log --id unknown
  const unknownLog = await runBuiltCli(
    ["prefs", "log", "--id", "does-not-exist", "--signal", "correction", "--root", root, "--unattended"],
    root,
  );
  assertCleanRefusal(unknownLog, "prefs log with an unknown id");
  assert.match(unknownLog.stderr, /Unknown preference id/u);

  // learn journal --limit -5
  const enableLearning = await runBuiltCli(["capabilities", "enable", "learning", "--root", root], root);
  assert.equal(enableLearning.exitCode, 0, `enabling learning should succeed; stderr: ${enableLearning.stderr}`);
  const negativeLimit = await runBuiltCli(["learn", "journal", "--limit", "-5", "--root", root], root);
  assertCleanRefusal(negativeLimit, "learn journal --limit -5");
  assert.match(negativeLimit.stderr, /non-negative integer/u);

  // prefs list / prefs regen on a corrupted ledger
  const ledgerPath = join(root, "10_memory", "preferences", "_ledger.json");
  await writeFile(
    ledgerPath,
    JSON.stringify({ schema_version: 3, preferences: [{ id: "bad" }] }),
    "utf8",
  );
  const corruptList = await runBuiltCli(["prefs", "list", "--root", root], root);
  assertCleanRefusal(corruptList, "prefs list on a corrupted ledger");
  assert.match(corruptList.stderr, /Invalid preference ledger/u);

  const corruptRegen = await runBuiltCli(["prefs", "regen", "--root", root], root);
  assertCleanRefusal(corruptRegen, "prefs regen on a corrupted ledger");
  assert.match(corruptRegen.stderr, /Invalid preference ledger/u);

  // gc --apply on a proposal that was never approved
  const validLedger = { schema_version: 3, preferences: [] };
  await writeFile(ledgerPath, JSON.stringify(validLedger), "utf8");
  const proposalPath = join(root, "proposal.json");
  const gcWrite = await runBuiltCli(["gc", "--write", proposalPath, "--root", root], root);
  assert.equal(gcWrite.exitCode, 0, `gc --write should succeed; stderr: ${gcWrite.stderr}`);
  const gcApply = await runBuiltCli(["gc", "--apply", proposalPath, "--root", root], root);
  assertCleanRefusal(gcApply, "gc --apply on an unapproved proposal");
  assert.match(gcApply.stderr, /reviewed and approved/u);
});

test("the remaining five former stack traces are now clean refusals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-clean-errors-json-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const init = await runBuiltCli(["init", root, "--no-git"], root);
  assert.equal(init.exitCode, 0, `init should succeed; stderr: ${init.stderr}`);

  const invalidJsonPath = join(root, "invalid.json");
  await writeFile(invalidJsonPath, "{ this is not json", "utf8");
  const emptyJsonPath = join(root, "empty.json");
  await writeFile(emptyJsonPath, "", "utf8");
  const malformedJsonPath = join(root, "malformed.json");
  await writeFile(malformedJsonPath, JSON.stringify({ foo: "bar" }), "utf8");

  // gc --apply on invalid JSON
  const applyInvalid = await runBuiltCli(["gc", "--apply", invalidJsonPath, "--root", root], root);
  assertCleanRefusal(applyInvalid, "gc --apply on invalid JSON");
  assert.match(applyInvalid.stderr, /JSON file is invalid/u);

  // gc --apply on an empty file
  const applyEmpty = await runBuiltCli(["gc", "--apply", emptyJsonPath, "--root", root], root);
  assertCleanRefusal(applyEmpty, "gc --apply on an empty file");
  assert.match(applyEmpty.stderr, /JSON file is invalid/u);

  // gc --apply on well-formed JSON that is not a GC proposal
  const applyMalformed = await runBuiltCli(["gc", "--apply", malformedJsonPath, "--root", root], root);
  assertCleanRefusal(applyMalformed, "gc --apply on a malformed proposal");
  assert.match(applyMalformed.stderr, /does not match the expected OpenBrain format/u);

  // gc --approve on invalid JSON
  const approveInvalid = await runBuiltCli(
    ["gc", "--approve", invalidJsonPath, "--reviewer", "me", "--root", root],
    root,
  );
  assertCleanRefusal(approveInvalid, "gc --approve on invalid JSON");
  assert.match(approveInvalid.stderr, /JSON file is invalid/u);

  // skin with an unknown name
  const badSkin = await runBuiltCli(["skin", "not-a-skin", "--root", root], root);
  assertCleanRefusal(badSkin, "skin with an unknown name");
  assert.match(badSkin.stderr, /skin must be either universal or brain/u);
});
