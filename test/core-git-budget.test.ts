import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contentAgeDays, GIT_HISTORY_TIMEOUT_MS } from "../src/core/lifecycle.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const lifecycleModuleUrl = new URL("../src/core/lifecycle.ts", import.meta.url).href;

// The budget is proven with a real child process and a real timeout, never with
// a mocked clock. The stand-in git runs from a PATH given to that child alone,
// so nothing in this test process depends on a mutated environment.
const CHILD_SCRIPT = `
import { clearGitContentTimesCache, gitContentTimes } from ${JSON.stringify(lifecycleModuleUrl)};

const options = JSON.parse(process.argv[2]);
const results = [];
let previous;
const startedAt = Date.now();

for (const step of options.steps) {
  if (step.clearBefore) {
    clearGitContentTimesCache();
  }
  const times = await gitContentTimes(options.root, {
    timeoutMs: step.timeoutMs,
    cache: step.cache !== false,
  });
  results.push({ size: times.size, sameAsPrevious: previous === times });
  previous = times;
}

process.stdout.write(JSON.stringify({ results, elapsedMs: Date.now() - startedAt }));
`;

interface ChildStep {
  timeoutMs: number;
  cache?: boolean;
  clearBefore?: boolean;
}

interface ChildReport {
  results: Array<{ size: number; sameAsPrevious: boolean }>;
  elapsedMs: number;
}

/**
 * A stand-in for git that records every invocation and then sleeps. The exec
 * keeps the sleep in the same pid, so the kill the timeout sends actually lands.
 */
async function installFakeGit(sandbox: string, sleepSeconds: number): Promise<string> {
  const binDirectory = join(sandbox, "bin");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    join(binDirectory, "git"),
    [
      "#!/bin/sh",
      `echo call >> ${JSON.stringify(join(sandbox, "calls.log"))}`,
      `exec sleep ${String(sleepSeconds)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(join(binDirectory, "git"), 0o755);
  return binDirectory;
}

async function callCount(sandbox: string): Promise<number> {
  const text = await readFile(join(sandbox, "calls.log"), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function runChild(
  scriptPath: string,
  binDirectory: string,
  payload: { root: string; steps: ChildStep[] },
): Promise<ChildReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, JSON.stringify(payload)],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, PATH: binDirectory + delimiter + (process.env.PATH ?? "") },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited with ${String(code)}`));
        return;
      }
      resolve(JSON.parse(stdout) as ChildReport);
    });
  });
}

interface Sandbox {
  sandbox: string;
  root: string;
  scriptPath: string;
  binDirectory: string;
}

async function prepare(sleepSeconds: number): Promise<Sandbox> {
  const sandbox = await mkdtemp(join(tmpdir(), "open-brain-gitbudget-"));
  const root = await mkdtemp(join(tmpdir(), "open-brain-gitroot-"));
  const scriptPath = join(sandbox, "probe.mjs");
  await writeFile(scriptPath, CHILD_SCRIPT, "utf8");
  return {
    sandbox,
    root,
    scriptPath,
    binDirectory: await installFakeGit(sandbox, sleepSeconds),
  };
}

const skipOnWindows = { skip: process.platform === "win32" ? "POSIX shell required" : false };

test("the default git history budget is the documented 15 seconds", () => {
  assert.equal(GIT_HISTORY_TIMEOUT_MS, 15_000);
});

test("a slow repository never outruns the budget and never throws", skipOnWindows, async (t) => {
  const context = await prepare(30);
  t.after(async () => {
    await rm(context.sandbox, { recursive: true, force: true });
    await rm(context.root, { recursive: true, force: true });
  });

  const report = await runChild(context.scriptPath, context.binDirectory, {
    root: context.root,
    steps: [{ timeoutMs: 1_200, cache: false }],
  });

  assert.equal(report.results[0]?.size, 0, "an exhausted budget yields no git signal at all");
  assert.ok(report.elapsedMs < 8_000, `the call must be bounded, took ${String(report.elapsedMs)} ms`);
  assert.equal(await callCount(context.sandbox), 1, "a killed command is never retried");
});

test("the budget is shared, so the second command only gets what the first left", skipOnWindows, async (t) => {
  // Each command needs about 800 ms and the whole budget is 1600 ms: the first
  // fits, the second cannot, which a per-command timeout would have allowed.
  const context = await prepare(0.8);
  t.after(async () => {
    await rm(context.sandbox, { recursive: true, force: true });
    await rm(context.root, { recursive: true, force: true });
  });

  const report = await runChild(context.scriptPath, context.binDirectory, {
    root: context.root,
    steps: [{ timeoutMs: 1_600, cache: false }],
  });

  assert.equal(report.results[0]?.size, 0, "partial history is discarded rather than half applied");
  assert.equal(
    await callCount(context.sandbox),
    2,
    "the first command ran and the second inherited only the remainder",
  );
});

test("the git history result is cached per root, so a slow repository is paid once", skipOnWindows, async (t) => {
  const context = await prepare(30);
  t.after(async () => {
    await rm(context.sandbox, { recursive: true, force: true });
    await rm(context.root, { recursive: true, force: true });
  });

  const report = await runChild(context.scriptPath, context.binDirectory, {
    root: context.root,
    steps: [
      { timeoutMs: 1_000 },
      { timeoutMs: 1_000 },
      { timeoutMs: 1_000, clearBefore: true },
    ],
  });

  assert.equal(report.results[1]?.sameAsPrevious, true, "the cached map comes back untouched");
  assert.equal(report.results[2]?.sameAsPrevious, false, "clearing the cache rebuilds it");
  assert.equal(
    await callCount(context.sandbox),
    2,
    "two spawns for three calls: the cached one costs nothing",
  );
});

test("a vault without a usable git history still ages its documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-gitfallback-"));
  const notePath = join(root, "note.md");
  await writeFile(notePath, "# Note\n", "utf8");

  // Degradation is functional, not an exception: the age falls back to the mtime.
  const age = await contentAgeDays({
    relativePath: "note.md",
    absolutePath: notePath,
    gitTimes: new Map(),
    now: new Date(Date.now() + 2 * 86_400_000),
  });

  await rm(root, { recursive: true, force: true });
  assert.ok(age >= 1.9 && age <= 2.1, `expected roughly two days from the mtime, got ${String(age)}`);
});
