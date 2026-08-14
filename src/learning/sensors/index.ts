import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { estimateTokens, type ContextBudget } from "../../core/budget.js";
import { isEnabled, requireCapability } from "../../core/capabilities.js";
import { VAULT_CONFIG_RELATIVE_PATH } from "../../core/config.js";
import { ExpectedError } from "../../core/errors.js";
import { atomicWriteJson, fsyncDirectory } from "../../core/fs-atomic.js";
import type { VaultConfig } from "../../core/types.js";
import { isLearningDisabled, readPopulation } from "../population.js";
import { learningDirectory } from "../store.js";
import {
  LEARNING_SCHEMA_VERSION,
  LINE_MAX_BYTES,
  SENSORS,
  SchemaError,
  encodeLine,
  fitLine,
  nowTs,
  validateObservation,
  type Observation,
  type SensorName,
} from "../types.js";
import {
  CIRCULATION_MEASURES,
  aggregateReads,
  buildCirculationDrafts,
  circulationSubject,
  graftReadsFromJournal,
  type DocumentRead,
  type TranscriptSource,
} from "./circulation.js";

/**
 * The sensor registry and the plumbing every sensor shares: observation ids,
 * the append only observation file, and the cursors an incremental read needs.
 *
 * The registry declares what exists and nothing else. Announcing ten sensors
 * where one is built would advertise a capacity this layer does not have, and a
 * reader has no way to tell a declared name from a working one.
 */

export const OBSERVATIONS_FILENAME = "observations.jsonl";
export const CURSORS_FILENAME = "cursors.json";
export const JOURNAL_CURSOR_KEY = "journal";

/** Bytes read from the end of the observation file to answer a bounded question. */
export const OBSERVATION_TAIL_BYTES = 256 * 1024;
export const OBSERVATION_SEQUENCE_MAX = 9_999;

export interface SensorDescriptor {
  name: SensorName;
  title: string;
  measures: readonly string[];
  sources: readonly string[];
  /** Said plainly, because a floor read as a total is a wrong conclusion. */
  caveat: string;
}

export const SENSOR_REGISTRY: readonly SensorDescriptor[] = [
  {
    name: "circulation",
    title: "How often each document of the population is read, per month",
    measures: CIRCULATION_MEASURES,
    sources: ["decision journal (route entries)", "session transcripts (when consented)"],
    caveat:
      "The number is a floor, never a total: a read performed outside these two sources leaves no trace this sensor can see.",
  },
];

export function listSensors(): readonly SensorDescriptor[] {
  return SENSOR_REGISTRY;
}

export function describeSensor(name: SensorName): SensorDescriptor {
  const descriptor = SENSOR_REGISTRY.find((sensor) => sensor.name === name);
  if (!descriptor) {
    throw new ExpectedError(`No sensor named ${name} is built in this vault.`);
  }
  return descriptor;
}

/** Names declared by the contract that no module produces. Kept honest, not hidden. */
export function unbuiltSensors(): readonly string[] {
  return SENSORS.filter((name) => !SENSOR_REGISTRY.some((sensor) => sensor.name === name));
}

// ---------------------------------------------------------------------------
// Tuning. Lists, caps and windows live in the vault configuration, never in the
// code. What ships here is a generic English default, honest about being one.
// ---------------------------------------------------------------------------

export interface CirculationTuning {
  /** Transcript tool names that count as reading a document. */
  read_tools: string[];
  /** Transcript tool names that count as writing one. */
  write_tools: string[];
  /** Monthly journal partitions one pass may open. */
  max_partitions: number;
  /** Journal entries one pass may look at. */
  max_entries: number;
}

export interface EvaluatorTuning {
  correction_window_turns: number;
  confirmation_window_turns: number;
  dead_output_days: number;
  /** Deliberately uncalibrated: the rule it feeds ships disarmed. */
  rapid_followup_seconds: number;
  session_closed_hours: number;
}

export interface InjectionTuning {
  max_chars: number;
  max_law: number;
  max_active: number;
  statement_clip: number;
  drift_alert_tokens: number;
}

export interface LearningTuning {
  sensors: { circulation: CirculationTuning };
  evaluator: EvaluatorTuning;
  injection: InjectionTuning;
}

export const DEFAULT_LEARNING_TUNING: LearningTuning = {
  sensors: {
    circulation: {
      read_tools: ["Read", "NotebookRead"],
      write_tools: ["Write", "Edit", "NotebookEdit"],
      max_partitions: 2,
      max_entries: 2_000,
    },
  },
  evaluator: {
    correction_window_turns: 2,
    confirmation_window_turns: 3,
    dead_output_days: 7,
    rapid_followup_seconds: 120,
    session_closed_hours: 12,
  },
  injection: {
    max_chars: 1_500,
    max_law: 1,
    max_active: 1,
    statement_clip: 160,
    drift_alert_tokens: 350,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function section(value: unknown, key: string): Record<string, unknown> {
  const parent = isRecord(value) ? value[key] : undefined;
  return isRecord(parent) ? parent : {};
}

function asPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return [...fallback];
  }
  const cleaned = (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
  return cleaned.length === 0 ? [...fallback] : [...new Set(cleaned)];
}

/**
 * Reads the learning tuning from the vault configuration. Anything absent or
 * malformed falls back to the generic default rather than raising: a tuning
 * mistake must never stop a purely observational organ.
 */
export async function readLearningTuning(root: string): Promise<LearningTuning> {
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(join(root, VAULT_CONFIG_RELATIVE_PATH), "utf8")) as unknown;
  } catch {
    return DEFAULT_LEARNING_TUNING;
  }
  const learning = section(parsed, "learning");
  const circulation = section(section(learning, "sensors"), "circulation");
  const evaluator = section(learning, "evaluator");
  const injection = section(learning, "injection");
  const defaults = DEFAULT_LEARNING_TUNING;

  return {
    sensors: {
      circulation: {
        read_tools: asStringList(circulation.read_tools, defaults.sensors.circulation.read_tools),
        write_tools: asStringList(circulation.write_tools, defaults.sensors.circulation.write_tools),
        max_partitions: asPositiveInteger(
          circulation.max_partitions,
          defaults.sensors.circulation.max_partitions,
        ),
        max_entries: asPositiveInteger(
          circulation.max_entries,
          defaults.sensors.circulation.max_entries,
        ),
      },
    },
    evaluator: {
      correction_window_turns: asPositiveInteger(
        evaluator.correction_window_turns,
        defaults.evaluator.correction_window_turns,
      ),
      confirmation_window_turns: asPositiveInteger(
        evaluator.confirmation_window_turns,
        defaults.evaluator.confirmation_window_turns,
      ),
      dead_output_days: asPositiveInteger(
        evaluator.dead_output_days,
        defaults.evaluator.dead_output_days,
      ),
      rapid_followup_seconds: asPositiveInteger(
        evaluator.rapid_followup_seconds,
        defaults.evaluator.rapid_followup_seconds,
      ),
      session_closed_hours: asPositiveInteger(
        evaluator.session_closed_hours,
        defaults.evaluator.session_closed_hours,
      ),
    },
    injection: {
      max_chars: asPositiveInteger(injection.max_chars, defaults.injection.max_chars),
      max_law: asPositiveInteger(injection.max_law, defaults.injection.max_law),
      max_active: asPositiveInteger(injection.max_active, defaults.injection.max_active),
      statement_clip: asPositiveInteger(injection.statement_clip, defaults.injection.statement_clip),
      drift_alert_tokens: asPositiveInteger(
        injection.drift_alert_tokens,
        defaults.injection.drift_alert_tokens,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Cursors.
// ---------------------------------------------------------------------------

export class CorruptCursorsError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "CorruptCursorsError";
  }
}

export interface Cursors {
  schema_version: number;
  updated_at: string;
  cursors: Record<string, number>;
}

/** The key is the digest of the path, never the path: a cursor has no business recording a local tree. */
export function cursorKey(path: string): string {
  return createHash("sha1").update(path, "utf8").digest("hex");
}

export function cursorsPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), CURSORS_FILENAME);
}

export function observationsPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), OBSERVATIONS_FILENAME);
}

/**
 * Reads the cursors, and raises BEFORE anything is measured when they cannot be
 * read. An eaten cursor once made a pass re-read a whole transcript while still
 * believing it was incremental, and it added that full total to the previous
 * one: six real reads became twelve, in an append only file that nothing comes
 * back to fix.
 */
export async function readCursors(config: VaultConfig, root: string): Promise<Cursors> {
  const path = cursorsPath(config, root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { schema_version: LEARNING_SCHEMA_VERSION, updated_at: nowTs(), cursors: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CorruptCursorsError(
      `The sensor cursors at ${path} are not valid JSON. Nothing was measured. Delete the file to restart the sensors from zero.`,
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.cursors)) {
    throw new CorruptCursorsError(
      `The sensor cursors at ${path} do not have the expected shape. Nothing was measured.`,
    );
  }
  const cursors: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.cursors)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new CorruptCursorsError(
        `The cursor "${key}" in ${path} is not a byte offset. Nothing was measured.`,
      );
    }
    cursors[key] = value;
  }
  return {
    schema_version: typeof parsed.schema_version === "number"
      ? parsed.schema_version
      : LEARNING_SCHEMA_VERSION,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : nowTs(),
    cursors,
  };
}

export async function writeCursors(
  config: VaultConfig,
  root: string,
  cursors: Record<string, number>,
  now: string = nowTs(),
): Promise<void> {
  await atomicWriteJson(cursorsPath(config, root), {
    schema_version: LEARNING_SCHEMA_VERSION,
    updated_at: now,
    cursors,
  });
}

// ---------------------------------------------------------------------------
// Observations.
// ---------------------------------------------------------------------------

export function observationId(ts: string, sequence: number): string {
  const day = ts.slice(0, 10).replace(/-/gu, "");
  return `obs_${day}_${String(sequence).padStart(4, "0")}`;
}

/**
 * The next free sequence for a day, read from the tail of the file. Two passes
 * on the same day must not mint the same identifier, and the file is append only
 * and chronological, so the answer always sits at the end of it.
 */
export async function nextObservationSequence(
  config: VaultConfig,
  root: string,
  ts: string,
): Promise<number> {
  const prefix = `"id":"obs_${ts.slice(0, 10).replace(/-/gu, "")}_`;
  const lines = await readTailLines(observationsPath(config, root), OBSERVATION_TAIL_BYTES);
  let highest = 0;
  for (const line of lines) {
    const compact = line.replace(/\s+/gu, "");
    const at = compact.indexOf(prefix);
    if (at === -1) {
      continue;
    }
    const sequence = Number.parseInt(compact.slice(at + prefix.length, at + prefix.length + 4), 10);
    if (Number.isInteger(sequence) && sequence > highest) {
      highest = sequence;
    }
  }
  return highest + 1;
}

/**
 * Reads the last bytes of a file and drops the partial line at the front. Every
 * question this module answers about past observations is answered from the
 * tail: the file is append only and chronological, so the answer is there.
 */
async function readTailLines(path: string, maxBytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return [];
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}

export interface ObservationRead {
  observations: Observation[];
  budget: ContextBudget;
  invalid: number;
  truncated: boolean;
}

export interface ObservationReadOptions {
  limit: number;
  sensor?: SensorName;
  subject?: string;
  maxBytes?: number;
}

/** Bounded by construction, invariant I11: it takes a limit and reports its cost. */
export async function readObservations(
  config: VaultConfig,
  root: string,
  options: ObservationReadOptions,
): Promise<ObservationRead> {
  requireCapability(config, "learning");
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new SchemaError("An observation read needs a limit of at least one entry.");
  }
  const lines = await readTailLines(
    observationsPath(config, root),
    options.maxBytes ?? OBSERVATION_TAIL_BYTES,
  );
  const kept: Observation[] = [];
  let invalid = 0;
  let total = 0;
  for (const line of lines) {
    let observation: Observation;
    try {
      observation = validateObservation(JSON.parse(line) as unknown);
    } catch {
      invalid += 1;
      continue;
    }
    if (options.sensor !== undefined && observation.sensor !== options.sensor) {
      continue;
    }
    if (options.subject !== undefined && observation.subject !== options.subject) {
      continue;
    }
    total += 1;
    kept.push(observation);
    if (kept.length > options.limit) {
      kept.shift();
    }
  }
  const text = kept.map((observation) => JSON.stringify(observation)).join("\n");
  return {
    observations: kept,
    invalid,
    truncated: total > kept.length,
    budget: {
      chars: text.length,
      token_estimate: estimateTokens(text),
      items_shown: kept.length,
      items_total: total,
      truncated: total > kept.length,
    },
  };
}

/** The last reading per subject, which is what an incremental pass carries over. */
export async function latestBySubject(
  config: VaultConfig,
  root: string,
  sensor: SensorName,
): Promise<Map<string, Observation>> {
  const read = await readObservations(config, root, { limit: 5_000, sensor });
  const latest = new Map<string, Observation>();
  for (const observation of read.observations) {
    latest.set(observation.subject, observation);
  }
  return latest;
}

async function appendLines(path: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true });
  const existed = await stat(path).then(() => true).catch(() => false);
  const handle = await open(path, "a");
  try {
    for (const line of lines) {
      await handle.write(Buffer.from(line, "utf8"));
    }
    await handle.datasync();
  } finally {
    await handle.close();
  }
  if (!existed) {
    await fsyncDirectory(directory);
  }
}

export async function appendObservations(
  config: VaultConfig,
  root: string,
  observations: readonly Observation[],
): Promise<{ written: number; truncated: number }> {
  requireCapability(config, "learning");
  const lines: string[] = [];
  let truncated = 0;
  for (const observation of observations) {
    const validated = validateObservation(observation);
    const fitted = fitLine(validated, LINE_MAX_BYTES);
    const final = validateObservation(fitted.record);
    if (fitted.truncated) {
      truncated += 1;
    }
    lines.push(encodeLine(final));
  }
  await appendLines(observationsPath(config, root), lines);
  return { written: lines.length, truncated };
}

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

export interface SensorPassOptions {
  now?: string;
  /** Absent means transcripts are not read at all, which is the default. */
  transcripts?: TranscriptSource;
  /** Inclusive lower bound handed to the journal read. */
  since?: string;
  tuning?: LearningTuning;
}

export interface SensorPassReport {
  ran: boolean;
  reason?: string;
  sensors: SensorName[];
  observations: number;
  truncated: number;
  sources: string[];
  failures: string[];
  /** Said in the report as well as in the registry: this is a floor. */
  floor: true;
  budget: ContextBudget;
}

/**
 * Runs every built sensor once. Purely observational: it writes readings, it
 * never touches a belief, and it stops on the OFF sentinel like every other
 * autonomous act of the layer.
 */
export async function runSensorPass(
  config: VaultConfig,
  root: string,
  options: SensorPassOptions = {},
): Promise<SensorPassReport> {
  requireCapability(config, "learning");
  const now = options.now ?? nowTs();
  const empty: SensorPassReport = {
    ran: false,
    sensors: [],
    observations: 0,
    truncated: 0,
    sources: [],
    failures: [],
    floor: true,
    budget: { chars: 0, token_estimate: 0, items_shown: 0, items_total: 0, truncated: false },
  };

  if (await isLearningDisabled(config, root)) {
    return { ...empty, reason: "disabled" };
  }

  const tuning = options.tuning ?? await readLearningTuning(root);
  // Raises before a single reading is taken, never after.
  const cursors = await readCursors(config, root);
  const population = await readPopulation(config, root);

  const sources: string[] = ["journal"];
  const failures: string[] = [];
  const graft = await graftReadsFromJournal(config, root, {
    limit: tuning.sensors.circulation.max_entries,
    maxPartitions: tuning.sensors.circulation.max_partitions,
    ...(options.since === undefined ? {} : { since: options.since }),
  });

  let transcript: DocumentRead[] = [];
  let fromZero = false;
  let nextCursors = cursors.cursors;
  if (options.transcripts !== undefined && isEnabled(config, "transcripts")) {
    sources.push("transcripts");
    const scan = await options.transcripts.scan(
      cursors.cursors,
      tuning.sensors.circulation.read_tools,
    );
    transcript = scan.events;
    fromZero = scan.from_zero;
    nextCursors = scan.cursors;
    failures.push(...scan.failures);
  }

  const previous = await latestBySubject(config, root, "circulation");
  const tallies = aggregateReads({
    graft: graft.reads,
    transcript,
    previous,
    transcriptFromZero: fromZero,
    population: population?.documents,
    now,
  });

  const drafts = buildCirculationDrafts(tallies, now);
  const firstSequence = await nextObservationSequence(config, root, now);
  const observations: Observation[] = drafts.map((draft, index) =>
    validateObservation(
      {
        schema_version: LEARNING_SCHEMA_VERSION,
        id: observationId(now, Math.min(firstSequence + index, OBSERVATION_SEQUENCE_MAX)),
        sensor: "circulation",
        ts: draft.ts,
        subject: draft.subject,
        population: draft.population,
        measure: draft.measure,
        derived: draft.derived,
      },
      population === undefined ? {} : { population: population.documents },
    ));

  const written = await appendObservations(config, root, observations);
  await writeCursors(config, root, nextCursors, now);

  const text = observations.map((observation) => JSON.stringify(observation)).join("\n");
  return {
    ran: true,
    sensors: ["circulation"],
    observations: written.written,
    truncated: written.truncated,
    sources,
    failures,
    floor: true,
    budget: {
      chars: text.length,
      token_estimate: estimateTokens(text),
      items_shown: observations.length,
      items_total: tallies.length,
      truncated: graft.truncated,
    },
  };
}

export { circulationSubject };
