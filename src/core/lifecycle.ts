import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import { toPosixPath } from "./text.js";
import type { Lifecycle, ThermalTier, VaultConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;
const FILENAME_DATE = /(20\d{2})-(\d{2})-(\d{2})/u;

/** Total wall clock a scan may spend reading git history, across all commands. */
export const GIT_HISTORY_TIMEOUT_MS = 15_000;

const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// A repository slow enough to exhaust the budget would otherwise pay the full
// budget again on every call within the same process.
const gitTimesCache = new Map<string, Map<string, number>>();

/** Clears the per-process git history cache. Tests and long-lived hosts use it. */
export function clearGitContentTimesCache(): void {
  gitTimesCache.clear();
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * A shared budget, not a per-command timeout. The second git call only gets
 * whatever the first one left, and once the budget is gone the call is refused
 * before it starts rather than started with a timeout of zero.
 */
function remainingGitBudget(deadlineMs: number, command: readonly string[]): number {
  const remaining = deadlineMs - monotonicMs();
  if (remaining <= 0) {
    throw new Error(`git history budget exhausted before running: git ${command.join(" ")}`);
  }
  return remaining;
}

export interface GitContentTimesOptions {
  /** Shared budget in milliseconds. Defaults to GIT_HISTORY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Set to false to bypass the per-process cache. */
  cache?: boolean;
}

export function filenameDateTimestamp(relativePath: string): number | undefined {
  const match = FILENAME_DATE.exec(basename(relativePath));
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? Math.floor(timestamp / 1000)
    : undefined;
}

function resolveRename(path: string, forward: Map<string, string>): string {
  const seen = new Set<string>();
  let current = path;
  while (forward.has(current) && !seen.has(current)) {
    seen.add(current);
    current = forward.get(current) as string;
  }
  return current;
}

/**
 * Reads the git content timestamps of a repository under a bounded budget.
 *
 * A slow or wedged repository must never stall a scan. When the budget runs out
 * the partial map is dropped rather than returned: a rename map without the
 * timestamps it resolves would age documents wrongly, which is worse than having
 * no git signal at all. The caller then falls back to file mtimes, which is a
 * degraded but honest answer, and never an exception.
 */
export async function gitContentTimes(
  root: string,
  options: GitContentTimesOptions = {},
): Promise<Map<string, number>> {
  const useCache = options.cache !== false;
  const cacheKey = resolve(root);
  if (useCache) {
    const cached = gitTimesCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const deadline = monotonicMs() + (options.timeoutMs ?? GIT_HISTORY_TIMEOUT_MS);
  const times = await readGitContentTimes(root, deadline);
  if (useCache) {
    gitTimesCache.set(cacheKey, times);
  }
  return times;
}

async function readGitContentTimes(
  root: string,
  deadline: number,
): Promise<Map<string, number>> {
  try {
    const renameArgs = ["-C", root, "log", "-M", "--format=", "--name-status", "--diff-filter=R"];
    const renameResult = await execFileAsync("git", renameArgs, {
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      timeout: remainingGitBudget(deadline, renameArgs),
      killSignal: "SIGKILL",
    });
    const forward = new Map<string, string>();
    for (const line of renameResult.stdout.split(/\r?\n/u)) {
      if (!line.startsWith("R")) {
        continue;
      }
      const parts = line.split("\t");
      const oldPath = parts[1];
      const newPath = parts[2];
      if (parts.length === 3 && oldPath && newPath) {
        forward.set(oldPath, newPath);
      }
    }

    const contentArgs = ["-C", root, "log", "-M", "--format=C%at", "--name-status", "--diff-filter=ACM"];
    const contentResult = await execFileAsync("git", contentArgs, {
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      timeout: remainingGitBudget(deadline, contentArgs),
      killSignal: "SIGKILL",
    });
    const times = new Map<string, number>();
    let currentTimestamp: number | undefined;
    for (const line of contentResult.stdout.split(/\r?\n/u)) {
      if (/^C\d+$/u.test(line)) {
        currentTimestamp = Number(line.slice(1));
        continue;
      }
      if (!line.trim() || currentTimestamp === undefined) {
        continue;
      }
      const path = line.split("\t").at(-1);
      if (!path) {
        continue;
      }
      const resolved = resolveRename(path, forward);
      if (!times.has(resolved)) {
        times.set(resolved, currentTimestamp);
      }
    }
    return times;
  } catch {
    return new Map();
  }
}

export function repoFloorTimestamp(times: ReadonlyMap<string, number>): number | undefined {
  let floor: number | undefined;
  for (const timestamp of times.values()) {
    floor = floor === undefined ? timestamp : Math.min(floor, timestamp);
  }
  return floor;
}

export interface ContentAgeOptions {
  relativePath: string;
  absolutePath: string;
  gitTimes: ReadonlyMap<string, number>;
  now?: Date;
  floorTimestamp?: number;
}

export async function contentAgeDays(options: ContentAgeOptions): Promise<number> {
  const candidates: number[] = [];
  const gitTimestamp = options.gitTimes.get(options.relativePath);
  if (gitTimestamp !== undefined) {
    candidates.push(gitTimestamp * 1000);
  }

  try {
    candidates.push((await stat(options.absolutePath)).mtimeMs);
  } catch {
    // A disappeared file simply has no age signal.
  }

  if (candidates.length === 0) {
    return 0;
  }

  let ageTimestamp = Math.min(...candidates);
  const filenameTimestamp = filenameDateTimestamp(options.relativePath);
  const floor = options.floorTimestamp;
  if (
    gitTimestamp !== undefined
    && floor !== undefined
    && gitTimestamp <= floor + 3 * 86_400
    && filenameTimestamp !== undefined
    && filenameTimestamp * 1000 < ageTimestamp
  ) {
    ageTimestamp = filenameTimestamp * 1000;
  }

  const now = options.now ?? new Date();
  return Math.max(0, (now.getTime() - ageTimestamp) / DAY_MS);
}

export function isActive(
  relativePath: string,
  activePaths: ReadonlySet<string>,
  activeDirPrefixes: ReadonlySet<string>,
): boolean {
  if (activePaths.has(relativePath)) {
    return true;
  }
  return [...activeDirPrefixes].some((prefix) => relativePath.startsWith(prefix));
}

export function activePathsFromConfig(config: VaultConfig): {
  files: Set<string>;
  directories: Set<string>;
} {
  return {
    files: new Set(config.activity.active_paths),
    directories: new Set(config.activity.active_dir_prefixes),
  };
}

export function thermalTier(
  ageDays: number,
  hasIncoming: boolean,
  lifecycle: Lifecycle,
  active: boolean,
  config: VaultConfig,
): ThermalTier {
  if (active || ageDays < config.thermal.hot_max_days) {
    return "hot";
  }
  if (
    ageDays > config.thermal.warm_max_days
    && !hasIncoming
    && lifecycle !== "master"
  ) {
    return "cold";
  }
  return "warm";
}

export interface GcGuardContext {
  /** Vault-relative path with the root label already stripped. */
  relativePath: string;
  lifecycle: Lifecycle;
  kind: string;
  hasIncoming: boolean;
  active: boolean;
  routingRefs: ReadonlySet<string>;
  config: VaultConfig;
}

/**
 * Structural guardrails shared by gc propose and gc apply: returns a reason
 * string when a document must NOT be archived, or undefined when it may be. The
 * same guards run at both stages so an apply re-verifies everything the proposal
 * asserted. Ported from brain_lifecycle.gc_guard_reason; the two vault-specific
 * literal guards (cadrage and pilotage docs) are intentionally not ported since
 * open-brain is generic and covers the same intent through config.activity.
 */
export function gcGuardReason(context: GcGuardContext): string | undefined {
  const { relativePath, lifecycle, kind, hasIncoming, active, routingRefs, config } = context;
  const name = basename(relativePath);
  const indexPrefix = toPosixPath(config.paths.index).replace(/\/+$/u, "") + "/";
  const archivePrefix = toPosixPath(config.paths.archive).replace(/\/+$/u, "") + "/";
  const preferencesPrefix = toPosixPath(config.paths.memory).replace(/\/+$/u, "") + "/preferences/";

  if (name === "_index.md" || kind === "index") {
    return "index_page";
  }
  if (lifecycle === "master") {
    return "lifecycle_master";
  }
  if (relativePath.startsWith(indexPrefix)) {
    return "index_zone";
  }
  if (relativePath.startsWith(preferencesPrefix)) {
    return "preferences_zone";
  }
  if (relativePath.startsWith(archivePrefix)) {
    return "already_archived";
  }
  if (routingRefs.has(relativePath)) {
    return "routing_reference";
  }
  if (active) {
    return "active_workstream";
  }
  if (hasIncoming) {
    return "has_incoming_link";
  }
  return undefined;
}

export function isExpired(expires: string | undefined, now = new Date()): boolean {
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/u.test(expires)) {
    return false;
  }
  const expiry = new Date(expires + "T00:00:00.000Z");
  if (Number.isNaN(expiry.getTime())) {
    return false;
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return expiry.getTime() < today;
}
