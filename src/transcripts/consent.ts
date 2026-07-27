import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { isEnabled, requireCapability } from "../core/capabilities.js";
import { ExpectedError } from "../core/errors.js";
import type { VaultConfig } from "../core/types.js";

/**
 * The consent contract for reading outside the vault. It is code, not
 * documentation, and every path in this lot goes through it.
 *
 * Three rules, in this order:
 *
 * 1. With capabilities.transcripts disarmed, nothing outside the vault is
 *    touched. Not stat'd, not opened, not resolved. The refusal is decided from
 *    the configuration alone, which is what makes invariant I3 a property of
 *    the code rather than a promise about it.
 * 2. With it armed, only the directories named in capabilities.transcripts.roots
 *    are readable. There is no discovery, no default root, and no guessing from
 *    the shape of a path: a file that looks exactly like a transcript but sits
 *    outside every consented root is refused like any other stranger.
 * 3. The vault itself is always readable, with or without the capability. That
 *    is not an exception to rule 1: reading its own directory is the entire job
 *    of the tool, and it is what lets a user copy a transcript into the vault
 *    and mine it with nothing armed at all.
 *
 * Escapes are closed by comparing real paths. A relative path that climbs out
 * with .. is normalized before the comparison, and a symbolic link that leaves
 * a consented root resolves outside it and is refused. The candidate path is
 * only ever resolved on disk once it is already lexically inside a consented
 * root, so a refusal never becomes a reason to touch the file it refuses.
 */

export const TRANSCRIPT_EXTENSION = ".jsonl";
export const ENABLE_COMMAND = "open-brain capabilities enable transcripts --root <directory>";

const MAX_WALK_DEPTH = 8;
const MAX_WALK_ENTRIES = 20_000;

export class TranscriptConsentError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "TranscriptConsentError";
  }
}

export interface ConsentedRoot {
  /** The path exactly as the user wrote it in the config. */
  declared: string;
  /** The declared path made absolute against the vault root. */
  lexical: string;
  /** The same path with every symbolic link resolved, when it exists. */
  real: string | undefined;
}

export type ReadableScope = "vault" | "consented-root";

export interface ReadableTarget {
  requested: string;
  resolved: string;
  scope: ReadableScope;
  root: string | undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

async function realPathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Containment by path segment, so /a/bc is never read as being inside /a/b. */
export function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The consented roots, resolved. A root that does not exist is kept in the list
 * with no real path rather than dropped, so an error message can still name the
 * directory the user thought they had consented to.
 */
export async function consentedRoots(
  vaultRoot: string,
  config: VaultConfig,
): Promise<ConsentedRoot[]> {
  const roots: ConsentedRoot[] = [];
  for (const declared of config.capabilities.transcripts.roots) {
    const lexical = resolve(vaultRoot, declared);
    roots.push({ declared, lexical, real: await realPathOrUndefined(lexical) });
  }
  return roots;
}

function refusal(requested: string, reason: string): TranscriptConsentError {
  return new TranscriptConsentError(
    `Refused to read ${requested}: ${reason} Consent is per directory and is never inferred: name the directory with \`${ENABLE_COMMAND}\`, then retry.`,
  );
}

/**
 * The single gate. Returns the resolved path when reading is consented, and
 * throws a refusal that names the path and the command to allow it otherwise.
 *
 * Nothing in this function touches the requested path on disk until it is
 * already known to be inside the vault or inside a consented root.
 */
export async function assertReadable(
  vaultRoot: string,
  config: VaultConfig,
  requestedPath: string,
): Promise<ReadableTarget> {
  const requested = resolve(requestedPath);
  const vault = resolve(vaultRoot);

  if (isWithin(vault, requested)) {
    // Inside the vault lexically. Resolve it to make sure a link does not carry
    // the read outside, and if it does, judge it like any other outside path.
    const real = await realPathOrUndefined(requested);
    if (real === undefined || isWithin(await realpath(vault).catch(() => vault), real)) {
      return {
        requested,
        resolved: real ?? requested,
        scope: "vault",
        root: vault,
      };
    }
  }

  if (!isEnabled(config, "transcripts")) {
    let capabilityMessage = "";
    try {
      requireCapability(config, "transcripts");
    } catch (error) {
      capabilityMessage = error instanceof Error ? ` ${error.message}` : "";
    }
    throw new TranscriptConsentError(
      `Refused to read ${requested}: it is outside this vault and the transcripts capability is disarmed, so Open Brain read nothing at all.${capabilityMessage} Arming it also requires naming the directory: \`${ENABLE_COMMAND}\`.`,
    );
  }

  const roots = await consentedRoots(vaultRoot, config);
  if (roots.length === 0) {
    throw refusal(
      requested,
      "the transcripts capability is armed but no directory has been consented to, so there is nothing outside this vault that Open Brain may open.",
    );
  }

  const container = roots.find(
    (root) => isWithin(root.lexical, requested)
      || (root.real !== undefined && isWithin(root.real, requested)),
  );
  if (container === undefined) {
    throw refusal(
      requested,
      `it is outside every consented directory (${roots.map((root) => root.declared).join(", ")}).`,
    );
  }

  const real = await realPathOrUndefined(requested);
  if (real === undefined) {
    throw new TranscriptConsentError(
      `Refused to read ${requested}: it is inside the consented directory ${container.declared} but it does not exist or cannot be resolved. Nothing was read.`,
    );
  }

  const realRoot = container.real ?? container.lexical;
  if (!isWithin(realRoot, real)) {
    throw refusal(
      real,
      `it is reached through ${requested}, which is a link out of the consented directory ${container.declared}. A link is not consent.`,
    );
  }

  return { requested, resolved: real, scope: "consented-root", root: realRoot };
}

export interface TranscriptFile {
  path: string;
  root: string;
  size: number;
  modified_at: string;
}

export interface TranscriptListing {
  files: TranscriptFile[];
  roots: ConsentedRoot[];
  scanned_entries: number;
  truncated: boolean;
}

export interface ListOptions {
  maxFiles?: number | undefined;
  sinceMs?: number | undefined;
}

const DEFAULT_MAX_FILES = 200;

/**
 * Enumerates transcript files inside the consented roots. This is not
 * discovery: it never leaves a directory the user named, it never follows a
 * symbolic link out of one, and it is bounded in depth and in entries so a
 * consented root that happens to contain a very large tree cannot turn a
 * listing into a full disk walk.
 */
export async function listTranscriptFiles(
  vaultRoot: string,
  config: VaultConfig,
  options: ListOptions = {},
): Promise<TranscriptListing> {
  requireCapability(config, "transcripts");
  const roots = await consentedRoots(vaultRoot, config);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: TranscriptFile[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = async (directory: string, root: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || scanned >= MAX_WALK_ENTRIES) {
      truncated = truncated || scanned >= MAX_WALK_ENTRIES;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      scanned += 1;
      if (scanned >= MAX_WALK_ENTRIES) {
        truncated = true;
        return;
      }
      const path = join(directory, entry.name);
      // A symbolic link is never followed here. Following one is how a listing
      // walks out of the directory the user consented to.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path, root, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_EXTENSION)) {
        continue;
      }
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (options.sinceMs !== undefined && info.mtimeMs < options.sinceMs) {
        continue;
      }
      files.push({
        path,
        root,
        size: info.size,
        modified_at: new Date(info.mtimeMs).toISOString(),
      });
    }
  };

  for (const root of roots) {
    const start = root.real ?? root.lexical;
    await walk(start, root.declared, 0);
  }

  // Sorted by path, never by modification time. Picking "the most recent file"
  // is how a reader silently reads the wrong session.
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length > maxFiles) {
    return {
      files: files.slice(0, maxFiles),
      roots,
      scanned_entries: scanned,
      truncated: true,
    };
  }
  return { files, roots, scanned_entries: scanned, truncated };
}

/** What `transcripts scan` prints when the capability is disarmed. */
export function consentSummary(config: VaultConfig): {
  enabled: boolean;
  redact: boolean;
  roots: string[];
} {
  return {
    enabled: isEnabled(config, "transcripts"),
    redact: config.capabilities.transcripts.redact,
    roots: [...config.capabilities.transcripts.roots],
  };
}
