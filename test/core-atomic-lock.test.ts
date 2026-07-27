import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  atomicWriteJson,
  atomicWriteSet,
  atomicWriteText,
  fsyncDirectory,
} from "../src/core/fs-atomic.js";
import { ExpectedError } from "../src/core/errors.js";
import {
  breakStaleLock,
  inspectLock,
  lockPathFor,
  withLock,
  type LockInfo,
} from "../src/core/lock.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const lockModuleUrl = new URL("../src/core/lock.ts", import.meta.url).href;

// Two promises in one process share the in-memory lock registry, so contention
// is only proven by separate operating system processes racing for the file.
const CHILD_SCRIPT = `
import { readFile, writeFile } from "node:fs/promises";
import { withLock } from ${JSON.stringify(lockModuleUrl)};

const options = JSON.parse(process.argv[2]);

try {
  await withLock(
    options.lockPath,
    async () => {
      if (options.counterPath) {
        const current = Number(await readFile(options.counterPath, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, options.holdMs ?? 0));
        await writeFile(options.counterPath, String(current + 1), "utf8");
      }
    },
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(3);
}
`;

interface ChildResult {
  code: number;
  stderr: string;
}

function runChild(scriptPath: string, payload: unknown): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, JSON.stringify(payload)],
      { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(typeof pid === "number", "spawned child should report a pid");
  return pid;
}

async function writeLockFile(path: string, info: LockInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2) + "\n", "utf8");
}

function temporaryFiles(entries: string[]): string[] {
  return entries.filter((entry) => entry.endsWith(".tmp"));
}

test("an atomic write never exposes a partially written file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-atomic-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const target = join(root, "artifact.json");
  const before = "A".repeat(512 * 1024);
  const after = "B".repeat(512 * 1024);
  await atomicWriteText(target, before);

  const write = atomicWriteText(target, after);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const observed = readFileSync(target, "utf8");
    assert.ok(
      observed === before || observed === after,
      `read ${String(observed.length)} bytes of a file that should only ever be complete`,
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  await write;

  assert.equal(await readFile(target, "utf8"), after);
  assert.deepEqual(temporaryFiles(await readdir(root)), []);
});

test("a failed atomic write removes its temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-atomic-fail-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  // Renaming a file onto an existing directory always fails.
  const target = join(root, "occupied");
  await mkdir(target, { recursive: true });

  await assert.rejects(atomicWriteText(target, "payload"));
  assert.deepEqual(temporaryFiles(await readdir(root)), []);
});

test("atomicWriteJson emits pretty JSON with a trailing newline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-atomic-json-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const target = join(root, "nested", "value.json");

  await atomicWriteJson(target, { schema_version: 1, records: [] });

  assert.equal(
    await readFile(target, "utf8"),
    "{\n  \"schema_version\": 1,\n  \"records\": []\n}\n",
  );
});

test("atomicWriteSet writes a whole set across directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-atomic-set-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await atomicWriteSet([
    { path: join(root, "a", "one.md"), content: "one" },
    { path: join(root, "a", "two.md"), content: "two" },
    { path: join(root, "b", "three.md"), content: "three" },
  ]);

  assert.equal(await readFile(join(root, "a", "one.md"), "utf8"), "one");
  assert.equal(await readFile(join(root, "a", "two.md"), "utf8"), "two");
  assert.equal(await readFile(join(root, "b", "three.md"), "utf8"), "three");
  assert.deepEqual(temporaryFiles(await readdir(join(root, "a"))), []);
  assert.deepEqual(temporaryFiles(await readdir(join(root, "b"))), []);
});

test("atomicWriteSet cleans up its temporary files when a rename fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-atomic-set-fail-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const blocked = join(root, "blocked");
  await mkdir(blocked, { recursive: true });

  await assert.rejects(atomicWriteSet([
    { path: join(root, "first.md"), content: "first" },
    { path: blocked, content: "never lands" },
    { path: join(root, "third.md"), content: "third" },
  ]));

  // Documented and deliberate: the set is not an ACID transaction, so a rename
  // that already succeeded stays. What must never remain is a temporary file.
  assert.equal(await readFile(join(root, "first.md"), "utf8"), "first");
  assert.deepEqual(temporaryFiles(await readdir(root)), []);
  assert.deepEqual(await readdir(blocked), []);
});

test("fsyncDirectory stays silent on a directory it cannot sync", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-fsync-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await fsyncDirectory(join(root, "does-not-exist"));
});

test("a lock is taken and released, even when the body throws", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lock-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const lockPath = lockPathFor(root, "vault");

  assert.equal(await inspectLock(lockPath), undefined);
  const held = await withLock(lockPath, async () => {
    const info = await inspectLock(lockPath);
    assert.equal(info?.pid, process.pid);
    assert.equal(info?.hostname, hostname());
    assert.equal(info?.holder, "open-brain");
    return "done";
  });
  assert.equal(held, "done");
  assert.equal(await inspectLock(lockPath), undefined);

  await assert.rejects(
    withLock(lockPath, async () => {
      throw new Error("body failed");
    }),
    /body failed/u,
  );
  assert.equal(await inspectLock(lockPath), undefined);
});

test("reentrant locking is refused instead of deadlocking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lock-reentrant-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const lockPath = lockPathFor(root, "vault");

  await assert.rejects(
    withLock(lockPath, async () => withLock(lockPath, async () => undefined)),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /already held by this process/u);
      return true;
    },
  );
  assert.equal(await inspectLock(lockPath), undefined);
});

test("two real processes contend for the same lock file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lock-processes-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const lockPath = lockPathFor(root, "vault");
  const scriptPath = join(root, "contender.mjs");
  await writeFile(scriptPath, CHILD_SCRIPT, "utf8");

  const refused = await withLock(lockPath, async () => runChild(scriptPath, {
    lockPath,
    timeoutMs: 300,
  }));
  assert.equal(refused.code, 3, `child should have timed out; stderr: ${refused.stderr}`);
  assert.match(refused.stderr, /Timed out/u);
  assert.ok(
    refused.stderr.includes(lockPath),
    `the timeout should name the lock file; stderr: ${refused.stderr}`,
  );
  assert.equal(await inspectLock(lockPath), undefined);

  // Three processes read, wait, then write the counter. Without mutual
  // exclusion they all read the same value and the counter ends at 1.
  const counterPath = join(root, "counter.txt");
  await writeFile(counterPath, "0", "utf8");
  const results = await Promise.all([0, 1, 2].map(async () => runChild(scriptPath, {
    lockPath,
    counterPath,
    holdMs: 30,
  })));

  for (const result of results) {
    assert.equal(result.code, 0, `child should have acquired the lock; stderr: ${result.stderr}`);
  }
  assert.equal(await readFile(counterPath, "utf8"), "3");
});

test("a stale lock whose owner is gone is broken and reacquired", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lock-stale-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const lockPath = lockPathFor(root, "vault");
  await writeLockFile(lockPath, {
    pid: await deadPid(),
    hostname: hostname(),
    acquired_at: new Date(Date.now() - 600_000).toISOString(),
    holder: "open-brain",
  });

  assert.equal(await breakStaleLock(lockPath, 60_000), true);
  assert.equal(await inspectLock(lockPath), undefined);

  await writeLockFile(lockPath, {
    pid: await deadPid(),
    hostname: hostname(),
    acquired_at: new Date(Date.now() - 600_000).toISOString(),
    holder: "open-brain",
  });
  assert.equal(
    await withLock(lockPath, async () => "reclaimed", { timeoutMs: 500 }),
    "reclaimed",
  );
});

test("a lock whose owner is alive is never broken, however old it is", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lock-live-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const lockPath = lockPathFor(root, "vault");
  await writeLockFile(lockPath, {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date(Date.now() - 3_600_000).toISOString(),
    holder: "open-brain",
  });

  assert.equal(await breakStaleLock(lockPath, 1_000), false);
  await assert.rejects(
    withLock(lockPath, async () => "should never run", { timeoutMs: 150, staleMs: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.ok(error.message.includes(lockPath));
      return true;
    },
  );
  assert.equal((await inspectLock(lockPath))?.pid, process.pid);
});

test("a lock recorded on another host is judged on age alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-lock-remote-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fresh = lockPathFor(root, "fresh");
  const old = lockPathFor(root, "old");
  // A living local pid, so only the recorded host keeps it from being trusted.
  const remote = { pid: process.pid, hostname: "another-host", holder: "open-brain" };

  await writeLockFile(fresh, { ...remote, acquired_at: new Date().toISOString() });
  await writeLockFile(old, {
    ...remote,
    acquired_at: new Date(Date.now() - 600_000).toISOString(),
  });

  assert.equal(await breakStaleLock(fresh, 60_000), false);
  assert.equal(await breakStaleLock(old, 60_000), true);
});

test("lock identity follows the resolved vault root, not the typed path", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-brain-lock-identity-")));
  const previousCwd = process.cwd();
  t.after(async () => {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  });

  const absolute = lockPathFor(root, "vault");
  process.chdir(root);
  const relative = lockPathFor(".", "vault");
  const roundabout = lockPathFor(join(root, "..", basename(root)), "vault");

  assert.equal(relative, absolute);
  assert.equal(roundabout, absolute);
  assert.equal(absolute, join(root, "00_index", ".locks", "vault.lock"));
  assert.deepEqual(await readdir(join(root, "00_index", ".locks")), []);
  assert.throws(() => lockPathFor(root, "../escape"), ExpectedError);
});
