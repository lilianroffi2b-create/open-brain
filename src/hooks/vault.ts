import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { DEFAULT_LOADER_FILENAMES } from "../loaders/index.js";
import { toPosixPath } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";

/**
 * Vault lookups shared by the hook handlers. Every directory name comes from
 * the configuration rather than a constant, because the skin presets rename the
 * numbered layers and a hard-coded list would stop matching under the alternate
 * preset.
 */

export const STATE_FILENAME = "_state.md";

/** Root-level Markdown files a vault legitimately owns, beyond the loaders. */
const STANDARD_ROOT_MARKDOWN = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "CODE_OF_CONDUCT.md",
  "PARITY.md",
  "MIGRATION_TODO.md",
];

export function allowedRootMarkdown(): Set<string> {
  return new Set([...DEFAULT_LOADER_FILENAMES, ...STANDARD_ROOT_MARKDOWN]);
}

export function stateFilePath(vaultRoot: string, config: VaultConfig): string {
  return join(vaultRoot, config.paths.memory, STATE_FILENAME);
}

export function stateRelativePath(config: VaultConfig): string {
  return toPosixPath(join(config.paths.memory, STATE_FILENAME));
}

/** Reads a file and reports absence or unreadability as absence. */
export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function fileMtimeMs(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a path reported by a tool call to a vault-relative POSIX path.
 * Returns undefined for anything outside the vault, which the callers treat as
 * none of their business rather than as a violation.
 */
export function relativeVaultPath(
  vaultRoot: string,
  rawPath: string,
  cwd?: string,
): string | undefined {
  const base = cwd !== undefined && cwd.length > 0 ? cwd : vaultRoot;
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
  const inside = relative(resolve(vaultRoot), absolute);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    return undefined;
  }
  return toPosixPath(inside);
}

/**
 * Generated and machine-owned areas the lint has no business commenting on:
 * the engine directory, the host integration directories, the index artifacts,
 * and the staging area.
 */
export function isLintExcluded(relativePath: string, config: VaultConfig): boolean {
  const parts = relativePath.split("/").filter((part) => part.length > 0);
  const first = parts[0];
  if (first === undefined) {
    return true;
  }
  if (first === config.paths.engine || first.startsWith(".")) {
    return true;
  }
  const second = parts[1];
  if (first === config.paths.index && (second === "deltas" || second === "catalog")) {
    return true;
  }
  if (first === config.paths.memory && second === "staging") {
    return true;
  }
  return false;
}

function isSkippedContentDirectory(
  relativeDirectory: string,
  config: VaultConfig,
): boolean {
  const parts = relativeDirectory.split("/").filter((part) => part.length > 0);
  const first = parts[0];
  if (first === undefined) {
    return false;
  }
  if (first.startsWith(".") || first === config.paths.engine) {
    return true;
  }
  // Filing something away is not authoring it. Counting the archive would also
  // make the stop hook react to its own consolidation.
  if (first === config.paths.archive) {
    return true;
  }
  const second = parts[1];
  if (first === config.paths.index && (second === "deltas" || second === "catalog")) {
    return true;
  }
  return first === config.paths.memory && second === "staging";
}

/**
 * Newest modification time among the authored Markdown of the vault, ignoring
 * generated artifacts and the staging area. Stops as soon as the deadline
 * passes and reports what it found so far, because an approximate answer in
 * time is worth more to a hook than an exact answer too late.
 */
export async function newestAuthoredMtimeMs(
  vaultRoot: string,
  config: VaultConfig,
  deadline: number,
  skipRelativePaths: ReadonlySet<string> = new Set(),
): Promise<number> {
  let newest = 0;

  const walk = async (relativeDirectory: string): Promise<void> => {
    if (Date.now() >= deadline) {
      return;
    }
    let entries;
    try {
      entries = await readdir(join(vaultRoot, relativeDirectory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        return;
      }
      const child = relativeDirectory.length === 0
        ? entry.name
        : relativeDirectory + "/" + entry.name;
      if (entry.isDirectory()) {
        if (!isSkippedContentDirectory(child, config)) {
          await walk(child);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (skipRelativePaths.has(child)) {
        continue;
      }
      const mtime = await fileMtimeMs(join(vaultRoot, child.split("/").join(sep)));
      if (mtime !== undefined && mtime > newest) {
        newest = mtime;
      }
    }
  };

  for (const directory of config.canonical_dirs) {
    if (Date.now() >= deadline) {
      break;
    }
    if (!isSkippedContentDirectory(directory, config)) {
      await walk(directory);
    }
  }
  return newest;
}
