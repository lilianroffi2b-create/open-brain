import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexHooksDocument,
  CODEX_DIFFERENCES,
  CODEX_HOOKS_RELATIVE_PATH,
  codexHookStatus,
  HOOK_HOST_SUPPORT,
  installCodexHooks,
  uninstallCodexHooks,
} from "../src/hooks/codex.js";
import { HOOK_EVENTS, HOST_EVENT_NAMES } from "../src/hooks/events.js";
import { hookCommandFor } from "../src/hooks/settings-merge.js";

const DOCUMENT = buildCodexHooksDocument();

interface CodexEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  statusMessage?: unknown;
  async?: unknown;
}

function allEntries(): CodexEntry[] {
  const entries: CodexEntry[] = [];
  for (const groups of Object.values(DOCUMENT.hooks)) {
    for (const group of groups) {
      entries.push(...group.hooks);
    }
  }
  return entries;
}

async function makeVault(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "version: 1\nroot_label: Test\n",
    "utf8",
  );
  return root;
}

test("the Codex document has exactly the two root keys Codex accepts", () => {
  assert.deepEqual(Object.keys(DOCUMENT).sort(), ["description", "hooks"]);
  assert.equal(typeof DOCUMENT.description, "string");
});

test("every event is registered once and no event Open Brain does not own appears", () => {
  const events = Object.keys(DOCUMENT.hooks).sort();
  assert.deepEqual(events, HOOK_EVENTS.map((event) => HOST_EVENT_NAMES[event]).sort());
  assert.equal(events.includes("SessionEnd"), false, "SessionEnd is deliberately absent");
  for (const event of HOOK_EVENTS) {
    const groups = DOCUMENT.hooks[HOST_EVENT_NAMES[event]];
    assert.ok(groups && groups.length === 1);
    assert.equal(groups[0]?.hooks.length, 1);
    assert.equal(groups[0]?.hooks[0]?.command, hookCommandFor(event));
  }
});

test("every entry carries a positive integer timeout and is never async", () => {
  for (const entry of allEntries()) {
    assert.equal(entry.type, "command");
    assert.ok(typeof entry.timeout === "number");
    assert.ok(Number.isInteger(entry.timeout));
    assert.ok(entry.timeout > 0);
    assert.equal(typeof entry.statusMessage, "string");
    assert.equal("async" in entry, false, "async is not allowed on a Codex entry");
  }
});

test("no command shells out to a system tool Open Brain cannot assume", () => {
  for (const entry of allEntries()) {
    const command = String(entry.command);
    assert.ok(command.includes("open-brain hook "), `${command} is not the entry point`);
    assert.equal(command.includes("jq"), false);
    assert.equal(command.includes("|"), false, `${command} pipes to something`);
    assert.equal(command.includes(">>"), false, `${command} redirects output`);
  }
});

test("every matcher is an anchored regular expression that matches only what it should", () => {
  const expectations: Array<[string, string[], string[]]> = [
    [
      "SessionStart",
      ["startup", "resume", "clear", "compact"],
      ["startupx", "xstartup", "Bash"],
    ],
    [
      "PreToolUse",
      ["Bash", "exec", "exec_command", "apply_patch", "Edit", "Write"],
      ["Read", "Writex", "xEdit", "Glob"],
    ],
    [
      "PostToolUse",
      ["apply_patch", "Edit", "Write"],
      ["Bash", "exec", "Read"],
    ],
    ["PreCompact", ["auto", "manual"], ["automatic", "manual2"]],
  ];

  for (const [event, matching, notMatching] of expectations) {
    const groups = DOCUMENT.hooks[event];
    const matcher = groups?.[0]?.matcher;
    assert.ok(typeof matcher === "string", `${event} has no matcher`);
    const pattern = new RegExp(matcher, "u");
    assert.ok(matcher.startsWith("^"), `${event} matcher is not anchored`);
    assert.ok(matcher.endsWith("$"), `${event} matcher is not anchored`);
    for (const value of matching) {
      assert.ok(pattern.test(value), `${event} should match ${value}`);
    }
    for (const value of notMatching) {
      assert.equal(pattern.test(value), false, `${event} should not match ${value}`);
    }
  }

  for (const event of ["UserPromptSubmit", "Stop"]) {
    assert.equal(DOCUMENT.hooks[event]?.[0]?.matcher, undefined);
  }
});

test("the documented host differences are real prose, not placeholders", () => {
  assert.ok(CODEX_DIFFERENCES.length >= 5);
  for (const difference of CODEX_DIFFERENCES) {
    assert.ok(difference.topic.length > 0);
    assert.ok(difference.detail.length > 40, `${difference.topic} has no explanation`);
  }
  const topics = CODEX_DIFFERENCES.map((difference) => difference.topic).join(" ");
  assert.match(topics, /turn_id/u);
  assert.match(topics, /SessionEnd/u);
});

test("a host with no hook mechanism is announced as degraded, not silently supported", () => {
  const degraded = HOOK_HOST_SUPPORT.find((host) => host.level === "degraded");
  assert.ok(degraded, "no degraded level is documented");
  assert.match(degraded.host, /Gemini/u);
  assert.match(degraded.works, /Nothing automatic/u);
  assert.equal(HOOK_HOST_SUPPORT.some((host) => host.level === "full"), true);
  assert.equal(HOOK_HOST_SUPPORT.some((host) => host.level === "full-plus"), true);
});

test("installing twice writes the same file once, and uninstall removes it", async (t) => {
  const root = await makeVault("open-brain-codex-install-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, CODEX_HOOKS_RELATIVE_PATH);

  const first = await installCodexHooks(root);
  assert.equal(first.created, true);
  const written = await readFile(path, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(written) as object).sort(), ["description", "hooks"]);

  const second = await installCodexHooks(root);
  assert.equal(second.changed, false, "a second install rewrote the file");
  assert.equal(await readFile(path, "utf8"), written);

  const status = await codexHookStatus(root);
  assert.equal(status.hooks.every((entry) => entry.wired && entry.occurrences === 1), true);

  const removed = await uninstallCodexHooks(root);
  assert.equal(removed.changed, true);
  await assert.rejects(access(path), "the generated file was left behind");
  assert.equal(typeof removed.backup_path, "string");
});

test("a Codex hook the user added themselves survives an uninstall", async (t) => {
  const root = await makeVault("open-brain-codex-foreign-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, CODEX_HOOKS_RELATIVE_PATH);

  await installCodexHooks(root);
  const document = JSON.parse(await readFile(path, "utf8")) as {
    hooks: Record<string, Array<{ hooks: unknown[] }>>;
  };
  const stopGroup = document.hooks.Stop?.[0];
  assert.ok(stopGroup);
  stopGroup.hooks.push({ type: "command", command: "my-own-tool", timeout: 3 });
  await writeFile(path, JSON.stringify(document, null, 2) + "\n", "utf8");

  await uninstallCodexHooks(root);
  const after = JSON.parse(await readFile(path, "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
  };
  const remaining = after.hooks.Stop?.[0]?.hooks ?? [];
  assert.deepEqual(remaining.map((entry) => entry.command), ["my-own-tool"]);
});
