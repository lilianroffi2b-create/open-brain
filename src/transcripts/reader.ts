import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { emptyBudget, estimateTokens, type ContextBudget } from "../core/budget.js";
import type { VaultConfig } from "../core/types.js";
import type { Harness } from "../staging/types.js";
import { assertReadable, type ReadableTarget } from "./consent.js";
import {
  mergeRedactionCounts,
  redactText,
  totalRedactions,
  type RedactionCounts,
} from "./redact.js";

/**
 * Bounded reading of session transcripts, per invariant I11.
 *
 * A transcript directory on a working machine is measured in hundreds of
 * megabytes, and one file can be tens. Nothing here ever loads a whole file:
 * the reader takes a window of bytes from the end of the file, which is where
 * the recent turns are, plus a small probe of the head, which is where the
 * session metadata is. Both windows are capped, the number of lines parsed is
 * capped, the number of messages kept is capped, and every message is capped in
 * characters. What was left out is reported, never hidden.
 *
 * Reading the tail rather than the head is a deliberate asymmetry. A capture
 * organ wants what just happened; a head-first reader on a large file would
 * return the oldest turns of the session and would look like it worked.
 *
 * Provenance is checked before content. A sidechain, a subagent rollout, or a
 * guardian thread is not the user speaking, and material extracted from one
 * would be attributed to a human who never said it.
 */

export const DEFAULT_TAIL_BYTES = 512_000;
export const HEAD_PROBE_BYTES = 65_536;
export const DEFAULT_MAX_LINES = 4_000;
export const DEFAULT_MAX_MESSAGES = 40;
export const ASSISTANT_CONTEXT_CAP = 4_000;
export const MESSAGE_TEXT_CAP = 4_000;
const MAX_LINE_BYTES = 1_048_576;

/**
 * Tags that open a block a program wrote into the user's turn. The text after
 * one of them is machine output wearing a human role, and capturing it would
 * put the tool's own words in the user's mouth.
 */
export const MACHINE_WRAPPER_TAGS: readonly string[] = [
  "task-notification",
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "ide-opened-file",
  "ide_opened_file",
  "user-prompt-submit-hook",
  "environment-context",
  "environment_context",
  "app-context",
  "apps-instructions",
  "plugins-instructions",
  "skills-instructions",
  "permissions-instructions",
  "recommended-plugins",
];

export interface SessionMetadata {
  harness: Harness;
  session_id: string | null;
  transcript_path: string;
  rollout_id: string | null;
  source: string | null;
  originator: string | null;
  is_root: boolean;
}

export interface HumanMessage {
  harness: Harness;
  session_id: string | null;
  text: string;
  timestamp: string | null;
  turn_id: string | null;
  event_id: string | null;
  transcript_path: string;
  assistant_context: string | null;
}

export interface TranscriptRead {
  session: SessionMetadata;
  messages: HumanMessage[];
  budget: ContextBudget;
  bytes_read: number;
  lines_read: number;
  lines_skipped: number;
  window: "whole-file" | "tail";
  truncated: boolean;
  redacted: boolean;
  redactions: RedactionCounts;
}

export interface ReadOptions {
  maxBytes?: number | undefined;
  maxLines?: number | undefined;
  maxMessages?: number | undefined;
  redact?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clip(text: string, cap: number): string {
  const points = Array.from(text);
  return points.length <= cap ? text : points.slice(0, cap).join("");
}

/** True when the text is a block a program injected into the user's turn. */
export function isMachineWrapper(text: string): boolean {
  const head = text.trimStart();
  if (!head.startsWith("<")) {
    return false;
  }
  const closing = /^<\/?([a-zA-Z0-9_-]+)/u.exec(head);
  const tag = closing?.[1]?.toLowerCase();
  return tag !== undefined && MACHINE_WRAPPER_TAGS.includes(tag);
}

/**
 * Text of a message whatever shape the host used: a bare string, a list of
 * content blocks, or a payload field. Tool results and images contribute
 * nothing, which is what keeps a tool result from being read as a human turn.
 */
export function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
    return parts.join("\n");
  }
  if (isRecord(value)) {
    return extractText(value.content);
  }
  return "";
}

export function harnessFromPath(path: string): Harness | undefined {
  const parts = path.split(sep);
  if (parts.includes(".codex")) {
    return "codex";
  }
  if (parts.includes(".claude")) {
    return "claude-code";
  }
  return undefined;
}

export function harnessFromLine(line: Record<string, unknown>): Harness | undefined {
  const type = line.type;
  if (type === "session_meta" || type === "event_msg" || type === "response_item") {
    return "codex";
  }
  if (type === "user" || type === "assistant" || type === "summary") {
    return "claude-code";
  }
  return undefined;
}

interface WindowResult {
  bytes: number;
  lines: number;
  skipped: number;
  reachedLineCap: boolean;
}

/**
 * Streams a byte range and hands whole lines to the visitor. The stream is
 * destroyed the moment the line cap is reached, so a cap is an actual bound on
 * work done and not just on work reported.
 */
async function readWindow(
  path: string,
  start: number,
  end: number,
  maxLines: number,
  visit: (line: string) => void,
): Promise<WindowResult> {
  const stream = createReadStream(path, { start, end });
  // A window boundary can fall inside a multi-byte character, so the decoder
  // holds the incomplete tail rather than turning it into replacement noise.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  let lines = 0;
  let skipped = 0;
  let reachedLineCap = false;
  let dropFirst = start > 0;

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      pending += decoder.write(buffer);
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (dropFirst) {
          // The window began mid-line. That fragment is not a record.
          dropFirst = false;
        } else if (line.trim().length > 0) {
          lines += 1;
          if (line.length > MAX_LINE_BYTES) {
            skipped += 1;
          } else {
            visit(line);
          }
          if (lines >= maxLines) {
            reachedLineCap = true;
            stream.destroy();
            return { bytes, lines, skipped, reachedLineCap };
          }
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE_BYTES) {
        // A single line larger than the cap: drop what is buffered rather than
        // grow without a ceiling.
        pending = "";
        skipped += 1;
      }
    }
  } finally {
    stream.destroy();
  }

  pending += decoder.end();
  if (!dropFirst && pending.trim().length > 0 && pending.length <= MAX_LINE_BYTES) {
    lines += 1;
    visit(pending);
  }
  return { bytes, lines, skipped, reachedLineCap };
}

interface ParserState {
  harness: Harness;
  sessionId: string | null;
  rolloutId: string | null;
  source: string | null;
  originator: string | null;
  isRoot: boolean;
  pendingTurnId: string | null;
  assistant: string;
  messages: HumanMessage[];
  totalHuman: number;
}

function newState(harness: Harness): ParserState {
  return {
    harness,
    sessionId: null,
    rolloutId: null,
    source: null,
    originator: null,
    isRoot: true,
    pendingTurnId: null,
    assistant: "",
    messages: [],
    totalHuman: 0,
  };
}

/**
 * The Codex root check. A rollout that belongs to a subagent or a guardian is
 * another program's conversation, not the user's, so the whole file is refused
 * rather than filtered line by line.
 */
function readSessionMeta(state: ParserState, line: Record<string, unknown>): void {
  const payload = isRecord(line.payload) ? line.payload : line;
  state.sessionId = stringField(payload.id) ?? stringField(payload.session_id) ?? state.sessionId;
  state.rolloutId = stringField(payload.rollout_id) ?? stringField(payload.id) ?? state.rolloutId;
  state.originator = stringField(payload.originator);

  const source = payload.source;
  if (isRecord(source)) {
    state.source = stringField(source.type) ?? "object";
    if ("subagent" in source) {
      state.isRoot = false;
    }
  } else {
    state.source = stringField(source);
  }
  const threadSource = stringField(payload.thread_source);
  if (state.source === "subagent" || state.source === "guardian") {
    state.isRoot = false;
  }
  if (threadSource === "subagent" || threadSource === "guardian") {
    state.isRoot = false;
  }
  if (payload.parent_thread_id !== undefined && payload.parent_thread_id !== null) {
    state.isRoot = false;
  }
  if (payload.agent_path !== undefined && payload.agent_path !== null) {
    state.isRoot = false;
  }
}

function pushAssistant(state: ParserState, text: string): void {
  if (text.length === 0) {
    return;
  }
  const merged = state.assistant.length === 0 ? text : `${state.assistant}\n${text}`;
  state.assistant = clip(merged, ASSISTANT_CONTEXT_CAP);
}

function pushHuman(
  state: ParserState,
  transcriptPath: string,
  text: string,
  timestamp: string | null,
  turnId: string | null,
  eventId: string | null,
  maxMessages: number,
): void {
  state.totalHuman += 1;
  state.messages.push({
    harness: state.harness,
    session_id: state.sessionId,
    text: clip(text, MESSAGE_TEXT_CAP),
    timestamp,
    turn_id: turnId,
    event_id: eventId,
    transcript_path: transcriptPath,
    assistant_context: state.assistant.length === 0 ? null : state.assistant,
  });
  state.assistant = "";
  while (state.messages.length > maxMessages) {
    state.messages.shift();
  }
}

/**
 * Claude Code retains a user line when it is a real typed turn. The two
 * provenance fields the host sets are honoured exactly; a line that carries
 * neither is accepted, because several hosts write neither and refusing them
 * would make the reader silently return nothing on those hosts. Every other
 * filter still applies, so a tool result or an injected block is still dropped.
 */
function isHumanClaudeLine(line: Record<string, unknown>): boolean {
  if (line.isSidechain === true) {
    return false;
  }
  const userType = line.userType;
  if (userType !== undefined && userType !== null && userType !== "external") {
    return false;
  }
  const promptSource = line.promptSource;
  if (typeof promptSource === "string") {
    return promptSource === "typed" || promptSource === "queued";
  }
  const origin = line.origin;
  if (isRecord(origin)) {
    return origin.kind === "human";
  }
  return true;
}

function visitClaudeLine(
  state: ParserState,
  line: Record<string, unknown>,
  transcriptPath: string,
  maxMessages: number,
): void {
  state.sessionId = stringField(line.sessionId) ?? state.sessionId;
  if (line.type === "assistant") {
    pushAssistant(state, extractText(line.message));
    return;
  }
  if (line.type !== "user" || !isHumanClaudeLine(line)) {
    return;
  }
  const text = extractText(line.message).trim();
  if (text.length === 0 || isMachineWrapper(text)) {
    return;
  }
  pushHuman(
    state,
    transcriptPath,
    text,
    stringField(line.timestamp),
    stringField(line.turn_id),
    stringField(line.uuid) ?? stringField(line.id),
    maxMessages,
  );
}

function visitCodexLine(
  state: ParserState,
  line: Record<string, unknown>,
  transcriptPath: string,
  maxMessages: number,
): void {
  if (line.type === "session_meta") {
    readSessionMeta(state, line);
    return;
  }
  const payload = isRecord(line.payload) ? line.payload : {};
  if (line.type === "response_item") {
    // A response item never produces a message. It only carries the stable turn
    // identifier forward to the event that holds the same text.
    if (payload.role === "user") {
      state.pendingTurnId = stringField(payload.turn_id) ?? stringField(line.turn_id)
        ?? state.pendingTurnId;
    }
    return;
  }
  if (line.type !== "event_msg") {
    return;
  }
  if (payload.type === "agent_message") {
    pushAssistant(state, extractText(payload.message));
    return;
  }
  if (payload.type !== "user_message") {
    return;
  }
  const text = extractText(payload.message).trim();
  if (text.length === 0 || isMachineWrapper(text)) {
    return;
  }
  const turnId = stringField(line.turn_id) ?? stringField(payload.turn_id) ?? state.pendingTurnId;
  state.pendingTurnId = null;
  pushHuman(
    state,
    transcriptPath,
    text,
    stringField(line.timestamp) ?? stringField(payload.timestamp),
    turnId,
    stringField(line.id) ?? stringField(payload.id),
    maxMessages,
  );
}

function parseLine(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a transcript that the caller has already proved it may read.
 * `readConsentedTranscript` is the entry point every organ uses; this one is
 * exported for the vault-internal case and for tests that build their own
 * fixture files.
 */
export async function readTranscript(
  path: string,
  options: ReadOptions = {},
): Promise<TranscriptRead> {
  const maxBytes = options.maxBytes ?? DEFAULT_TAIL_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const redact = options.redact !== false;

  const info = await stat(path);
  const start = Math.max(0, info.size - maxBytes);
  let harness = harnessFromPath(path) ?? "unknown";
  let state = newState(harness);
  let bytes = 0;
  let lines = 0;
  let skipped = 0;

  if (start > 0) {
    // The head carries the session metadata, which the tail cannot contain.
    const probe = await readWindow(path, 0, HEAD_PROBE_BYTES - 1, 200, (raw) => {
      const line = parseLine(raw);
      if (line === undefined) {
        return;
      }
      if (harness === "unknown") {
        harness = harnessFromLine(line) ?? "unknown";
        state.harness = harness;
      }
      if (line.type === "session_meta") {
        readSessionMeta(state, line);
      }
      state.sessionId = state.sessionId ?? stringField(line.sessionId);
    });
    bytes += probe.bytes;
    skipped += probe.skipped;
  }

  const head = state;
  state = newState(harness);
  state.sessionId = head.sessionId;
  state.rolloutId = head.rolloutId;
  state.source = head.source;
  state.originator = head.originator;
  state.isRoot = head.isRoot;

  const window = await readWindow(path, start, Infinity, maxLines, (raw) => {
    const line = parseLine(raw);
    if (line === undefined) {
      skipped += 1;
      return;
    }
    if (harness === "unknown") {
      harness = harnessFromLine(line) ?? "unknown";
      state.harness = harness;
    }
    if (harness === "codex") {
      visitCodexLine(state, line, path, maxMessages);
      return;
    }
    visitClaudeLine(state, line, path, maxMessages);
  });
  bytes += window.bytes;
  lines += window.lines;
  skipped += window.skipped;

  const session: SessionMetadata = {
    harness: state.harness,
    session_id: state.sessionId,
    transcript_path: path,
    rollout_id: state.rolloutId,
    source: state.source,
    originator: state.originator,
    is_root: state.isRoot,
  };

  // A non-root rollout is somebody else's conversation. Nothing is returned
  // from it, and the caller is told why through is_root.
  const messages = state.isRoot ? state.messages : [];
  let counts: RedactionCounts = {};
  const finalMessages = messages.map((message) => {
    if (!redact) {
      return message;
    }
    const text = redactText(message.text);
    counts = mergeRedactionCounts(counts, text.counts);
    if (message.assistant_context === null) {
      return { ...message, text: text.text };
    }
    const context = redactText(message.assistant_context);
    counts = mergeRedactionCounts(counts, context.counts);
    return { ...message, text: text.text, assistant_context: context.text };
  });

  const chars = finalMessages.reduce((total, message) => total + message.text.length, 0);
  const truncated = start > 0 || window.reachedLineCap || state.totalHuman > finalMessages.length;
  const budget: ContextBudget = {
    chars,
    token_estimate: estimateTokens(finalMessages.map((message) => message.text).join("\n")),
    items_shown: finalMessages.length,
    items_total: state.totalHuman,
    truncated,
  };

  return {
    session,
    messages: finalMessages,
    budget,
    bytes_read: bytes,
    lines_read: lines,
    lines_skipped: skipped,
    window: start > 0 ? "tail" : "whole-file",
    truncated,
    redacted: totalRedactions(counts) > 0,
    redactions: counts,
  };
}

export interface ConsentedRead extends TranscriptRead {
  target: ReadableTarget;
}

/**
 * The only entry point an organ may use. Consent is decided before the path is
 * touched, and the vault configuration decides whether redaction applies unless
 * the caller overrides it explicitly.
 */
export async function readConsentedTranscript(
  vaultRoot: string,
  config: VaultConfig,
  path: string,
  options: ReadOptions = {},
): Promise<ConsentedRead> {
  const target = await assertReadable(vaultRoot, config, path);
  const redact = options.redact ?? config.capabilities.transcripts.redact;
  const read = await readTranscript(target.resolved, { ...options, redact });
  return { ...read, target };
}

export function emptyRead(path: string): TranscriptRead {
  return {
    session: {
      harness: "unknown",
      session_id: null,
      transcript_path: path,
      rollout_id: null,
      source: null,
      originator: null,
      is_root: true,
    },
    messages: [],
    budget: emptyBudget(),
    bytes_read: 0,
    lines_read: 0,
    lines_skipped: 0,
    window: "whole-file",
    truncated: false,
    redacted: false,
    redactions: {},
  };
}

/**
 * The identity of an observation, used to make a capture replayable without
 * doubling. An event identifier is preferred over a turn identifier, and a turn
 * over the text itself, so two distinct events in one turn stay two
 * observations and the same sentence in two sessions stays two observations.
 */
export function identityTokens(message: HumanMessage): {
  kind: "event" | "turn" | "quote";
  value: string;
} {
  if (message.event_id !== null) {
    return { kind: "event", value: message.event_id };
  }
  if (message.turn_id !== null) {
    return { kind: "turn", value: message.turn_id };
  }
  return { kind: "quote", value: message.text };
}
