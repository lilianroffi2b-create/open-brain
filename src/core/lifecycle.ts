import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

import type { Lifecycle, ThermalTier, VaultConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;
const FILENAME_DATE = /(20\d{2})-(\d{2})-(\d{2})/u;

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

export async function gitContentTimes(root: string): Promise<Map<string, number>> {
  try {
    const renameResult = await execFileAsync(
      "git",
      ["-C", root, "log", "-M", "--format=", "--name-status", "--diff-filter=R"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
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

    const contentResult = await execFileAsync(
      "git",
      ["-C", root, "log", "-M", "--format=C%at", "--name-status", "--diff-filter=ACM"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
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
