import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "citty";

import { captureCommand } from "../src/cli/commands/capture.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import { getPreCompactExtractor, registerPreCompactExtractor } from "../src/hooks/pre-compact.js";
import type { HookContext } from "../src/hooks/runtime.js";
import {
  captureOperationId,
  depositsFromMessages,
  preCompactCapture,
  promptSubmitCapture,
  registerCaptureOrgans,
  renderCaptureLoaderLines,
  scanTranscriptForCandidates,
  sessionStartStagingReminder,
  turnEndCapture,
} from "../src/staging/capture.js";
import {
  defaultCaptureSettings,
  detectSignal,
  ENGLISH_MARKER_PACK,
  loadCaptureSettings,
  normalizeForMatch,
} from "../src/staging/markers.js";
import { mineTranscripts } from "../src/staging/mine.js";
import { listCandidates } from "../src/staging/store.js";
import type { HumanMessage } from "../src/transcripts/reader.js";

/**
 * The pre-filter and the organs that spend its verdict. Everything here runs
 * against fixture transcripts written into a temporary directory: no path, no
 * session, and no sentence in this file came from a real machine.
 */

const markers = defaultCaptureSettings().markers;

function message(text: string, overrides: Partial<HumanMessage> = {}): HumanMessage {
  return {
    harness: "claude-code",
    session_id: "session-a",
    text,
    timestamp: "2026-07-26T10:00:00Z",
    turn_id: null,
    event_id: null,
    transcript_path: "fixture.jsonl",
    assistant_context: null,
    ...overrides,
  };
}

test("the pre-filter ranks explicit requests above corrections above praise", () => {
  const explicit = detectSignal(
    { text: "From now on, keep the answers short.", hasAssistantContext: true },
    markers,
  );
  assert.equal(explicit.signal, "explicit_request");
  assert.deepEqual(explicit.markers, ["from now on"]);

  const correction = detectSignal(
    { text: "No, that is wrong, I told you to keep it short.", hasAssistantContext: true },
    markers,
  );
  assert.equal(correction.signal, "correction");
  assert.ok(correction.markers.includes("that is wrong"));

  // A message that both corrects and compliments is a correction.
  const both = detectSignal(
    { text: "That is wrong, though the structure is exactly right.", hasAssistantContext: true },
    markers,
  );
  assert.equal(both.signal, "correction");

  assert.equal(
    detectSignal({ text: "well done", hasAssistantContext: true }, markers).signal,
    "praise",
  );
  assert.equal(
    detectSignal({ text: "well done", hasAssistantContext: false }, markers).signal,
    "praise_weak",
    "praise with nothing to praise can never be approved",
  );
  assert.equal(
    detectSignal({ text: "Please open the file.", hasAssistantContext: true }, markers).signal,
    undefined,
  );
});

test("the pre-filter is accent-free, case-free, and bounded", () => {
  assert.equal(normalizeForMatch("  Frôm  NOW-on! "), " from now on ");
  assert.equal(
    detectSignal({ text: "FROM NOW ON: be brief", hasAssistantContext: false }, markers).signal,
    "explicit_request",
  );

  // Negation cancels praise.
  assert.equal(
    detectSignal({ text: "that is not exactly right", hasAssistantContext: true }, markers).signal,
    undefined,
  );
  // So does a metalinguistic frame.
  assert.equal(
    detectSignal(
      { text: "if it were exactly right I would tell you", hasAssistantContext: true },
      markers,
    ).signal,
    undefined,
  );

  // An essay is not a terse correction.
  const essay = `${"context ".repeat(400)}that is wrong`;
  assert.equal(detectSignal({ text: essay, hasAssistantContext: true }, markers).signal, undefined);

  // Markers are capped even when everything matches.
  const noisy = ENGLISH_MARKER_PACK.explicit_request.join(" and ");
  const detection = detectSignal({ text: noisy, hasAssistantContext: false }, markers);
  assert.ok(detection.markers.length <= markers.limits.max_markers_per_message);
});

test("marker lists, limits, and packs come from the vault config", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbrain-markers-"));
  try {
    await mkdir(join(root, "00_index"), { recursive: true });
    await writeFile(join(root, "00_index", "vault.config.yml"), [
      "version: 1",
      "capture:",
      "  markers:",
      "    packs: [en, klingon]",
      "    limits:",
      "      max_correction_chars: 40",
      "      max_markers_per_message: 2",
      "    custom:",
      "      - id: mine",
      "        explicit_request:",
      "          - grave ca",
      "  limits:",
      "    max_candidates_per_scan: 3",
      "    transcript_max_bytes: 4096",
      "",
    ].join("\n"), "utf8");

    const settings = await loadCaptureSettings(root);
    assert.equal(settings.source, "vault-config");
    assert.deepEqual(settings.unknown_packs, ["klingon"]);
    assert.deepEqual(settings.markers.packs.map((pack) => pack.id), ["en", "mine"]);
    assert.equal(settings.markers.limits.max_correction_chars, 40);
    assert.equal(settings.markers.limits.max_markers_per_message, 2);
    assert.equal(settings.limits.max_candidates_per_scan, 3);
    assert.equal(settings.limits.transcript_max_bytes, 4_096);
    assert.equal(
      settings.limits.max_messages_per_scan,
      defaultCaptureSettings().limits.max_messages_per_scan,
      "an absent key keeps its default",
    );

    // A user pack in another language fires on the mechanism alone.
    assert.equal(
      detectSignal({ text: "Grave ca, s'il te plait", hasAssistantContext: false }, settings.markers)
        .signal,
      "explicit_request",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture identity is stable, session scoped, and refuses to be invented", () => {
  const withEvent = message("a sentence", { event_id: "event-1" });
  assert.equal(captureOperationId(withEvent), captureOperationId({ ...withEvent }));
  assert.notEqual(
    captureOperationId(withEvent),
    captureOperationId({ ...withEvent, session_id: "session-b" }),
  );
  assert.notEqual(
    captureOperationId(withEvent),
    captureOperationId({ ...withEvent, event_id: "event-2" }),
    "two distinct events in one session stay two observations",
  );
  assert.equal(captureOperationId(message("x", { session_id: null })), null);
  assert.equal(captureOperationId(message("x", { harness: "unknown" })), null);
});

test("the deposit keeps the user's own words, redacted, and caps the batch", () => {
  const config = configWith({ capture: true });
  const settings = defaultCaptureSettings();
  settings.limits.max_candidates_per_scan = 2;

  const deposits = depositsFromMessages(
    config,
    [
      message("from now on, use my address someone@example.com", { event_id: "e1" }),
      message("nothing to see here", { event_id: "e2" }),
      message("from now on, be brief", { event_id: "e3" }),
      message("from now on, be very brief", { event_id: "e4" }),
    ],
    "pre_compact",
    settings,
  );

  assert.equal(deposits.length, 2, "the batch cap keeps the most recent matches");
  assert.equal(deposits[0]?.request.raw_quote, "from now on, be brief");
  const quotes = deposits.map((deposit) => String(deposit.request.raw_quote));
  assert.equal(quotes.some((quote) => quote.includes("example.com")), false);

  const single = depositsFromMessages(
    config,
    [message("from now on, use my address someone@example.com", { event_id: "e1" })],
    "pre_compact",
    settings,
  );
  assert.match(String(single[0]?.request.raw_quote), /\[redacted:email\]/u);
  assert.deepEqual(single[0]?.request.raw_markers, ["from now on"]);
});

function configWith(overrides: {
  capture?: boolean;
  transcripts?: boolean;
  roots?: string[];
  redact?: boolean;
}): VaultConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: {
      ...DEFAULT_CONFIG.capabilities,
      capture: { enabled: overrides.capture === true },
      transcripts: {
        enabled: overrides.transcripts === true,
        roots: overrides.roots ?? [],
        redact: overrides.redact !== false,
      },
    },
  };
}

function claudeUser(text: string, index: number, session = "session-a"): string {
  return JSON.stringify({
    type: "user",
    uuid: `uuid-${session}-${String(index)}`,
    sessionId: session,
    timestamp: "2026-07-26T10:00:00Z",
    promptSource: "typed",
    message: { role: "user", content: text },
  });
}

interface Fixture {
  root: string;
  sessions: string;
  transcript: string;
  config: VaultConfig;
}

async function newFixture(lines?: readonly string[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "openbrain-capture-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");

  const sessions = await mkdtemp(join(tmpdir(), "openbrain-capture-sessions-"));
  const transcript = join(sessions, "session.jsonl");
  const assistant = (text: string): string => JSON.stringify({
    type: "assistant",
    sessionId: "session-a",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const body = lines ?? [
    assistant("Done."),
    claudeUser("From now on, keep answers short.", 1),
    claudeUser("just a normal follow up question", 2),
    assistant("Here is the shorter version."),
    claudeUser("well done", 3),
  ];
  await writeFile(transcript, body.join("\n") + "\n", "utf8");

  return {
    root,
    sessions,
    transcript,
    config: configWith({ capture: true, transcripts: true, roots: [sessions] }),
  };
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
  await rm(fixture.sessions, { recursive: true, force: true });
}

function context(fixture: Fixture, payload: Record<string, unknown>): HookContext {
  return {
    event: "pre-compact",
    payload,
    vaultRoot: fixture.root,
    config: fixture.config,
    deadline: Date.now() + 5_000,
  };
}

test("replaying a scan never files the same candidate twice", async () => {
  const fixture = await newFixture();
  try {
    const first = await scanTranscriptForCandidates(
      fixture.root,
      fixture.config,
      fixture.transcript,
    );
    assert.equal(first.filed, 2, "the explicit request and the grounded praise");
    assert.deepEqual(
      first.staged.map((row) => row.signal).sort(),
      ["explicit_request", "praise"],
    );

    const second = await scanTranscriptForCandidates(
      fixture.root,
      fixture.config,
      fixture.transcript,
    );
    assert.equal(second.filed, 0, "a replay files nothing");
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 2);

    // A new message in the same session is still captured after the replay.
    await writeFile(
      fixture.transcript,
      [
        claudeUser("From now on, keep answers short.", 1),
        claudeUser("well done", 3),
        claudeUser("Remember this: always run the tests.", 4),
      ].join("\n") + "\n",
      "utf8",
    );
    const third = await scanTranscriptForCandidates(
      fixture.root,
      fixture.config,
      fixture.transcript,
    );
    assert.equal(third.filed, 1);
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 3);
  } finally {
    await dropFixture(fixture);
  }
});

test("a dry run reads and reports without writing anything", async () => {
  const fixture = await newFixture();
  try {
    const disarmed = configWith({ transcripts: true, roots: [fixture.sessions] });
    const result = await scanTranscriptForCandidates(
      fixture.root,
      disarmed,
      fixture.transcript,
      { dryRun: true },
    );
    assert.equal(result.dry_run, true);
    assert.equal(result.matched, 2);
    assert.equal(result.filed, 0);
    assert.deepEqual(await listCandidates(fixture.root, disarmed), []);
  } finally {
    await dropFixture(fixture);
  }
});

test("a transcript copied into the vault is scannable with transcripts disarmed", async () => {
  const fixture = await newFixture();
  try {
    // The last rung of the degradation ladder: no hooks, no consented
    // directory, and the user hands the vault a copy of their own session.
    const inside = join(fixture.root, "40_sources", "session.jsonl");
    await mkdir(join(fixture.root, "40_sources"), { recursive: true });
    await writeFile(
      inside,
      [claudeUser("From now on, keep answers short.", 1)].join("\n") + "\n",
      "utf8",
    );
    const captureOnly = configWith({ capture: true });
    const result = await scanTranscriptForCandidates(fixture.root, captureOnly, inside);
    assert.equal(result.filed, 1);
    assert.equal((await listCandidates(fixture.root, captureOnly)).length, 1);
  } finally {
    await dropFixture(fixture);
  }
});

test("every organ stays silent and writes nothing while capture is disarmed", async () => {
  const fixture = await newFixture();
  const disarmed = configWith({ transcripts: true, roots: [fixture.sessions] });
  const disarmedContext = {
    event: "stop" as const,
    payload: {
      transcript_path: fixture.transcript,
      session_id: "session-a",
      prompt: "From now on, keep answers short.",
    },
    vaultRoot: fixture.root,
    config: disarmed,
    deadline: Date.now() + 5_000,
  };
  try {
    assert.equal(await promptSubmitCapture(disarmedContext), undefined);
    assert.equal(await turnEndCapture(disarmedContext), undefined);
    assert.equal(await preCompactCapture(disarmedContext), undefined);
    assert.deepEqual(await listCandidates(fixture.root, disarmed), []);
  } finally {
    await dropFixture(fixture);
  }
});

test("the prompt organ files an explicit request and only that", async () => {
  const fixture = await newFixture();
  try {
    await promptSubmitCapture(context(fixture, {
      prompt: "From now on, keep answers short.",
      session_id: "session-a",
      event_id: "event-1",
    }));
    const staged = await listCandidates(fixture.root, fixture.config);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.source, "prompt_submit");
    assert.equal(staged[0]?.signal, "explicit_request");

    // A replay of the same prompt is the same observation.
    await promptSubmitCapture(context(fixture, {
      prompt: "From now on, keep answers short.",
      session_id: "session-a",
      event_id: "event-1",
    }));
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 1);

    // A correction in a prompt is left to the end-of-turn organ, which can see
    // what it is correcting.
    await promptSubmitCapture(context(fixture, {
      prompt: "No, that is wrong.",
      session_id: "session-a",
      event_id: "event-2",
    }));
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 1);

    // Plan mode is inert.
    await promptSubmitCapture(context(fixture, {
      prompt: "Remember this: always run the tests.",
      session_id: "session-a",
      event_id: "event-3",
      permission_mode: "plan",
    }));
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 1);
  } finally {
    await dropFixture(fixture);
  }
});

test("the end-of-turn organ files the last human message and respects the loop guard", async () => {
  const fixture = await newFixture();
  try {
    await turnEndCapture(context(fixture, {
      transcript_path: fixture.transcript,
      stop_hook_active: true,
    }));
    assert.deepEqual(await listCandidates(fixture.root, fixture.config), []);

    await turnEndCapture(context(fixture, { transcript_path: fixture.transcript }));
    const staged = await listCandidates(fixture.root, fixture.config);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.source, "turn_end");
    assert.equal(staged[0]?.raw_quote, "well done");
    assert.equal(staged[0]?.signal, "praise", "the assistant context proves the praise");
  } finally {
    await dropFixture(fixture);
  }
});

test("the pre-compaction organ files a batch, reports it, and registers itself", async () => {
  const fixture = await newFixture();
  const previous = getPreCompactExtractor();
  try {
    registerCaptureOrgans();
    const extractor = getPreCompactExtractor();
    assert.equal(typeof extractor, "function");

    const outcome = await preCompactCapture(context(fixture, {
      transcript_path: fixture.transcript,
      trigger: "auto",
    }));
    assert.equal(outcome?.context, undefined, "a compaction hook never writes to stdout");
    assert.match(String(outcome?.notice), /Filed 2 candidate\(s\)/u);
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 2);

    // An automatic compaction can fire twice on the same material.
    const replay = await preCompactCapture(context(fixture, {
      transcript_path: fixture.transcript,
      trigger: "auto",
    }));
    assert.equal(replay, undefined);
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 2);
  } finally {
    registerPreCompactExtractor(previous);
    await dropFixture(fixture);
  }
});

test("the session reminder counts what is waiting, or says nothing", async () => {
  const fixture = await newFixture();
  try {
    assert.equal(await sessionStartStagingReminder(context(fixture, {})), undefined);

    await scanTranscriptForCandidates(fixture.root, fixture.config, fixture.transcript);
    const outcome = await sessionStartStagingReminder(context(fixture, {}));
    assert.match(String(outcome?.context), /2 staged item\(s\) await review/u);
    assert.match(String(outcome?.context), /human-initiated only/u);
    assert.equal(outcome?.budget?.truncated, false);
    assert.ok((outcome?.budget?.chars ?? 0) > 0);

    // An unreadable store never reports an empty queue.
    await writeFile(
      join(fixture.root, "10_memory", "staging", "candidates.jsonl"),
      "{ not json\n",
      "utf8",
    );
    const broken = await sessionStartStagingReminder(context(fixture, {}));
    assert.match(String(broken?.context), /Staging status unavailable/u);
    assert.match(String(broken?.context), /Do not conclude that nothing is staged/u);
  } finally {
    await dropFixture(fixture);
  }
});

test("mining reports corrections that recur across distinct sessions", async () => {
  const fixture = await newFixture();
  try {
    for (const session of ["session-a", "session-b", "session-c"]) {
      await writeFile(
        join(fixture.sessions, `${session}.jsonl`),
        [
          claudeUser("No, that is wrong, the changelog entry is missing again.", 1, session),
          claudeUser("please continue", 2, session),
        ].join("\n") + "\n",
        "utf8",
      );
    }
    const report = await mineTranscripts(fixture.root, fixture.config, {
      minOccurrences: 3,
      minSessions: 3,
    });
    assert.ok(report.files_examined >= 3);
    assert.ok(report.corrections_found >= 3);
    assert.ok(
      report.clusters.some((cluster) => cluster.token === "changelog"),
      "a word repeated across three sessions surfaces",
    );
    const cluster = report.clusters.find((item) => item.token === "changelog");
    assert.equal(cluster?.sessions, 3);
    assert.ok((cluster?.samples.length ?? 0) > 0, "the report shows the sentence behind the token");
    assert.equal(report.budget.items_shown, report.clusters.length);
  } finally {
    await dropFixture(fixture);
  }
});

test("the loader block replaces the events for a CLI with no hooks", () => {
  const withCapture = renderCaptureLoaderLines(true).join("\n");
  assert.match(withCapture, /open-brain staging status/u);
  assert.match(withCapture, /open-brain staging add/u);
  assert.match(withCapture, /open-brain capture scan --transcript/u);
  assert.match(withCapture, /human-initiated only/u);

  const withoutCapture = renderCaptureLoaderLines(false).join("\n");
  assert.equal(withoutCapture.includes("capture scan"), false);
});

interface CapturedRun {
  output: unknown;
  raw: string;
}

async function runCli(rawArgs: string[]): Promise<CapturedRun> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCommand(captureCommand, { rawArgs });
  } finally {
    process.stdout.write = original;
  }
  const first = captured.indexOf("{");
  const json = first === -1 ? "" : captured.slice(first, captured.lastIndexOf("}") + 1);
  return { output: json.length === 0 ? undefined : (JSON.parse(json) as unknown), raw: captured };
}

test("capture markers prints the filter in force and the keys that configure it", async () => {
  const fixture = await newFixture();
  try {
    const run = await runCli(["markers", "--root", fixture.root, "--test", "Frôm NOW on"]);
    const output = run.output as Record<string, unknown>;
    assert.equal(output.source, "defaults");
    assert.equal(output.normalized, "from now on");
    assert.ok(Array.isArray(output.config_keys));
    assert.ok((output.config_keys as string[]).includes("capture.markers.custom"));
    assert.match(run.raw, /generic English/u);
  } finally {
    await dropFixture(fixture);
  }
});

test("capture scan is the pre-compaction organ made manual", async () => {
  const fixture = await newFixture();
  try {
    await writeFile(join(fixture.root, "00_index", "vault.config.yml"), [
      "version: 1",
      "capabilities:",
      "  capture:",
      "    enabled: true",
      "  transcripts:",
      "    enabled: true",
      "    roots:",
      `      - ${JSON.stringify(fixture.sessions)}`,
      "",
    ].join("\n"), "utf8");

    const dry = await runCli([
      "scan",
      "--root",
      fixture.root,
      "--transcript",
      fixture.transcript,
      "--dry-run",
    ]);
    const dryOutput = dry.output as Record<string, unknown>;
    assert.equal(dryOutput.dry_run, true);
    assert.equal(dryOutput.filed, 0);
    assert.deepEqual(await listCandidates(fixture.root, fixture.config), []);

    const run = await runCli(["scan", "--root", fixture.root, "--transcript", fixture.transcript]);
    const output = run.output as Record<string, unknown>;
    assert.equal(output.filed, 2);
    assert.equal((await listCandidates(fixture.root, fixture.config)).length, 2);
  } finally {
    await dropFixture(fixture);
  }
});
