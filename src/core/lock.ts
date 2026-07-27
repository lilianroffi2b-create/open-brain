import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ExpectedError } from "./errors.js";

/**
 * Cross-process mutual exclusion for vault writes. Node has no portable flock,
 * so the lock is a file created with the exclusive flag: exactly one process
 * wins the create, everyone else waits. The file carries its owner so a lock
 * left behind by a crashed process can be identified and, when it is provably
 * dead, reclaimed instead of wedging the vault forever.
 */

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCK_STALE_MS = 60_000;
export const DEFAULT_LOCK_HOLDER = "open-brain";

const INITIAL_RETRY_DELAY_MS = 10;
const MAX_RETRY_DELAY_MS = 250;
const LOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

export interface LockInfo {
  pid: number;
  hostname: string;
  acquired_at: string;
  holder: string;
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  holder?: string;
}

interface LockState {
  info?: LockInfo;
  age_ms: number;
}

// Locks held by this process, keyed by resolved lock path. A second withLock on
// the same path would wait for a lock this very process holds, so it is refused.
const heldLocks = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

function isLockInfo(value: unknown): value is LockInfo {
  return (
    isRecord(value)
    && typeof value.pid === "number"
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.hostname === "string"
    && typeof value.acquired_at === "string"
    && typeof value.holder === "string"
  );
}

function parseLockInfo(text: string): LockInfo | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return isLockInfo(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readLockState(lockPath: string): Promise<LockState | undefined> {
  let text: string;
  let mtimeMs: number;
  try {
    text = await readFile(lockPath, "utf8");
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  const info = parseLockInfo(text);
  const acquiredAt = info ? Date.parse(info.acquired_at) : Number.NaN;
  const reference = Number.isNaN(acquiredAt) ? mtimeMs : acquiredAt;
  const ageMs = Math.max(0, Date.now() - reference);
  return info ? { info, age_ms: ageMs } : { age_ms: ageMs };
}

/**
 * A signal of 0 performs the permission and existence check without sending
 * anything. ESRCH means the process is gone; EPERM means it exists but belongs
 * to another user, which still counts as alive.
 */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

/**
 * A lock is breakable only once it is older than staleMs. Past that age, a lock
 * whose owner still runs on this host is still never broken: an old operation
 * is not a dead one. A pid recorded on another host cannot be checked from
 * here, so for those the age is the only evidence available, and the same
 * applies to a lock file whose contents cannot be parsed.
 */
function isBreakable(state: LockState, staleMs: number): boolean {
  if (state.age_ms < staleMs) {
    return false;
  }
  if (!state.info || state.info.hostname !== hostname()) {
    return true;
  }
  return !processIsRunning(state.info.pid);
}

export async function inspectLock(lockPath: string): Promise<LockInfo | undefined> {
  return (await readLockState(resolve(lockPath)))?.info;
}

/**
 * Removes a lock left behind by a process that is provably gone. Returns false
 * when the lock is absent, too young, or still owned by a living process. Best
 * effort by nature: another process may replace the file between the check and
 * the removal, which is why the caller retries the acquisition rather than
 * assuming success.
 */
export async function breakStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const path = resolve(lockPath);
  const state = await readLockState(path);
  if (!state || !isBreakable(state, staleMs)) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function tryCreateLock(lockPath: string, holder: string): Promise<LockInfo | undefined> {
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
    holder,
  };
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(info, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return info;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function describeHolder(info: LockInfo | undefined): string {
  if (!info) {
    return "";
  }
  return ` It is held by ${info.holder} (pid ${String(info.pid)} on ${info.hostname}) since ${info.acquired_at}.`;
}

async function acquireLock(
  lockPath: string,
  holder: string,
  timeoutMs: number,
  staleMs: number,
): Promise<LockInfo> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;

  while (true) {
    const created = await tryCreateLock(lockPath, holder);
    if (created) {
      return created;
    }
    if (await breakStaleLock(lockPath, staleMs)) {
      const reclaimed = await tryCreateLock(lockPath, holder);
      if (reclaimed) {
        return reclaimed;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const current = await readLockState(lockPath);
      throw new ExpectedError(
        `Timed out after ${String(timeoutMs)} ms waiting for the lock file ${lockPath}.`
        + describeHolder(current?.info)
        + ` Wait for the other process to finish, or delete ${lockPath} once you are sure no other process is using this vault.`,
      );
    }
    await delay(Math.min(retryDelayMs, remaining));
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }
}

async function releaseLock(lockPath: string, owned: LockInfo): Promise<void> {
  // Only remove the file we still own. If our lock had been broken as stale and
  // another process re-acquired it, deleting its file would hand the vault to a
  // third process while that one is still writing.
  const state = await readLockState(lockPath).catch(() => undefined);
  if (
    state?.info
    && (state.info.pid !== owned.pid
      || state.info.hostname !== owned.hostname
      || state.info.acquired_at !== owned.acquired_at)
  ) {
    return;
  }
  await unlink(lockPath).catch(() => undefined);
}

/**
 * Runs fn while holding an exclusive lock on lockPath, and releases the lock
 * whatever fn does, including throwing.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const path = resolve(lockPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const holder = options.holder ?? DEFAULT_LOCK_HOLDER;

  if (heldLocks.has(path)) {
    throw new ExpectedError(
      `The lock ${path} is already held by this process. Reentrant locking is refused because it can only ever time out; wrap the whole operation in a single withLock instead.`,
    );
  }

  heldLocks.add(path);
  let owned: LockInfo;
  try {
    owned = await acquireLock(path, holder, timeoutMs, staleMs);
  } catch (error) {
    heldLocks.delete(path);
    throw error;
  }

  try {
    return await fn();
  } finally {
    heldLocks.delete(path);
    await releaseLock(path, owned);
  }
}

/**
 * Resolves the identity of a vault for locking. Two invocations that name the
 * same vault through different paths, "." and an absolute path for instance,
 * must contend for the same file, so symlinks are resolved when the root
 * already exists.
 */
function resolveRootIdentity(root: string): string {
  const absolute = resolve(root);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Returns the canonical lock path for a named vault lock and makes sure its
 * directory exists, because the exclusive create used to take a lock fails when
 * the parent directory is missing.
 */
export function lockPathFor(root: string, name: string): string {
  if (!LOCK_NAME_PATTERN.test(name)) {
    throw new ExpectedError(
      `Invalid lock name "${name}". A lock name may contain only letters, digits, dots, dashes, and underscores, and must start with a letter or a digit.`,
    );
  }
  const directory = join(resolveRootIdentity(root), "00_index", ".locks");
  mkdirSync(directory, { recursive: true });
  return join(directory, name + ".lock");
}
