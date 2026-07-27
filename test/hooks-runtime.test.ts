import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HOOK_BUDGET_MS,
  HOOK_BUDGET_ENV,
  HOOK_DECLARED_TIMEOUT_SECONDS,
  hookBudgetMs,
} from "../src/hooks/runtime.js";
import { HOOK_EVENTS } from "../src/hooks/events.js";

const runnerPath = fileURLToPath(new URL("./fixtures/hook-runner.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The child runs from the project root so the tsx loader resolves; the vault it
 * works on is the one named in the payload, exactly as a host CLI would report
 * it. CLAUDE_PROJECT_DIR is cleared so a test never picks up the vault of
 * whatever environment happens to be running it.
 */
function runHookProcess(
  event: string,
  mode: string,
  payload: unknown,
  env: Record<string, string> = {},
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.CLAUDE_PROJECT_DIR;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", runnerPath, event, mode],
      { cwd: projectRoot, env: childEnv },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** stdout is one line of JSON and nothing else, on every event that speaks. */
function parseEnvelope(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `stdout carried ${String(lines.length)} lines, not one`);
  return JSON.parse(lines[0] ?? "") as unknown;
}

interface VaultOptions {
  hooksEnabled?: boolean;
  state?: string;
}

async function makeVault(prefix: string, options: VaultOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    [
      "version: 1",
      "root_label: Test",
      "capabilities:",
      "  hooks:",
      `    enabled: ${options.hooksEnabled === true ? "true" : "false"}`,
      "    targets:",
      "      - claude-code",
      "",
    ].join("\n"),
    "utf8",
  );
  if (options.state !== undefined) {
    await writeFile(join(root, "10_memory", "_state.md"), options.state, "utf8");
  }
  return root;
}

test("the declared host timeout stays above the internal budget", () => {
  // A timeout declared in a settings file and a budget written in code drift
  // apart in silence unless something asserts the nesting.
  assert.ok(
    HOOK_DECLARED_TIMEOUT_SECONDS * 1_000 >= DEFAULT_HOOK_BUDGET_MS + 1_000,
    "the host would kill the hook before its own deadline fires",
  );
});

test("the time budget is configurable and refuses nonsense", () => {
  const original = process.env[HOOK_BUDGET_ENV];
  try {
    delete process.env[HOOK_BUDGET_ENV];
    assert.equal(hookBudgetMs(), DEFAULT_HOOK_BUDGET_MS);
    process.env[HOOK_BUDGET_ENV] = "500";
    assert.equal(hookBudgetMs(), 500);
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env[HOOK_BUDGET_ENV] = bad;
      assert.equal(hookBudgetMs(), DEFAULT_HOOK_BUDGET_MS, `accepted ${bad}`);
    }
  } finally {
    if (original === undefined) {
      delete process.env[HOOK_BUDGET_ENV];
    } else {
      process.env[HOOK_BUDGET_ENV] = original;
    }
  }
});

test("invariant I6: a hook only ever stays silent, injects context, or blocks", async (t) => {
  const root = await makeVault("open-brain-hook-contract-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const payload = { cwd: root, hook_event_name: "Stop" };

  const silent = await runHookProcess("stop", "silent", payload);
  assert.deepEqual(silent, { code: 0, stdout: "", stderr: "" });

  // stdout never carries bare text. It carries an envelope the host parses.
  const injected = await runHookProcess("session-start", "context", {
    cwd: root,
    hook_event_name: "SessionStart",
  });
  assert.equal(injected.code, 0);
  assert.equal(injected.stderr, "");
  assert.deepEqual(parseEnvelope(injected.stdout), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "INJECTED CONTEXT",
    },
  });

  const blocked = await runHookProcess("stop", "block", payload);
  assert.equal(blocked.code, 2, "Claude Code takes a stop block as exit 2 plus stderr");
  assert.equal(blocked.stdout, "", "stdout must stay empty on that form");
  assert.equal(blocked.stderr, "BLOCKED FOR A REASON\n");

  // A handler that throws is a bug in Open Brain, never a broken session.
  const exploded = await runHookProcess("stop", "throw", payload);
  assert.deepEqual(exploded, { code: 0, stdout: "", stderr: "" });
});

test("the output form follows the event, and Stop follows the host", async (t) => {
  const root = await makeVault("open-brain-hook-forms-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  // A refusal before the effect is the host's first-class deny, not a soft
  // block: on a red line the call has to be stopped, not argued with.
  const denied = await runHookProcess("pre-tool-use", "block", {
    cwd: root,
    hook_event_name: "PreToolUse",
  });
  assert.equal(denied.code, 0);
  assert.equal(denied.stderr, "");
  assert.deepEqual(parseEnvelope(denied.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "BLOCKED FOR A REASON",
    },
  });

  const afterEffect = await runHookProcess("post-tool-use", "block", {
    cwd: root,
    hook_event_name: "PostToolUse",
  });
  assert.equal(afterEffect.code, 0);
  assert.equal(afterEffect.stderr, "");
  assert.deepEqual(parseEnvelope(afterEffect.stdout), {
    decision: "block",
    reason: "BLOCKED FOR A REASON",
  });

  // The one event where the hosts genuinely differ. Branch, do not flatten.
  const codexStop = await runHookProcess("stop", "block", {
    cwd: root,
    hook_event_name: "Stop",
    turn_id: "turn-42",
  });
  assert.equal(codexStop.code, 0);
  assert.equal(codexStop.stderr, "");
  assert.deepEqual(parseEnvelope(codexStop.stdout), {
    decision: "block",
    reason: "BLOCKED FOR A REASON",
  });

  const claudeStop = await runHookProcess("stop", "block", { cwd: root, hook_event_name: "Stop" });
  assert.equal(claudeStop.code, 2);
  assert.equal(claudeStop.stdout, "");
  assert.equal(claudeStop.stderr, "BLOCKED FOR A REASON\n");
});

test("the envelope echoes the name the host used for the event", async (t) => {
  const root = await makeVault("open-brain-hook-echo-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const renamed = await runHookProcess("user-prompt-submit", "context", {
    cwd: root,
    hook_event_name: "UserPromptSubmitted",
  });
  const envelope = parseEnvelope(renamed.stdout) as {
    hookSpecificOutput: { hookEventName: string };
  };
  assert.equal(envelope.hookSpecificOutput.hookEventName, "UserPromptSubmitted");

  const silentAboutName = await runHookProcess("user-prompt-submit", "context", { cwd: root });
  const fallback = parseEnvelope(silentAboutName.stdout) as {
    hookSpecificOutput: { hookEventName: string };
  };
  assert.equal(fallback.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("invariant I6: a handler that never returns cannot hold the session open", async (t) => {
  const root = await makeVault("open-brain-hook-hang-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const started = Date.now();
  const result = await runHookProcess(
    "stop",
    "hang",
    { cwd: root },
    { [HOOK_BUDGET_ENV]: "300" },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.ok(Date.now() - started < 15_000, "the hook did not give up in time");
});

test("a hook run outside any vault is silent", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "open-brain-hook-novault-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  const result = await runHookProcess("stop", "context", { cwd: outside });
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
});

test("a malformed payload is treated as an empty one, never as a failure", async (t) => {
  const root = await makeVault("open-brain-hook-badpayload-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", runnerPath, "stop", "real"],
    { cwd: projectRoot },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end("{ this is not json");
  const code = await new Promise<number>((resolve) => {
    child.once("close", (value) => resolve(value ?? -1));
  });
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("with the hooks capability disarmed nothing runs and nothing is read", async (t) => {
  const sentinel = "## Current work\nSENTINEL-DISARMED\n";
  const root = await makeVault("open-brain-hook-disarmed-", { state: sentinel });
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const event of HOOK_EVENTS) {
    const forced = await runHookProcess(event, "context", { cwd: root });
    assert.deepEqual(
      forced,
      { code: 0, stdout: "", stderr: "" },
      `${event} produced output while disarmed`,
    );
  }

  const real = await runHookProcess("session-start", "real", { cwd: root });
  assert.equal(real.stdout, "");
  assert.equal(
    real.stdout.includes("SENTINEL-DISARMED"),
    false,
    "the state file was read while the capability was disarmed",
  );
});

test("session-start injects the living state and its own status line", async (t) => {
  const root = await makeVault("open-brain-hook-session-", {
    hooksEnabled: true,
    state: [
      "---",
      "lifecycle: master",
      "---",
      "# Living state",
      "",
      "## Current work",
      "Wiring the hooks.",
      "",
      "## Not injected",
      "Instructions nobody needs at startup.",
      "",
    ].join("\n"),
  });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await runHookProcess(
    "session-start",
    "real",
    { cwd: root, hook_event_name: "SessionStart", source: "startup" },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const envelope = parseEnvelope(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(envelope.hookSpecificOutput.hookEventName, "SessionStart");
  const injected = envelope.hookSpecificOutput.additionalContext;
  assert.match(injected, /Wiring the hooks\./u);
  assert.match(injected, /no index yet/u);
  assert.equal(
    injected.includes("Instructions nobody needs"),
    false,
    "a section outside the state headings was injected",
  );
});

test("post-tool-use blocks a new Markdown file with no lifecycle front matter", async (t) => {
  const root = await makeVault("open-brain-hook-lint-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const target = join(root, "10_memory", "note.md");
  await writeFile(target, "# A note with no front matter\n", "utf8");

  const result = await runHookProcess(
    "post-tool-use",
    "real",
    {
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: "# A note with no front matter\n" },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const blocked = parseEnvelope(result.stdout) as { decision: string; reason: string };
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /\[open-brain lint\]/u);
  assert.match(blocked.reason, /lifecycle/u);
});

test("post-tool-use stays silent on a compliant file and on a file outside the vault", async (t) => {
  const root = await makeVault("open-brain-hook-lint-ok-", { hooksEnabled: true });
  const outside = await mkdtemp(join(tmpdir(), "open-brain-hook-elsewhere-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const good = join(root, "10_memory", "good.md");
  await writeFile(good, "---\nlifecycle: working\n---\n# Fine\n", "utf8");
  const compliant = await runHookProcess(
    "post-tool-use",
    "real",
    {
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: good, content: "---\nlifecycle: working\n---\n# Fine\n" },
    },
  );
  assert.deepEqual(compliant, { code: 0, stdout: "", stderr: "" });

  const stranger = join(outside, "stranger.md");
  await writeFile(stranger, "# Not our business\n", "utf8");
  const elsewhere = await runHookProcess(
    "post-tool-use",
    "real",
    { cwd: root, tool_name: "Write", tool_input: { file_path: stranger, content: "x" } },
  );
  assert.deepEqual(elsewhere, { code: 0, stdout: "", stderr: "" });
});

test("stop reminds only when content moved without the living state, and never twice", async (t) => {
  const root = await makeVault("open-brain-hook-stop-", {
    hooksEnabled: true,
    state: "---\nlifecycle: master\n---\n## Current work\nNothing yet.\n",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "20_contexts"), { recursive: true });

  const quiet = await runHookProcess("stop", "real", { cwd: root });
  assert.deepEqual(quiet, { code: 0, stdout: "", stderr: "" });

  const note = join(root, "20_contexts", "note.md");
  await writeFile(note, "---\nlifecycle: working\n---\n# Work\n", "utf8");
  const future = new Date(Date.now() + 60_000);
  await utimes(note, future, future);

  const reminded = await runHookProcess("stop", "real", { cwd: root });
  assert.equal(reminded.code, 2);
  assert.equal(reminded.stdout, "");
  assert.match(reminded.stderr, /\[open-brain handoff\]/u);
  assert.match(reminded.stderr, /10_memory\/_state\.md/u);

  // Already continuing because of an earlier block: blocking again is how a
  // hook turns into an infinite loop.
  const continuing = await runHookProcess(
    "stop",
    "real",
    { cwd: root, stop_hook_active: true },
  );
  assert.deepEqual(continuing, { code: 0, stdout: "", stderr: "" });

  const planning = await runHookProcess(
    "stop",
    "real",
    { cwd: root, permission_mode: "plan" },
  );
  assert.deepEqual(planning, { code: 0, stdout: "", stderr: "" });
});

test("pre-tool-use forwards the guard verdict and nothing else", async (t) => {
  const root = await makeVault("open-brain-hook-guard-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const denied = await runHookProcess(
    "pre-tool-use",
    "real",
    {
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(root, "10_memory", "preferences", "_ledger.json"), content: "{}" },
    },
  );
  // The red line on the preference kernel gets the host's real refusal, so the
  // write never happens, rather than a soft block the assistant could talk past.
  assert.equal(denied.code, 0);
  assert.equal(denied.stderr, "");
  const verdict = parseEnvelope(denied.stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  assert.equal(verdict.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /\[open-brain guard\]/u);

  const allowed = await runHookProcess(
    "pre-tool-use",
    "real",
    {
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: join(root, "20_contexts", "ok.md"), content: "x" },
    },
  );
  assert.deepEqual(allowed, { code: 0, stdout: "", stderr: "" });
});

test("stop enforces the declared load cap and loses nothing doing it", async (t) => {
  // The cap is declared by the document, never by the engine.
  const sections = Array.from(
    { length: 40 },
    (_, index) => `## Session ${String(index)}\n${"detail ".repeat(40)}\n`,
  );
  const body = "# Living state\n\n" + sections.join("\n");
  const original = "---\nlifecycle: master\nmax_load: 2000\n---\n" + body;
  assert.ok(original.length > 2_000, "the fixture has to actually overflow");

  const root = await makeVault("open-brain-hook-cap-", {
    hooksEnabled: true,
    state: original,
  });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await runHookProcess("stop", "real", { cwd: root });
  assert.equal(result.code, 0, "consolidating is not a reason to block a turn");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /\[open-brain load\]/u);
  assert.match(result.stderr, /Nothing was deleted/u);

  const kept = await readFile(join(root, "10_memory", "_state.md"), "utf8");
  assert.ok(kept.length <= 2_000, `the living state is still ${String(kept.length)} chars`);
  assert.match(kept, /^---\nlifecycle: master\nmax_load: 2000\n---\n/u);
  assert.match(kept, /moved to 90_archive\/state\//u);

  const archives = await readdir(join(root, "90_archive", "state"));
  assert.equal(archives.length, 1, "consolidation wrote no archive, or wrote several");
  const archiveName = archives[0] ?? "";
  const archived = await readFile(join(root, "90_archive", "state", archiveName), "utf8");
  assert.match(archived, /^---\nlifecycle: data\n---\n/u);

  // The proof: the kept body plus the archived body reconstitute the original
  // body character for character. Nothing dropped, nothing duplicated,
  // nothing rewritten.
  const keptBody = kept
    .replace(/^---\n[\s\S]*?\n---\n/u, "")
    .replace(/\n> \[open-brain\][^\n]*\n$/u, "");
  const archivedBody = archived.slice(archived.indexOf("verbatim and unedited.\n\n")
    + "verbatim and unedited.\n\n".length);
  assert.equal(keptBody + archivedBody, body, "a byte was lost or duplicated");

  // Running again is a no-op: the file is under its cap now.
  const again = await runHookProcess("stop", "real", { cwd: root });
  assert.equal(again.stderr, "", "the cap was enforced twice on the same overflow");
  assert.deepEqual(await readdir(join(root, "90_archive", "state")), archives);
});

test("a living state with no declared cap is never consolidated", async (t) => {
  const root = await makeVault("open-brain-hook-nocap-", {
    hooksEnabled: true,
    state: "---\nlifecycle: master\n---\n## One\n" + "x".repeat(80_000) + "\n## Two\ntail\n",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const before = await readFile(join(root, "10_memory", "_state.md"), "utf8");
  const result = await runHookProcess("stop", "real", { cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(await readFile(join(root, "10_memory", "_state.md"), "utf8"), before);
  assert.equal(result.code, 0);
});

test("pre-compact is silent until an extractor is registered", async (t) => {
  const root = await makeVault("open-brain-hook-precompact-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const result = await runHookProcess(
    "pre-compact",
    "real",
    { cwd: root, hook_event_name: "PreCompact", trigger: "auto" },
  );
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
});

test("an unknown event is refused inside the contract, not with a random exit code", async (t) => {
  const root = await makeVault("open-brain-hook-unknown-", { hooksEnabled: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const result = await runHookProcess("not-an-event", "real", { cwd: root });
  assert.equal(result.code, 9, "the fixture rejects it before the runtime sees it");
  assert.match(result.stderr, /unknown event/u);
});
