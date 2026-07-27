import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import { buildDecision, writeEntry } from "../src/learning/journal.js";
import { offFlagPath, writePopulation } from "../src/learning/population.js";
import {
  CorruptCursorsError,
  DEFAULT_LEARNING_TUNING,
  SENSOR_REGISTRY,
  cursorKey,
  cursorsPath,
  describeSensor,
  observationsPath,
  readCursors,
  readLearningTuning,
  readObservations,
  runSensorPass,
  unbuiltSensors,
} from "../src/learning/sensors/index.js";
import {
  aggregateReads,
  circulationSubject,
  type DocumentRead,
  type TranscriptScan,
  type TranscriptSource,
} from "../src/learning/sensors/circulation.js";
import { SENSORS, type Observation } from "../src/learning/types.js";

interface Vault {
  root: string;
  config: VaultConfig;
}

async function vaultWith(prefix: string, capabilities: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), capabilities, "utf8");
  return { root, config: await loadConfig(root) };
}

async function armedVault(prefix: string): Promise<Vault> {
  return vaultWith(prefix, "capabilities:\n  learning:\n    enabled: true\n");
}

async function vaultWithTranscripts(prefix: string): Promise<Vault> {
  return vaultWith(
    prefix,
    [
      "capabilities:",
      "  learning:",
      "    enabled: true",
      "  transcripts:",
      "    enabled: true",
      "    roots:",
      "      - /somewhere/transcripts",
      "",
    ].join("\n"),
  );
}

function routeDecision(id: string, ts: string, documents: string[]): ReturnType<typeof buildDecision> {
  return buildDecision({
    id,
    ts,
    session: "session-1",
    type: "route",
    input: { text: `prompt ${id}`, summary: `summary ${id}` },
    documents,
  });
}

function sourceOf(events: DocumentRead[], fromZero: boolean): TranscriptSource {
  return {
    scan: async (cursors) => {
      const scan: TranscriptScan = {
        events,
        cursors: { ...cursors, [cursorKey("/somewhere/transcripts/a.jsonl")]: events.length },
        from_zero: fromZero,
        failures: [],
      };
      return scan;
    },
  };
}

function measureOf(observations: readonly Observation[], subject: string): Record<string, number> {
  const found = observations.filter((observation) => observation.subject === subject).at(-1);
  assert.ok(found, `no observation for ${subject}`);
  return found.measure;
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

test("the registry declares what exists and nothing else", () => {
  assert.deepEqual(SENSOR_REGISTRY.map((sensor) => sensor.name), ["circulation"]);
  assert.deepEqual([...SENSORS], ["circulation"]);
  assert.deepEqual(unbuiltSensors(), []);

  const circulation = describeSensor("circulation");
  assert.deepEqual([...circulation.measures], ["reads", "reads_transcript", "reads_graft"]);
  // The caveat is part of the contract: a floor read as a total is a wrong
  // conclusion, and the registry says so.
  assert.match(circulation.caveat, /floor/u);
});

test("the tuning lives in the vault configuration, with a generic default", async (t) => {
  const { root } = await armedVault("open-brain-sensors-tuning-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const fallback = await readLearningTuning(root);
  assert.deepEqual(fallback, DEFAULT_LEARNING_TUNING);
  assert.deepEqual(fallback.sensors.circulation.read_tools, ["Read", "NotebookRead"]);

  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    [
      "capabilities:",
      "  learning:",
      "    enabled: true",
      "learning:",
      "  sensors:",
      "    circulation:",
      "      read_tools:",
      "        - OpenFile",
      "        - Lire",
      "  evaluator:",
      "    session_closed_hours: 6",
      "  injection:",
      "    max_chars: 800",
      "",
    ].join("\n"),
    "utf8",
  );
  const tuned = await readLearningTuning(root);
  assert.deepEqual(tuned.sensors.circulation.read_tools, ["OpenFile", "Lire"]);
  assert.equal(tuned.evaluator.session_closed_hours, 6);
  assert.equal(tuned.injection.max_chars, 800);
  // Anything not overridden keeps its default rather than disappearing.
  assert.equal(tuned.evaluator.dead_output_days, DEFAULT_LEARNING_TUNING.evaluator.dead_output_days);
});

// ---------------------------------------------------------------------------
// The measurement.
// ---------------------------------------------------------------------------

test("a pass counts the reads of the graft, per document and per month", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-graft-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("dec_20260701T0900_11111111", "2026-07-01T09:00:00Z", [
    "10_memory/_state.md",
    "20_contexts/brief.md",
  ]));
  await writeEntry(config, root, routeDecision("dec_20260701T1000_22222222", "2026-07-01T10:00:00Z", [
    "10_memory/_state.md",
  ]));

  const report = await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" });
  assert.equal(report.ran, true);
  assert.equal(report.floor, true);
  assert.deepEqual(report.sources, ["journal"]);
  assert.equal(report.observations, 2);

  const read = await readObservations(config, root, { limit: 50 });
  assert.equal(read.invalid, 0);
  assert.ok(read.budget.token_estimate > 0);
  const state = measureOf(read.observations, circulationSubject("10_memory/_state.md", "2026-07"));
  assert.deepEqual(state, { reads: 2, reads_transcript: 0, reads_graft: 2 });
  const brief = measureOf(read.observations, circulationSubject("20_contexts/brief.md", "2026-07"));
  assert.deepEqual(brief, { reads: 1, reads_transcript: 0, reads_graft: 1 });

  const derived = read.observations.at(-1)?.derived;
  assert.equal(derived?.graft_share, 1);
});

test("two passes in a row never double a total", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-idempotent-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("dec_20260701T0900_11111111", "2026-07-01T09:00:00Z", [
    "10_memory/_state.md",
  ]));

  const first = await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" });
  const second = await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" });
  assert.equal(first.observations, 1);
  assert.equal(second.observations, 1);

  const read = await readObservations(config, root, { limit: 50 });
  assert.deepEqual(
    measureOf(read.observations, circulationSubject("10_memory/_state.md", "2026-07")),
    { reads: 1, reads_transcript: 0, reads_graft: 1 },
  );
  // Two readings the same day never share an identifier.
  const ids = read.observations.map((observation) => observation.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a transcript source that restarts replaces its total instead of adding to it", async (t) => {
  const { root, config } = await vaultWithTranscripts("open-brain-sensors-transcript-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const six: DocumentRead[] = Array.from({ length: 6 }, (_unused, index) => ({
    document: "10_memory/_state.md",
    ts: `2026-07-01T09:0${String(index)}:00Z`,
    session: "session-1",
  }));

  await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z", transcripts: sourceOf(six, true) });
  let read = await readObservations(config, root, { limit: 50 });
  assert.equal(
    measureOf(read.observations, circulationSubject("10_memory/_state.md", "2026-07")).reads_transcript,
    6,
  );

  // The cursor was lost, so the source re-read everything. Six real reads must
  // stay six, and never become twelve.
  await runSensorPass(config, root, { now: "2026-07-02T10:00:00Z", transcripts: sourceOf(six, true) });
  read = await readObservations(config, root, { limit: 50 });
  assert.equal(
    measureOf(read.observations, circulationSubject("10_memory/_state.md", "2026-07")).reads_transcript,
    6,
  );

  // An incremental pass that saw two more adds exactly two.
  const two: DocumentRead[] = Array.from({ length: 2 }, (_unused, index) => ({
    document: "10_memory/_state.md",
    ts: `2026-07-01T10:0${String(index)}:00Z`,
    session: "session-1",
  }));
  await runSensorPass(config, root, { now: "2026-07-02T11:00:00Z", transcripts: sourceOf(two, false) });
  read = await readObservations(config, root, { limit: 50 });
  assert.equal(
    measureOf(read.observations, circulationSubject("10_memory/_state.md", "2026-07")).reads_transcript,
    8,
  );

  const cursors = await readCursors(config, root);
  assert.ok(Object.keys(cursors.cursors).length > 0);
});

test("a transcript source is never consulted while that capability is disarmed", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-consent-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  let consulted = false;
  const source: TranscriptSource = {
    scan: async (cursors) => {
      consulted = true;
      return { events: [], cursors, from_zero: false, failures: [] };
    },
  };
  const report = await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z", transcripts: source });
  assert.equal(consulted, false, "a disarmed capability was consulted anyway");
  assert.deepEqual(report.sources, ["journal"]);
});

test("an unreadable cursor raises before a single reading is taken", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-cursor-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("dec_20260701T0900_11111111", "2026-07-01T09:00:00Z", [
    "10_memory/_state.md",
  ]));
  await mkdir(join(root, "10_memory", "learning"), { recursive: true });
  await writeFile(cursorsPath(config, root), "{ this is not json", "utf8");

  await assert.rejects(
    async () => runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof CorruptCursorsError);
      return true;
    },
  );
  // The observation file is append only and nothing comes back to fix it, so a
  // doubtful reading must never reach it.
  await assert.rejects(stat(observationsPath(config, root)));

  await writeFile(cursorsPath(config, root), '{"cursors":{"a":-4}}', "utf8");
  await assert.rejects(
    async () => runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof CorruptCursorsError);
      return true;
    },
  );
});

test("a document outside the population is never measured", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-population-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(config, root, routeDecision("dec_20260701T0900_11111111", "2026-07-01T09:00:00Z", [
    "10_memory/_state.md",
    "10_memory/learning/journal/journal-2026-07.jsonl",
  ]));
  await writePopulation(config, root, {
    schema_version: 1,
    updated_at: "2026-07-01T09:00:00Z",
    total: 1,
    documents: ["10_memory/_state.md"],
  });

  const report = await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" });
  assert.equal(report.observations, 1);
  const read = await readObservations(config, root, { limit: 50 });
  assert.equal(read.observations.length, 1);
  assert.equal(read.observations[0]?.population, "10_memory/_state.md");
});

test("aggregation keeps the graft side authoritative and the transcript side cumulative", () => {
  const previous = new Map<string, Observation>([
    ["10_memory/_state.md@2026-07", {
      schema_version: 1,
      id: "obs_20260701_0001",
      sensor: "circulation",
      ts: "2026-07-01T09:00:00Z",
      subject: "10_memory/_state.md@2026-07",
      population: "10_memory/_state.md",
      measure: { reads: 9, reads_transcript: 4, reads_graft: 5 },
      derived: { graft_share: 0.5556 },
    }],
  ]);
  const graft: DocumentRead[] = [
    { document: "10_memory/_state.md", ts: "2026-07-01T09:00:00Z", session: "s" },
  ];

  const carried = aggregateReads({
    graft,
    transcript: [],
    previous,
    transcriptFromZero: false,
  });
  assert.deepEqual(carried, [{
    subject: "10_memory/_state.md@2026-07",
    document: "10_memory/_state.md",
    month: "2026-07",
    reads_transcript: 4,
    reads_graft: 1,
  }]);

  // A source that started over replaces its own component: the four it had
  // counted before are not added a second time.
  const restarted = aggregateReads({
    graft,
    transcript: [{ document: "10_memory/_state.md", ts: "2026-07-02T09:00:00Z", session: "s" }],
    previous,
    transcriptFromZero: true,
  });
  assert.deepEqual(restarted, [{
    subject: "10_memory/_state.md@2026-07",
    document: "10_memory/_state.md",
    month: "2026-07",
    reads_transcript: 1,
    reads_graft: 1,
  }]);
});

// ---------------------------------------------------------------------------
// Capability and sentinel.
// ---------------------------------------------------------------------------

test("the sensors refuse to run while the learning capability is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-sensors-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const run of [
    async () => runSensorPass(DEFAULT_CONFIG, root, {}),
    async () => readObservations(DEFAULT_CONFIG, root, { limit: 5 }),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning is disabled/u);
      return true;
    });
  }
  await assert.rejects(stat(observationsPath(DEFAULT_CONFIG, root)));
});

test("the OFF sentinel stops the pass without raising", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-off-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "10_memory", "learning"), { recursive: true });
  await writeFile(offFlagPath(config, root), '{"disabled_at":"2026-07-02T09:00:00Z"}\n', "utf8");

  const report = await runSensorPass(config, root, { now: "2026-07-02T10:00:00Z" });
  assert.equal(report.ran, false);
  assert.equal(report.reason, "disabled");
  await assert.rejects(stat(observationsPath(config, root)));
});

test("an observation read is bounded and reports what it left out", async (t) => {
  const { root, config } = await armedVault("open-brain-sensors-budget-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 12; index += 1) {
    await writeEntry(
      config,
      root,
      routeDecision(
        `dec_20260701T09${String(index).padStart(2, "0")}_1111111${String(index % 10)}`,
        `2026-07-01T09:${String(index).padStart(2, "0")}:00Z`,
        [`20_contexts/brief-${String(index)}.md`],
      ),
    );
  }
  await runSensorPass(config, root, { now: "2026-07-02T09:00:00Z" });

  const read = await readObservations(config, root, { limit: 4 });
  assert.equal(read.observations.length, 4);
  assert.equal(read.budget.items_shown, 4);
  assert.equal(read.budget.items_total, 12);
  assert.equal(read.budget.truncated, true);
  assert.ok(read.budget.chars > 0);

  // Nothing in this module ever slurps the whole file to answer a question.
  const bytes = (await readFile(observationsPath(config, root), "utf8")).length;
  assert.ok(read.budget.chars < bytes);
});
