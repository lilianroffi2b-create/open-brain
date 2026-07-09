import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readFreeMode, type FreeMode } from "../free-mode/config.js";
import { renderFreeModeLoaderBlock } from "./free-mode-block.js";
import {
  DEFAULT_LOADER_FILENAMES,
  OPENBRAIN_LOADER_BEGIN_MARKER,
  OPENBRAIN_LOADER_END_MARKER,
  type LoaderFilename,
} from "./markers.js";

const loaderBlockPattern = new RegExp(
  `${escapeRegExp(OPENBRAIN_LOADER_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(OPENBRAIN_LOADER_END_MARKER)}`,
  "g",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function assertWellFormedMarkers(content: string): void {
  const beginCount = countOccurrences(content, OPENBRAIN_LOADER_BEGIN_MARKER);
  const endCount = countOccurrences(content, OPENBRAIN_LOADER_END_MARKER);

  if (beginCount !== endCount) {
    throw new Error(
      "OpenBrain loader markers are malformed. Repair the marker pair before syncing.",
    );
  }

  const markerPattern = new RegExp(
    `${escapeRegExp(OPENBRAIN_LOADER_BEGIN_MARKER)}|${escapeRegExp(OPENBRAIN_LOADER_END_MARKER)}`,
    "g",
  );
  let insideGeneratedBlock = false;

  for (const match of content.matchAll(markerPattern)) {
    if (match[0] === OPENBRAIN_LOADER_BEGIN_MARKER) {
      if (insideGeneratedBlock) {
        throw new Error(
          "OpenBrain loader markers are malformed. Repair the marker pair before syncing.",
        );
      }
      insideGeneratedBlock = true;
    } else {
      if (!insideGeneratedBlock) {
        throw new Error(
          "OpenBrain loader markers are malformed. Repair the marker pair before syncing.",
        );
      }
      insideGeneratedBlock = false;
    }
  }
}

/**
 * Inserts or replaces exactly one generated block. User-authored text outside
 * marker pairs is preserved byte-for-byte. Extra complete generated blocks are
 * removed while all intervening user text remains intact.
 */
export function syncLoaderContent(content: string, mode: FreeMode): string {
  assertWellFormedMarkers(content);

  const block = renderFreeModeLoaderBlock(mode);
  const markerCount = countOccurrences(content, OPENBRAIN_LOADER_BEGIN_MARKER);

  if (markerCount === 0) {
    if (content.length === 0) {
      return `${block}\n`;
    }

    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}${block}\n`;
  }

  let replacedFirstBlock = false;
  return content.replace(loaderBlockPattern, () => {
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
  const temporaryPath = join(directory, `.openbrain-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export interface LoaderSyncResult {
  path: string;
  changed: boolean;
}

export interface LoaderSyncOptions {
  files?: readonly LoaderFilename[];
}

export async function syncLoaderFile(
  path: string,
  mode: FreeMode,
): Promise<LoaderSyncResult> {
  let current = "";

  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!nodeErrorHasCode(error, "ENOENT")) {
      throw error;
    }
  }

  const next = syncLoaderContent(current, mode);
  if (next !== current) {
    await writeAtomically(path, next);
  }

  return { path, changed: next !== current };
}

/**
 * CLI-facing synchroniser for the three portable agent loaders. It reads no
 * network state and never touches content outside the marked generated blocks.
 */
export async function syncLoaders(
  vaultRoot: string,
  mode: FreeMode,
  options: LoaderSyncOptions = {},
): Promise<LoaderSyncResult[]> {
  const files = options.files ?? DEFAULT_LOADER_FILENAMES;
  return Promise.all(
    files.map((filename) => syncLoaderFile(join(vaultRoot, filename), mode)),
  );
}

/** Convenience entry point for a CLI that already parsed vault.config.yml. */
export async function syncLoadersFromConfig(
  vaultRoot: string,
  config: unknown,
  options: LoaderSyncOptions = {},
): Promise<LoaderSyncResult[]> {
  return syncLoaders(vaultRoot, readFreeMode(config), options);
}
