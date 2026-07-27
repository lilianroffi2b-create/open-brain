import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// The gitignored bundle is built once by scripts/run-tests.mjs before the
// parallel test processes start; building here would race other test files
// that spawn the same bundle. Same pattern as test/cli-errors.test.ts.
const builtCli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

/**
 * A smoke test that drives the built binary, bin/cli.js, and nothing else.
 *
 * Every other test that touches a CLI command imports its command object and
 * hands it straight to citty's runCommand, which never goes through
 * src/cli/main.ts. That proved every command's own logic, and it proved
 * nothing about whether main.ts actually registers the command a user would
 * type. It did not: eleven commands existed, were fully tested this way, and
 * were unreachable from the real binary until this same lot wired them into
 * subCommands. This file is the one test in the suite that would have caught
 * that gap, and it stays here to keep it from reopening.
 */

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

/** Every subcommand main.ts registers under open-brain. Kept in sync by hand:
 * a command missing from this list would not be caught by this test, so this
 * list is exactly the set the CLI wiring lot is responsible for keeping
 * current. */
const REGISTERED_SUBCOMMANDS: readonly string[] = [
  "init",
  "update",
  "doctor",
  "scan",
  "route",
  "loader-sync",
  "free-mode",
  "feedback",
  "gc",
  "health",
  "status",
  "ingest",
  "prefs",
  "skin",
  "hook",
  "hooks",
  "staging",
  "guard",
  "sync",
  "classify",
  "transcripts",
  "capture",
  "onboarding",
  "capabilities",
  "learn",
  "parity",
];

test("every registered subcommand answers --help with exit 0 and real output", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-smoke-help-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  for (const name of REGISTERED_SUBCOMMANDS) {
    const result = await runBuiltCli([name, "--help"], outside);
    assert.equal(
      result.exitCode,
      0,
      `\`open-brain ${name} --help\` should exit 0; stderr: ${result.stderr}`,
    );
    assert.ok(
      result.stdout.trim().length > 0,
      `\`open-brain ${name} --help\` should print something; stdout was empty`,
    );
  }
});

test("an unknown top-level subcommand fails cleanly with a non-zero exit code", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-smoke-unknown-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const result = await runBuiltCli(["not-a-real-command"], outside);
  assert.notEqual(result.exitCode, 0);
  assert.ok(
    (result.stdout + result.stderr).includes("Unknown command"),
    `should name the unknown command; stdout: ${result.stdout}; stderr: ${result.stderr}`,
  );
});

test("--version works at the top level and on a subcommand", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-smoke-version-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const top = await runBuiltCli(["--version"], outside);
  assert.equal(top.exitCode, 0);
  const version = top.stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+/u, `should print a version; stdout: ${top.stdout}`);

  for (const args of [["prefs", "--version"], ["learn", "--version"], ["staging", "drop", "--version"]]) {
    const result = await runBuiltCli(args, outside);
    assert.equal(result.exitCode, 0, `\`open-brain ${args.join(" ")}\` should exit 0`);
    assert.equal(
      result.stdout.trim(),
      version,
      `\`open-brain ${args.join(" ")}\` should print the same version as the top level`,
    );
  }
});
