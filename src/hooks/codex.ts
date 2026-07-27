import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteText } from "../core/fs-atomic.js";
import { ExpectedError } from "../core/errors.js";
import { lockPathFor, withLock } from "../core/lock.js";
import { HOOK_EVENTS, HOST_EVENT_NAMES, isRecord, type HookEvent } from "./events.js";
import { HOOK_DECLARED_TIMEOUT_SECONDS } from "./runtime.js";
import {
  hookCommandFor,
  isOwnedCommand,
  mergeHookSettings,
  normalizeCommand,
  type DesiredHooks,
  type HookCommandEntry,
  type HookMatcherGroup,
  type SettingsWriteResult,
} from "./settings-merge.js";

/**
 * Codex parity, and the places where parity is not possible.
 *
 * The same entry point serves both hosts and the harness is recognised from the
 * payload, so nothing about the handlers changes here. What changes is the
 * wiring: Codex keeps its hooks in a dedicated file, spells its matchers as
 * anchored regular expressions, requires a timeout on every entry, and knows
 * three tools Claude Code does not have.
 *
 * Where the two hosts genuinely differ, the difference is written down rather
 * than papered over. CODEX_DIFFERENCES is the single source for that, and both
 * `open-brain hooks status` and the integration documentation read it.
 */

export const CODEX_HOOKS_RELATIVE_PATH = join(".codex", "hooks.json");
export const CODEX_HOOKS_BACKUP_SUFFIX = ".bak";
export const CODEX_DESCRIPTION =
  "Open Brain hooks. Managed by `open-brain hooks install`; run `open-brain hooks uninstall` to remove them.";

/**
 * Codex matches with a real anchored regular expression, so an alternation has
 * to be anchored or it matches far more tools than intended. PreToolUse covers
 * three tools that exist only here, and PostToolUse covers apply_patch, which
 * is how Codex writes, edits, moves, and deletes files.
 */
const CODEX_MATCHERS: Partial<Record<HookEvent, string>> = {
  "session-start": "^(?:startup|resume|clear|compact)$",
  "pre-tool-use": "^(?:Bash|exec_command|exec|apply_patch|Edit|Write)$",
  "post-tool-use": "^(?:apply_patch|Edit|Write)$",
  "pre-compact": "^(?:auto|manual)$",
};

const CODEX_STATUS_MESSAGES: Record<HookEvent, string> = {
  "session-start": "Open Brain: loading the living state",
  "user-prompt-submit": "Open Brain: routing the request",
  "pre-tool-use": "Open Brain: checking the action",
  "post-tool-use": "Open Brain: linting what changed",
  stop: "Open Brain: closing the turn",
  "pre-compact": "Open Brain: saving what compaction would drop",
};

export interface CodexHookEntry extends HookCommandEntry {
  timeout: number;
  statusMessage: string;
}

export interface CodexHooksDocument {
  description: string;
  hooks: DesiredHooks;
}

export function desiredCodexHooks(): DesiredHooks {
  const desired: DesiredHooks = {};
  for (const event of HOOK_EVENTS) {
    const matcher = CODEX_MATCHERS[event];
    const entry: CodexHookEntry = {
      type: "command",
      command: hookCommandFor(event),
      timeout: HOOK_DECLARED_TIMEOUT_SECONDS,
      statusMessage: CODEX_STATUS_MESSAGES[event],
    };
    const group: HookMatcherGroup = matcher === undefined
      ? { hooks: [entry] }
      : { matcher, hooks: [entry] };
    desired[HOST_EVENT_NAMES[event]] = [group];
  }
  return desired;
}

export function buildCodexHooksDocument(): CodexHooksDocument {
  return { description: CODEX_DESCRIPTION, hooks: desiredCodexHooks() };
}

export interface HostDifference {
  topic: string;
  detail: string;
}

/**
 * What one host has and the other does not. Absences are documented, never
 * simulated: a capability that cannot exist on a host is announced as missing
 * so nobody builds on a promise Open Brain cannot keep.
 */
export const CODEX_DIFFERENCES: readonly HostDifference[] = [
  {
    topic: "turn_id, Codex only",
    detail:
      "Codex tags every payload with a turn identifier. Claude Code does not, so anything that needs to know what changed during this exact turn is more precise under Codex. Under Claude Code the stop hook compares modification times instead, which is coarser and can be wrong in both directions.",
  },
  {
    topic: "CLAUDE_PROJECT_DIR, Claude Code only",
    detail:
      "Codex sets no project directory variable. This is why every hook resolves the vault from the payload's working directory first and treats the variable as a fallback only.",
  },
  {
    topic: "Extra tools, Codex only",
    detail:
      "Codex calls exec, exec_command, and apply_patch, which have no Claude Code equivalent. The PreToolUse matcher covers all three, and apply_patch is parsed into the same normalized file changes as Write and Edit.",
  },
  {
    topic: "Per-entry timeout and status message, Codex only",
    detail:
      "Codex requires a timeout on every hook entry and can display a status message while one runs. Open Brain declares a timeout on both hosts anyway: a hook with no budget is a hook that can freeze a session.",
  },
  {
    topic: "SessionEnd, neither host",
    detail:
      "Open Brain registers no SessionEnd hook. The end-of-turn ritual lives on Stop, which fires on every turn rather than once at the very end.",
  },
  {
    topic: "Stop block form",
    detail:
      "Codex expresses a stop block as a JSON object on stdout with exit 0; Claude Code expresses it as exit 2 with the message on stderr. Both are native and Open Brain uses each host's own form, decided from the payload. Every other event has one form on both hosts.",
  },
];

export type HookSupportLevel = "full" | "full-plus" | "degraded";

export interface HostSupport {
  host: string;
  level: HookSupportLevel;
  works: string;
  missing: string;
}

/**
 * What a user actually gets per host, stated before they find out the hard way.
 * A CLI with no hook mechanism gets nothing automatic, and saying so is the
 * only honest option.
 */
export const HOOK_HOST_SUPPORT: readonly HostSupport[] = [
  {
    host: "Claude Code",
    level: "full",
    works:
      "Route injection, session context, lint after writes, end-of-turn handoff, and the pre-effect guard.",
    missing:
      "Detection of what changed during this exact turn, because there is no turn identifier.",
  },
  {
    host: "Codex",
    level: "full-plus",
    works: "Everything Claude Code gets, plus per-turn precision through turn_id.",
    missing: "The status line and inline shell hooks, which have no Codex equivalent.",
  },
  {
    host: "Gemini CLI and any CLI without hooks",
    level: "degraded",
    works:
      "Nothing automatic. Every hook has an equivalent command that can be run by hand: open-brain hook <event> reads a payload on stdin and prints its block on stdout.",
    missing:
      "All of it. The generated loader states the ritual in writing instead, which moves it from guaranteed by the host to asked of the assistant. That is less reliable, and it is better than pretending.",
  },
];

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

interface ExistingDocument {
  text?: string;
  value: unknown;
}

async function readCodexHooks(path: string): Promise<ExistingDocument> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { value: undefined };
    }
    throw new ExpectedError(
      `The Codex hooks file ${path} exists but could not be read, so Open Brain changed nothing. Fix its permissions, then run the install again.`,
    );
  }
  if (text.trim().length === 0) {
    return { text, value: {} };
  }
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ExpectedError(
      `The Codex hooks file ${path} is not valid JSON, so Open Brain changed nothing and wrote no backup.${detail} Fix the file by hand, then run the install again.`,
    );
  }
}

function codexPath(vaultRoot: string): string {
  return join(vaultRoot, CODEX_HOOKS_RELATIVE_PATH);
}

async function updateCodexHooks(
  vaultRoot: string,
  desired: DesiredHooks,
  removeWhenEmpty: boolean,
): Promise<SettingsWriteResult> {
  const path = codexPath(vaultRoot);
  return withLock(lockPathFor(vaultRoot, "hooks-codex"), async () => {
    const existing = await readCodexHooks(path);
    const base = existing.value === undefined
      ? { description: CODEX_DESCRIPTION }
      : existing.value;
    const merged = mergeHookSettings(base, desired);
    if (merged.description === undefined) {
      merged.description = CODEX_DESCRIPTION;
    }

    const hooks = merged.hooks;
    const empty = !isRecord(hooks) || Object.keys(hooks).length === 0;
    if (removeWhenEmpty && empty) {
      if (existing.text === undefined) {
        return { path, changed: false, created: false };
      }
      const backupPath = path + CODEX_HOOKS_BACKUP_SUFFIX;
      await atomicWriteText(backupPath, existing.text);
      await rm(path, { force: true });
      return { path, changed: true, created: false, backup_path: backupPath };
    }

    const serialized = JSON.stringify(merged, null, 2) + "\n";
    if (existing.text === serialized) {
      return { path, changed: false, created: false };
    }
    if (existing.text !== undefined) {
      const backupPath = path + CODEX_HOOKS_BACKUP_SUFFIX;
      await atomicWriteText(backupPath, existing.text);
      await atomicWriteText(path, serialized);
      return { path, changed: true, created: false, backup_path: backupPath };
    }
    await atomicWriteText(path, serialized);
    return { path, changed: true, created: true };
  });
}

export async function installCodexHooks(vaultRoot: string): Promise<SettingsWriteResult> {
  return updateCodexHooks(vaultRoot, desiredCodexHooks(), false);
}

export async function uninstallCodexHooks(vaultRoot: string): Promise<SettingsWriteResult> {
  return updateCodexHooks(vaultRoot, {}, true);
}

export interface CodexHookWiring {
  event: HookEvent;
  host_event: string;
  command: string;
  matcher?: string;
  wired: boolean;
  occurrences: number;
}

export interface CodexHookStatus {
  path: string;
  present: boolean;
  readable: boolean;
  hooks: CodexHookWiring[];
  foreign_entries: number;
}

function emptyCodexWiring(): CodexHookWiring[] {
  return HOOK_EVENTS.map((event) => {
    const matcher = CODEX_MATCHERS[event];
    const base = {
      event,
      host_event: HOST_EVENT_NAMES[event],
      command: hookCommandFor(event),
      wired: false,
      occurrences: 0,
    };
    return matcher === undefined ? base : { ...base, matcher };
  });
}

export async function codexHookStatus(vaultRoot: string): Promise<CodexHookStatus> {
  const path = codexPath(vaultRoot);
  let existing: ExistingDocument;
  try {
    existing = await readCodexHooks(path);
  } catch {
    return {
      path,
      present: true,
      readable: false,
      hooks: emptyCodexWiring(),
      foreign_entries: 0,
    };
  }

  const value = existing.value;
  const hooks = isRecord(value) && isRecord(value.hooks) ? value.hooks : {};
  const counts = new Map<string, number>();
  let foreign = 0;

  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        continue;
      }
      for (const entry of group.hooks) {
        const command = isRecord(entry) && typeof entry.command === "string"
          ? entry.command
          : undefined;
        if (command === undefined) {
          continue;
        }
        if (!isOwnedCommand(command)) {
          foreign += 1;
          continue;
        }
        const key = normalizeCommand(command);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    path,
    present: existing.text !== undefined,
    readable: true,
    hooks: emptyCodexWiring().map((wiring) => {
      const occurrences = counts.get(normalizeCommand(wiring.command)) ?? 0;
      return { ...wiring, wired: occurrences > 0, occurrences };
    }),
    foreign_entries: foreign,
  };
}
