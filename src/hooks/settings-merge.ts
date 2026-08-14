import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteText } from "../core/fs-atomic.js";
import { ExpectedError } from "../core/errors.js";
import { lockPathFor, withLock } from "../core/lock.js";
import { HOOK_EVENTS, HOST_EVENT_NAMES, isRecord, type HookEvent } from "./events.js";
import { HOOK_DECLARED_TIMEOUT_SECONDS } from "./runtime.js";

/**
 * Writing Open Brain's hooks into a settings file the user owns.
 *
 * Three requirements that only look contradictory: never lose what the user put
 * there, never duplicate what Open Brain already put there, and still be able
 * to update Open Brain's own entries when they change between versions.
 *
 * The complete command string is the identity of a hook entry, because Claude
 * Code's format gives an entry no id, no name, and no source. Every command
 * Open Brain generates contains the literal segment "open-brain hook ", which
 * makes ownership an exact predicate rather than a guess, and lets a renamed or
 * retired hook be cleaned up without ever touching an entry that belongs to
 * someone else.
 */

export const CLAUDE_SETTINGS_RELATIVE_PATH = join(".claude", "settings.json");
export const CLAUDE_SETTINGS_BACKUP_SUFFIX = ".bak";
export const OWNERSHIP_MARKER = "open-brain hook ";

export interface HookCommandEntry {
  type: string;
  command: string;
  timeout?: number;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

/** Host event name to the groups Open Brain wants registered under it. */
export type DesiredHooks = Record<string, HookMatcherGroup[]>;

/**
 * Matchers per event on Claude Code. Written as the loose alternation the host
 * expects there; the anchored regular expressions Codex requires live in
 * codex.ts, because the two hosts disagree on the syntax and pretending
 * otherwise breaks one of them.
 */
const CLAUDE_MATCHERS: Partial<Record<HookEvent, string>> = {
  "session-start": "startup|resume|clear|compact",
  "pre-tool-use": "Write|Edit|Bash",
  "post-tool-use": "Write|Edit",
  "pre-compact": "auto|manual",
};

export function hookCommandFor(event: HookEvent): string {
  return `open-brain hook ${event}`;
}

export function desiredClaudeHooks(): DesiredHooks {
  const desired: DesiredHooks = {};
  for (const event of HOOK_EVENTS) {
    const matcher = CLAUDE_MATCHERS[event];
    const entry: HookCommandEntry = {
      type: "command",
      command: hookCommandFor(event),
      timeout: HOOK_DECLARED_TIMEOUT_SECONDS,
    };
    desired[HOST_EVENT_NAMES[event]] = [
      matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] },
    ];
  }
  return desired;
}

/**
 * Only whitespace is normalized, and only for comparison. Resolving variables
 * or unifying quotes would make two genuinely different commands look equal,
 * and a vault path containing a space depends on those quotes.
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

export function isOwnedCommand(command: string): boolean {
  return normalizeCommand(command).includes(OWNERSHIP_MARKER);
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => cloneJson(item)) as unknown as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ) as unknown as T;
  }
  return value;
}

/** A group with no matcher applies to everything, however that is spelled. */
function matcherEquals(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => (
    typeof value === "string" ? value.trim() : ""
  );
  return normalize(left) === normalize(right);
}

function entryCommand(entry: unknown): string | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  return typeof entry.command === "string" ? entry.command : undefined;
}

function groupEntries(group: Record<string, unknown>): unknown[] {
  const entries = group.hooks;
  return Array.isArray(entries) ? entries : [];
}

function readEventGroups(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((group) => (isRecord(group) ? cloneJson(group) : { hooks: [] }));
}

function groupFromDesired(group: HookMatcherGroup): Record<string, unknown> {
  const entries: unknown[] = group.hooks.map((entry) => cloneJson(entry));
  return group.matcher === undefined
    ? { hooks: entries }
    : { matcher: group.matcher, hooks: entries };
}

/** Replaces an entry with the same command in place, appends anything new. */
function mergeGroupEntries(
  target: Record<string, unknown>,
  desiredEntries: HookCommandEntry[],
): void {
  const entries = [...groupEntries(target)];
  const index = new Map<string, number>();
  for (const [position, entry] of entries.entries()) {
    const command = entryCommand(entry);
    if (command !== undefined && !index.has(normalizeCommand(command))) {
      index.set(normalizeCommand(command), position);
    }
  }
  for (const desiredEntry of desiredEntries) {
    const key = normalizeCommand(desiredEntry.command);
    const position = index.get(key);
    if (position === undefined) {
      index.set(key, entries.length);
      entries.push(cloneJson(desiredEntry));
    } else {
      entries[position] = cloneJson(desiredEntry);
    }
  }
  target.hooks = entries;
}

function desiredCommandsFor(desired: DesiredHooks, eventName: string): Set<string> {
  const commands = new Set<string>();
  for (const group of desired[eventName] ?? []) {
    for (const entry of group.hooks) {
      commands.add(normalizeCommand(entry.command));
    }
  }
  return commands;
}

/**
 * Drops Open Brain entries that are no longer wanted under this event, which is
 * what lets a hook be renamed or retired between two versions without leaving a
 * corpse behind. An entry that is not owned is never considered.
 */
function pruneOwnedEntries(
  group: Record<string, unknown>,
  wanted: ReadonlySet<string>,
): boolean {
  const entries = groupEntries(group);
  const kept = entries.filter((entry) => {
    const command = entryCommand(entry);
    if (command === undefined || !isOwnedCommand(command)) {
      return true;
    }
    return wanted.has(normalizeCommand(command));
  });
  group.hooks = kept;
  return kept.length !== entries.length;
}

/**
 * Merges Open Brain's hooks into an existing settings object and returns a new
 * object. Pure: it reads nothing and writes nothing.
 *
 * Running it twice on its own output is a no-op, which is what invariant I9
 * asks for, and any entry it does not own comes back byte for byte identical.
 */
export function mergeHookSettings(
  existing: unknown,
  desired: DesiredHooks,
): Record<string, unknown> {
  if (existing !== undefined && existing !== null && !isRecord(existing)) {
    throw new ExpectedError(
      "The host settings file does not contain a JSON object, so Open Brain will not rewrite it. Fix the file by hand, then run the install again.",
    );
  }

  const merged: Record<string, unknown> = isRecord(existing) ? cloneJson(existing) : {};
  const hadHooksKey = isRecord(existing) && existing.hooks !== undefined;
  const existingHooks = merged.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) {
    throw new ExpectedError(
      "The hooks section of the host settings file is not a JSON object, so Open Brain will not rewrite it. Fix the file by hand, then run the install again.",
    );
  }
  const hooks: Record<string, unknown> = isRecord(existingHooks)
    ? cloneJson(existingHooks)
    : {};

  const eventNames = new Set([...Object.keys(hooks), ...Object.keys(desired)]);
  for (const eventName of eventNames) {
    const raw = hooks[eventName];
    const desiredGroups = desired[eventName];

    if (desiredGroups !== undefined && raw !== undefined && !Array.isArray(raw)) {
      throw new ExpectedError(
        `hooks.${eventName} in the host settings file is not an array, so Open Brain cannot merge into it safely. Fix that entry by hand, then run the install again.`,
      );
    }
    if (desiredGroups === undefined && raw !== undefined && !Array.isArray(raw)) {
      // Malformed and none of our business: an event Open Brain does not
      // register is left exactly as the user wrote it, broken or not.
      continue;
    }

    const groups = readEventGroups(raw);
    // Only a group this merge actually edited may be pruned when it ends up
    // empty. An empty group the user wrote themselves stays where it is.
    const touched = new Set<Record<string, unknown>>();

    for (const desiredGroup of desiredGroups ?? []) {
      const target = groups.find((group) => matcherEquals(group.matcher, desiredGroup.matcher));
      if (target === undefined) {
        groups.push(groupFromDesired(desiredGroup));
      } else {
        mergeGroupEntries(target, desiredGroup.hooks);
        touched.add(target);
      }
    }

    const wanted = desiredCommandsFor(desired, eventName);
    for (const group of groups) {
      if (pruneOwnedEntries(group, wanted)) {
        touched.add(group);
      }
    }

    const kept = groups.filter(
      (group) => groupEntries(group).length > 0 || !touched.has(group),
    );
    if (kept.length === 0) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = kept;
    }
  }

  if (Object.keys(hooks).length > 0 || hadHooksKey) {
    merged.hooks = hooks;
  }
  return merged;
}

export interface SettingsWriteResult {
  path: string;
  changed: boolean;
  created: boolean;
  backup_path?: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

interface ExistingSettings {
  text?: string;
  value: unknown;
  mode?: number;
}

async function readSettings(path: string): Promise<ExistingSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { value: {} };
    }
    throw new ExpectedError(
      `The host settings file ${path} exists but could not be read, so Open Brain changed nothing. Fix its permissions, then run the install again.`,
    );
  }

  const mode = (await stat(path)).mode;
  if (text.trim().length === 0) {
    return { text, value: {}, mode };
  }
  try {
    return { text, value: JSON.parse(text) as unknown, mode };
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ExpectedError(
      `The host settings file ${path} is not valid JSON, so Open Brain changed nothing and wrote no backup.${detail} Fix the file by hand, then run the install again.`,
    );
  }
}

async function writeSettings(
  path: string,
  existing: ExistingSettings,
  merged: Record<string, unknown>,
): Promise<SettingsWriteResult> {
  const serialized = JSON.stringify(merged, null, 2) + "\n";
  if (existing.text !== undefined && existing.text === serialized) {
    return { path, changed: false, created: false };
  }

  const backupPath = path + CLAUDE_SETTINGS_BACKUP_SUFFIX;
  if (existing.text !== undefined) {
    await atomicWriteText(backupPath, existing.text);
  }
  await atomicWriteText(path, serialized);
  if (existing.mode !== undefined) {
    await chmod(path, existing.mode).catch(() => undefined);
  }
  return existing.text === undefined
    ? { path, changed: true, created: true }
    : { path, changed: true, created: false, backup_path: backupPath };
}

function settingsPath(vaultRoot: string): string {
  return join(vaultRoot, CLAUDE_SETTINGS_RELATIVE_PATH);
}

async function updateSettings(
  vaultRoot: string,
  desired: DesiredHooks,
): Promise<SettingsWriteResult> {
  const path = settingsPath(vaultRoot);
  return withLock(lockPathFor(vaultRoot, "hooks-settings"), async () => {
    const existing = await readSettings(path);
    return writeSettings(path, existing, mergeHookSettings(existing.value, desired));
  });
}

export async function installClaudeCodeHooks(
  vaultRoot: string,
): Promise<SettingsWriteResult> {
  return updateSettings(vaultRoot, desiredClaudeHooks());
}

/** Removes every owned entry and leaves everything else exactly as it was. */
export async function uninstallClaudeCodeHooks(
  vaultRoot: string,
): Promise<SettingsWriteResult> {
  return updateSettings(vaultRoot, {});
}

export interface ClaudeHookWiring {
  event: HookEvent;
  host_event: string;
  command: string;
  wired: boolean;
  occurrences: number;
}

export interface ClaudeHookStatus {
  path: string;
  present: boolean;
  readable: boolean;
  hooks: ClaudeHookWiring[];
  foreign_entries: number;
}

export async function claudeCodeHookStatus(vaultRoot: string): Promise<ClaudeHookStatus> {
  const path = settingsPath(vaultRoot);
  let value: unknown;
  let present = true;
  try {
    const existing = await readSettings(path);
    present = existing.text !== undefined;
    value = existing.value;
  } catch {
    return {
      path,
      present: true,
      readable: false,
      hooks: HOOK_EVENTS.map((event) => ({
        event,
        host_event: HOST_EVENT_NAMES[event],
        command: hookCommandFor(event),
        wired: false,
        occurrences: 0,
      })),
      foreign_entries: 0,
    };
  }

  const hooks = isRecord(value) && isRecord(value.hooks) ? value.hooks : {};
  let foreign = 0;
  const counts = new Map<string, number>();
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (!isRecord(group)) {
        continue;
      }
      for (const entry of groupEntries(group)) {
        const command = entryCommand(entry);
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
    present,
    readable: true,
    hooks: HOOK_EVENTS.map((event) => {
      const command = hookCommandFor(event);
      const occurrences = counts.get(normalizeCommand(command)) ?? 0;
      return {
        event,
        host_event: HOST_EVENT_NAMES[event],
        command,
        wired: occurrences > 0,
        occurrences,
      };
    }),
    foreign_entries: foreign,
  };
}
