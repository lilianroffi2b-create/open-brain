import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Durable write helpers shared by every module that persists vault state.
 * Content goes to a temporary sibling file, is flushed to disk, and only then
 * replaces the target through a rename, so a reader never observes a partial
 * file. The parent directory is flushed after the rename because a rename is
 * not durable until the directory entry itself reaches the disk.
 */

function temporaryPathFor(path: string): string {
  return join(dirname(path), "." + basename(path) + "." + randomUUID() + ".tmp");
}

async function writeTemporaryFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a directory so a rename that already succeeded survives a crash.
 * Never throws: Windows cannot open a directory as a file and some filesystems
 * refuse fsync on a directory, and failing a write that already landed would be
 * worse than accepting a weaker durability guarantee on those platforms.
 */
export async function fsyncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWriteText(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = temporaryPathFor(path);
  try {
    await writeTemporaryFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(directory);
}

/** Writes pretty-printed JSON with the trailing newline used by every vault artifact. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

export interface AtomicWriteEntry {
  path: string;
  content: string;
}

/**
 * Writes a set of files as close to all-or-nothing as a filesystem allows
 * without a database. Every temporary file is written and flushed first, then
 * the renames run back to back, then each distinct parent directory is flushed
 * once.
 *
 * What this guarantees: no target file is ever partially written, and no target
 * is touched at all if any content fails to reach the disk, because every
 * rename happens after every write.
 *
 * What this does NOT guarantee: it is not an ACID transaction. The renames are
 * separate syscalls, so a crash or a filesystem error in the middle of the
 * rename phase can leave earlier entries updated and later entries untouched.
 * Renames that already succeeded are not rolled back; only the temporary files
 * that never landed are removed before the error is re-raised. Callers that
 * need a consistent set across a crash must make the set self-describing, for
 * example by writing a manifest last and treating it as the commit point.
 */
export async function atomicWriteSet(entries: AtomicWriteEntry[]): Promise<void> {
  const prepared = entries.map((entry) => ({
    path: entry.path,
    content: entry.content,
    temporaryPath: temporaryPathFor(entry.path),
  }));
  const directories = [...new Set(prepared.map((entry) => dirname(entry.path)))];
  const pending = new Set(prepared.map((entry) => entry.temporaryPath));

  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
    }
    for (const entry of prepared) {
      await writeTemporaryFile(entry.temporaryPath, entry.content);
    }
    for (const entry of prepared) {
      await rename(entry.temporaryPath, entry.path);
      pending.delete(entry.temporaryPath);
    }
  } catch (error) {
    for (const temporaryPath of pending) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw error;
  }

  for (const directory of directories) {
    await fsyncDirectory(directory);
  }
}
