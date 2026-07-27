import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { estimateTokens } from "../src/core/budget.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  buildDecision,
  journalDirectory,
  journalPartitionName,
  journalPartitionPath,
  listJournalPartitions,
  newDecisionId,
  noteError,
  readJournal,
  writeEntry,
  writeEntryTolerant,
} from "../src/learning/journal.js";
import {
  INPUT_SUMMARY_CAP,
  LINE_MAX_BYTES,
  InvariantError,
  fitLine,
  validateJournalEntry,
} from "../src/learning/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const journalModuleUrl = new URL("../src/learning/journal.ts", import.meta.url).href;
const configModuleUrl = new URL("../src/core/config.ts", import.meta.url).href;

interface Vault {
  root: string;
  config: VaultConfig;
}

async function armedVault(prefix: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "capabilities:\n  learning:\n    enabled: true\n",
    "utf8",
  );
  return { root, config: await loadConfig(root) };
}

function routeDecision(ts: string, session = "session-1"): ReturnType<typeof buildDecision> {
  return buildDecision({
    session,
    type: "route",
    input: { text: "how do I bound the context of a route", summary: "route request" },
    options: ["engineering", "writing"],
    choice: "engineering",
    score: 0.82,
    documents: ["10_memory/_state.md"],
    ts,
  });
}

test("a decision is written, read back, and the read is bounded and priced", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-write-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 25; index += 1) {
    const minute = String(index).padStart(2, "0");
    await writeEntry(config, root, routeDecision(`2026-07-10T09:${minute}:00Z`));
  }

  const read = await readJournal(config, root, { limit: 5 });
  assert.equal(read.entries.length, 5);
  assert.equal(read.budget.items_shown, 5);
  assert.equal(read.budget.items_total, 25);
  assert.equal(read.budget.truncated, true);
  assert.ok(read.budget.chars > 0);
  // The shared estimator, so two organs never disagree on what a block costs.
  assert.equal(
    read.budget.token_estimate,
    estimateTokens(read.entries.map((entry) => JSON.stringify(entry)).join("\n")),
  );
  assert.equal(read.invalid, 0);
  // Newest last, and the window really is the newest one.
  assert.equal(read.entries[4]?.ts, "2026-07-10T09:24:00Z");
  assert.equal(read.entries[0]?.ts, "2026-07-10T09:20:00Z");

  const everything = await readJournal(config, root, { limit: 1000 });
  assert.equal(everything.budget.truncated, false);
  assert.equal(everything.budget.items_shown, 25);
});

test("I11: a journal read is never unbounded", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-bounded-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeEntry(config, root, routeDecision("2026-07-10T09:00:00Z"));

  for (const limit of [0, -1, 1.5]) {
    await assert.rejects(
      async () => readJournal(config, root, { limit }),
      (error: unknown) => {
        assert.ok(error instanceof ExpectedError);
        assert.match(error.message, /limit of at least one entry/u);
        return true;
      },
    );
  }

  const capped = await readJournal(config, root, { limit: 10, maxChars: 10 });
  assert.equal(capped.entries.length, 0);
  assert.equal(capped.budget.items_total, 1);
  assert.equal(capped.budget.truncated, true);
});

test("entries are partitioned by month and older partitions are announced, not read", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-partitions-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("2026-05-02T09:00:00Z"));
  await writeEntry(config, root, routeDecision("2026-06-02T09:00:00Z"));
  await writeEntry(config, root, routeDecision("2026-07-02T09:00:00Z"));

  assert.equal(journalPartitionName("2026-07-02T09:00:00Z"), "journal-2026-07.jsonl");
  assert.deepEqual(await listJournalPartitions(config, root), [
    "journal-2026-07.jsonl",
    "journal-2026-06.jsonl",
    "journal-2026-05.jsonl",
  ]);

  const read = await readJournal(config, root, { limit: 50, maxPartitions: 1 });
  assert.equal(read.entries.length, 1);
  assert.deepEqual(read.partitions, ["journal-2026-07.jsonl"]);
  assert.equal(read.partitions_skipped, 2);
  assert.equal(read.budget.truncated, true);
});

test("a filtered read answers a question instead of dumping the journal", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-filter-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("2026-07-10T09:00:00Z", "session-a"));
  await writeEntry(config, root, routeDecision("2026-07-10T09:01:00Z", "session-b"));
  await writeEntry(config, root, buildDecision({
    session: "session-a",
    type: "produced",
    input: { text: "write the report", summary: "produced a report" },
    documents: ["50_outputs/report.md"],
    ts: "2026-07-10T09:02:00Z",
  }));

  const bySession = await readJournal(config, root, { limit: 10, session: "session-a" });
  assert.equal(bySession.budget.items_total, 2);
  const byType = await readJournal(config, root, { limit: 10, types: ["produced"] });
  assert.equal(byType.budget.items_total, 1);
  const byWindow = await readJournal(config, root, {
    limit: 10,
    since: "2026-07-10T09:01:00Z",
  });
  assert.equal(byWindow.budget.items_total, 2);
});

test("an oversized line is shrunk to fit, keeps its essential fields, and says so", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-cap-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const entry = buildDecision({
    session: "session-1",
    type: "route",
    input: { text: "x".repeat(20_000), summary: "a very wide route" },
    options: Array.from({ length: 400 }, (_, index) => `candidate-${String(index)}`),
    choice: "candidate-0",
    documents: Array.from({ length: 400 }, (_, index) => `40_sources/file-${String(index)}.md`),
    beliefs_applied: ["b_bounded_context"],
    beliefs_evicted: ["b_other_belief"],
    ts: "2026-07-10T09:00:00Z",
  });

  const written = await writeEntry(config, root, entry);
  assert.equal(written.truncated, true);
  assert.ok(written.bytes <= LINE_MAX_BYTES, `line is ${String(written.bytes)} bytes`);

  const read = await readJournal(config, root, { limit: 1 });
  const stored = read.entries[0];
  assert.ok(stored);
  assert.equal(stored.truncated, true);
  assert.ok("beliefs_applied" in stored);
  // The join key of the learning loop is never shortened to buy room.
  assert.deepEqual(stored.beliefs_applied, ["b_bounded_context"]);
  assert.deepEqual(stored.beliefs_evicted, ["b_other_belief"]);
  assert.equal(stored.id, entry.id);
  assert.equal(stored.session, "session-1");
  assert.equal(stored.choice, "candidate-0");
  // A shrunk line still satisfies its own contract.
  validateJournalEntry(stored);
});

test("a line that cannot be shrunk raises instead of writing an invalid one", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-irreducible-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  // Every oversized field here is essential, so there is nothing the fitter is
  // allowed to touch. It must refuse rather than hand back a record that no
  // longer validates.
  const entry = buildDecision({
    session: "s".repeat(6_000),
    type: "route",
    input: { text: "wide", summary: "wide" },
    ts: "2026-07-10T09:00:00Z",
  });
  assert.throws(
    () => {
      fitLine(entry, LINE_MAX_BYTES);
    },
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "line.cap.irreducible");
      return true;
    },
  );
  await assert.rejects(async () => writeEntry(config, root, entry));
  assert.deepEqual(await listJournalPartitions(config, root), []);
});

test("the journal records a hash and a bounded summary, never the prompt itself", () => {
  const secret = "my api key is 0123456789abcdef and my client is a real person";
  const entry = buildDecision({
    session: "session-1",
    type: "route",
    input: { text: secret, summary: "x".repeat(400) },
    ts: "2026-07-10T09:00:00Z",
  });
  const line = JSON.stringify(entry);
  assert.ok(!line.includes(secret));
  assert.ok(!line.includes("0123456789abcdef"));
  assert.match(entry.input.hash, /^sha1:[0-9a-f]{40}$/u);
  assert.equal(entry.input.summary.length, INPUT_SUMMARY_CAP);
});

test("the journal refuses to run while the learning capability is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-journal-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = DEFAULT_CONFIG;
  const entry = routeDecision("2026-07-10T09:00:00Z");

  await assert.rejects(
    async () => writeEntry(config, root, entry),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning is disabled/u);
      return true;
    },
  );
  await assert.rejects(async () => readJournal(config, root, { limit: 1 }));

  // The tolerant path is what a hook point uses, so it never raises and never
  // writes anything when the capability is off.
  assert.equal(await writeEntryTolerant(config, root, entry, "test"), undefined);
  await noteError(config, root, "test", new Error("boom"));
  await assert.rejects(readFile(join(journalDirectory(config, root), "journal-2026-07.jsonl")));
});

test("a corrupt line is counted and skipped, never guessed at", async (t) => {
  const { root, config } = await armedVault("open-brain-journal-corrupt-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("2026-07-10T09:00:00Z"));
  const path = journalPartitionPath(config, root, "2026-07-10T09:00:00Z");
  const raw = await readFile(path, "utf8");
  await writeFile(path, `${raw}{"not":"a decision"}\nnot json at all\n`, "utf8");

  const read = await readJournal(config, root, { limit: 10 });
  assert.equal(read.entries.length, 1);
  assert.equal(read.invalid, 2);
});

const CHILD_SCRIPT = `
import { buildDecision, writeEntry } from ${JSON.stringify(journalModuleUrl)};
import { loadConfig } from ${JSON.stringify(configModuleUrl)};

const options = JSON.parse(process.argv[2]);
const config = await loadConfig(options.root);
for (let index = 0; index < options.count; index += 1) {
  await writeEntry(config, options.root, buildDecision({
    session: options.session,
    type: "route",
    input: { text: "concurrent " + String(index), summary: "concurrent write" },
    ts: "2026-07-10T09:00:00Z",
  }));
}
process.exit(0);
`;

function runChild(scriptPath: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, JSON.stringify(payload)],
      { cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? -1);
    });
  });
}

test("two processes journaling at once never lose or corrupt an entry", async (t) => {
  const { root } = await armedVault("open-brain-journal-concurrent-");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptPath = join(root, "child.mjs");
  await writeFile(scriptPath, CHILD_SCRIPT, "utf8");

  const count = 250;
  const codes = await Promise.all([
    runChild(scriptPath, { root, count, session: "process-a" }),
    runChild(scriptPath, { root, count, session: "process-b" }),
  ]);
  assert.deepEqual(codes, [0, 0]);

  const raw = await readFile(
    join(root, "10_memory", "learning", "journal", "journal-2026-07.jsonl"),
    "utf8",
  );
  const lines = raw.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, count * 2, "no append may be lost");

  const sessions = new Map<string, number>();
  for (const line of lines) {
    const entry = validateJournalEntry(JSON.parse(line) as unknown);
    const session = "session" in entry ? entry.session : "";
    sessions.set(session, (sessions.get(session) ?? 0) + 1);
  }
  assert.equal(sessions.get("process-a"), count);
  assert.equal(sessions.get("process-b"), count);
});
