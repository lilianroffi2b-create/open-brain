import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

interface CliResult {
  stdout: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
    );
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", exitCode: failure.code ?? 1 };
  }
}

test("prefs add wires auto-regen through the CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-cli-prefs-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const init = await runCli(["init", root, "--no-git"]);
  assert.equal(init.exitCode, 0);

  const add = await runCli([
    "prefs", "add",
    "--root", root,
    "--id", "cli-smoke-pref",
    "--text", "Always confirm before deleting.",
    "--weight", "5",
    "--status", "law",
  ]);
  assert.equal(add.exitCode, 0);
  const addResult = JSON.parse(add.stdout) as {
    preference: { id: string };
    regenerated: boolean;
  };
  assert.equal(addResult.preference.id, "cli-smoke-pref");
  assert.equal(addResult.regenerated, true);

  const core = await readFile(join(root, "10_memory", "preferences", "_core.md"), "utf8");
  assert.ok(core.includes("cli-smoke-pref"));

  const duplicate = await runCli([
    "prefs", "add",
    "--root", root,
    "--id", "cli-smoke-pref",
    "--text", "duplicate",
    "--weight", "1",
  ]);
  assert.notEqual(duplicate.exitCode, 0);
});

test("prefs add below core threshold does not regenerate the core", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-cli-prefs-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await runCli(["init", root, "--no-git"]);

  const add = await runCli([
    "prefs", "add",
    "--root", root,
    "--id", "cli-low-weight-pref",
    "--text", "Minor stylistic nudge.",
    "--weight", "2",
  ]);
  assert.equal(add.exitCode, 0);
  const addResult = JSON.parse(add.stdout) as { regenerated: boolean };
  assert.equal(addResult.regenerated, false);
});

test("free-mode check exit code reflects dismissal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-cli-freemode-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await runCli(["init", root, "--no-git"]);
  await runCli(["free-mode", "on", "--root", root]);

  const before = await runCli(["free-mode", "check", "an idea", "--root", root]);
  assert.equal(before.exitCode, 0);
  assert.deepEqual(JSON.parse(before.stdout), { dismissed: false });

  await runCli(["free-mode", "dismiss", "an idea", "--root", root]);
  const after = await runCli(["free-mode", "check", "an idea", "--root", root]);
  assert.equal(after.exitCode, 1);
  assert.deepEqual(JSON.parse(after.stdout), { dismissed: true });

  const reset = await runCli(["free-mode", "reset", "--root", root]);
  assert.equal(reset.exitCode, 0);
  const afterReset = await runCli(["free-mode", "check", "an idea", "--root", root]);
  assert.equal(afterReset.exitCode, 0);
});
