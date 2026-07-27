import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_NAMES,
  capabilityIssues,
  isEnabled,
} from "../src/core/capabilities.js";
import { loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import { applyCapabilities, planCapabilities } from "../src/onboarding/apply.js";
import {
  CONSOLIDATE_CONFIRMATION_PHRASE,
  SCOPING_QUESTIONS,
} from "../src/onboarding/questions.js";
import {
  createNonInteractiveIo,
  readConsent,
  runOnboarding,
  type OnboardingIo,
} from "../src/onboarding/run.js";

/**
 * The walk and the write. The properties proved here are the ones the product
 * is sold on: an abandoned walk leaves a working, fully disarmed vault; the
 * enter key never arms anything; the only subtractive capability cannot be
 * reached by a shortcut; and replaying the same answers rewrites nothing.
 */

const templateConfigPath = fileURLToPath(
  new URL("../templates/vault/00_index/vault.config.yml", import.meta.url),
);
const CONFIG_RELATIVE = join("00_index", "vault.config.yml");

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-onboarding-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, CONFIG_RELATIVE),
    await readFile(templateConfigPath, "utf8"),
    "utf8",
  );
  return root;
}

function configPath(root: string): string {
  return join(root, CONFIG_RELATIVE);
}

async function configText(root: string): Promise<string> {
  return await readFile(configPath(root), "utf8");
}

interface Scripted {
  io: OnboardingIo;
  output: () => string;
  unused: () => number;
}

function scripted(script: string[]): Scripted {
  const pending = [...script];
  const written: string[] = [];
  return {
    io: {
      interactive: true,
      async ask(prompt: string): Promise<string> {
        await Promise.resolve();
        written.push(prompt);
        const next = pending.shift();
        if (next === undefined) {
          throw new Error(`The walk asked one question too many: ${prompt}`);
        }
        return next;
      },
      write(text: string): void {
        written.push(text);
      },
      async close(): Promise<void> {
        await Promise.resolve();
      },
    },
    output: () => written.join("\n"),
    unused: () => pending.length,
  };
}

const SKIP_SCOPING = SCOPING_QUESTIONS.map(() => "");

function fullYesScript(root: string, consolidateConfirmation: string): string[] {
  return [
    ...SKIP_SCOPING,
    "y",
    "claude-code",
    "y",
    "y",
    "y",
    "y",
    join(root, "transcripts"),
    "y",
    "y",
    consolidateConfirmation,
    "y",
  ];
}

async function loadFor(root: string): Promise<VaultConfig> {
  return await loadConfig(root);
}

test("a walk that says yes to everything arms everything it was allowed to arm", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);
  const session = scripted(fullYesScript(root, CONSOLIDATE_CONFIRMATION_PHRASE));

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(session.unused(), 0, "the script must match the walk exactly");
  assert.equal(result.status, "applied");
  assert.equal(result.applied, true);

  const config = await loadFor(root);
  for (const name of CAPABILITY_NAMES) {
    assert.equal(isEnabled(config, name), true, `${name} should be armed`);
  }
  assert.deepEqual(config.capabilities.hooks.targets, ["claude-code"]);
  assert.deepEqual(config.capabilities.transcripts.roots, [join(root, "transcripts")]);
  assert.equal(config.capabilities.classifier.provider, "claude-code-subagent");
  assert.deepEqual(capabilityIssues(config), []);

  // Comments and every unrelated line survive the write.
  const after = await configText(root);
  assert.equal(
    after.slice(0, after.indexOf("capabilities:")),
    before.slice(0, before.indexOf("capabilities:")),
    "everything above the capabilities section must be untouched",
  );
  for (const comment of [
    "# Every capability ships whole and disarmed. Read one before arming it:",
    "# Hard cap on model calls per day. A run stops when the budget is spent.",
    "# The only subtractive operation: it deletes; `learn consolidate --restore` undoes it.",
    "# Off is the safe default when onboarding is skipped.",
  ]) {
    assert.ok(after.includes(comment), `the comment should survive: ${comment}`);
  }
});

test("saying yes to consolidation is not enough without its own confirmation", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const session = scripted(fullYesScript(root, "yes"));

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(result.status, "applied");
  const config = await loadFor(root);
  assert.equal(isEnabled(config, "learning.evaluate"), true);
  assert.equal(
    isEnabled(config, "learning.consolidate"),
    false,
    "a yes plus a global confirmation must never arm the capability that deletes",
  );
  assert.equal(config.capabilities.learning.consolidate, false);
  assert.match(session.output(), /stays disarmed/u);
});

test("abandoning the walk leaves a fully disarmed vault that still works", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);
  const session = scripted([...SKIP_SCOPING, "y", "claude-code", "y", "q"]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(result.status, "abandoned");
  assert.equal(result.applied, false);
  assert.equal(result.plan, null);
  assert.match(result.resume, /Nothing was written/u);
  assert.match(result.resume, /open-brain onboarding --interactive/u);

  assert.equal(await configText(root), before, "an abandoned walk writes nothing at all");
  const config = await loadFor(root);
  for (const name of CAPABILITY_NAMES) {
    assert.equal(isEnabled(config, name), false, `${name} must still be disarmed`);
  }
  assert.deepEqual(capabilityIssues(config), [], "the vault it leaves behind is coherent");
});

test("the enter key never arms anything", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);
  // Four capability questions are reachable when every answer is a skip: the
  // two children are never offered because their parents were not armed.
  const session = scripted([...SKIP_SCOPING, "", "", "", "", ""]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(session.unused(), 0);
  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.applied, false);
  assert.equal(result.plan?.changes_anything, false);
  assert.equal(result.answers.every((answer) => !answer.armed), true);
  assert.equal(result.skipped.length, 2);
  assert.equal(await configText(root), before);

  assert.equal(readConsent(""), "skip");
  assert.equal(readConsent("  "), "skip");
  assert.equal(readConsent("YES"), "yes");
  assert.equal(readConsent("maybe"), "unclear");
  assert.equal(readConsent("q"), "quit");
});

test("an unclear answer is re-asked and never read as consent", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const session = scripted([...SKIP_SCOPING, "sure", "why not", "ok", "", "", "", ""]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.answers[0]?.capability, "hooks");
  assert.equal(result.answers[0]?.armed, false);
  assert.match(session.output(), /Still unclear, so this one is left disarmed/u);
});

test("saying yes to transcripts without naming a directory arms nothing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);
  const session = scripted([...SKIP_SCOPING, "n", "n", "n", "y", "", "n"]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(result.status, "nothing-to-do");
  const transcripts = result.answers.find((answer) => answer.capability === "transcripts");
  assert.equal(transcripts?.armed, false);
  assert.match(session.output(), /No directory was named/u);
  assert.equal(await configText(root), before);
});

test("the recap shows exactly what will be written and asks once before writing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);
  const session = scripted([...SKIP_SCOPING, "n", "n", "y", "n", "n", "n", "n"]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.equal(result.status, "declined");
  assert.equal(result.applied, false);
  const output = session.output();
  assert.match(output, /Recap\. Nothing has been written yet\./u);
  assert.match(output, /capabilities\.learning\.enabled: false -> true/u);
  assert.match(output, /Nothing else in that file is touched, comments included\./u);
  assert.match(output, /Write these changes to /u);
  assert.equal(await configText(root), before, "declining at the recap writes nothing");
  assert.deepEqual(result.plan?.writes.map((write) => write.key), [
    "capabilities.learning.enabled",
  ]);
});

test("a dry run answers the same questions and writes nothing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);
  const session = scripted([...SKIP_SCOPING, "n", "n", "y", "n", "n", "n"]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
    dryRun: true,
  });

  assert.equal(session.unused(), 0, "a dry run must not ask for a confirmation it will not use");
  assert.equal(result.status, "dry-run");
  assert.equal(result.applied, false);
  assert.equal(result.plan?.changes_anything, true);
  assert.equal(await configText(root), before);
});

test("without a terminal the walk explains how to resume instead of blocking", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: createNonInteractiveIo(),
  });

  assert.equal(result.status, "not-interactive");
  assert.equal(result.applied, false);
  assert.equal(result.plan, null);
  assert.match(result.resume, /needs a terminal/u);
  assert.match(result.resume, /openbrain-onboarding skill/u);
  assert.equal(await configText(root), before);
  await assert.rejects(createNonInteractiveIo().ask("anything"), ExpectedError);
});

test("preference answers become exact commands and are not written by the walk", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const answers = SCOPING_QUESTIONS.map((question) => {
    if (question.id === "style.format") {
      return "Short blocks, no filler.";
    }
    if (question.id === "style.free-mode") {
      return "calibrated";
    }
    return "";
  });
  const session = scripted([...answers, "n", "n", "n", "n", "n"]);

  const result = await runOnboarding({
    root,
    config: await loadFor(root),
    io: session.io,
  });

  assert.deepEqual(result.next_commands, [
    'open-brain prefs add --id answer-format --text "Short blocks, no filler." --weight 4',
    "open-brain free-mode on",
  ]);
  assert.equal(result.status, "nothing-to-do");
  // The walk reports the commands; it does not run them, so free mode is
  // untouched until the user or the assistant runs the command.
  assert.match(await configText(root), /free_mode: off/u);
});

test("replaying the same answers rewrites nothing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = await loadFor(root);
  const requests = [
    { capability: "learning" as const, enable: true },
    { capability: "learning.evaluate" as const, enable: true },
  ];

  const first = await applyCapabilities(root, config, requests);
  assert.equal(first.applied, true);
  const afterFirst = await configText(root);

  const second = await applyCapabilities(root, await loadFor(root), requests);
  assert.equal(second.applied, false);
  assert.equal(second.already_current, true);
  assert.equal(second.plan.changes_anything, false);
  assert.equal(await configText(root), afterFirst, "a replay must not touch a single byte");
});

test("a child is never armed under a disarmed parent", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);

  const refused = await applyCapabilities(root, await loadFor(root), [
    { capability: "learning.evaluate", enable: true },
  ]);
  assert.equal(refused.applied, false);
  assert.match(String(refused.plan.refusals[0]), /parent capability learning is disarmed/u);
  assert.equal(await configText(root), before);

  // The same batch works when the parent is armed first, because requests are
  // evaluated in order.
  const ordered = await applyCapabilities(root, await loadFor(root), [
    { capability: "learning", enable: true },
    { capability: "learning.evaluate", enable: true },
  ]);
  assert.equal(ordered.applied, true);
  assert.equal(isEnabled(await loadFor(root), "learning.evaluate"), true);
});

test("no preset and no global yes can arm the capability that deletes", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await applyCapabilities(root, await loadFor(root), [
    { capability: "learning", enable: true },
    { capability: "learning.evaluate", enable: true },
  ]);
  const armedParents = await configText(root);

  for (const confirmation of [undefined, "yes", "y", "--yes", "true", "ENABLE LEARNING.CONSOLIDATE"]) {
    const attempt = await applyCapabilities(root, await loadFor(root), [
      {
        capability: "learning.consolidate",
        enable: true,
        ...(confirmation === undefined ? {} : { confirmation }),
      },
    ]);
    assert.equal(attempt.applied, false, `"${String(confirmation)}" must not arm consolidation`);
    assert.match(String(attempt.plan.refusals[0]), /its own confirmation/u);
    assert.equal(await configText(root), armedParents);
  }

  const armed = await applyCapabilities(root, await loadFor(root), [
    {
      capability: "learning.consolidate",
      enable: true,
      confirmation: CONSOLIDATE_CONFIRMATION_PHRASE,
    },
  ]);
  assert.equal(armed.applied, true);
  assert.equal(isEnabled(await loadFor(root), "learning.consolidate"), true);
});

test("invariant I10: disarming a parent disarms its children in the same write", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await applyCapabilities(root, await loadFor(root), [
    { capability: "learning", enable: true },
    { capability: "learning.evaluate", enable: true },
    {
      capability: "learning.consolidate",
      enable: true,
      confirmation: CONSOLIDATE_CONFIRMATION_PHRASE,
    },
  ]);

  const disabled = await applyCapabilities(root, await loadFor(root), [
    { capability: "learning", enable: false },
  ]);
  assert.equal(disabled.applied, true);
  assert.deepEqual(disabled.plan.writes.map((write) => write.key).sort(), [
    "capabilities.learning.consolidate",
    "capabilities.learning.enabled",
    "capabilities.learning.evaluate",
  ]);

  const config = await loadFor(root);
  assert.equal(config.capabilities.learning.enabled, false);
  assert.equal(config.capabilities.learning.evaluate, false);
  assert.equal(config.capabilities.learning.consolidate, false);
  assert.deepEqual(capabilityIssues(config), [], "no orphan is left behind in the file");
});

test("consent to transcripts is per directory and accumulates without duplicates", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);

  const refused = await applyCapabilities(root, await loadFor(root), [
    { capability: "transcripts", enable: true },
  ]);
  assert.equal(refused.applied, false);
  assert.match(String(refused.plan.refusals[0]), /consent is given per directory/u);
  assert.equal(await configText(root), before);

  const first = join(root, "sessions");
  const second = join(root, "other");
  await applyCapabilities(root, await loadFor(root), [
    { capability: "transcripts", enable: true, roots: [first] },
  ]);
  await applyCapabilities(root, await loadFor(root), [
    { capability: "transcripts", enable: true, roots: [first, second] },
  ]);
  assert.deepEqual((await loadFor(root)).capabilities.transcripts.roots, [first, second]);

  // Disarming stops the reading and leaves the recorded consent visible.
  await applyCapabilities(root, await loadFor(root), [
    { capability: "transcripts", enable: false },
  ]);
  const config = await loadFor(root);
  assert.equal(isEnabled(config, "transcripts"), false);
  assert.deepEqual(config.capabilities.transcripts.roots, [first, second]);
});

test("planning says what would be written without writing it", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);

  const plan = await planCapabilities(root, await loadFor(root), [
    { capability: "hooks", enable: true, targets: ["claude-code", "codex"] },
  ]);
  assert.equal(plan.changes_anything, true);
  assert.deepEqual(plan.writes, [
    { key: "capabilities.hooks.enabled", before: "false", after: "true" },
    { key: "capabilities.hooks.targets", before: "[]", after: "claude-code, codex" },
  ]);
  assert.equal(await configText(root), before);

  const dry = await applyCapabilities(
    root,
    await loadFor(root),
    [{ capability: "hooks", enable: true, targets: ["claude-code"] }],
    { dryRun: true },
  );
  assert.equal(dry.applied, false);
  assert.equal(await configText(root), before);
});

test("a config written before capabilities existed gains only the keys it needs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-onboarding-legacy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, CONFIG_RELATIVE),
    "# a vault from before capabilities\nversion: 1\nroot_label: Legacy\n",
    "utf8",
  );

  const applied = await applyCapabilities(root, await loadFor(root), [
    { capability: "capture", enable: true },
  ]);
  assert.equal(applied.applied, true);

  const text = await configText(root);
  assert.match(text, /# a vault from before capabilities/u);
  assert.match(text, /root_label: Legacy/u);
  assert.match(text, /capabilities:\n {2}capture:\n {4}enabled: true/u);
  const config = await loadFor(root);
  assert.equal(isEnabled(config, "capture"), true);
  for (const name of CAPABILITY_NAMES.filter((item) => item !== "capture")) {
    assert.equal(isEnabled(config, name), false, `${name} must stay disarmed`);
  }
});
