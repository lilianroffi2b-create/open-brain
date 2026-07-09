import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_LOADER_FILENAMES, type LoaderFilename } from "../loaders/markers.js";
import { renderPreferenceMirror } from "./render.js";
import type { PreferenceLedger } from "./types.js";

export const PREFERENCE_MIRROR_BEGIN_MARKER = "<!-- openbrain:prefs:begin -->";
export const PREFERENCE_MIRROR_END_MARKER = "<!-- openbrain:prefs:end -->";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const preferenceMirrorPattern = new RegExp(
  `${escapeRegExp(PREFERENCE_MIRROR_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(PREFERENCE_MIRROR_END_MARKER)}`,
  "g",
);

function countOccurrences(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function assertWellFormedMirrorMarkers(content: string): void {
  const beginCount = countOccurrences(content, PREFERENCE_MIRROR_BEGIN_MARKER);
  const endCount = countOccurrences(content, PREFERENCE_MIRROR_END_MARKER);
  if (beginCount !== endCount) {
    throw new Error("OpenBrain preference mirror markers are malformed.");
  }

  const markerPattern = new RegExp(
    `${escapeRegExp(PREFERENCE_MIRROR_BEGIN_MARKER)}|${escapeRegExp(PREFERENCE_MIRROR_END_MARKER)}`,
    "g",
  );
  let insideMirror = false;
  for (const match of content.matchAll(markerPattern)) {
    if (match[0] === PREFERENCE_MIRROR_BEGIN_MARKER) {
      if (insideMirror) {
        throw new Error("OpenBrain preference mirror markers are malformed.");
      }
      insideMirror = true;
    } else {
      if (!insideMirror) {
        throw new Error("OpenBrain preference mirror markers are malformed.");
      }
      insideMirror = false;
    }
  }
}

export function renderPreferenceMirrorBlock(ledger: PreferenceLedger): string {
  return [
    PREFERENCE_MIRROR_BEGIN_MARKER,
    renderPreferenceMirror(ledger),
    PREFERENCE_MIRROR_END_MARKER,
  ].join("\n");
}

/** Replaces only the preference mirror, preserving all other loader text. */
export function syncPreferenceMirrorContent(
  content: string,
  ledger: PreferenceLedger,
): string {
  assertWellFormedMirrorMarkers(content);
  const block = renderPreferenceMirrorBlock(ledger);
  const markerCount = countOccurrences(content, PREFERENCE_MIRROR_BEGIN_MARKER);

  if (markerCount === 0) {
    if (content.length === 0) {
      return `${block}\n`;
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}${block}\n`;
  }

  let replacedFirstBlock = false;
  return content.replace(preferenceMirrorPattern, () => {
    if (!replacedFirstBlock) {
      replacedFirstBlock = true;
      return block;
    }
    return "";
  });
}

function nodeErrorHasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.openbrain-prefs-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export interface PreferenceMirrorSyncResult {
  path: string;
  changed: boolean;
}

export interface PreferenceMirrorSyncOptions {
  files?: readonly LoaderFilename[];
}

export async function syncPreferenceMirrorFile(
  path: string,
  ledger: PreferenceLedger,
): Promise<PreferenceMirrorSyncResult> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!nodeErrorHasCode(error, "ENOENT")) {
      throw error;
    }
  }

  const next = syncPreferenceMirrorContent(current, ledger);
  if (next !== current) {
    await writeAtomically(path, next);
  }
  return { path, changed: next !== current };
}

/**
 * Mirrors the deterministic core to the portable agent loaders. The shared
 * DEFAULT_LOADER_FILENAMES helper keeps this in step with loader-sync.
 */
export async function syncPreferenceMirrors(
  vaultRoot: string,
  ledger: PreferenceLedger,
  options: PreferenceMirrorSyncOptions = {},
): Promise<PreferenceMirrorSyncResult[]> {
  const files = options.files ?? DEFAULT_LOADER_FILENAMES;
  return Promise.all(
    files.map((filename) =>
      syncPreferenceMirrorFile(join(vaultRoot, filename), ledger),
    ),
  );
}
