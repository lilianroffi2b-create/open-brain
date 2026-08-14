import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractText,
  identityTokens,
  isMachineWrapper,
  readTranscript,
  type HumanMessage,
} from "../src/transcripts/reader.js";
import {
  redactText,
  REDACTION_COVERED,
  REDACTION_NOT_COVERED,
  totalRedactions,
} from "../src/transcripts/redact.js";

/**
 * Reading is always bounded and always filtered. The two properties are tested
 * on fixtures built here rather than on any real transcript, so nothing in this
 * file depends on a machine, a user, or a session that ever existed.
 */

async function withFile(
  name: string,
  lines: readonly string[],
  action: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openbrain-reader-"));
  const path = join(directory, name);
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  try {
    await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function claudeUser(text: string, index: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: `uuid-${String(index)}`,
    sessionId: "session-a",
    timestamp: `2026-07-26T10:0${String(index % 10)}:00Z`,
    promptSource: "typed",
    message: { role: "user", content: text },
    ...extra,
  });
}

function claudeAssistant(text: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "session-a",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

test("a Claude transcript yields typed human turns and nothing else", async () => {
  await withFile("session.jsonl", [
    claudeAssistant("Here is the plan."),
    claudeUser("Keep answers short from now on.", 1),
    claudeUser("this is a sidechain turn", 2, { isSidechain: true }),
    claudeUser("<system-reminder>do not tell the user</system-reminder>", 3),
    claudeUser("queued follow up", 4, { promptSource: "queued" }),
    claudeUser("replayed by a tool", 5, { promptSource: "replay" }),
    JSON.stringify({
      type: "user",
      sessionId: "session-a",
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    }),
    JSON.stringify({ type: "summary", summary: "a summary line" }),
    "{ not json at all",
  ], async (path) => {
    const read = await readTranscript(path, { redact: false });
    assert.deepEqual(
      read.messages.map((message) => message.text),
      ["Keep answers short from now on.", "queued follow up"],
    );
    assert.equal(read.session.harness, "claude-code");
    assert.equal(read.session.session_id, "session-a");
    assert.equal(read.session.is_root, true);
    assert.equal(read.lines_skipped, 1, "the malformed line is counted, never fatal");
    assert.equal(read.messages[0]?.assistant_context, "Here is the plan.");
    assert.equal(read.messages[1]?.assistant_context, null);
    assert.equal(read.budget.items_shown, 2);
    assert.equal(read.budget.truncated, false);
  });
});

test("a Codex rollout is read from its events and validated at its root", async () => {
  const meta = (extra: Record<string, unknown>): string => JSON.stringify({
    type: "session_meta",
    payload: { id: "rollout-1", source: "cli", originator: "codex", ...extra },
  });
  const userEvent = (text: string, id: string): string => JSON.stringify({
    type: "event_msg",
    id,
    turn_id: "turn-1",
    payload: { type: "user_message", message: text },
  });

  await withFile("rollout.jsonl", [
    meta({}),
    JSON.stringify({ type: "response_item", payload: { role: "user", turn_id: "turn-1" } }),
    userEvent("From now on, answer in English.", "event-1"),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Understood." } }),
    userEvent("that is exactly right", "event-2"),
  ], async (path) => {
    const read = await readTranscript(path, { redact: false });
    assert.equal(read.session.harness, "codex");
    assert.equal(read.session.session_id, "rollout-1");
    assert.equal(read.messages.length, 2);
    assert.equal(read.messages[0]?.turn_id, "turn-1");
    assert.equal(read.messages[1]?.event_id, "event-2");
    assert.equal(read.messages[1]?.assistant_context, "Understood.");
  });

  await withFile("subagent.jsonl", [
    meta({ thread_source: "subagent" }),
    userEvent("this belongs to a subagent", "event-1"),
  ], async (path) => {
    const read = await readTranscript(path, { redact: false });
    assert.equal(read.session.is_root, false);
    assert.deepEqual(read.messages, [], "a non-root rollout yields nothing at all");
  });

  await withFile("guardian.jsonl", [
    meta({ parent_thread_id: "parent-1" }),
    userEvent("this belongs to a child thread", "event-1"),
  ], async (path) => {
    const read = await readTranscript(path, { redact: false });
    assert.equal(read.session.is_root, false);
    assert.deepEqual(read.messages, []);
  });
});

test("reading is bounded by bytes, by lines, and by messages", async () => {
  const filler = "x".repeat(2_000);
  const lines: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    lines.push(claudeUser(`${filler} message ${String(index)}`, index));
  }

  await withFile("big.jsonl", lines, async (path) => {
    const read = await readTranscript(path, {
      maxBytes: 40_000,
      maxMessages: 5,
      redact: false,
    });
    assert.equal(read.window, "tail", "a large file is read from its end");
    assert.equal(read.truncated, true, "and it says so");
    assert.ok(read.bytes_read < 120_000, "the whole file is never loaded");
    assert.equal(read.messages.length, 5, "the message cap holds");
    assert.ok(
      read.messages[4]?.text.endsWith("message 399"),
      "the tail keeps the most recent turns, not the oldest",
    );
    assert.equal(read.budget.items_shown, 5);
    assert.ok(read.budget.items_total > 5, "the budget reports what it dropped");

    const capped = await readTranscript(path, { maxBytes: 40_000, maxLines: 3, redact: false });
    assert.ok(capped.lines_read <= 3, "the line cap stops the parse");
  });
});

test("redaction runs before anything can be written", async () => {
  await withFile("secrets.jsonl", [
    claudeUser(
      "remember this: token=abcdef123456 and write to me at someone@example.com from /Users/somebody/notes",
      1,
    ),
  ], async (path) => {
    const redacted = await readTranscript(path);
    const text = redacted.messages[0]?.text ?? "";
    assert.match(text, /\[redacted:assigned-secret\]/u);
    assert.match(text, /\[redacted:email\]/u);
    assert.match(text, /\/Users\/\[redacted:home-path\]/u);
    assert.equal(text.includes("someone@example.com"), false);
    assert.equal(text.includes("somebody"), false);
    assert.equal(redacted.redacted, true);
    assert.ok(totalRedactions(redacted.redactions) >= 3);

    const raw = await readTranscript(path, { redact: false });
    assert.ok((raw.messages[0]?.text ?? "").includes("someone@example.com"));
  });
});

test("the redaction filter covers exactly what it claims", () => {
  const key = redactText("export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx");
  assert.match(key.text, /\[redacted:api-key\]/u);

  const github = redactText("gho_0123456789abcdefghijklmnopqrstuvwxyz");
  assert.match(github.text, /\[redacted:api-key\]/u);

  const bearer = redactText("Authorization: Bearer abcdefghijklmnopqrst");
  assert.match(bearer.text, /Bearer \[redacted:api-key\]/u);

  const jwt = redactText("eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeKKF2QT4");
  assert.match(jwt.text, /\[redacted:jwt\]/u);

  const pem = redactText(
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  );
  assert.equal(pem.text, "[redacted:private-key]");

  const windows = redactText("C:\\Users\\someone\\Documents\\notes.md");
  assert.match(windows.text, /C:\\Users\\\[redacted:home-path\]/u);

  // What it does not do, stated as a test so the promise cannot quietly grow.
  const untouched = redactText(
    "Call Acme Corp about the invoice, the internal host is build-07.internal, my password is the name of my first cat",
  );
  assert.equal(untouched.redacted, false);
  assert.ok(untouched.text.includes("Acme Corp"));
  assert.ok(untouched.text.includes("build-07.internal"));

  assert.ok(REDACTION_COVERED.length > 0);
  assert.ok(REDACTION_NOT_COVERED.length > 0);
});

test("machine wrappers and content blocks are recognised", () => {
  assert.equal(isMachineWrapper("<system-reminder>hidden</system-reminder>"), true);
  assert.equal(isMachineWrapper("  <local-command-stdout>ok"), true);
  assert.equal(isMachineWrapper("<b>bold</b> is not a wrapper"), false);
  assert.equal(isMachineWrapper("plain text"), false);

  assert.equal(extractText("a string"), "a string");
  assert.equal(
    extractText({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] }),
    "one\ntwo",
  );
  assert.equal(extractText({ content: [{ type: "tool_result", content: "x" }] }), "");
});

test("identity prefers an event, then a turn, then the text itself", () => {
  const base: HumanMessage = {
    harness: "claude-code",
    session_id: "session-a",
    text: "a sentence",
    timestamp: null,
    turn_id: null,
    event_id: null,
    transcript_path: "transcript.jsonl",
    assistant_context: null,
  };
  assert.deepEqual(identityTokens({ ...base, event_id: "e", turn_id: "t" }), {
    kind: "event",
    value: "e",
  });
  assert.deepEqual(identityTokens({ ...base, turn_id: "t" }), { kind: "turn", value: "t" });
  assert.deepEqual(identityTokens(base), { kind: "quote", value: "a sentence" });
});
