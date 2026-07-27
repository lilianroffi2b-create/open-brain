import { join } from "node:path";

import { capText, type ContextBudget } from "../core/budget.js";
import type { VaultConfig } from "../core/types.js";
import { sessionStartStagingReminder } from "../staging/capture.js";
import {
  composeHookOutcomes,
  overBudget,
  runOrgan,
  type HookContext,
  type HookOutcome,
} from "./runtime.js";
import { readTextFile, stateFilePath, stateRelativePath } from "./vault.js";

/**
 * Moves "where are we" from a file the assistant has to remember to open into
 * the context it already has at the first token of a session.
 *
 * The index status is read from the freshness artifact and never recomputed:
 * walking a vault to answer a question a session-start hook asks would cost
 * every session more than the answer is worth. `open-brain health` is the deep
 * check, and it is a command, not a hook.
 */

export const MAX_SESSION_CONTEXT_CHARS = 4_000;
export const MIN_SECTION_CHARS = 400;
export const FALLBACK_LINE_CHARS = 320;
export const FALLBACK_MAX_LINES = 40;
const FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Headings whose content is session state rather than instructions. Matching is
 * by prefix, so "Current work (2026-07)" is picked up along with "Current work".
 */
export const STATE_SECTION_HEADERS = [
  "Current session",
  "Current work",
  "Active workstreams",
];

interface StateSection {
  title: string;
  lines: string[];
}

function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function isHeading(line: string): boolean {
  return line.trimStart().startsWith("## ");
}

function headingTitle(line: string): string {
  return line.trim().slice(3).trim();
}

/** Sections whose heading is one the injector cares about, in file order. */
export function extractStateSections(text: string): StateSection[] {
  const sections: StateSection[] = [];
  let current: StateSection | undefined;

  for (const rawLine of stripFrontmatter(text).split(/\r?\n/u)) {
    if (isHeading(rawLine)) {
      const title = headingTitle(rawLine);
      const wanted = STATE_SECTION_HEADERS.some((header) => title.startsWith(header));
      current = wanted ? { title, lines: [rawLine.trimEnd()] } : undefined;
      if (current) {
        sections.push(current);
      }
      continue;
    }
    if (current && rawLine.trim().length > 0) {
      current.lines.push(rawLine.trimEnd());
    }
  }
  return sections;
}

/**
 * Used when a state file predates the section convention: the head of the file,
 * with each line clipped, so one very long line cannot eat the whole budget.
 */
export function fallbackStateHead(text: string): StateSection[] {
  const lines = stripFrontmatter(text)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, FALLBACK_MAX_LINES)
    .map((line) => (
      line.length > FALLBACK_LINE_CHARS
        ? line.slice(0, FALLBACK_LINE_CHARS) + "..."
        : line
    ));
  return lines.length === 0 ? [] : [{ title: "header", lines }];
}

interface FreshnessSummary {
  documents: number;
  generatedAt: string;
}

function readFreshnessSummary(value: unknown): FreshnessSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...value };
  const documents = record.source_count;
  const generatedAt = record.generated_at;
  if (typeof documents !== "number" || typeof generatedAt !== "string") {
    return undefined;
  }
  return { documents, generatedAt };
}

async function indexStatusLine(
  vaultRoot: string,
  config: VaultConfig,
  now: number,
): Promise<string> {
  const text = await readTextFile(join(vaultRoot, config.paths.freshness));
  if (text === undefined) {
    return `[open-brain] ${config.root_label}: no index yet. Run "open-brain scan".`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return `[open-brain] ${config.root_label}: the index is unreadable. Run "open-brain scan".`;
  }
  const summary = readFreshnessSummary(parsed);
  if (summary === undefined) {
    return `[open-brain] ${config.root_label}: the index is unreadable. Run "open-brain scan".`;
  }
  const generated = Date.parse(summary.generatedAt);
  const stale = Number.isNaN(generated) || now - generated > FRESHNESS_MAX_AGE_MS;
  const state = stale ? "stale, run \"open-brain scan\"" : "fresh";
  return `[open-brain] ${config.root_label}: ${String(summary.documents)} document(s) indexed, ${state} (last scan ${summary.generatedAt}).`;
}

export interface SessionContextBlock {
  text: string;
  budget: ContextBudget;
}

/**
 * Builds the injected block under a hard character cap, splitting the budget
 * across sections so a long first section can never silence a later one, and
 * leaving a truncation notice wherever it cut.
 */
export function buildSessionContext(
  statusLine: string,
  stateText: string | undefined,
  stateRelative: string,
  maxChars: number,
): SessionContextBlock {
  const sections = stateText === undefined
    ? []
    : (() => {
      const found = extractStateSections(stateText);
      return found.length > 0 ? found : fallbackStateHead(stateText);
    })();

  const totalLines = 1 + sections.reduce((total, section) => total + section.lines.length, 0);
  if (sections.length === 0) {
    const capped = capText(statusLine, maxChars, totalLines);
    return { text: capped.text, budget: capped.budget };
  }

  const header = `[open-brain] Living state, from ${stateRelative}:`;
  const perSection = Math.max(MIN_SECTION_CHARS, Math.floor(maxChars / sections.length));
  const parts = sections
    .map((section) => capText(section.lines.join("\n"), perSection).text)
    .filter((part) => part.length > 0);
  const merged = [statusLine, header, ...parts].join("\n");
  const capped = capText(merged, maxChars, totalLines + 1);
  return { text: capped.text, budget: capped.budget };
}

export async function sessionStartHook(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  const statusLine = await indexStatusLine(context.vaultRoot, context.config, Date.now());
  const stateText = overBudget(context)
    ? undefined
    : await readTextFile(stateFilePath(context.vaultRoot, context.config));

  const block = buildSessionContext(
    statusLine,
    stateText,
    stateRelativePath(context.config),
    MAX_SESSION_CONTEXT_CHARS,
  );
  const base: HookOutcome | undefined = block.text.length === 0
    ? undefined
    : { context: block.text, budget: block.budget };

  // Needs no capability of its own: it only reports what is already staged.
  const reminder = overBudget(context)
    ? undefined
    : await runOrgan(() => sessionStartStagingReminder(context));

  return composeHookOutcomes(base, reminder, MAX_SESSION_CONTEXT_CHARS);
}
