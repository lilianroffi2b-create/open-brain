import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  composeHookOutcomes,
  runOrgan,
  type HookContext,
  type HookOutcome,
} from "../src/hooks/runtime.js";
import { MAX_SESSION_CONTEXT_CHARS, sessionStartHook } from "../src/hooks/session-start.js";
import { stopHook } from "../src/hooks/stop.js";
import { userPromptSubmitHook } from "../src/hooks/user-prompt-submit.js";
import { appendCandidate, listCandidates } from "../src/staging/store.js";

/**
 * The last coupling this build closes: the capture organs are composed into
 * the three handlers that already do something of their own, and the wiring
 * has to prove itself both ways: a deposit really lands in the store through
 * the real handler, and a disarmed or failing organ never costs the base
 * behavior that was already there.
 */

function configWith(overrides: { hooks?: boolean; capture?: boolean }): VaultConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: {
      ...DEFAULT_CONFIG.capabilities,
      hooks: { ...DEFAULT_CONFIG.capabilities.hooks, enabled: overrides.hooks !== false },
      capture: { enabled: overrides.capture === true },
    },
  };
}

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbrain-wiring-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");
  return root;
}

function contextFor(
  event: HookContext["event"],
  root: string,
  config: VaultConfig,
  payload: Record<string, unknown> = {},
): HookContext {
  return { event, payload, vaultRoot: root, config, deadline: Date.now() + 10_000 };
}

function assistantLine(text: string, session = "session-a"): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: session,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function userLine(text: string, index: number, session = "session-a"): string {
  return JSON.stringify({
    type: "user",
    uuid: `uuid-${session}-${String(index)}`,
    sessionId: session,
    timestamp: "2026-07-26T10:00:00Z",
    promptSource: "typed",
    message: { role: "user", content: text },
  });
}

/**
 * Written inside the vault itself, under 40_sources, which is always readable
 * regardless of the transcripts capability: the fixture stays focused on the
 * hooks/capture coupling and does not need to also consent a directory.
 */
async function writeTranscript(root: string, lines: string[]): Promise<string> {
  const path = join(root, "40_sources", "session.jsonl");
  await mkdir(join(root, "40_sources"), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

test("userPromptSubmitHook deposits an explicit request through the real handler path", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = configWith({ hooks: true, capture: true });

  const outcome = await userPromptSubmitHook(contextFor("user-prompt-submit", root, config, {
    prompt: "Remember this: always run the full test suite before shipping anything.",
    session_id: "session-a",
    event_id: "event-1",
  }));

  const staged = await listCandidates(root, config);
  assert.equal(staged.length, 1, "the deposit never reached the store through the real handler");
  assert.equal(staged[0]?.source, "prompt_submit");
  assert.equal(staged[0]?.signal, "explicit_request");
  // No routing table is configured in this fixture, so the base organ has
  // nothing of its own to say. The deposit is the only effect, and the
  // handler still returns cleanly.
  assert.equal(outcome, undefined);
});

test("with capture disarmed, userPromptSubmitHook keeps its own behavior and deposits nothing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = configWith({ hooks: true, capture: false });

  const outcome = await userPromptSubmitHook(contextFor("user-prompt-submit", root, config, {
    prompt: "Remember this: always run the full test suite before shipping anything.",
    session_id: "session-a",
    event_id: "event-1",
  }));

  assert.equal(outcome, undefined, "the base behavior for an unrouted prompt is unchanged");
  assert.deepEqual(await listCandidates(root, config), []);
});

test("stopHook deposits the end-of-turn candidate through the real handler, even with no living state to react to", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = configWith({ hooks: true, capture: true });
  const transcript = await writeTranscript(root, [
    assistantLine("Sure, on it."),
    userLine("From now on, keep answers short.", 1),
  ]);

  const outcome = await stopHook(contextFor("stop", root, config, {
    transcript_path: transcript,
    session_id: "session-a",
  }));

  const staged = await listCandidates(root, config);
  assert.equal(staged.length, 1, "the deposit never reached the store through the real handler");
  assert.equal(staged[0]?.source, "turn_end");
  assert.equal(staged[0]?.signal, "explicit_request");
  assert.equal(outcome, undefined, "no living state file means no ritual outcome of its own");
});

test("with capture disarmed, stopHook keeps its handoff ritual intact and deposits nothing", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = configWith({ hooks: true, capture: false });

  await writeFile(
    join(root, "10_memory", "_state.md"),
    "---\nlifecycle: master\n---\n## Current work\nNothing yet.\n",
    "utf8",
  );
  await mkdir(join(root, "20_contexts"), { recursive: true });
  const note = join(root, "20_contexts", "note.md");
  await writeFile(note, "---\nlifecycle: working\n---\n# Work\n", "utf8");
  const future = new Date(Date.now() + 60_000);
  await utimes(note, future, future);

  const transcript = await writeTranscript(root, [
    assistantLine("Sure, on it."),
    userLine("From now on, keep answers short.", 1),
  ]);

  const outcome = await stopHook(contextFor("stop", root, config, { transcript_path: transcript }));
  assert.ok(outcome?.block, "the handoff reminder must survive capture being disarmed");
  assert.match(String(outcome?.block), /\[open-brain handoff\]/u);
  assert.deepEqual(await listCandidates(root, config), []);
});

test("sessionStartHook composes the living state block with the staging reminder", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = configWith({ hooks: true, capture: true });

  await writeFile(
    join(root, "10_memory", "_state.md"),
    "---\nlifecycle: master\n---\n# Living state\n\n## Current work\nWiring the capture organs.\n",
    "utf8",
  );
  await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: "Always run the full test suite before shipping.",
    raw_markers: [],
    harness: "unknown",
  });

  const outcome = await sessionStartHook(contextFor("session-start", root, config));
  assert.ok(outcome?.context);
  assert.match(outcome.context, /Wiring the capture organs\./u);
  assert.match(outcome.context, /1 staged item\(s\) await review/u);
  assert.ok(outcome.budget);
  assert.equal(outcome.budget.chars, outcome.context.length);
  assert.ok(outcome.budget.chars <= MAX_SESSION_CONTEXT_CHARS);
  assert.equal(outcome.budget.truncated, false);
});

test("invariant I11: composing the reminder never truncates the base living-state block", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = configWith({ hooks: true, capture: true });

  // Many short lines, not one giant one: capText drops whole lines, so a
  // single unbroken line would vanish entirely instead of filling the budget.
  const filler = "x".repeat(20_000).match(/.{1,200}/gu) ?? [];
  const bigState = [
    "---",
    "lifecycle: master",
    "---",
    "# Living state",
    "",
    "## Current work",
    ...filler,
    "",
  ].join("\n");
  await writeFile(join(root, "10_memory", "_state.md"), bigState, "utf8");

  const solo = await sessionStartHook(contextFor("session-start", root, config));
  assert.ok(solo?.context);
  assert.ok(solo.budget);
  assert.equal(solo.budget.truncated, true, "the fixture must already fill the base's own cap");

  await appendCandidate(root, config, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: "Keep the diff surgical.",
    raw_markers: [],
    harness: "unknown",
  });

  const composed = await sessionStartHook(contextFor("session-start", root, config));
  assert.ok(composed?.context);
  assert.ok(composed.budget);

  // The base text is not cut: it is present verbatim, at the very start of
  // the composed output. Whatever room is left goes to the addition, down to
  // just its own truncation notice when almost nothing fits.
  assert.ok(
    composed.context.startsWith(solo.context),
    "the base block must not be the one cut when there is barely any room left",
  );
  assert.match(
    composed.context.slice(solo.context.length),
    /TRUNCATED/u,
    "what could not fit of the addition must still be announced, not silently dropped",
  );
  assert.ok(composed.context.length <= MAX_SESSION_CONTEXT_CHARS);
  assert.equal(composed.budget.chars, composed.context.length);
  assert.ok(
    composed.budget.items_total > solo.budget.items_total,
    "the reminder that was cut for lack of room must still be counted, not silently dropped",
  );
});

test("a throwing organ is swallowed by runOrgan, and composeHookOutcomes returns the base untouched", async () => {
  const base: HookOutcome = {
    context: "SUGGESTED ROUTE: hook_wiring (score 7)",
    budget: {
      chars: 40,
      token_estimate: 10,
      items_shown: 1,
      items_total: 1,
      truncated: false,
    },
  };

  // The exact shape every composed handler uses: run the organ through
  // runOrgan, then compose whatever it produced with the base outcome.
  const fromExplodingOrgan = await runOrgan(async (): Promise<HookOutcome | undefined> => {
    throw new Error("capture organ exploded");
  });
  assert.equal(fromExplodingOrgan, undefined, "runOrgan must swallow the exception, not rethrow it");

  const composed = composeHookOutcomes(base, fromExplodingOrgan, 1_500);
  assert.deepEqual(composed, base, "the base outcome must survive a throwing organ unchanged");
});
