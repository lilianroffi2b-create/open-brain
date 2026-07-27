/**
 * Payload shapes and payload readers for the six hook events.
 *
 * The same entry point serves every host CLI, so nothing here branches on an
 * environment variable or a command-line flag: the harness is recognised from
 * the shape of the payload alone. Every reader is defensive, because a payload
 * is external input written by another program and a hook that throws on a
 * surprising field is a hook that breaks a session.
 */

export const HOOK_EVENTS = [
  "session-start",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "stop",
  "pre-compact",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The event names the host CLIs use in their own settings files. */
export const HOST_EVENT_NAMES: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
  "pre-compact": "PreCompact",
};

export function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.some((event) => event === value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function payloadRecord(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = payload[key];
  return isRecord(value) ? value : undefined;
}

export function payloadBoolean(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

/**
 * Codex sends a turn identifier and Claude Code does not, so its presence is
 * the harness discriminant. Anything that depends on a turn identity is
 * therefore Codex only, and the documentation says so rather than pretending
 * the two hosts are equivalent.
 */
export function isCodexPayload(payload: Record<string, unknown>): boolean {
  const turnId = payload.turn_id;
  return (
    typeof turnId === "string"
    && turnId.length > 0
    && turnId.length <= 256
    && !turnId.includes(" ")
  );
}

/**
 * Plan mode means the assistant is drafting, not acting. Every hook that could
 * write, warn, or refuse stays inert there.
 */
export function isPlanPayload(payload: Record<string, unknown>): boolean {
  return payload.permission_mode === "plan";
}

export type FileChangeKind = "Add" | "Update" | "Delete" | "Write" | "Edit";

export interface FileChange {
  kind: FileChangeKind;
  sourcePath: string;
  targetPath: string;
  addedLines: string[];
}

/** A move makes a file new at its destination even when its content is old. */
export function isNewFile(change: FileChange): boolean {
  return (
    change.kind === "Add"
    || change.kind === "Write"
    || change.targetPath !== change.sourcePath
  );
}

/**
 * Codex passes a shell command either as a string or as an argument vector.
 * Both forms have to reach the guard as one string or a rule written against
 * commands silently stops matching under one of the two hosts.
 */
export function commandFromToolInput(
  toolInput: Record<string, unknown>,
): string | undefined {
  const command = toolInput.command;
  if (typeof command === "string" && command.length > 0) {
    return command;
  }
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    return parts.length === command.length && parts.length > 0
      ? parts.join(" ")
      : undefined;
  }
  return undefined;
}

const PATCH_FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/u;
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/u;

function asPatchKind(value: string | undefined): FileChangeKind | undefined {
  return value === "Add" || value === "Update" || value === "Delete"
    ? value
    : undefined;
}

/**
 * Parses the textual patch format Codex uses for every file mutation. A single
 * patch can touch several files, so the lint and the guard both need the
 * normalized list rather than the raw text.
 */
export function parseApplyPatch(patch: string): FileChange[] {
  const changes: FileChange[] = [];
  let current: FileChange | undefined;

  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const header = PATCH_FILE_HEADER.exec(line);
    if (header) {
      const kind = asPatchKind(header[1]);
      const path = header[2];
      if (current) {
        changes.push(current);
      }
      current = kind === undefined || path === undefined
        ? undefined
        : {
          kind,
          sourcePath: path.trim(),
          targetPath: path.trim(),
          addedLines: [],
        };
      continue;
    }
    const move = PATCH_MOVE_HEADER.exec(line);
    if (move && current) {
      current.targetPath = (move[1] ?? current.targetPath).trim();
      continue;
    }
    if (line === "*** End Patch") {
      if (current) {
        changes.push(current);
        current = undefined;
      }
      continue;
    }
    if (current && current.kind !== "Delete" && line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    }
  }

  if (current) {
    changes.push(current);
  }
  return changes;
}

function pathFromToolInput(toolInput: Record<string, unknown>): string | undefined {
  const filePath = toolInput.file_path;
  if (typeof filePath === "string" && filePath.length > 0) {
    return filePath;
  }
  const fallback = toolInput.path;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : undefined;
}

/**
 * Normalizes what a tool call is about to change, whichever host produced it.
 * Returns an empty list for every tool that touches no file, so callers can
 * stay silent without a second lookup.
 */
export function changesFromPayload(payload: Record<string, unknown>): FileChange[] {
  const tool = payloadString(payload, "tool_name");
  const toolInput = payloadRecord(payload, "tool_input");
  if (tool === undefined || toolInput === undefined) {
    return [];
  }

  if (tool === "Write") {
    const path = pathFromToolInput(toolInput);
    const content = toolInput.content;
    if (path === undefined || typeof content !== "string") {
      return [];
    }
    return [{
      kind: "Write",
      sourcePath: path,
      targetPath: path,
      addedLines: content.split("\n"),
    }];
  }

  if (tool === "Edit") {
    const path = pathFromToolInput(toolInput);
    const added = toolInput.new_string;
    if (path === undefined || typeof added !== "string") {
      return [];
    }
    return [{
      kind: "Edit",
      sourcePath: path,
      targetPath: path,
      addedLines: added.split("\n"),
    }];
  }

  if (tool === "apply_patch") {
    const patch = commandFromToolInput(toolInput)
      ?? (typeof toolInput.patch === "string" ? toolInput.patch : undefined);
    return patch === undefined ? [] : parseApplyPatch(patch);
  }

  return [];
}
