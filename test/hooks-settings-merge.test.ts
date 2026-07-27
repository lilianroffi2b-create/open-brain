import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExpectedError } from "../src/core/errors.js";
import {
  CLAUDE_SETTINGS_RELATIVE_PATH,
  claudeCodeHookStatus,
  desiredClaudeHooks,
  hookCommandFor,
  installClaudeCodeHooks,
  isOwnedCommand,
  mergeHookSettings,
  normalizeCommand,
  uninstallClaudeCodeHooks,
} from "../src/hooks/settings-merge.js";
import { HOOK_EVENTS } from "../src/hooks/events.js";

const DESIRED = desiredClaudeHooks();

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

async function readSettings(root: string): Promise<unknown> {
  const text = await readFile(join(root, CLAUDE_SETTINGS_RELATIVE_PATH), "utf8");
  return JSON.parse(text) as unknown;
}

function countCommands(settings: unknown, command: string): number {
  const key = normalizeCommand(command);
  let count = 0;
  const value = settings as { hooks?: Record<string, unknown> };
  for (const groups of Object.values(value.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      const entries = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        const entryCommand = (entry as { command?: unknown }).command;
        if (typeof entryCommand === "string" && normalizeCommand(entryCommand) === key) {
          count += 1;
        }
      }
    }
  }
  return count;
}

test("every generated command is owned and unique per event", () => {
  const commands = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const command = hookCommandFor(event);
    assert.ok(isOwnedCommand(command), `${command} is not recognised as ours`);
    assert.equal(commands.has(command), false, `${command} is not unique`);
    commands.add(command);
  }
  assert.equal(isOwnedCommand("npm run something"), false);
});

test("merging is a fixed point: merge(merge(x, d), d) equals merge(x, d)", () => {
  const cases: unknown[] = [
    undefined,
    {},
    { hooks: {} },
    { statusLine: { type: "command", command: "my-status" } },
    {
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "other-tool lint" }] }],
      },
    },
    {
      hooks: {
        SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [] }],
      },
    },
    {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "open-brain hook stop", timeout: 99 }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "open-brain hook stop" }] },
        ],
      },
    },
  ];

  for (const value of cases) {
    const once = mergeHookSettings(value, DESIRED);
    const twice = mergeHookSettings(once, DESIRED);
    assert.deepEqual(twice, once, `merge is not idempotent for ${JSON.stringify(value)}`);
  }
});

test("the merge never overwrites a scalar the user owns", () => {
  const merged = mergeHookSettings(
    {
      model: "opus",
      statusLine: { type: "command", command: "my-status" },
      permissions: { deny: ["Bash(rm:*)"] },
    },
    DESIRED,
  );
  assert.equal(merged.model, "opus");
  assert.deepEqual(merged.statusLine, { type: "command", command: "my-status" });
  assert.deepEqual(merged.permissions, { deny: ["Bash(rm:*)"] });
});

test("a foreign event and a foreign entry both survive untouched", () => {
  const existing = {
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "notify-me" }] }],
      PostToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: "third-party lint" }] },
      ],
    },
  };
  const merged = mergeHookSettings(existing, DESIRED);
  assert.deepEqual(merged.hooks && (merged.hooks as Record<string, unknown>).Notification, [
    { hooks: [{ type: "command", command: "notify-me" }] },
  ]);

  const postToolUse = (merged.hooks as Record<string, unknown>).PostToolUse;
  assert.ok(Array.isArray(postToolUse));
  const group = postToolUse[0] as { matcher?: string; hooks: unknown[] };
  assert.equal(group.matcher, "Write|Edit");
  // The matcher already existed, so our entry joins that group instead of
  // creating a second one, and the third-party entry stays first.
  assert.deepEqual(group.hooks[0], { type: "command", command: "third-party lint" });
  assert.equal(countCommands(merged, hookCommandFor("post-tool-use")), 1);
});

test("an owned entry is updated in place rather than duplicated", () => {
  const existing = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "open-brain hook stop", timeout: 1 }] }],
    },
  };
  const merged = mergeHookSettings(existing, DESIRED);
  assert.equal(countCommands(merged, hookCommandFor("stop")), 1);
  const stop = (merged.hooks as Record<string, unknown>).Stop;
  assert.ok(Array.isArray(stop));
  const entry = ((stop[0] as { hooks: unknown[] }).hooks[0]) as { timeout?: number };
  assert.notEqual(entry.timeout, 1, "the stale timeout was not refreshed");
});

test("an owned entry that is no longer wanted is removed, foreign ones are not", () => {
  const existing = {
    hooks: {
      PreToolUse: [{
        matcher: "Write|Edit|Bash",
        hooks: [
          { type: "command", command: "open-brain hook retired-event" },
          { type: "command", command: "someone-else guard" },
        ],
      }],
    },
  };
  const merged = mergeHookSettings(existing, DESIRED);
  assert.equal(countCommands(merged, "open-brain hook retired-event"), 0);
  assert.equal(countCommands(merged, "someone-else guard"), 1);
});

test("uninstalling strips every owned entry and keeps the rest of the file", () => {
  const installed = mergeHookSettings({ model: "opus" }, DESIRED);
  const removed = mergeHookSettings(installed, {});
  assert.equal(removed.model, "opus");
  for (const event of HOOK_EVENTS) {
    assert.equal(countCommands(removed, hookCommandFor(event)), 0);
  }
});

test("a settings file that is not an object, or whose hooks are not, is refused", () => {
  assert.throws(() => mergeHookSettings([1, 2, 3], DESIRED), ExpectedError);
  assert.throws(() => mergeHookSettings({ hooks: "nope" }, DESIRED), ExpectedError);
  assert.throws(() => mergeHookSettings({ hooks: { Stop: "nope" } }, DESIRED), ExpectedError);
  // An event Open Brain does not register is left alone even when malformed:
  // it is neither ours to fix nor a reason to refuse the whole install.
  const merged = mergeHookSettings({ hooks: { Notification: "nope" } }, DESIRED);
  assert.equal((merged.hooks as Record<string, unknown>).Notification, "nope");
});

test("invariant I9: install twice, zero duplicates, and a third-party entry added in between survives", async (t) => {
  const root = await makeVault("open-brain-hooks-i9-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const first = await installClaudeCodeHooks(root);
  assert.equal(first.created, true);
  assert.equal(first.changed, true);

  // Someone else edits the file between the two installs.
  const afterFirst = await readSettings(root) as Record<string, unknown>;
  const hooks = afterFirst.hooks as Record<string, unknown>;
  const stop = hooks.Stop as Array<{ hooks: unknown[] }>;
  const stopGroup = stop[0];
  assert.ok(stopGroup);
  stopGroup.hooks.push({ type: "command", command: "third-party stop-hook" });
  hooks.Notification = [{ hooks: [{ type: "command", command: "third-party notify" }] }];
  afterFirst.statusLine = { type: "command", command: "my-status" };
  await writeFile(
    join(root, CLAUDE_SETTINGS_RELATIVE_PATH),
    JSON.stringify(afterFirst, null, 2) + "\n",
    "utf8",
  );

  const second = await installClaudeCodeHooks(root);
  assert.equal(second.created, false);

  const settings = await readSettings(root);
  for (const event of HOOK_EVENTS) {
    assert.equal(
      countCommands(settings, hookCommandFor(event)),
      1,
      `${event} is wired more or less than once`,
    );
  }
  assert.equal(countCommands(settings, "third-party stop-hook"), 1);
  assert.equal(countCommands(settings, "third-party notify"), 1);
  assert.deepEqual(
    (settings as Record<string, unknown>).statusLine,
    { type: "command", command: "my-status" },
  );

  // A third install with nothing changed in between writes nothing at all.
  const third = await installClaudeCodeHooks(root);
  assert.equal(third.changed, false);
  assert.equal(third.backup_path, undefined);
});

test("an unreadable settings file is reported and nothing is written", async (t) => {
  const root = await makeVault("open-brain-hooks-invalid-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, CLAUDE_SETTINGS_RELATIVE_PATH);
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(path, "{ not json", "utf8");

  await assert.rejects(installClaudeCodeHooks(root), ExpectedError);
  assert.equal(await readFile(path, "utf8"), "{ not json");
  await assert.rejects(readFile(path + ".bak", "utf8"));

  const status = await claudeCodeHookStatus(root);
  assert.equal(status.readable, false);
  assert.deepEqual(status.hooks.filter((entry) => entry.wired), []);
});

test("install then uninstall leaves the user's own file exactly as it was", async (t) => {
  const root = await makeVault("open-brain-hooks-roundtrip-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, CLAUDE_SETTINGS_RELATIVE_PATH);
  const original = {
    statusLine: { type: "command", command: "my-status" },
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "notify-me" }] }],
    },
  };
  await mkdir(join(root, ".claude"), { recursive: true });
  const originalText = JSON.stringify(original, null, 2) + "\n";
  await writeFile(path, originalText, "utf8");

  await installClaudeCodeHooks(root);
  const backup = await readFile(path + ".bak", "utf8");
  assert.equal(backup, originalText, "the backup is the file as it was before the change");

  await uninstallClaudeCodeHooks(root);
  assert.deepEqual(await readSettings(root), original);
});

test("status separates wired from not wired and counts duplicates", async (t) => {
  const root = await makeVault("open-brain-hooks-status-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const before = await claudeCodeHookStatus(root);
  assert.equal(before.present, false);
  assert.equal(before.hooks.every((entry) => !entry.wired), true);

  await installClaudeCodeHooks(root);
  const after = await claudeCodeHookStatus(root);
  assert.equal(after.present, true);
  assert.equal(after.hooks.every((entry) => entry.wired && entry.occurrences === 1), true);
  assert.equal(after.foreign_entries, 0);
});
