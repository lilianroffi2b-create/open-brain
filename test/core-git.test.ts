import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { applyReviewedGcProposal, proposeGc, reviewGcProposal } from "../src/core/gc.js";
import { contentAgeDays, gitContentTimes, repoFloorTimestamp } from "../src/core/lifecycle.js";
import type { CatalogRecord, VaultConfig } from "../src/core/types.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args]);
}

async function commit(root: string, message: string, unixSeconds: number): Promise<void> {
  const iso = `@${unixSeconds} +0000`;
  await execFileAsync(
    "git",
    [
      "-C", root,
      "-c", "user.email=test@example.com",
      "-c", "user.name=Test",
      "-c", "commit.gpgsign=false",
      "commit", "-m", message,
    ],
    { env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } },
  );
}

const TS_2026_05_01 = Math.floor(Date.UTC(2026, 4, 1) / 1000);
const TS_2026_05_20 = Math.floor(Date.UTC(2026, 4, 20) / 1000);

test("gitContentTimes follows renames, keeps the newest content change, and floors the repo", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-git-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q"]);

  await writeFile(join(root, "fileOld.md"), "old\n", "utf8");
  await writeFile(join(root, "note-2020-01-01.md"), "dated content\n", "utf8");
  await git(root, ["add", "-A"]);
  await commit(root, "initial", TS_2026_05_01);

  await git(root, ["mv", "fileOld.md", "fileNew.md"]);
  await commit(root, "rename", Math.floor(Date.UTC(2026, 4, 10) / 1000));

  await writeFile(join(root, "fileNew.md"), "old\nmore\n", "utf8");
  await git(root, ["add", "-A"]);
  await commit(root, "modify", TS_2026_05_20);

  const times = await gitContentTimes(root);
  // The rename map resolves the historical path onto its current name.
  assert.equal(times.get("fileNew.md"), TS_2026_05_20);
  assert.equal(times.has("fileOld.md"), false);
  assert.equal(times.get("note-2020-01-01.md"), TS_2026_05_01);
  assert.equal(repoFloorTimestamp(times), TS_2026_05_01);

  // A doc sitting on the repo floor with an older YYYY-MM-DD name ages from the name.
  const floorTimestamp = repoFloorTimestamp(times);
  assert.notEqual(floorTimestamp, undefined);
  const age = await contentAgeDays({
    relativePath: "note-2020-01-01.md",
    absolutePath: join(root, "note-2020-01-01.md"),
    gitTimes: times,
    now: new Date("2026-07-09T00:00:00.000Z"),
    ...(floorTimestamp === undefined ? {} : { floorTimestamp }),
  });
  assert.ok(age > 2000, `expected the 2020 filename to dominate the age, got ${age}`);
});

test("gc apply uses git mv inside a Git repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-gitgc-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q"]);
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "10_memory", "cold.md"), "archive me\n", "utf8");
  await git(root, ["add", "-A"]);
  await commit(root, "seed", TS_2026_05_01);

  const vault: VaultConfig = { ...structuredClone(DEFAULT_CONFIG), root_label: "GitApply" };
  const coldRecord: CatalogRecord = {
    path: "GitApply/10_memory/cold.md",
    layer: "memory",
    domain: "general",
    kind: "note",
    lifecycle: "working",
    tags: [],
    summary: "Cold note.",
    headings: [],
    links: [],
    sha256: "a".repeat(64),
    size: 1,
    token_estimate: 1,
    read_priority: 10,
    source_state: "working",
    tier: "cold",
  };
  const now = new Date("2026-07-09T12:00:00.000Z");
  const reviewed = reviewGcProposal(proposeGc([coldRecord], vault, { now }), "approved", "reviewer", now);
  const applied = await applyReviewedGcProposal(root, vault, reviewed, [coldRecord], now);

  assert.equal(applied.archived_count, 1);
  assert.equal(
    await readFile(join(root, "90_archive", "2026", "10_memory", "cold.md"), "utf8"),
    "archive me\n",
  );
  await assert.rejects(readFile(join(root, "10_memory", "cold.md"), "utf8"));

  // git mv staged the rename, so the archive path is tracked.
  const tracked = (await execFileAsync("git", ["-C", root, "ls-files"])).stdout;
  assert.ok(tracked.includes("90_archive/2026/10_memory/cold.md"));
});
