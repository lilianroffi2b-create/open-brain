import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const builtCli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// The built bundle is gitignored, so ensure it exists before spawning it. The
// standard pipeline builds first; this keeps the test robust when it does not.
before(() => {
  execFileSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
});

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
