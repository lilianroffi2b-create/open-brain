import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  changesFromPayload,
  commandFromToolInput,
  isCodexPayload,
  isNewFile,
  isPlanPayload,
  parseApplyPatch,
} from "../src/hooks/events.js";
import { hasLifecycleFrontmatter, renderLintFeedback } from "../src/hooks/post-tool-use.js";
import {
  getPreCompactExtractor,
  preCompactHook,
  registerPreCompactExtractor,
} from "../src/hooks/pre-compact.js";
import { blockFormFor, type HookContext } from "../src/hooks/runtime.js";
import {
  declaredMaxLoad,
  planConsolidation,
  splitStateChunks,
} from "../src/hooks/stop.js";
import {
  buildSessionContext,
  extractStateSections,
  fallbackStateHead,
  MAX_SESSION_CONTEXT_CHARS,
} from "../src/hooks/session-start.js";
import {
  clip,
  domainPreferenceLines,
  isMicroTurn,
  MAX_INJECTION_CHARS,
  readRouteMeta,
  selectIndexFiles,
  userPromptSubmitHook,
} from "../src/hooks/user-prompt-submit.js";

function contextFor(
  vaultRoot: string,
  config: VaultConfig,
  payload: Record<string, unknown>,
): HookContext {
  return {
    event: "user-prompt-submit",
    payload,
    vaultRoot,
    config,
    deadline: Date.now() + 10_000,
  };
}

test("a micro turn never triggers an injection", () => {
  for (const prompt of [
    "ok",
    "yes please",
    "thanks, that works for me right now",
    "/route something",
    "supercalifragilistic",
    "and also do the same for the other file too",
    "",
    "   ",
  ]) {
    assert.equal(isMicroTurn(prompt), true, `should be a micro turn: ${prompt}`);
  }
});

test("a real request is not mistaken for an acknowledgement", () => {
  for (const prompt of [
    "Explain how the routing table decides which files to read first.",
    "android builds are failing since the last dependency bump, investigate",
    "goal: make the settings merge idempotent across two installs",
    "nothing works when the vault path contains a space, can you look",
  ]) {
    assert.equal(isMicroTurn(prompt), false, `should not be a micro turn: ${prompt}`);
  }
});

test("clip cuts on a word boundary and marks the cut", () => {
  assert.equal(clip("short enough", 40), "short enough");
  assert.equal(clip("  collapses   internal   spacing ", 40), "collapses internal spacing");
  const clipped = clip("one two three four five six seven eight", 20);
  assert.ok(clipped.endsWith("..."));
  assert.ok(clipped.length <= 23);
  assert.equal(clipped.includes("  "), false);
});

test("selectIndexFiles puts synthesis pages first and stops at three", () => {
  assert.deepEqual(
    selectIndexFiles(["a/detail.md", "b/_index.md", "c/_index.md", "d/detail.md", "e/_index.md"]),
    ["b/_index.md", "c/_index.md", "e/_index.md"],
  );
  assert.deepEqual(selectIndexFiles(["only.md"]), ["only.md"]);
  assert.deepEqual(selectIndexFiles([]), []);
});

test("readRouteMeta reads one route and survives a broken routing file", () => {
  const routing = [
    "routes:",
    "  wiring:",
    "    intent: wire things up",
    "    active_rule: \"Prefer the smallest change\"",
    "    triggers:",
    "      - hooks",
    "      - settings",
    "  other:",
    "    triggers:",
    "      - unrelated",
    "",
  ].join("\n");
  const meta = readRouteMeta(routing, "wiring");
  assert.deepEqual(meta.triggers, ["hooks", "settings"]);
  assert.equal(meta.activeRule, "Prefer the smallest change");

  assert.deepEqual(readRouteMeta(routing, "other").triggers, ["unrelated"]);
  assert.equal(readRouteMeta(routing, "other").activeRule, undefined);
  assert.deepEqual(readRouteMeta("::: not yaml :::", "wiring"), { triggers: [] });
  assert.deepEqual(readRouteMeta(routing, "absent"), { triggers: [] });
});

test("a preference is injected only when its whole domain belongs to the route", () => {
  const ledger = {
    preferences: [
      { id: "strong-match", weight: 5, apply: "Do the thing.", domains: ["hooks wiring"] },
      { id: "partial-match", weight: 5, apply: "Do it too.", domains: ["hooks pricing"] },
      { id: "too-light", weight: 3, apply: "Ignore me.", domains: ["hooks"] },
      { id: "retired", weight: 5, status: "retired", apply: "Gone.", domains: ["hooks"] },
      { id: "no-domain", weight: 5, apply: "Nowhere.", domains: [] },
      { id: "second-match", weight: 4, apply: "Also relevant.", domains: ["wiring"] },
    ],
  };
  const tokens = new Set(["hooks", "wiring", "settings"]);
  const lines = domainPreferenceLines(ledger, tokens);
  assert.deepEqual(lines, [
    "- strong-match: Do the thing.",
    "- second-match: Also relevant.",
  ]);
  assert.deepEqual(domainPreferenceLines(undefined, tokens), []);
  assert.deepEqual(domainPreferenceLines({ preferences: "nope" }, tokens), []);
});

test("invariant I11: the route injection is capped and reports its cost", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-hook-route-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "version: 1\nroot_label: Test\n",
    "utf8",
  );
  await writeFile(
    join(root, "00_index", "routing.yml"),
    [
      "always_read: []",
      "routes:",
      "  hook_wiring:",
      "    intent: wire the hooks into the host",
      "    active_rule: \"Never write outside the canonical layers\"",
      "    read_order:",
      "      - 20_contexts/_index.md",
      "      - 20_contexts/detail.md",
      "    triggers:",
      "      - idempotent settings merge",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "00_index", "catalog.json"),
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      root_label: "Test",
      records: [
        {
          path: "Test/20_contexts/_index.md",
          layer: "context",
          domain: "wiring",
          kind: "note",
          lifecycle: "working",
          tags: ["hooks"],
          summary: "Index of the wiring context",
          headings: [],
          links: [],
          sha256: "",
          size: 10,
          token_estimate: 3,
          read_priority: 50,
          source_state: "tracked",
          tier: "hot",
        },
      ],
    }),
    "utf8",
  );
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  await writeFile(
    join(root, "10_memory", "preferences", "_ledger.json"),
    JSON.stringify({
      schema_version: 3,
      preferences: [
        {
          id: "small-diffs",
          weight: 5,
          apply: "Keep the diff surgical.",
          domains: ["idempotent settings merge"],
        },
      ],
    }),
    "utf8",
  );

  const config = await loadConfig(root);
  const outcome = await userPromptSubmitHook(contextFor(root, config, {
    cwd: root,
    prompt: "Make the idempotent settings merge survive a third-party entry added in between.",
  }));

  assert.ok(outcome, "a confident route produced no injection");
  assert.ok(outcome.context);
  assert.match(outcome.context, /^SUGGESTED ROUTE: hook_wiring \(score \d+\)/u);
  assert.match(outcome.context, /READ FIRST: 20_contexts\/_index\.md/u);
  assert.match(outcome.context, /ACTIVE RULE: Never write outside the canonical layers/u);
  assert.match(outcome.context, /- small-diffs: Keep the diff surgical\./u);

  assert.ok(outcome.budget, "the injection did not report its cost");
  assert.equal(outcome.budget.chars, outcome.context.length);
  assert.ok(outcome.budget.chars <= MAX_INJECTION_CHARS);
  assert.ok(outcome.budget.token_estimate > 0);
  assert.equal(outcome.budget.truncated, false);

  // A prompt with no signal must not drag a route in behind it.
  const quiet = await userPromptSubmitHook(contextFor(root, config, {
    cwd: root,
    prompt: "Could you take a look at something unrelated for me this afternoon please.",
  }));
  assert.equal(quiet, undefined);
});

test("the session block keeps only state sections and falls back when there are none", () => {
  const state = [
    "---",
    "lifecycle: master",
    "---",
    "# Living state",
    "",
    "## Current work",
    "Building the hook layer.",
    "",
    "## Handoff",
    "Read me first.",
    "",
    "## Active workstreams (July)",
    "One, two, three.",
    "",
  ].join("\n");
  const sections = extractStateSections(state);
  assert.deepEqual(sections.map((section) => section.title), [
    "Current work",
    "Active workstreams (July)",
  ]);
  assert.deepEqual(sections[0]?.lines, ["## Current work", "Building the hook layer."]);

  assert.deepEqual(extractStateSections("---\nlifecycle: master\n---\nplain text\n"), []);
  const fallback = fallbackStateHead("---\nlifecycle: master\n---\nplain text\n");
  assert.equal(fallback.length, 1);
  assert.deepEqual(fallback[0]?.lines, ["plain text"]);
  assert.deepEqual(fallbackStateHead(""), []);
});

test("invariant I11: no state section can be starved by a long one", () => {
  const state = [
    "## Current work",
    ..."x".repeat(50_000).match(/.{1,200}/gu) ?? [],
    "## Active workstreams",
    "THE-LAST-SECTION-SURVIVES",
  ].join("\n");
  const block = buildSessionContext(
    "[open-brain] Test: 0 document(s) indexed, fresh (last scan now).",
    state,
    "10_memory/_state.md",
    MAX_SESSION_CONTEXT_CHARS,
  );
  assert.ok(block.text.length <= MAX_SESSION_CONTEXT_CHARS);
  assert.equal(block.budget.chars, block.text.length);
  assert.equal(block.budget.truncated, true);
  assert.match(block.text, /TRUNCATED/u);
  assert.match(block.text, /Active workstreams/u);
  assert.match(block.text, /THE-LAST-SECTION-SURVIVES/u);
});

test("the session block is just the status line when there is no state file", () => {
  const block = buildSessionContext(
    "[open-brain] Test: no index yet.",
    undefined,
    "10_memory/_state.md",
    MAX_SESSION_CONTEXT_CHARS,
  );
  assert.equal(block.text, "[open-brain] Test: no index yet.");
  assert.equal(block.budget.truncated, false);
});

test("front matter has to be closed and carry a value the scanner accepts", () => {
  assert.equal(hasLifecycleFrontmatter("---\nlifecycle: working\n---\n# Body\n"), true);
  assert.equal(hasLifecycleFrontmatter("---\nlifecycle: \"master\"\n---\n"), true);
  assert.equal(hasLifecycleFrontmatter("﻿---\nlifecycle: data\n---\n"), true);
  assert.equal(
    hasLifecycleFrontmatter("---\nlifecycle: working\n# never closed\n"),
    false,
    "an unterminated block is not front matter",
  );
  assert.equal(hasLifecycleFrontmatter("---\nlifecycle: invented\n---\n"), false);
  assert.equal(hasLifecycleFrontmatter("---\ntitle: no lifecycle\n---\n"), false);
  assert.equal(hasLifecycleFrontmatter("# No front matter at all\n"), false);
});

test("lint feedback names every offending path once", () => {
  assert.equal(
    renderLintFeedback([
      { path: "a/b.md", messages: ["first", "second"] },
      { path: "c.md", messages: ["third"] },
    ]),
    "[open-brain lint] a/b.md: first; second | c.md: third",
  );
});

test("a Codex patch becomes the same normalized changes as a Claude Code write", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: 20_contexts/new.md",
    "+---",
    "+lifecycle: working",
    "+---",
    "*** Update File: 20_contexts/old.md",
    "*** Move to: 20_contexts/moved.md",
    "+one added line",
    " context line",
    "*** Delete File: 20_contexts/gone.md",
    "*** End Patch",
  ].join("\n");
  const changes = parseApplyPatch(patch);
  assert.equal(changes.length, 3);

  const [added, moved, deleted] = changes;
  assert.ok(added);
  assert.ok(moved);
  assert.ok(deleted);
  assert.equal(added?.kind, "Add");
  assert.equal(added?.targetPath, "20_contexts/new.md");
  assert.deepEqual(added?.addedLines, ["---", "lifecycle: working", "---"]);
  assert.equal(isNewFile(added), true);

  assert.equal(moved?.kind, "Update");
  assert.equal(moved?.sourcePath, "20_contexts/old.md");
  assert.equal(moved?.targetPath, "20_contexts/moved.md");
  assert.deepEqual(moved?.addedLines, ["one added line"]);
  assert.equal(isNewFile(moved), true, "a move makes the destination new");

  assert.equal(deleted?.kind, "Delete");
  assert.deepEqual(deleted?.addedLines, []);
});

test("a command arrives as one string whether the host sends a string or a vector", () => {
  assert.equal(commandFromToolInput({ command: "git status" }), "git status");
  assert.equal(commandFromToolInput({ command: ["git", "status"] }), "git status");
  assert.equal(commandFromToolInput({ command: ["git", 3] }), undefined);
  assert.equal(commandFromToolInput({ command: [] }), undefined);
  assert.equal(commandFromToolInput({}), undefined);
});

test("changesFromPayload normalizes both hosts and ignores everything else", () => {
  assert.deepEqual(
    changesFromPayload({
      tool_name: "Write",
      tool_input: { file_path: "a.md", content: "one\ntwo" },
    }),
    [{ kind: "Write", sourcePath: "a.md", targetPath: "a.md", addedLines: ["one", "two"] }],
  );
  assert.deepEqual(
    changesFromPayload({
      tool_name: "Edit",
      tool_input: { path: "b.md", new_string: "added" },
    }),
    [{ kind: "Edit", sourcePath: "b.md", targetPath: "b.md", addedLines: ["added"] }],
  );
  assert.equal(
    changesFromPayload({
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: c.md\n+x\n*** End Patch" },
    }).length,
    1,
  );
  assert.deepEqual(changesFromPayload({ tool_name: "Read", tool_input: { file_path: "a" } }), []);
  assert.deepEqual(changesFromPayload({ tool_name: "Write", tool_input: "nope" }), []);
  assert.deepEqual(changesFromPayload({}), []);
});

test("the harness is recognised from the payload alone", () => {
  assert.equal(isCodexPayload({ turn_id: "abc123" }), true);
  assert.equal(isCodexPayload({ turn_id: "" }), false);
  assert.equal(isCodexPayload({ turn_id: "has a space" }), false);
  assert.equal(isCodexPayload({ turn_id: "x".repeat(257) }), false);
  assert.equal(isCodexPayload({ turn_id: 42 }), false);
  assert.equal(isCodexPayload({}), false, "Claude Code sends no turn identifier");

  assert.equal(isPlanPayload({ permission_mode: "plan" }), true);
  assert.equal(isPlanPayload({ permission_mode: "default" }), false);
  assert.equal(isPlanPayload({}), false);
});

test("the refusal form is chosen per event, and per host only where hosts differ", () => {
  assert.equal(blockFormFor("pre-tool-use", false), "permission-deny");
  assert.equal(blockFormFor("pre-tool-use", true), "permission-deny");
  assert.equal(blockFormFor("post-tool-use", false), "decision-block");
  assert.equal(blockFormFor("post-tool-use", true), "decision-block");
  assert.equal(blockFormFor("stop", true), "decision-block");
  assert.equal(blockFormFor("stop", false), "stderr-exit-2");
  for (const event of ["session-start", "user-prompt-submit", "pre-compact"] as const) {
    assert.equal(blockFormFor(event, false), "stderr-exit-2");
    assert.equal(blockFormFor(event, true), "stderr-exit-2");
  }
});

test("the load cap is read from the document and nowhere else", () => {
  assert.equal(declaredMaxLoad("---\nlifecycle: master\nmax_load: 26000\n---\nbody"), 26_000);
  assert.equal(declaredMaxLoad("---\nmax_load:   512\t\n---\n"), 512);
  assert.equal(declaredMaxLoad("---\nlifecycle: master\n---\nbody"), undefined);
  assert.equal(declaredMaxLoad("---\nmax_load: 0\n---\n"), undefined);
  assert.equal(declaredMaxLoad("---\nmax_load: lots\n---\n"), undefined);
  // Declared too far down the file to be a cheap read is declared nowhere.
  assert.equal(declaredMaxLoad("x".repeat(5_000) + "\nmax_load: 10\n"), undefined);
});

test("splitting a state file into chunks never changes a single character", () => {
  const bodies = [
    "",
    "no headings at all\n",
    "preamble\n\n## One\nalpha\n\n## Two\nbeta\n",
    "## One\nalpha\n## Two\n",
    "## Only\nno trailing newline",
  ];
  for (const body of bodies) {
    assert.equal(splitStateChunks(body).join(""), body, `round trip failed for ${body}`);
  }
  assert.deepEqual(splitStateChunks("## One\na\n## Two\nb\n"), ["## One\na\n", "## Two\nb\n"]);
});

test("invariant I11: consolidation moves the overflow and never loses a byte", () => {
  const body = "# Living state\n\n"
    + Array.from({ length: 20 }, (_, index) => `## Session ${String(index)}\n${"x".repeat(120)}\n`)
      .join("\n");
  const text = "---\nlifecycle: master\nmax_load: 1200\n---\n" + body;
  const plan = planConsolidation(text, "90_archive/state/_state-now.md");

  assert.ok(plan, "an overflowing file produced no plan");
  assert.ok(plan.keptText.length <= 1_200, `kept ${String(plan.keptText.length)} chars`);
  assert.ok(plan.movedChars > 0);
  assert.equal(plan.maxLoad, 1_200);
  assert.match(plan.keptText, /^---\nlifecycle: master\nmax_load: 1200\n---\n/u);
  // Truncation is announced where the user will actually see it.
  assert.match(plan.keptText, /90_archive\/state\/_state-now\.md/u);
  assert.match(plan.keptText, /Nothing was deleted/u);

  const keptBody = plan.keptText
    .replace(/^---\n[\s\S]*?\n---\n/u, "")
    .replace(/\n> \[open-brain\][^\n]*\n$/u, "");
  assert.equal(keptBody + plan.archivedBody, body, "a byte was lost or duplicated");
  assert.ok(keptBody.length > 0, "the living state was emptied");
});

test("consolidation declines rather than empty a file it cannot split", () => {
  assert.equal(
    planConsolidation("---\nmax_load: 10\n---\n" + "x".repeat(500), "a.md"),
    undefined,
    "a single chunk has nothing to move",
  );
  assert.equal(
    planConsolidation("---\nmax_load: 100000\n---\n## A\nshort\n## B\nshort\n", "a.md"),
    undefined,
    "a file under its cap is left alone",
  );
  assert.equal(
    planConsolidation("---\nlifecycle: master\n---\n## A\n" + "x".repeat(9_000), "a.md"),
    undefined,
    "no declared cap means no consolidation",
  );
});

test("pre-compact dispatches to a registered extractor and swallows its failures", async (t) => {
  t.after(() => registerPreCompactExtractor(undefined));
  const context: HookContext = {
    event: "pre-compact",
    payload: { trigger: "auto" },
    vaultRoot: "/nowhere",
    config: await loadConfig(await mkdtemp(join(tmpdir(), "open-brain-precompact-"))),
    deadline: Date.now() + 1_000,
  };

  assert.equal(getPreCompactExtractor(), undefined);
  assert.equal(await preCompactHook(context), undefined);

  registerPreCompactExtractor(async (received) => ({
    context: `extracted for ${String(received.payload.trigger)}`,
  }));
  assert.deepEqual(await preCompactHook(context), { context: "extracted for auto" });

  registerPreCompactExtractor(async () => {
    throw new Error("extractor exploded");
  });
  assert.equal(
    await preCompactHook(context),
    undefined,
    "a broken extractor must not break a compaction",
  );
});
