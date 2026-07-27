import assert from "node:assert/strict";
import { runCommand } from "citty";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { capabilitiesCommand } from "../src/cli/commands/capabilities.js";
import { onboardingCommand } from "../src/cli/commands/onboarding.js";
import { CAPABILITY_NAMES } from "../src/core/capabilities.js";
import { CONSOLIDATE_CONFIRMATION_PHRASE } from "../src/onboarding/questions.js";

/**
 * The command surface a suspicious user meets: list to see what is armed,
 * explain to read what a capability actually does before arming it, enable to
 * arm one thing and be refused when arming it would be meaningless, disable to
 * stop it and everything under it.
 */

const templateConfigPath = fileURLToPath(
  new URL("../templates/vault/00_index/vault.config.yml", import.meta.url),
);
const CONFIG_RELATIVE = join("00_index", "vault.config.yml");

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-capabilities-cli-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, CONFIG_RELATIVE),
    await readFile(templateConfigPath, "utf8"),
    "utf8",
  );
  return root;
}

async function configText(root: string): Promise<string> {
  return await readFile(join(root, CONFIG_RELATIVE), "utf8");
}

async function capture(action: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected a JSON object");
  return value as Record<string, unknown>;
}

async function runJson(rawArgs: string[]): Promise<Record<string, unknown>> {
  const raw = await capture(() => runCommand(capabilitiesCommand, { rawArgs }));
  const start = raw.indexOf("{");
  assert.ok(start > -1, `expected JSON output, got: ${raw}`);
  return asRecord(JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1)) as unknown);
}

async function runText(rawArgs: string[]): Promise<string> {
  return await capture(() => runCommand(capabilitiesCommand, { rawArgs }));
}

test("list shows every capability, what is armed, and any anomaly", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const listing = await runJson(["list", "--root", root]);
  assert.deepEqual(listing.armed, []);
  assert.deepEqual(listing.disarmed, [...CAPABILITY_NAMES]);
  assert.deepEqual(listing.issues, []);
  assert.match(String(listing.next), /reads nothing outside this vault and costs nothing/u);

  const rows = listing.capabilities;
  assert.ok(Array.isArray(rows) && rows.length === CAPABILITY_NAMES.length);
  const classifier = asRecord(rows.find((row) => asRecord(row).name === "classifier"));
  // The cap in force is readable without opening the config file.
  assert.deepEqual(classifier.detail, { provider: "none", daily_call_budget: 25 });
  const evaluate = asRecord(rows.find((row) => asRecord(row).name === "learning.evaluate"));
  assert.equal(evaluate.parent, "learning");
});

test("explain prints the whole framing, the current state, and its own cost", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const text = await runText(["explain", "transcripts", "--root", root]);
  for (const field of [
    "What it does:",
    "What it reads:",
    "What it writes:",
    "What it costs:",
    "Risk if armed:",
    "How to turn it off:",
  ]) {
    assert.ok(text.includes(field), `explain must state ${field}`);
  }
  assert.match(text, /Status: disarmed\./u);
  assert.match(text, /Directories consented to: none/u);
  assert.match(text, /Redaction: on\./u);
  assert.match(text, /Arm it: open-brain capabilities enable transcripts --path <directory>/u);
  assert.match(text, /\[budget\] \d+ chars, about \d+ tokens/u);
  assert.ok(text.length < 2_400, "explain must stay readable in one screen");

  const consolidate = await runText(["explain", "learning.consolidate", "--root", root]);
  assert.match(consolidate, /Parent capability: learning\./u);
  assert.ok(consolidate.includes(CONSOLIDATE_CONFIRMATION_PHRASE));

  const json = await runJson(["explain", "hooks", "--root", root, "--json"]);
  assert.equal(asRecord(json.description).name, "hooks");
  assert.equal(asRecord(json.budget).truncated, false);

  await assert.rejects(runText(["explain", "telepathy", "--root", root]), /Unknown capability/u);
});

test("enable refuses what it cannot honestly arm, and says why", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);

  await assert.rejects(
    runJson(["enable", "learning.evaluate", "--root", root]),
    /parent capability learning is disarmed/u,
  );
  await assert.rejects(
    runJson(["enable", "transcripts", "--root", root]),
    /consent is given per directory/u,
  );
  await assert.rejects(
    runJson(["enable", "learning.consolidate", "--root", root]),
    /its own confirmation/u,
  );
  await assert.rejects(
    runJson(["enable", "classifier", "--root", root, "--provider", "gpt"]),
    /--provider must be none or claude-code-subagent/u,
  );
  assert.equal(await configText(root), before, "a refusal writes nothing");
});

test("enable arms one capability and reports exactly what it wrote", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const hooks = await runJson(["enable", "hooks", "--root", root, "--target", "claude-code,codex"]);
  assert.equal(hooks.applied, true);
  assert.deepEqual(hooks.writes, [
    { key: "capabilities.hooks.enabled", before: "false", after: "true" },
    { key: "capabilities.hooks.targets", before: "[]", after: "claude-code, codex" },
  ]);
  assert.match(String(hooks.next), /disable hooks/u);

  const again = await runJson(["enable", "hooks", "--root", root, "--target", "claude-code"]);
  assert.equal(again.applied, false);
  assert.equal(again.already_armed, true);
  assert.deepEqual(again.writes, []);

  const transcripts = await runJson([
    "enable",
    "transcripts",
    "--root",
    root,
    "--path",
    join(root, "sessions"),
  ]);
  assert.equal(transcripts.applied, true);
  assert.ok(
    (transcripts.notes as string[]).some((note) => note.includes(join(root, "sessions"))),
  );

  // Arming the classifier sets a provider, so it can never be armed and mute.
  const classifier = await runJson(["enable", "classifier", "--root", root]);
  assert.equal(classifier.applied, true);
  assert.ok(
    (classifier.notes as string[]).some((note) => note.includes("claude-code-subagent")),
  );

  const listing = await runJson(["list", "--root", root]);
  assert.deepEqual(listing.armed, ["hooks", "transcripts", "classifier"]);
  assert.deepEqual(listing.issues, []);
});

test("only the dedicated confirmation arms the capability that deletes", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await runJson(["enable", "learning", "--root", root]);
  await runJson(["enable", "learning.evaluate", "--root", root]);
  const before = await configText(root);

  await assert.rejects(
    runJson(["enable", "learning.consolidate", "--root", root, "--confirm", "yes"]),
    /its own confirmation/u,
  );
  assert.equal(await configText(root), before);

  const armed = await runJson([
    "enable",
    "learning.consolidate",
    "--root",
    root,
    "--confirm",
    CONSOLIDATE_CONFIRMATION_PHRASE,
  ]);
  assert.equal(armed.applied, true);
  assert.match(await configText(root), /consolidate: true/u);
});

test("disable takes the children with it and is effective immediately", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await runJson(["enable", "learning", "--root", root]);
  await runJson(["enable", "learning.evaluate", "--root", root]);
  await runJson([
    "enable",
    "learning.consolidate",
    "--root",
    root,
    "--confirm",
    CONSOLIDATE_CONFIRMATION_PHRASE,
  ]);

  const disabled = await runJson(["disable", "learning", "--root", root]);
  assert.equal(disabled.applied, true);
  assert.deepEqual(disabled.children_disarmed, ["learning.evaluate", "learning.consolidate"]);
  assert.deepEqual(
    (disabled.writes as Array<Record<string, unknown>>).map((write) => write.key).sort(),
    [
      "capabilities.learning.consolidate",
      "capabilities.learning.enabled",
      "capabilities.learning.evaluate",
    ],
  );

  const listing = await runJson(["list", "--root", root]);
  assert.deepEqual(listing.armed, []);
  assert.deepEqual(listing.issues, []);

  const noop = await runJson(["disable", "learning", "--root", root]);
  assert.equal(noop.applied, false);
  assert.equal(noop.already_disarmed, true);
});

test("onboarding without a terminal describes the walk without pouring it out", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = await configText(root);

  const raw = await capture(() => runCommand(onboardingCommand, { rawArgs: ["--root", root] }));
  const plan = asRecord(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as unknown);
  assert.deepEqual(plan.armed, []);
  const questions = plan.capability_questions;
  assert.ok(Array.isArray(questions) && questions.length === CAPABILITY_NAMES.length);
  assert.equal(asRecord(questions[0]).capability, "hooks");
  assert.equal(asRecord(questions[questions.length - 1]).capability, "learning.consolidate");
  assert.ok(Array.isArray(plan.preference_questions) && plan.preference_questions.length >= 8);
  assert.equal(asRecord(plan.budget).truncated, false);
  assert.ok(asRecord(plan.budget).chars as number < 1_500);
  assert.equal(await configText(root), before, "describing the walk arms nothing");
});
