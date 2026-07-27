import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineCommand } from "citty";

import {
  capItems,
  emptyBudget,
  estimateTokens,
  type ContextBudget,
} from "../../core/budget.js";
import { isEnabled, requireCapability } from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import type { VaultConfig } from "../../core/types.js";
import { consumeDormancy, consumeVerdicts } from "../../learning/confidence.js";
import {
  consolidate,
  deconsolidate,
  pendingTransaction,
  readLoadContract,
  splitDocument,
  verifyReversibility,
  type ReferenceMode,
} from "../../learning/consolidation.js";
import { readVerdicts, runEvaluatorPass } from "../../learning/evaluator.js";
import { readJournal, type JournalReadOptions } from "../../learning/journal.js";
import {
  buildMirror,
  buildOrganReport,
  capsForTotal,
  formatMirror,
  MIRROR_WINDOW_DAYS,
} from "../../learning/mirror.js";
import { planRevert, revert } from "../../learning/rollback.js";
import {
  listSensors,
  readObservations,
  runSensorPass,
  unbuiltSensors,
} from "../../learning/sensors/index.js";
import { readBeliefDocument } from "../../learning/store.js";
import {
  BELIEF_RANKS,
  DECISION_TYPES,
  isTs,
  type Belief,
  type BeliefRank,
} from "../../learning/types.js";
import {
  booleanArgument,
  isRecord,
  loadConfigForCli,
  optionalNonNegativeInteger,
  optionalString,
  printJson,
  printNotice,
  requiredString,
  rootArgument,
} from "../shared.js";
import { resolveVaultRoot } from "../vault.js";

/**
 * The learning surface.
 *
 * Three rules shape every subcommand here.
 *
 * Every read is capped and says what it cost, per invariant I11. A read with no
 * limit is not a read, it is a leak.
 *
 * Nothing writes unless the user asked for it in that exact invocation. The two
 * commands that can take something away, consolidation and the way back, show
 * their state first and act only on a confirmation typed on purpose. No global
 * --yes reaches them: a flag that approves everything is a flag that will one
 * day approve the one thing nobody read.
 *
 * An unknown flag is refused rather than ignored. A typo that silently changes
 * nothing is how a user ends up believing a cap was raised when it was not.
 */

const DEFAULT_LIST_CHARS = 4_000;
const MIN_LIST_CHARS = 500;
const DEFAULT_JOURNAL_LIMIT = 20;
const DEFAULT_VERDICT_LIMIT = 50;
const DEFAULT_OBSERVATION_LIMIT = 50;
const DEFAULT_BELIEF_LIMIT = 50;
const HISTORY_TAIL = 10;

// ---------------------------------------------------------------------------
// Argument plumbing.
// ---------------------------------------------------------------------------

function toCamel(name: string): string {
  return name.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Refuses anything the command did not declare. citty parses unknown flags into
 * the argument record instead of failing, so without this a mistyped cap is
 * accepted in silence and the user reads a truncated answer believing it whole.
 */
function guardArguments(
  args: unknown,
  definition: Readonly<Record<string, unknown>>,
  command: string,
): void {
  if (!isRecord(args)) {
    return;
  }
  const allowed = new Set<string>(["_"]);
  for (const name of Object.keys(definition)) {
    allowed.add(name);
    allowed.add(toCamel(name));
  }
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const known = Object.keys(definition).map((name) => `--${name}`).join(", ");
    throw new ExpectedError(
      `Unknown flag ${unknown.map((key) => `--${key}`).join(", ")} for \`${command}\`. It accepts ${known}. Nothing was read and nothing was written.`,
    );
  }
  const positionals = args._;
  if (Array.isArray(positionals) && positionals.length > 0) {
    throw new ExpectedError(
      `\`${command}\` takes no positional argument, and got ${String(positionals[0])}. Nothing was read and nothing was written.`,
    );
  }
}

function maxChars(args: unknown, fallback: number): number {
  const value = optionalNonNegativeInteger(args, "max-chars");
  if (value === undefined) {
    return fallback;
  }
  if (value < MIN_LIST_CHARS) {
    throw new ExpectedError(`--max-chars must be at least ${String(MIN_LIST_CHARS)} characters.`);
  }
  return value;
}

function positiveLimit(args: unknown, fallback: number): number {
  const value = optionalNonNegativeInteger(args, "limit");
  if (value === undefined) {
    return fallback;
  }
  if (value < 1) {
    throw new ExpectedError("--limit must be at least one item.");
  }
  return value;
}

function timestampArgument(args: unknown, name: string): string {
  const value = requiredString(args, name);
  if (!isTs(value)) {
    throw new ExpectedError(
      `--${name} must be a timestamp of the form YYYY-MM-DDTHH:MM:SSZ, and got "${value}".`,
    );
  }
  return value;
}

function commaList(args: unknown, name: string): string[] {
  const value = optionalString(args, name);
  if (value === undefined) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function budgetOfJson(value: unknown, itemsShown: number, itemsTotal: number): ContextBudget {
  const text = JSON.stringify(value);
  return {
    chars: text.length,
    token_estimate: estimateTokens(text),
    items_shown: itemsShown,
    items_total: itemsTotal,
    truncated: itemsShown < itemsTotal,
  };
}

function mergeBudgets(capped: ContextBudget, source: ContextBudget): ContextBudget {
  const total = Math.max(capped.items_total, source.items_total);
  return {
    chars: capped.chars,
    token_estimate: capped.token_estimate,
    items_shown: capped.items_shown,
    items_total: total,
    truncated: capped.truncated || source.truncated || capped.items_shown < total,
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const statusArgs = { ...rootArgument };

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "What is armed, what is built, what is absent, and whether the layer is acting.",
  },
  args: statusArgs,
  async run({ args }) {
    guardArguments(args, statusArgs, "open-brain learn status");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const organs = await buildOrganReport(config, root);
    printJson({
      ...organs,
      budget: budgetOfJson(organs, organs.organs.length, organs.organs.length),
    });
    if (!isEnabled(config, "learning")) {
      printNotice(
        "The learning layer is disarmed, so nothing was read from it. `open-brain capabilities explain learning` says what arming it would do.",
      );
    }
  },
});

// ---------------------------------------------------------------------------
// mirror
// ---------------------------------------------------------------------------

const mirrorArgs = {
  ...rootArgument,
  json: {
    type: "boolean",
    description: "Print the structured mirror instead of the human one.",
    default: false,
  },
  "max-chars": {
    type: "string",
    description: "Total character cap, spread over the six sections. Defaults to 12000.",
    required: false,
  },
  days: {
    type: "string",
    description: `Length of the reporting window in days. Defaults to ${String(MIRROR_WINDOW_DAYS)}.`,
    required: false,
  },
} as const;

const mirrorCommand = defineCommand({
  meta: {
    name: "mirror",
    description: "The mirror: what the layer believes, what it decided alone, what it cannot do.",
  },
  args: mirrorArgs,
  async run({ args }) {
    guardArguments(args, mirrorArgs, "open-brain learn mirror");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const total = optionalNonNegativeInteger(args, "max-chars");
    const days = optionalNonNegativeInteger(args, "days");
    if (total !== undefined && total < MIN_LIST_CHARS) {
      throw new ExpectedError(`--max-chars must be at least ${String(MIN_LIST_CHARS)} characters.`);
    }
    if (days !== undefined && days < 1) {
      throw new ExpectedError("--days must be at least one day.");
    }
    const mirror = await buildMirror(config, root, {
      ...(total === undefined ? {} : { caps: capsForTotal(total) }),
      ...(days === undefined ? {} : { days }),
    });

    if (booleanArgument(args, "json")) {
      printJson(mirror);
      return;
    }
    process.stdout.write(`${formatMirror(mirror)}\n`);
  },
});

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

const journalArgs = {
  ...rootArgument,
  limit: {
    type: "string",
    description: `Entries to keep at most. Defaults to ${String(DEFAULT_JOURNAL_LIMIT)}.`,
    required: false,
  },
  "max-chars": {
    type: "string",
    description: `Character cap of the listing. Defaults to ${String(DEFAULT_LIST_CHARS)}.`,
    required: false,
  },
  type: {
    type: "string",
    description: `Comma separated entry types. One of ${DECISION_TYPES.join(", ")}, consolidated.`,
    required: false,
  },
  session: {
    type: "string",
    description: "Keep only the entries of one session.",
    required: false,
  },
  since: {
    type: "string",
    description: "Inclusive lower bound on the entry timestamp.",
    required: false,
  },
  until: {
    type: "string",
    description: "Inclusive upper bound on the entry timestamp.",
    required: false,
  },
  partitions: {
    type: "string",
    description: "Monthly partitions this read may open, newest first. Defaults to 2.",
    required: false,
  },
} as const;

const journalCommand = defineCommand({
  meta: {
    name: "journal",
    description: "A bounded read of the decision journal, newest entries first.",
  },
  args: journalArgs,
  async run({ args }) {
    guardArguments(args, journalArgs, "open-brain learn journal");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const types = commaList(args, "type");
    const session = optionalString(args, "session");
    const since = optionalString(args, "since");
    const until = optionalString(args, "until");
    const partitions = optionalNonNegativeInteger(args, "partitions");

    const options: JournalReadOptions = { limit: positiveLimit(args, DEFAULT_JOURNAL_LIMIT) };
    if (types.length > 0) {
      options.types = types;
    }
    if (session !== undefined) {
      options.session = session;
    }
    if (since !== undefined) {
      options.since = since;
    }
    if (until !== undefined) {
      options.until = until;
    }
    if (partitions !== undefined) {
      options.maxPartitions = partitions;
    }

    const read = await readJournal(config, root, options);
    const capped = capItems(
      read.entries,
      (entry) => JSON.stringify(entry),
      maxChars(args, DEFAULT_LIST_CHARS),
    );
    const shown = read.entries.slice(0, capped.budget.items_shown);
    const budget = mergeBudgets(capped.budget, read.budget);
    printJson({
      entries: shown,
      invalid: read.invalid,
      partitions: read.partitions,
      partitions_skipped: read.partitions_skipped,
      budget,
      ...(budget.truncated
        ? {
          next:
            "Raise --limit or --max-chars, or narrow the read with --type, --session, --since and --until.",
        }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// sensors
// ---------------------------------------------------------------------------

const sensorsArgs = {
  ...rootArgument,
  run: {
    type: "boolean",
    description: "Run one sensor pass. This writes observations, and nothing else.",
    default: false,
  },
  limit: {
    type: "string",
    description: `Observations to read at most. Defaults to ${String(DEFAULT_OBSERVATION_LIMIT)}.`,
    required: false,
  },
  "max-chars": {
    type: "string",
    description: `Character cap of the listing. Defaults to ${String(DEFAULT_LIST_CHARS)}.`,
    required: false,
  },
  subject: {
    type: "string",
    description: "Keep only the observations of one subject.",
    required: false,
  },
} as const;

const sensorsCommand = defineCommand({
  meta: {
    name: "sensors",
    description: "What the sensors have observed, and the pass that observes more.",
  },
  args: sensorsArgs,
  async run({ args }) {
    guardArguments(args, sensorsArgs, "open-brain learn sensors");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);

    if (booleanArgument(args, "run")) {
      const report = await runSensorPass(config, root);
      printJson(report);
      printNotice(
        "A sensor pass observes and concludes nothing: it wrote readings, it moved no belief.",
      );
      return;
    }

    const subject = optionalString(args, "subject");
    const read = await readObservations(config, root, {
      limit: positiveLimit(args, DEFAULT_OBSERVATION_LIMIT),
      sensor: "circulation",
      ...(subject === undefined ? {} : { subject }),
    });
    const capped = capItems(
      read.observations,
      (observation) => JSON.stringify(observation),
      maxChars(args, DEFAULT_LIST_CHARS),
    );
    const shown = read.observations.slice(0, capped.budget.items_shown);
    const budget = mergeBudgets(capped.budget, read.budget);
    printJson({
      sensors_built: listSensors(),
      sensors_declared_unbuilt: unbuiltSensors(),
      observations: shown,
      invalid: read.invalid,
      budget,
      ...(budget.truncated
        ? { next: "Raise --limit or --max-chars, or narrow the read with --subject." }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

const evaluateArgs = {
  ...rootArgument,
  show: {
    type: "boolean",
    description: "Read the verdicts already on record instead of running a pass.",
    default: false,
  },
  consume: {
    type: "boolean",
    description: "After the pass, let the verdicts and dormancy move the beliefs.",
    default: false,
  },
  limit: {
    type: "string",
    description: `Verdicts to read at most. Defaults to ${String(DEFAULT_VERDICT_LIMIT)}.`,
    required: false,
  },
  "max-chars": {
    type: "string",
    description: `Character cap of the listing. Defaults to ${String(DEFAULT_LIST_CHARS)}.`,
    required: false,
  },
  since: {
    type: "string",
    description: "Inclusive lower bound handed to the journal read of the pass.",
    required: false,
  },
} as const;

const evaluateCommand = defineCommand({
  meta: {
    name: "evaluate",
    description: "The evaluation pass, and the verdicts it leaves behind.",
  },
  args: evaluateArgs,
  async run({ args }) {
    guardArguments(args, evaluateArgs, "open-brain learn evaluate");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const limit = positiveLimit(args, DEFAULT_VERDICT_LIMIT);

    if (booleanArgument(args, "show")) {
      const read = await readVerdicts(config, root, { limit });
      const capped = capItems(
        read.verdicts,
        (verdict) => JSON.stringify(verdict),
        maxChars(args, DEFAULT_LIST_CHARS),
      );
      const shown = read.verdicts.slice(0, capped.budget.items_shown);
      const budget = mergeBudgets(capped.budget, read.budget);
      printJson({
        verdicts: shown,
        invalid: read.invalid,
        budget,
        ...(budget.truncated ? { next: "Raise --limit or --max-chars." } : {}),
      });
      return;
    }

    const since = optionalString(args, "since");
    const report = await runEvaluatorPass(config, root, {
      ...(since === undefined ? {} : { since }),
    });

    if (!booleanArgument(args, "consume")) {
      printJson({
        pass: report,
        consumed: null,
        budget: report.budget,
        next:
          "The verdicts are written and no belief moved. Add --consume to let them move the beliefs.",
      });
      return;
    }

    const read = await readVerdicts(config, root, { limit: 2_000 });
    const consumed = await consumeVerdicts(config, root, read.verdicts);
    const dormancy = await consumeDormancy(config, root);
    printJson({
      pass: report,
      consumed: {
        verdicts_read: read.verdicts.length,
        applied: consumed.applied,
        skipped: consumed.skipped,
        ignored: consumed.ignored,
        written: consumed.written,
      },
      dormancy: {
        applied: dormancy.applied,
        skipped: dormancy.skipped,
        written: dormancy.written,
      },
      budget: report.budget,
    });
  },
});

// ---------------------------------------------------------------------------
// beliefs
// ---------------------------------------------------------------------------

interface BeliefSummary {
  id: string;
  statement: string;
  domain: string;
  origin: string;
  rank: BeliefRank;
  confidence: number;
  locked: boolean;
  opportunities: number;
  applications: number;
  corrections: number;
  created_at: string;
  seen_at: string;
  moved_at: string;
  history_entries: number;
}

function summarize(belief: Belief): BeliefSummary {
  return {
    id: belief.id,
    statement: belief.statement,
    domain: belief.domain,
    origin: belief.origin,
    rank: belief.rank,
    confidence: belief.confidence,
    locked: belief.locked,
    opportunities: belief.opportunities,
    applications: belief.applications,
    corrections: belief.corrections,
    created_at: belief.created_at,
    seen_at: belief.seen_at,
    moved_at: belief.moved_at,
    history_entries: belief.history.length,
  };
}

const beliefsArgs = {
  ...rootArgument,
  id: {
    type: "string",
    description: "Show one belief in full, with the tail of its history.",
    required: false,
  },
  rank: {
    type: "string",
    description: `Keep only one rank. One of ${BELIEF_RANKS.join(", ")}.`,
    required: false,
  },
  limit: {
    type: "string",
    description: `Beliefs to list at most. Defaults to ${String(DEFAULT_BELIEF_LIMIT)}.`,
    required: false,
  },
  "max-chars": {
    type: "string",
    description: `Character cap of the listing. Defaults to ${String(DEFAULT_LIST_CHARS)}.`,
    required: false,
  },
} as const;

const beliefsCommand = defineCommand({
  meta: {
    name: "beliefs",
    description: "The belief population: rank, confidence, counters, lock and history.",
  },
  args: beliefsArgs,
  async run({ args }) {
    guardArguments(args, beliefsArgs, "open-brain learn beliefs");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const document = await readBeliefDocument(config, root);

    const id = optionalString(args, "id");
    if (id !== undefined) {
      const belief = document.beliefs.find((candidate) => candidate.id === id);
      if (!belief) {
        throw new ExpectedError(`No belief named ${id} in this vault.`);
      }
      const history = belief.history.slice(-HISTORY_TAIL);
      const payload = {
        belief: summarize(belief),
        evidence: belief.evidence,
        history,
        history_shown: history.length,
        history_total: belief.history.length,
      };
      printJson({
        ...payload,
        budget: budgetOfJson(payload, history.length, belief.history.length),
      });
      return;
    }

    const rank = optionalString(args, "rank");
    if (rank !== undefined && !BELIEF_RANKS.some((candidate) => candidate === rank)) {
      throw new ExpectedError(`--rank must be one of ${BELIEF_RANKS.join(", ")}.`);
    }
    const selected = document.beliefs
      .filter((belief) => rank === undefined || belief.rank === rank)
      .sort((left, right) =>
        left.confidence === right.confidence
          ? left.id.localeCompare(right.id)
          : right.confidence - left.confidence);
    const limited = selected.slice(0, positiveLimit(args, DEFAULT_BELIEF_LIMIT));
    const summaries = limited.map((belief) => summarize(belief));
    const capped = capItems(
      summaries,
      (summary) => JSON.stringify(summary),
      maxChars(args, DEFAULT_LIST_CHARS),
    );
    const shown = summaries.slice(0, capped.budget.items_shown);
    const budget = mergeBudgets(capped.budget, {
      ...capped.budget,
      items_total: selected.length,
      truncated: shown.length < selected.length,
    });
    printJson({
      beliefs: shown,
      total: selected.length,
      budget,
      ...(budget.truncated
        ? { next: "Raise --limit or --max-chars, or read one belief with --id <id>." }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

const rollbackArgs = {
  ...rootArgument,
  date: {
    type: "string",
    description: "The date to come back to, as YYYY-MM-DDTHH:MM:SSZ.",
    required: true,
  },
  id: {
    type: "string",
    description: "Comma separated belief identifiers. Absent means every belief.",
    required: false,
  },
  "max-chars": {
    type: "string",
    description: `Character cap of the plan. Defaults to ${String(DEFAULT_LIST_CHARS)}.`,
    required: false,
  },
  apply: {
    type: "boolean",
    description: "Write the plan. Needs --confirm as well, and nothing else grants it.",
    default: false,
  },
  confirm: {
    type: "string",
    description: "Repeat the value of --date to confirm the write.",
    required: false,
  },
} as const;

const rollbackCommand = defineCommand({
  meta: {
    name: "rollback",
    description: "Bring confidences back to a date. Plans first, writes only on a confirmation.",
  },
  args: rollbackArgs,
  async run({ args }) {
    guardArguments(args, rollbackArgs, "open-brain learn rollback");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const date = timestampArgument(args, "date");
    const ids = commaList(args, "id");
    const cap = maxChars(args, DEFAULT_LIST_CHARS);

    const plan = await planRevert(config, root, {
      date,
      maxChars: cap,
      ...(ids.length === 0 ? {} : { ids }),
    });

    if (!booleanArgument(args, "apply")) {
      printJson({
        plan,
        written: false,
        budget: plan.budget,
        next: plan.entries.length === 0
          ? "Nothing would move, so there is nothing to apply."
          : `Apply it with \`open-brain learn rollback --date ${date} --apply --confirm ${date}\`.`,
      });
      return;
    }

    const confirm = optionalString(args, "confirm");
    if (confirm !== date) {
      throw new ExpectedError(
        `Applying a rollback rewrites confidences, so it needs its own confirmation: re-run with --confirm ${date}. A global --yes never grants it.`,
      );
    }

    const result = await revert(config, root, {
      date,
      maxChars: cap,
      write: true,
      ...(ids.length === 0 ? {} : { ids }),
    });
    printJson({
      plan: result.plan,
      written: result.written,
      budget: result.plan.budget,
      next: result.written
        ? "Every move was added to the history, and nothing was erased from it."
        : "Nothing had to be written: the plan was already the state on disk.",
    });
  },
});

// ---------------------------------------------------------------------------
// consolidate
// ---------------------------------------------------------------------------

const REFERENCE_MODES: readonly ReferenceMode[] = ["strict", "bootstrap", "resume"];

const consolidateArgs = {
  ...rootArgument,
  document: {
    type: "string",
    description: "Path of the bounded document, relative to the vault root.",
    required: true,
  },
  confirm: {
    type: "string",
    description: "Repeat the value of --document to confirm the write.",
    required: false,
  },
  mode: {
    type: "string",
    description: `Write reference mode. One of ${REFERENCE_MODES.join(", ")}. Defaults to strict.`,
    required: false,
  },
  restore: {
    type: "boolean",
    description: "The way back: rebuild the origin from the document and its archives.",
    default: false,
  },
} as const;

function modeArgument(args: unknown): ReferenceMode | undefined {
  const value = optionalString(args, "mode");
  if (value === undefined) {
    return undefined;
  }
  const mode = REFERENCE_MODES.find((candidate) => candidate === value);
  if (!mode) {
    throw new ExpectedError(`--mode must be one of ${REFERENCE_MODES.join(", ")}.`);
  }
  return mode;
}

interface SplitPreview {
  blocks?: number;
  pointers?: number;
  bytes?: number;
  /** Why the document could not be read or cut. Reported, never guessed around. */
  error?: string;
}

/**
 * What the document looks like before anything moves. It reads and it cuts in
 * memory only, so a preflight never touches the file it is describing.
 */
async function previewSplit(
  config: VaultConfig,
  root: string,
  document: string,
): Promise<SplitPreview> {
  try {
    const raw = await readFile(join(root, document), "utf8");
    const contract = readLoadContract(raw, config);
    const split = splitDocument(raw, contract);
    return {
      blocks: split.blocks.length,
      pointers: split.pointers.length,
      bytes: Buffer.byteLength(raw, "utf8"),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const consolidateCommand = defineCommand({
  meta: {
    name: "consolidate",
    description: "The one subtractive act. Shows its safety catch first, writes only on a confirmation.",
  },
  args: consolidateArgs,
  async run({ args }) {
    guardArguments(args, consolidateArgs, "open-brain learn consolidate");
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const document = requiredString(args, "document");
    const confirm = optionalString(args, "confirm");
    const mode = modeArgument(args);

    if (booleanArgument(args, "restore")) {
      const report = await deconsolidate(config, root, document, {
        write: confirm === document,
      });
      // Same reason as consolidation: the restored origin is a document, not an
      // answer. Its digest and its size are what a caller checks.
      const { text: _restored, ...summary } = report;
      printJson({
        restore: summary,
        written: confirm === document,
        budget: report.budget,
        ...(confirm === document
          ? {}
          : {
            next:
              `Nothing was written. Write the origin back with \`open-brain learn consolidate --document ${document} --restore --confirm ${document}\`.`,
          }),
      });
      return;
    }

    // Refuse before anything else, and say what would arm it. Consolidation is
    // the one act that takes something away, so it never rides on a parent
    // capability or on a preset.
    requireCapability(config, "learning.consolidate");

    const proof = await verifyReversibility();
    const pending = await pendingTransaction(config, root);
    const preview = await previewSplit(config, root, document);

    const preflight = {
      document,
      mode: mode ?? "strict",
      reversibility: proof,
      pending_transaction: pending ?? null,
      preview,
    };

    if (!proof.ok) {
      printJson({
        ...preflight,
        written: false,
        budget: budgetOfJson(preflight, proof.cases.length, proof.cases.length),
      });
      throw new ExpectedError(
        "The byte exact way back is not proven, so the subtractive organ stays disarmed and nothing was moved. The failing cases are printed above.",
      );
    }

    if (confirm !== document) {
      printJson({
        ...preflight,
        written: false,
        budget: budgetOfJson(preflight, proof.cases.length, proof.cases.length),
        next:
          `Nothing was written. The way back is proven on ${String(proof.cases.length)} case(s). Apply it with \`open-brain learn consolidate --document ${document} --confirm ${document}\`. A global --yes never grants it.`,
      });
      return;
    }

    const report = await consolidate(config, root, document, {
      ...(mode === undefined ? {} : { mode }),
    });
    // The rewritten document itself is not printed: it is already on disk, and
    // echoing it would blow the budget of a command whose answer is a report.
    const { text, ...summary } = report;
    printJson({
      reversibility: proof,
      report: summary,
      document_chars: text.length,
      budget: report.budget,
    });
  },
});

// ---------------------------------------------------------------------------

export const learnCommand = defineCommand({
  meta: {
    name: "learn",
    description: "The learning layer: what it observes, what it concludes, and what it shows.",
  },
  subCommands: {
    status: statusCommand,
    mirror: mirrorCommand,
    journal: journalCommand,
    sensors: sensorsCommand,
    evaluate: evaluateCommand,
    beliefs: beliefsCommand,
    rollback: rollbackCommand,
    consolidate: consolidateCommand,
  },
});
