import { readFile, stat } from "node:fs/promises";

import {
  capItems,
  emptyBudget,
  estimateTokens,
  type ContextBudget,
} from "../core/budget.js";
import {
  describeCapability,
  isEnabled,
  type CapabilityName,
} from "../core/capabilities.js";
import type { VaultConfig } from "../core/types.js";
import { clipStatement, confidenceCap } from "./confidence.js";
import {
  ARMED_RULES,
  readVerdicts,
  VERDICTS_FILENAME,
  verdictsPath,
} from "./evaluator.js";
import {
  JOURNAL_DIRECTORY_NAME,
  JOURNAL_ERRORS_FILENAME,
  journalErrorsPath,
  listJournalPartitions,
  readJournal,
} from "./journal.js";
import {
  isLearningDisabled,
  POPULATION_FILENAME,
  populationPath,
  readPopulation,
} from "./population.js";
import {
  listSensors,
  OBSERVATIONS_FILENAME,
  observationsPath,
  readObservations,
  unbuiltSensors,
} from "./sensors/index.js";
import {
  BELIEFS_FILENAME,
  beliefStoreExists,
  historyWatermark,
  readBeliefDocument,
} from "./store.js";
import {
  DISARMED_RULES,
  formatTs,
  nowTs,
  parseTs,
  RANK_LAW_FLOOR,
  VERDICT_RULES,
  type Belief,
  type BeliefOrigin,
  type BeliefRank,
  type ConsolidationEntry,
  type DecisionEntry,
  type JournalEntry,
  type Observation,
  type Verdict,
  type VerdictOutcome,
  type VerdictRule,
} from "./types.js";

/**
 * The mirror: the organ that shows and writes nothing.
 *
 * Three properties hold it together, and every one of them is a test rather
 * than an intention.
 *
 * Read only. It opens files, it never creates, appends, renames or removes one.
 * It consumes no verdict, it moves no belief, it runs no pass. A fingerprint of
 * the whole learning directory is identical before and after a full render.
 *
 * It shows only what exists. A section with no data says it is empty. It never
 * fabricates filler, never extrapolates, never draws a trend from two points.
 * Every line it prints traces back to a real identifier on disk.
 *
 * It is capped, per invariant I11. Every section has its own character cap,
 * returns its own budget, announces its truncation and says how to see the
 * rest. A mirror that costs more than it makes you understand is a failed
 * mirror.
 */

export const MIRROR_SCHEMA_VERSION = 1;

/** The reporting window of the weekly sections, in days. */
export const MIRROR_WINDOW_DAYS = 7;

export const MIRROR_SECTION_IDS = [
  "beliefs",
  "week",
  "uncertain",
  "blind",
  "autonomous",
  "unbuilt",
] as const;
export type MirrorSectionId = (typeof MIRROR_SECTION_IDS)[number];

/**
 * The cap of each section, in characters. Explicit here rather than implicit in
 * the rendering code, so a caller can read what a full mirror costs at worst
 * without running it: 14000 characters, about 3500 tokens.
 *
 * The section on what is absent gets a wide cap on purpose. It is the one
 * section whose whole job is honesty, and an honesty that gets truncated first
 * is the honesty nobody reads.
 */
export const DEFAULT_SECTION_CAPS: Readonly<Record<MirrorSectionId, number>> = {
  beliefs: 3_000,
  week: 1_500,
  uncertain: 1_500,
  blind: 2_500,
  autonomous: 2_000,
  unbuilt: 3_500,
};

/** No section is ever squeezed below this, or its notice would be all it says. */
export const MIRROR_SECTION_CAP_FLOOR = 200;

export interface MirrorReadLimits {
  /** Journal entries the mirror may hold at once. */
  journal: number;
  /** Monthly journal partitions it may open, newest first. */
  partitions: number;
  verdicts: number;
  observations: number;
  /** Lines of the graft failure trace it may hold at once. */
  errors: number;
}

export const DEFAULT_MIRROR_READ_LIMITS: Readonly<MirrorReadLimits> = {
  journal: 500,
  partitions: 2,
  verdicts: 800,
  observations: 800,
  errors: 200,
};

const STATEMENT_CLIP = 140;
const QUOTE_CLIP = 120;
const UNDETERMINED_SAMPLES = 3;

const AUTONOMOUS_CAUSES: readonly string[] = [
  "application_confirmed",
  "application_corrected",
  "dormancy",
];

const HUMAN_CAUSES: readonly string[] = ["human_engrave", "human_retract"];

/**
 * Said next to every circulation number, because a floor read as a total is a
 * wrong conclusion, and the wrong conclusion here is "nobody reads this file".
 */
export const CIRCULATION_FLOOR_NOTE =
  "Circulation is a floor, never a total: only reads seen in the decision journal and in consented transcripts are counted. A read from a shell, from another editor, or from a CLI that has no hooks leaves no trace this layer can see, so a document measured at zero may well have been read.";

/** Said in section 6, because a section honestly empty beats a fabricated one. */
export const NO_PROPOSAL_PRODUCER_NOTE =
  "Nothing produces proposals in this layer: the inferrer that would write them is not built. Nothing is invented here to fill the gap.";

export interface MirrorOrgan {
  name: string;
  built: boolean;
  role: string;
  /** What the absence costs, said plainly. Present only when it is absent. */
  consequence?: string;
}

/**
 * The organ map of the layer, absences included. An absent organ is named here
 * rather than left to be discovered at use: a loop that looks complete and is
 * not is worse than a loop that says where it stops.
 */
export const LEARNING_ORGANS: readonly MirrorOrgan[] = [
  {
    name: "store",
    built: true,
    role: "Holds the belief population and the mark that makes an application idempotent.",
  },
  {
    name: "journal",
    built: true,
    role: "Records every decision of the layer, partitioned by month, bounded on read.",
  },
  {
    name: "population",
    built: true,
    role: "Names the documents a sensor is allowed to measure.",
  },
  {
    name: "sensors",
    built: true,
    role: "Observe without concluding. They write readings, never a belief.",
  },
  {
    name: "evaluator",
    built: true,
    role: "Turns decisions into verdicts under a closed set of rules.",
  },
  {
    name: "confidence",
    built: true,
    role: "Consumes verdicts and dormancy, and renders the injected block under its own cap.",
  },
  {
    name: "consolidation",
    built: true,
    role: "The one subtractive act: folds the overflow of a bounded document into a verified archive.",
  },
  {
    name: "rollback",
    built: true,
    role: "Brings a confidence back to the value it held on a date by adding a move, never by erasing history.",
  },
  {
    name: "mirror",
    built: true,
    role: "Shows what the layer believes, what it decided alone, and what it cannot do.",
  },
  {
    name: "inferrer",
    built: false,
    role: "Would infer beliefs nobody stated, by reading what is said against what is done.",
    consequence:
      "No belief of origin `inferred` is ever created. The contract validates that origin and nothing produces it, so a belief only ever enters from a human statement.",
  },
  {
    name: "metabolism",
    built: false,
    role: "Would retire a belief, a document or an organ on its own.",
    consequence:
      "The only retirement that exists is the slow decay of dormancy, plus an explicit rollback. Nothing is ever quarantined automatically.",
  },
  {
    name: "voice",
    built: false,
    role: "Would build a writing profile out of how you actually phrase things.",
    consequence:
      "Nothing produces writing patches and nothing consumes them. This mirror has nothing to count and does not pretend otherwise.",
  },
  {
    name: "generalized consolidation",
    built: false,
    role: "Would decide on its own which bounded document to fold, instead of folding the one you name.",
    consequence:
      "The load sensor that would measure what a document costs is not built, so no document is ever picked automatically. Consolidation only ever runs on a document you name.",
  },
];

const DISARMED_RULE_REASONS: Readonly<Partial<Record<VerdictRule, string>>> = {
  rapid_followup:
    "It measures a rhythm that has to be calibrated on a corpus before it can conclude anything, so it stays observational.",
  wasted_load:
    "It would need a source this layer does not have, so it can only ever answer undetermined.",
  deliverable_shipped:
    "It would need a source this layer does not have, so it can only ever answer undetermined.",
};

export interface DisarmedRuleReport {
  rule: VerdictRule;
  reason: string;
}

export interface MirrorCapabilityState {
  name: CapabilityName;
  title: string;
  enabled: boolean;
  /** The exact command that arms it. Present only while it is disarmed. */
  arm_with?: string;
}

export interface OrganReport {
  capabilities: MirrorCapabilityState[];
  /** True when the OFF sentinel is set, or when learning itself is disarmed. */
  layer_inactive: boolean;
  belief_store_present: boolean;
  organs: MirrorOrgan[];
  organs_built: number;
  organs_absent: number;
  sensors_built: string[];
  /** Declared by the contract and produced by nothing. Never hidden. */
  sensors_declared_unbuilt: string[];
  rules_total: number;
  rules_armed: VerdictRule[];
  rules_disarmed: DisarmedRuleReport[];
}

export interface SourceDiagnostic {
  source: string;
  present: boolean;
  /** Items the mirror actually read. Absent when it could not read at all. */
  items?: number;
  /** Lines that failed their contract: counted and skipped, never guessed. */
  invalid?: number;
  /** Why the mirror could not read it. A missing file is not an error. */
  error?: string;
}

export interface MirrorNextRank {
  rank: BeliefRank;
  floor: number;
  distance: number;
  /** False when only a human hand can open that rank. */
  reachable: boolean;
  /** Where automatic growth stops. Present only when the gate is shut. */
  growth_cap?: number;
}

export interface MirrorBelief {
  id: string;
  statement: string;
  domain: string;
  origin: BeliefOrigin;
  rank: BeliefRank;
  confidence: number;
  locked: boolean;
  opportunities: number;
  applications: number;
  corrections: number;
  quote: string;
  next_rank?: MirrorNextRank;
  /** Present when history was folded: everything at or before it is summarized. */
  history_watermark?: string;
}

export interface MirrorShadowBelief {
  id: string;
  statement: string;
  confidence: number;
  locked: boolean;
  /** The last move on record, which is why it sits at shadow. */
  demoted_by?: MirrorMove;
}

export interface MirrorConsolidation {
  decision_id: string;
  document: string;
  size_before: number;
  size_after: number;
  archives: string[];
  deconsolidation_verified: boolean;
}

export interface MirrorMove {
  belief_id: string;
  cause: string;
  from: number | null;
  to: number;
  ref: string;
  ts: string;
  /** False when the mark was written and the confidence did not move. */
  effective: boolean;
}

export interface MirrorHumanMove extends MirrorMove {
  /** State of the belief lock as it now stands. Reported, never set here. */
  locked: boolean;
}

export interface UndeterminedZone {
  rule: VerdictRule;
  total: number;
  undetermined: number;
  share: number;
  /** Read from the verdict itself, never assumed from a table. */
  armed: boolean;
  sample_decision_ids: string[];
}

export interface DomainFailure {
  choice: string;
  good: number;
  bad: number;
  undetermined: number;
  determined: number;
  bad_share: number;
}

export interface GraftFailures {
  /** False means the trace file has never been created, which is not zero failures. */
  present: boolean;
  count: number;
  by_origin: Record<string, number>;
  latest?: { ts: string; origin: string; error: string };
  unreadable_lines: number;
}

export interface MirrorSectionBase {
  id: MirrorSectionId;
  title: string;
  /** The rendered body, already capped. Empty when the section has no data. */
  text: string;
  /** Honest messages: why it is empty, what a number does not include. */
  notes: string[];
  budget: ContextBudget;
  /** How to see what the cap dropped. Present only when it truncated. */
  next?: string;
}

export interface BeliefsSection extends MirrorSectionBase {
  id: "beliefs";
  beliefs: MirrorBelief[];
}

export interface WeekSection extends MirrorSectionBase {
  id: "week";
  decisions: number;
  decisions_by_type: Record<string, number>;
  consolidations: MirrorConsolidation[];
  circulation: {
    documents_measured: number;
    reads_measured: number;
    available: boolean;
  };
}

export interface UncertainSection extends MirrorSectionBase {
  id: "uncertain";
  beliefs: MirrorShadowBelief[];
}

export interface BlindSection extends MirrorSectionBase {
  id: "blind";
  undetermined_zones: UndeterminedZone[];
  failure_by_choice: DomainFailure[];
  declared_versus_observed: { decisions_with_declared_verdict: number; decisions: number };
  circulation_blind_spot: {
    available: boolean;
    population_total?: number;
    never_measured?: number;
  };
  graft_failures: GraftFailures;
}

export interface AutonomousSection extends MirrorSectionBase {
  id: "autonomous";
  moves: MirrorMove[];
  human_moves: MirrorHumanMove[];
  /** The exact signature of a verdict replaying: a mark written, nothing moved. */
  consumptions_without_move: { count: number; by_belief: Record<string, number> };
}

export interface UnbuiltSection extends MirrorSectionBase {
  id: "unbuilt";
  organs: OrganReport;
}

export type MirrorSection =
  | BeliefsSection
  | WeekSection
  | UncertainSection
  | BlindSection
  | AutonomousSection
  | UnbuiltSection;

export interface Mirror {
  schema_version: number;
  root: string;
  generated_at: string;
  window: { since: string; until: string; days: number };
  /** False means nothing at all was read, and the sections say why. */
  learning_enabled: boolean;
  organs: OrganReport;
  sections: MirrorSection[];
  diagnostics: SourceDiagnostic[];
  /** The cost of the whole mirror, summed over its sections. */
  budget: ContextBudget;
}

export interface MirrorOptions {
  now?: string;
  days?: number;
  /** Per section character caps. Anything omitted keeps its default. */
  caps?: Partial<Record<MirrorSectionId, number>>;
  limits?: Partial<MirrorReadLimits>;
}

// ---------------------------------------------------------------------------
// Capability and organ reporting. Available whether or not anything is armed.
// ---------------------------------------------------------------------------

const LEARNING_CAPABILITIES: readonly CapabilityName[] = [
  "learning",
  "learning.evaluate",
  "learning.consolidate",
];

function capabilityState(config: VaultConfig, name: CapabilityName): MirrorCapabilityState {
  const enabled = isEnabled(config, name);
  const description = describeCapability(name);
  return enabled
    ? { name, title: description.title, enabled }
    : {
      name,
      title: description.title,
      enabled,
      arm_with: `open-brain capabilities enable ${name}`,
    };
}

function disarmedRules(): DisarmedRuleReport[] {
  return DISARMED_RULES.map((rule) => ({
    rule,
    reason: DISARMED_RULE_REASONS[rule]
      ?? "The contract refuses this rule armed, so it is measured and never moves a confidence.",
  }));
}

/**
 * What is armed, what is built, what is not. Read only, and cheap enough to run
 * on a vault where every capability is disarmed: it touches the disk only to
 * check whether the belief store exists.
 */
export async function buildOrganReport(
  config: VaultConfig,
  root: string,
): Promise<OrganReport> {
  const learning = isEnabled(config, "learning");
  const storePresent = learning ? await beliefStoreExists(config, root) : false;
  const built = LEARNING_ORGANS.filter((organ) => organ.built);
  return {
    capabilities: LEARNING_CAPABILITIES.map((name) => capabilityState(config, name)),
    layer_inactive: await isLearningDisabled(config, root),
    belief_store_present: storePresent,
    organs: [...LEARNING_ORGANS],
    organs_built: built.length,
    organs_absent: LEARNING_ORGANS.length - built.length,
    sensors_built: listSensors().map((sensor) => sensor.name),
    sensors_declared_unbuilt: [...unbuiltSensors()],
    rules_total: VERDICT_RULES.length,
    rules_armed: [...ARMED_RULES],
    rules_disarmed: disarmedRules(),
  };
}

// ---------------------------------------------------------------------------
// Tolerant reading. A missing file is a legitimate empty state, a broken one is
// reported as broken, and neither ever raises out of this module.
// ---------------------------------------------------------------------------

interface ErrorLine {
  ts: string;
  origin: string;
  error: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorLine(value: unknown): ErrorLine | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ts = typeof value.ts === "string" ? value.ts : "";
  const origin = typeof value.origin === "string" && value.origin.length > 0
    ? value.origin
    : "(no origin)";
  const error = typeof value.error === "string" ? value.error : "";
  return { ts, origin, error };
}

/**
 * The graft failure trace, read without any contract at all. A trace of a
 * failure must not depend on a contract that could itself be the cause of the
 * failure, which is already the rule its writer follows.
 */
async function readGraftFailures(
  config: VaultConfig,
  root: string,
  limit: number,
): Promise<{ failures: GraftFailures; diagnostic: SourceDiagnostic }> {
  const path = journalErrorsPath(config, root);
  const present = await exists(path);
  const empty: GraftFailures = {
    present,
    count: 0,
    by_origin: {},
    unreadable_lines: 0,
  };
  if (!present) {
    return {
      failures: empty,
      diagnostic: { source: JOURNAL_ERRORS_FILENAME, present: false },
    };
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      failures: empty,
      diagnostic: {
        source: JOURNAL_ERRORS_FILENAME,
        present: true,
        error: messageOf(error),
      },
    };
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const kept: ErrorLine[] = [];
  let unreadable = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      unreadable += 1;
      continue;
    }
    const entry = readErrorLine(parsed);
    if (!entry) {
      unreadable += 1;
      continue;
    }
    kept.push(entry);
    if (kept.length > limit) {
      kept.shift();
    }
  }

  const byOrigin: Record<string, number> = {};
  let latest: ErrorLine | undefined;
  for (const entry of kept) {
    byOrigin[entry.origin] = (byOrigin[entry.origin] ?? 0) + 1;
    if (latest === undefined || entry.ts > latest.ts) {
      latest = entry;
    }
  }

  const failures: GraftFailures = {
    present: true,
    count: kept.length,
    by_origin: byOrigin,
    unreadable_lines: unreadable,
    ...(latest === undefined
      ? {}
      : { latest: { ts: latest.ts, origin: latest.origin, error: latest.error } }),
  };
  return {
    failures,
    diagnostic: {
      source: JOURNAL_ERRORS_FILENAME,
      present: true,
      items: kept.length,
      invalid: unreadable,
    },
  };
}

interface Sources {
  beliefs: Belief[];
  journal: JournalEntry[];
  verdicts: Verdict[];
  observations: Observation[];
  population?: string[];
  graftFailures: GraftFailures;
  diagnostics: SourceDiagnostic[];
}

async function readSources(
  config: VaultConfig,
  root: string,
  limits: MirrorReadLimits,
  since: string,
): Promise<Sources> {
  const diagnostics: SourceDiagnostic[] = [];

  let beliefs: Belief[] = [];
  const storePresent = await beliefStoreExists(config, root);
  if (!storePresent) {
    diagnostics.push({ source: BELIEFS_FILENAME, present: false });
  } else {
    try {
      const document = await readBeliefDocument(config, root);
      beliefs = document.beliefs;
      diagnostics.push({
        source: BELIEFS_FILENAME,
        present: true,
        items: beliefs.length,
      });
    } catch (error) {
      diagnostics.push({
        source: BELIEFS_FILENAME,
        present: true,
        error: messageOf(error),
      });
    }
  }

  let journal: JournalEntry[] = [];
  const partitions = await listJournalPartitions(config, root);
  if (partitions.length === 0) {
    diagnostics.push({ source: `${JOURNAL_DIRECTORY_NAME}/`, present: false });
  } else {
    try {
      const read = await readJournal(config, root, {
        limit: limits.journal,
        maxPartitions: limits.partitions,
        since,
      });
      journal = read.entries;
      diagnostics.push({
        source: `${JOURNAL_DIRECTORY_NAME}/`,
        present: true,
        items: journal.length,
        invalid: read.invalid,
      });
    } catch (error) {
      diagnostics.push({
        source: `${JOURNAL_DIRECTORY_NAME}/`,
        present: true,
        error: messageOf(error),
      });
    }
  }

  let verdicts: Verdict[] = [];
  const verdictsPresent = await exists(verdictsPath(config, root));
  if (!verdictsPresent) {
    diagnostics.push({ source: VERDICTS_FILENAME, present: false });
  } else {
    try {
      const read = await readVerdicts(config, root, { limit: limits.verdicts });
      verdicts = read.verdicts;
      diagnostics.push({
        source: VERDICTS_FILENAME,
        present: true,
        items: verdicts.length,
        invalid: read.invalid,
      });
    } catch (error) {
      diagnostics.push({
        source: VERDICTS_FILENAME,
        present: true,
        error: messageOf(error),
      });
    }
  }

  let observations: Observation[] = [];
  const observationsPresent = await exists(observationsPath(config, root));
  if (!observationsPresent) {
    diagnostics.push({ source: OBSERVATIONS_FILENAME, present: false });
  } else {
    try {
      const read = await readObservations(config, root, {
        limit: limits.observations,
        sensor: "circulation",
      });
      observations = read.observations;
      diagnostics.push({
        source: OBSERVATIONS_FILENAME,
        present: true,
        items: observations.length,
        invalid: read.invalid,
      });
    } catch (error) {
      diagnostics.push({
        source: OBSERVATIONS_FILENAME,
        present: true,
        error: messageOf(error),
      });
    }
  }

  let population: string[] | undefined;
  const populationPresent = await exists(populationPath(config, root));
  if (!populationPresent) {
    diagnostics.push({ source: POPULATION_FILENAME, present: false });
  } else {
    try {
      const read = await readPopulation(config, root);
      population = read?.documents;
      diagnostics.push({
        source: POPULATION_FILENAME,
        present: true,
        items: population?.length ?? 0,
      });
    } catch (error) {
      diagnostics.push({
        source: POPULATION_FILENAME,
        present: true,
        error: messageOf(error),
      });
    }
  }

  const graft = await readGraftFailures(config, root, limits.errors);
  diagnostics.push(graft.diagnostic);

  return {
    beliefs,
    journal,
    verdicts,
    observations,
    ...(population === undefined ? {} : { population }),
    graftFailures: graft.failures,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Section builders. Each one caps its own body and returns its own budget.
// ---------------------------------------------------------------------------

function inWindow(ts: string, since: string, until: string): boolean {
  return ts >= since && ts <= until;
}

function isDecision(entry: JournalEntry): entry is DecisionEntry {
  return entry.type !== "consolidated";
}

function isConsolidation(entry: JournalEntry): entry is ConsolidationEntry {
  return entry.type === "consolidated";
}

function number(value: number): string {
  return String(value);
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

interface SectionBody {
  text: string;
  budget: ContextBudget;
  next?: string;
}

/**
 * Caps a section body and reports what the cap dropped. `next` is attached only
 * when something was actually dropped: a pointer to "the rest" printed when
 * there is no rest is noise that trains a reader to stop reading pointers.
 */
function body(chunks: string[], cap: number, next: string): SectionBody {
  const capped = capItems(chunks, (chunk) => chunk, cap);
  return {
    text: capped.text,
    budget: capped.budget,
    ...(capped.budget.truncated ? { next } : {}),
  };
}

function nextRankOf(belief: Belief, now: string): MirrorNextRank | undefined {
  if (belief.rank !== "active") {
    return undefined;
  }
  const cap = confidenceCap(belief, now);
  const reachable = cap >= RANK_LAW_FLOOR;
  return {
    rank: "law",
    floor: RANK_LAW_FLOOR,
    distance: Math.round((RANK_LAW_FLOOR - belief.confidence) * 100) / 100,
    reachable,
    ...(reachable ? {} : { growth_cap: cap }),
  };
}

function mirrorBelief(belief: Belief, now: string): MirrorBelief {
  const next = nextRankOf(belief, now);
  const watermark = historyWatermark(belief);
  return {
    id: belief.id,
    statement: clipStatement(belief.statement, STATEMENT_CLIP),
    domain: belief.domain,
    origin: belief.origin,
    rank: belief.rank,
    confidence: belief.confidence,
    locked: belief.locked,
    opportunities: belief.opportunities,
    applications: belief.applications,
    corrections: belief.corrections,
    quote: clipStatement(belief.evidence.quote, QUOTE_CLIP),
    ...(next === undefined ? {} : { next_rank: next }),
    ...(watermark === undefined ? {} : { history_watermark: watermark }),
  };
}

function renderBelief(belief: MirrorBelief): string {
  const lines = [
    `  - ${belief.id} (${belief.rank}, c=${number(belief.confidence)}): ${belief.statement}`,
    `      domain ${belief.domain} | origin ${belief.origin} | ${belief.locked ? "locked by a human hand" : "unlocked"}`,
    `      opportunities ${number(belief.opportunities)}, applications ${number(belief.applications)}, corrections ${number(belief.corrections)}`,
  ];
  const next = belief.next_rank;
  if (next) {
    lines.push(
      next.reachable
        ? `      ${number(next.distance)} from rank ${next.rank} (floor ${number(next.floor)}), and that door is open.`
        : `      ${number(next.distance)} from rank ${next.rank} (floor ${number(next.floor)}), door shut: automatic growth stops at ${number(next.growth_cap ?? 0)}, only your engraving opens ${next.rank}.`,
    );
  }
  if (belief.history_watermark !== undefined) {
    lines.push(
      `      history folded up to ${belief.history_watermark}: everything at or before it is summarized, not lost.`,
    );
  }
  lines.push(`      evidence quoted: "${belief.quote}"`);
  return lines.join("\n");
}

function buildBeliefsSection(
  beliefs: Belief[],
  storeError: string | undefined,
  storePresent: boolean,
  now: string,
  cap: number,
): BeliefsSection {
  const held = beliefs
    .filter((belief) => belief.rank === "active" || belief.rank === "law")
    .sort((left, right) =>
      left.confidence === right.confidence
        ? left.id.localeCompare(right.id)
        : right.confidence - left.confidence)
    .map((belief) => mirrorBelief(belief, now));

  const notes: string[] = [];
  if (storeError !== undefined) {
    notes.push(
      `The belief store exists and could not be read, so nothing is shown rather than something guessed: ${storeError}`,
    );
  } else if (!storePresent) {
    notes.push("No belief store in this vault yet: nothing has ever been learned here.");
  } else if (held.length === 0) {
    notes.push("No belief holds rank active or law right now.");
  }

  return {
    id: "beliefs",
    title: "1. What I believe I know about you",
    beliefs: held,
    notes,
    ...body(
      held.map((belief) => renderBelief(belief)),
      cap,
      "Raise --max-chars, or read one belief in full with `open-brain learn beliefs --id <id>`.",
    ),
  };
}

function buildWeekSection(
  journal: JournalEntry[],
  observations: Observation[],
  observationsAvailable: boolean,
  since: string,
  until: string,
  consolidateArmed: boolean,
  cap: number,
): WeekSection {
  const inside = journal.filter((entry) => inWindow(entry.ts, since, until));
  const decisions = inside.filter(isDecision);
  const byType: Record<string, number> = {};
  for (const decision of decisions) {
    byType[decision.type] = (byType[decision.type] ?? 0) + 1;
  }

  const consolidations: MirrorConsolidation[] = inside
    .filter(isConsolidation)
    .map((entry) => ({
      decision_id: entry.id,
      document: entry.document,
      size_before: entry.before.size,
      size_after: entry.after.size,
      archives: entry.blocks.map((block) => block.archive),
      deconsolidation_verified: entry.deconsolidation_verified,
    }));

  const documents = new Set<string>();
  let reads = 0;
  for (const observation of observations) {
    if (!inWindow(observation.ts, since, until)) {
      continue;
    }
    documents.add(observation.population ?? observation.subject);
    reads += observation.measure.reads ?? 0;
  }

  const chunks: string[] = [
    `  - decisions journaled: ${number(decisions.length)}${
      decisions.length === 0
        ? ""
        : ` (${Object.entries(byType).sort().map(([type, count]) => `${type} ${number(count)}`).join(", ")})`
    }`,
  ];
  chunks.push(
    consolidations.length === 0
      ? "  - documents consolidated: none."
      : `  - documents consolidated: ${number(consolidations.length)}`,
  );
  for (const item of consolidations) {
    chunks.push(
      `      * ${item.document} (${item.decision_id}): ${number(item.size_before)} to ${number(item.size_after)} bytes, archives ${item.archives.join(", ")}, way back verified: ${item.deconsolidation_verified ? "yes" : "no"}`,
    );
  }
  chunks.push(
    observationsAvailable
      ? `  - circulation measured: ${number(documents.size)} document(s), ${number(reads)} read(s).`
      : "  - circulation measured: nothing, no observation has ever been written.",
  );

  const notes: string[] = [CIRCULATION_FLOOR_NOTE];
  if (!consolidateArmed) {
    notes.push(
      "Consolidation is disarmed, so this layer folded nothing on its own. `open-brain capabilities enable learning.consolidate` would arm it.",
    );
  }

  return {
    id: "week",
    title: "2. What I filed this week",
    decisions: decisions.length,
    decisions_by_type: byType,
    consolidations,
    circulation: {
      documents_measured: documents.size,
      reads_measured: reads,
      available: observationsAvailable,
    },
    notes,
    ...body(
      chunks,
      cap,
      "Raise --max-chars, or read the window entry by entry with `open-brain learn journal --limit <n>`.",
    ),
  };
}

function lastMove(belief: Belief): MirrorMove | undefined {
  const entry = belief.history[belief.history.length - 1];
  if (!entry) {
    return undefined;
  }
  return {
    belief_id: belief.id,
    cause: entry.cause,
    from: entry.from,
    to: entry.to,
    ref: entry.ref,
    ts: entry.ts,
    effective: entry.from !== entry.to,
  };
}

function buildUncertainSection(
  beliefs: Belief[],
  storeError: string | undefined,
  cap: number,
): UncertainSection {
  const shadows: MirrorShadowBelief[] = beliefs
    .filter((belief) => belief.rank === "shadow")
    .sort((left, right) =>
      left.confidence === right.confidence
        ? left.id.localeCompare(right.id)
        : left.confidence - right.confidence)
    .map((belief) => {
      const demoted = lastMove(belief);
      return {
        id: belief.id,
        statement: clipStatement(belief.statement, STATEMENT_CLIP),
        confidence: belief.confidence,
        locked: belief.locked,
        ...(demoted === undefined ? {} : { demoted_by: demoted }),
      };
    });

  const notes: string[] = [];
  if (storeError !== undefined) {
    notes.push("The belief store could not be read, so this section shows nothing.");
  } else if (shadows.length === 0) {
    notes.push("No belief sits at rank shadow right now.");
  }

  const chunks = shadows.map((belief) => {
    const head = `  - ${belief.id} (c=${number(belief.confidence)}): ${belief.statement}`;
    const move = belief.demoted_by;
    const why = move
      ? `      demoted by ${move.cause} on ${move.ts}, ref ${move.ref} (${move.from === null ? "birth" : number(move.from)} to ${number(move.to)})`
      : "      no move on record explains this rank.";
    return `${head}\n${why}`;
  });

  return {
    id: "uncertain",
    title: "3. What I am no longer sure about",
    beliefs: shadows,
    notes,
    ...body(
      chunks,
      cap,
      "Raise --max-chars, or read one belief and its full history with `open-brain learn beliefs --id <id>`.",
    ),
  };
}

function buildBlindSection(
  verdicts: Verdict[],
  journal: JournalEntry[],
  observations: Observation[],
  population: string[] | undefined,
  graftFailures: GraftFailures,
  cap: number,
): BlindSection {
  const tallies = new Map<
    VerdictRule,
    { total: number; armed: boolean; samples: string[] } & Record<VerdictOutcome, number>
  >();
  for (const verdict of verdicts) {
    const entry = tallies.get(verdict.rule) ?? {
      total: 0,
      armed: verdict.armed,
      samples: [],
      good: 0,
      bad: 0,
      undetermined: 0,
    };
    entry.total += 1;
    entry[verdict.verdict] += 1;
    // D-4: armed is read from the verdict itself, never assumed from a table.
    entry.armed = verdict.armed;
    if (verdict.verdict === "undetermined" && entry.samples.length < UNDETERMINED_SAMPLES) {
      entry.samples.push(verdict.decision_id);
    }
    tallies.set(verdict.rule, entry);
  }

  const zones: UndeterminedZone[] = [];
  for (const [rule, entry] of tallies) {
    if (entry.undetermined === 0) {
      continue;
    }
    zones.push({
      rule,
      total: entry.total,
      undetermined: entry.undetermined,
      share: entry.undetermined / entry.total,
      armed: entry.armed,
      sample_decision_ids: entry.samples,
    });
  }
  zones.sort((left, right) =>
    left.undetermined === right.undetermined
      ? left.rule.localeCompare(right.rule)
      : right.undetermined - left.undetermined);

  const decisions = journal.filter(isDecision);
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const perChoice = new Map<string, Record<VerdictOutcome, number>>();
  for (const verdict of verdicts) {
    if (verdict.rule !== "sterile_route") {
      continue;
    }
    const decision = byId.get(verdict.decision_id);
    if (!decision) {
      continue;
    }
    const choice = decision.choice ?? "(no choice)";
    const counts = perChoice.get(choice) ?? { good: 0, bad: 0, undetermined: 0 };
    counts[verdict.verdict] += 1;
    perChoice.set(choice, counts);
  }
  const failures: DomainFailure[] = [];
  for (const [choice, counts] of perChoice) {
    const determined = counts.good + counts.bad;
    if (determined === 0) {
      continue;
    }
    failures.push({
      choice,
      good: counts.good,
      bad: counts.bad,
      undetermined: counts.undetermined,
      determined,
      bad_share: counts.bad / determined,
    });
  }
  failures.sort((left, right) =>
    left.bad_share === right.bad_share
      ? left.choice.localeCompare(right.choice)
      : right.bad_share - left.bad_share);

  const declared = decisions.filter((decision) => decision.verdict !== null).length;

  const measured = new Set<string>();
  for (const observation of observations) {
    if (observation.population !== undefined) {
      measured.add(observation.population);
    }
  }
  const blindSpot = population === undefined
    ? { available: false }
    : {
      available: true,
      population_total: population.length,
      never_measured: population.filter((document) => !measured.has(document)).length,
    };

  const chunks: string[] = [];
  chunks.push("  Rules that cannot conclude, read from the verdicts themselves:");
  if (zones.length === 0) {
    chunks.push("    nothing: no verdict on record answers undetermined.");
  }
  for (const zone of zones) {
    chunks.push(
      `    - ${zone.rule} (${zone.armed ? "armed" : "disarmed, measured with no effect on any confidence"}): ${number(zone.undetermined)}/${number(zone.total)} undetermined (${percent(zone.share)}); samples: ${zone.sample_decision_ids.join(", ") || "(none)"}`,
    );
  }
  chunks.push("  Failure rate by routed choice, rule sterile_route, undetermined excluded:");
  if (failures.length === 0) {
    chunks.push("    nothing comparable: no sterile_route verdict joins a decision on record.");
  }
  for (const failure of failures) {
    chunks.push(
      `    - ${failure.choice}: ${number(failure.bad)} bad of ${number(failure.determined)} determined (${percent(failure.bad_share)}), ${number(failure.undetermined)} undetermined beside them`,
    );
  }
  chunks.push("  What was declared against what was observed:");
  chunks.push(
    declared === 0
      ? `    no decision carries a declared verdict: the field exists in the contract and nothing fills it, so there is nothing to confront (${number(decisions.length)} decision(s) read).`
      : `    ${number(declared)}/${number(decisions.length)} decision(s) carry a declared verdict, comparable with the observed ones.`,
  );
  chunks.push("  Blind spot of circulation:");
  chunks.push(
    blindSpot.available
      ? `    ${number(blindSpot.never_measured ?? 0)}/${number(blindSpot.population_total ?? 0)} document(s) of the population have never been measured as read.`
      : "    nothing: no population file, so there is no scope to compare against.",
  );
  chunks.push("  Graft failures:");
  if (!graftFailures.present) {
    chunks.push(
      "    the trace file has never been created, so no graft has ever failed. That is not the same statement as zero failure recorded.",
    );
  } else if (graftFailures.count === 0) {
    chunks.push("    the trace file exists and holds no failure.");
  } else {
    chunks.push(`    ${number(graftFailures.count)} failure(s) recorded:`);
    for (const [origin, count] of Object.entries(graftFailures.by_origin).sort()) {
      chunks.push(`    - ${origin}: ${number(count)}`);
    }
    const latest = graftFailures.latest;
    if (latest) {
      chunks.push(`    latest: ${latest.origin} on ${latest.ts} (${latest.error})`);
    }
  }
  if (graftFailures.unreadable_lines > 0) {
    chunks.push(
      `    ${number(graftFailures.unreadable_lines)} unreadable line(s) in the failure trace: even a failure file can break, so it is counted and not swallowed.`,
    );
  }

  const notes = [CIRCULATION_FLOOR_NOTE];

  return {
    id: "blind",
    title: "4. What I do not understand",
    undetermined_zones: zones,
    failure_by_choice: failures,
    declared_versus_observed: {
      decisions_with_declared_verdict: declared,
      decisions: decisions.length,
    },
    circulation_blind_spot: blindSpot,
    graft_failures: graftFailures,
    notes,
    ...body(
      chunks,
      cap,
      "Raise --max-chars, or read the verdicts one by one with `open-brain learn evaluate --show`.",
    ),
  };
}

function buildAutonomousSection(
  beliefs: Belief[],
  since: string,
  until: string,
  evaluateArmed: boolean,
  cap: number,
): AutonomousSection {
  const moves: MirrorMove[] = [];
  const humanMoves: MirrorHumanMove[] = [];
  const byBelief: Record<string, number> = {};
  let withoutMove = 0;

  for (const belief of beliefs) {
    for (const entry of belief.history) {
      if (!inWindow(entry.ts, since, until)) {
        continue;
      }
      const move: MirrorMove = {
        belief_id: belief.id,
        cause: entry.cause,
        from: entry.from,
        to: entry.to,
        ref: entry.ref,
        ts: entry.ts,
        effective: entry.from !== entry.to,
      };
      if (AUTONOMOUS_CAUSES.includes(entry.cause)) {
        moves.push(move);
        if (!move.effective) {
          withoutMove += 1;
          byBelief[belief.id] = (byBelief[belief.id] ?? 0) + 1;
        }
        continue;
      }
      if (HUMAN_CAUSES.includes(entry.cause)) {
        humanMoves.push({ ...move, locked: belief.locked });
      }
    }
  }
  moves.sort((left, right) =>
    left.ts === right.ts ? left.belief_id.localeCompare(right.belief_id) : left.ts.localeCompare(right.ts));
  humanMoves.sort((left, right) =>
    left.ts === right.ts ? left.belief_id.localeCompare(right.belief_id) : left.ts.localeCompare(right.ts));

  const chunks: string[] = [];
  if (moves.length === 0) {
    chunks.push("  - no confidence moved on its own during this window.");
  }
  for (const move of moves) {
    chunks.push(
      `  - ${move.belief_id}: ${move.cause}, ${move.from === null ? "birth" : number(move.from)} to ${number(move.to)}, ref ${move.ref} (${move.ts})${move.effective ? "" : "  [mark written, confidence unchanged]"}`,
    );
  }
  chunks.push(
    `  - marks written without a move: ${number(withoutMove)}${
      Object.keys(byBelief).length === 0
        ? ""
        : ` (${Object.entries(byBelief).sort().map(([id, count]) => `${id}: ${number(count)}`).join(", ")})`
    }`,
  );
  if (humanMoves.length > 0) {
    chunks.push("  Moves a human made, not this layer:");
    for (const move of humanMoves) {
      chunks.push(
        `    - ${move.belief_id}: ${move.cause}, ${move.from === null ? "birth" : number(move.from)} to ${number(move.to)} (${move.ts}), lock now ${move.locked ? "held" : "open"}`,
      );
    }
  }

  const notes = [
    "A count of marks that climbs while no confidence moves is the exact signature of a verdict replaying. It stays visible on purpose.",
  ];
  if (!evaluateArmed) {
    notes.push(
      "Evaluation is disarmed, so no verdict is consumed and nothing here can move on its own. `open-brain capabilities enable learning.evaluate` would arm it.",
    );
  }

  return {
    id: "autonomous",
    title: "5. What I decided on my own this week",
    moves,
    human_moves: humanMoves,
    consumptions_without_move: { count: withoutMove, by_belief: byBelief },
    notes,
    ...body(
      chunks,
      cap,
      "Raise --max-chars, or read one belief and its full history with `open-brain learn beliefs --id <id>`.",
    ),
  };
}

function buildUnbuiltSection(organs: OrganReport, cap: number): UnbuiltSection {
  const chunks: string[] = [];
  chunks.push("  Organs that are not built:");
  const absent = organs.organs.filter((organ) => !organ.built);
  if (absent.length === 0) {
    chunks.push("    none: every organ this layer declares is built.");
  }
  for (const organ of absent) {
    chunks.push(`    - ${organ.name}: ${organ.role}`);
    if (organ.consequence !== undefined) {
      chunks.push(`      consequence: ${organ.consequence}`);
    }
  }
  chunks.push("  Sensors:");
  chunks.push(
    `    built: ${organs.sensors_built.join(", ") || "(none)"}`,
  );
  chunks.push(
    organs.sensors_declared_unbuilt.length === 0
      ? "    declared and unbuilt: none. This layer declares only the sensors it produces."
      : `    declared and unbuilt: ${organs.sensors_declared_unbuilt.join(", ")}`,
  );
  chunks.push("  Rules that never move a confidence:");
  if (organs.rules_disarmed.length === 0) {
    chunks.push("    none.");
  }
  for (const rule of organs.rules_disarmed) {
    chunks.push(`    - ${rule.rule}: ${rule.reason}`);
  }
  chunks.push("  Capabilities:");
  for (const capability of organs.capabilities) {
    chunks.push(
      capability.enabled
        ? `    - ${capability.name}: armed.`
        : `    - ${capability.name}: disarmed. Arm it with \`${capability.arm_with ?? ""}\`.`,
    );
  }

  return {
    id: "unbuilt",
    title: "6. What I cannot do yet",
    organs,
    notes: [NO_PROPOSAL_PRODUCER_NOTE],
    ...body(
      chunks,
      cap,
      "Raise --max-chars, or read the same map with `open-brain learn status`.",
    ),
  };
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

function resolveCaps(
  caps: Partial<Record<MirrorSectionId, number>> | undefined,
): Record<MirrorSectionId, number> {
  const resolved = { ...DEFAULT_SECTION_CAPS };
  for (const id of MIRROR_SECTION_IDS) {
    const wanted = caps?.[id];
    if (wanted !== undefined) {
      resolved[id] = Math.max(MIRROR_SECTION_CAP_FLOOR, wanted);
    }
  }
  return resolved;
}

/**
 * Spreads a total character budget over the sections, keeping their relative
 * weights. It exists so a caller has one number to turn, instead of six.
 */
export function capsForTotal(total: number): Record<MirrorSectionId, number> {
  const defaultTotal = MIRROR_SECTION_IDS.reduce(
    (sum, id) => sum + DEFAULT_SECTION_CAPS[id],
    0,
  );
  const ratio = total / defaultTotal;
  const caps = { ...DEFAULT_SECTION_CAPS };
  for (const id of MIRROR_SECTION_IDS) {
    caps[id] = Math.max(
      MIRROR_SECTION_CAP_FLOOR,
      Math.floor(DEFAULT_SECTION_CAPS[id] * ratio),
    );
  }
  return caps;
}

function totalBudget(sections: readonly MirrorSection[]): ContextBudget {
  const budget = emptyBudget();
  for (const item of sections) {
    budget.chars += item.budget.chars;
    budget.token_estimate += item.budget.token_estimate;
    budget.items_shown += item.budget.items_shown;
    budget.items_total += item.budget.items_total;
    budget.truncated = budget.truncated || item.budget.truncated;
  }
  return budget;
}

function disarmedMirror(
  root: string,
  now: string,
  since: string,
  days: number,
  organs: OrganReport,
  caps: Record<MirrorSectionId, number>,
): Mirror {
  const note =
    "The learning capability is disarmed, so this mirror read nothing at all: not one byte of the vault was opened. Read what arming it would do with `open-brain capabilities explain learning`, then arm it with `open-brain capabilities enable learning`.";
  const empty: MirrorSection[] = [
    buildBeliefsSection([], undefined, false, now, caps.beliefs),
    buildWeekSection([], [], false, since, now, false, caps.week),
    buildUncertainSection([], undefined, caps.uncertain),
    buildBlindSection(
      [],
      [],
      [],
      undefined,
      { present: false, count: 0, by_origin: {}, unreadable_lines: 0 },
      caps.blind,
    ),
    buildAutonomousSection([], since, now, false, caps.autonomous),
    buildUnbuiltSection(organs, caps.unbuilt),
  ];
  for (const item of empty) {
    item.notes = [note, ...item.notes];
  }
  return {
    schema_version: MIRROR_SCHEMA_VERSION,
    root,
    generated_at: now,
    window: { since, until: now, days },
    learning_enabled: false,
    organs,
    sections: empty,
    diagnostics: [],
    budget: totalBudget(empty),
  };
}

/**
 * Builds the whole mirror. It opens files and it writes none, which is the
 * property its test proves by fingerprinting the learning directory before and
 * after a full render.
 */
export async function buildMirror(
  config: VaultConfig,
  root: string,
  options: MirrorOptions = {},
): Promise<Mirror> {
  const now = options.now ?? nowTs();
  const days = options.days ?? MIRROR_WINDOW_DAYS;
  const since = formatTs(new Date(parseTs(now).getTime() - days * 24 * 60 * 60 * 1_000));
  const caps = resolveCaps(options.caps);
  const limits: MirrorReadLimits = { ...DEFAULT_MIRROR_READ_LIMITS, ...options.limits };
  const organs = await buildOrganReport(config, root);

  if (!isEnabled(config, "learning")) {
    return disarmedMirror(root, now, since, days, organs, caps);
  }

  const sources = await readSources(config, root, limits, since);
  const storeDiagnostic = sources.diagnostics.find(
    (item) => item.source === BELIEFS_FILENAME,
  );
  const observationsAvailable = sources.diagnostics.some(
    (item) => item.source === OBSERVATIONS_FILENAME && item.present && item.error === undefined,
  );

  const sections: MirrorSection[] = [
    buildBeliefsSection(
      sources.beliefs,
      storeDiagnostic?.error,
      storeDiagnostic?.present ?? false,
      now,
      caps.beliefs,
    ),
    buildWeekSection(
      sources.journal,
      sources.observations,
      observationsAvailable,
      since,
      now,
      isEnabled(config, "learning.consolidate"),
      caps.week,
    ),
    buildUncertainSection(sources.beliefs, storeDiagnostic?.error, caps.uncertain),
    buildBlindSection(
      sources.verdicts,
      sources.journal,
      sources.observations,
      sources.population,
      sources.graftFailures,
      caps.blind,
    ),
    buildAutonomousSection(
      sources.beliefs,
      since,
      now,
      isEnabled(config, "learning.evaluate"),
      caps.autonomous,
    ),
    buildUnbuiltSection(organs, caps.unbuilt),
  ];

  return {
    schema_version: MIRROR_SCHEMA_VERSION,
    root,
    generated_at: now,
    window: { since, until: now, days },
    learning_enabled: true,
    organs,
    sections,
    diagnostics: sources.diagnostics,
    budget: totalBudget(sections),
  };
}

// ---------------------------------------------------------------------------
// The human rendering. This is the one people are shown, so it is the one that
// has to read like a report and not like a dump.
// ---------------------------------------------------------------------------

function renderDiagnostic(diagnostic: SourceDiagnostic): string {
  if (!diagnostic.present) {
    return `  - ${diagnostic.source}: absent.`;
  }
  if (diagnostic.error !== undefined) {
    return `  - ${diagnostic.source}: present and unreadable (${diagnostic.error}).`;
  }
  const invalid = diagnostic.invalid ?? 0;
  const skipped = invalid === 0 ? "" : `, ${number(invalid)} line(s) skipped as invalid`;
  return `  - ${diagnostic.source}: present, ${number(diagnostic.items ?? 0)} item(s) read${skipped}.`;
}

/** Renders the mirror for a terminal. Deterministic, and free of any colour. */
export function formatMirror(mirror: Mirror): string {
  const lines: string[] = [
    "Open Brain, the learning mirror",
    `root: ${mirror.root}`,
    `generated: ${mirror.generated_at}`,
    `window: last ${number(mirror.window.days)} day(s), ${mirror.window.since} to ${mirror.window.until}`,
  ];

  const armed = mirror.organs.capabilities
    .filter((capability) => capability.enabled)
    .map((capability) => capability.name);
  lines.push(`capabilities armed: ${armed.join(", ") || "none"}`);
  lines.push(
    mirror.organs.layer_inactive
      ? "state: the layer is not acting. It observes and reports, it moves nothing."
      : "state: the layer is acting.",
  );
  lines.push(
    `organs: ${number(mirror.organs.organs_built)} built, ${number(mirror.organs.organs_absent)} absent. See section 6.`,
  );

  for (const item of mirror.sections) {
    lines.push("");
    lines.push(item.title);
    if (item.text.length > 0) {
      lines.push(item.text);
    }
    for (const note of item.notes) {
      lines.push(`  note: ${note}`);
    }
    if (item.next !== undefined) {
      lines.push(`  next: ${item.next}`);
    }
  }

  lines.push("");
  lines.push("Sources read");
  if (mirror.diagnostics.length === 0) {
    lines.push("  - nothing was read.");
  }
  for (const diagnostic of mirror.diagnostics) {
    lines.push(renderDiagnostic(diagnostic));
  }

  lines.push("");
  lines.push("What this mirror cost you");
  lines.push(
    `  ${number(mirror.budget.chars)} character(s), about ${number(mirror.budget.token_estimate)} token(s), ${number(mirror.budget.items_shown)} of ${number(mirror.budget.items_total)} item(s) shown${mirror.budget.truncated ? ", truncated" : ""}.`,
  );

  return lines.join("\n");
}

/** Builds then renders. The single entry point a caller usually wants. */
export async function renderMirror(
  config: VaultConfig,
  root: string,
  options: MirrorOptions = {},
): Promise<{ text: string; mirror: Mirror; budget: ContextBudget }> {
  const mirror = await buildMirror(config, root, options);
  const text = formatMirror(mirror);
  return {
    text,
    mirror,
    budget: {
      chars: text.length,
      token_estimate: estimateTokens(text),
      items_shown: mirror.budget.items_shown,
      items_total: mirror.budget.items_total,
      truncated: mirror.budget.truncated,
    },
  };
}
