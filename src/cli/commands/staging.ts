import { defineCommand } from "citty";

import { capItems, capText, emptyBudget, type ContextBudget } from "../../core/budget.js";
import { isEnabled } from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import {
  compactStaging,
  dropCandidates,
  getCandidate,
  listCandidates,
  stagingStatus,
  appendCandidate,
} from "../../staging/store.js";
import {
  CANDIDATE_SIGNALS,
  CANDIDATE_SOURCES,
  CANDIDATE_STATUSES,
  HARNESSES,
  type CandidateRow,
  type CandidateSignal,
  type CandidateSource,
  type CandidateStatus,
  type Harness,
} from "../../staging/types.js";
import {
  booleanArgument,
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
 * The staging surface. Every listing is capped and reports what it cost, per
 * invariant I11: a review that silently drops half the candidates is worse than
 * one that shows fewer and says so.
 */

const DEFAULT_LIST_CHARS = 4_000;
const DEFAULT_SHOW_CHARS = 8_000;
const QUOTE_PREVIEW = 160;

interface CandidateSummary {
  id: string;
  ts: string;
  status: CandidateStatus;
  source: CandidateSource;
  signal: CandidateSignal;
  harness: Harness;
  batch_id: string | null;
  quote: string;
  quote_truncated: boolean;
}

function summarize(row: CandidateRow): CandidateSummary {
  const points = Array.from(row.raw_quote);
  const truncated = points.length > QUOTE_PREVIEW;
  return {
    id: row.id,
    ts: row.ts,
    status: row.status,
    source: row.source,
    signal: row.signal,
    harness: row.harness,
    batch_id: row.batch_id,
    quote: truncated ? points.slice(0, QUOTE_PREVIEW).join("") : row.raw_quote,
    quote_truncated: truncated,
  };
}

function renderSummary(summary: CandidateSummary): string {
  const quote = summary.quote.replace(/\s+/gu, " ").trim();
  return `${summary.id}  ${summary.status}  ${summary.source}/${summary.signal}  ${summary.ts}  ${quote}${summary.quote_truncated ? "..." : ""}`;
}

function maxChars(args: unknown, fallback: number): number {
  const value = optionalNonNegativeInteger(args, "max-chars");
  if (value === undefined) {
    return fallback;
  }
  if (value < 200) {
    throw new ExpectedError("--max-chars must be at least 200 characters.");
  }
  return value;
}

function optionalStatus(args: unknown): CandidateStatus | undefined {
  const value = optionalString(args, "status");
  if (value === undefined) {
    return undefined;
  }
  const status = CANDIDATE_STATUSES.find((item) => item === value);
  if (!status) {
    throw new ExpectedError(
      `--status must be one of ${CANDIDATE_STATUSES.join(", ")}.`,
    );
  }
  return status;
}

function optionalSources(args: unknown): CandidateSource[] | undefined {
  const value = optionalString(args, "source");
  if (value === undefined) {
    return undefined;
  }
  const requested = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const sources = requested.map((item) => {
    const source = CANDIDATE_SOURCES.find((known) => known === item);
    if (!source) {
      throw new ExpectedError(
        `--source must be a comma-separated list from ${CANDIDATE_SOURCES.join(", ")}, received "${item}".`,
      );
    }
    return source;
  });
  return sources.length === 0 ? undefined : sources;
}

function truncationNext(budget: ContextBudget, command: string): string | undefined {
  return budget.truncated
    ? `${String(budget.items_total - budget.items_shown)} candidate(s) were not shown. Raise --max-chars, filter with --status, or read one with \`${command}\`.`
    : undefined;
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List staged candidates, capped and with the cost of the listing.",
  },
  args: {
    ...rootArgument,
    status: {
      type: "string",
      description: "Filter by candidate status.",
      required: false,
    },
    pending: {
      type: "boolean",
      description: "Show only candidates that still await a human decision.",
      default: false,
    },
    "include-archived": {
      type: "boolean",
      description: "Include candidates already archived by a compaction.",
      default: false,
    },
    "max-chars": {
      type: "string",
      description: `Character cap for the listing. Defaults to ${String(DEFAULT_LIST_CHARS)}.`,
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const status = optionalStatus(args);
    const rows = await listCandidates(root, config, {
      ...(status === undefined ? {} : { status }),
      ...(booleanArgument(args, "pending") ? { pending: true } : {}),
      ...(booleanArgument(args, "include-archived") ? { includeArchived: true } : {}),
    });
    const summaries = rows.map((row) => summarize(row));
    const capped = capItems(summaries, renderSummary, maxChars(args, DEFAULT_LIST_CHARS));
    const shown = summaries.slice(0, capped.budget.items_shown);
    const next = truncationNext(capped.budget, "open-brain staging show --id <id>");
    printJson({
      total: rows.length,
      candidates: shown,
      budget: capped.budget,
      ...(next === undefined ? {} : { next }),
    });
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show one candidate in full, with its quote capped and counted.",
  },
  args: {
    id: {
      type: "positional",
      description: "Candidate identifier.",
      required: true,
    },
    ...rootArgument,
    "max-chars": {
      type: "string",
      description: `Character cap for the quote and content. Defaults to ${String(DEFAULT_SHOW_CHARS)}.`,
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const id = requiredString(args, "id");
    const candidate = await getCandidate(root, config, id);
    if (!candidate) {
      throw new ExpectedError(`Unknown candidate ${id}.`);
    }
    const cap = maxChars(args, DEFAULT_SHOW_CHARS);
    const quote = capText(candidate.raw_quote, cap);
    const content = candidate.content === null ? undefined : capText(candidate.content, cap);
    printJson({
      candidate: {
        ...candidate,
        raw_quote: quote.text,
        ...(content === undefined ? {} : { content: content.text }),
      },
      budget: {
        chars: quote.budget.chars + (content?.budget.chars ?? 0),
        token_estimate: quote.budget.token_estimate + (content?.budget.token_estimate ?? 0),
        items_shown: 1,
        items_total: 1,
        truncated: quote.budget.truncated || (content?.budget.truncated ?? false),
      },
    });
  },
});

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Stage a candidate by hand. Available with no capability armed.",
  },
  args: {
    ...rootArgument,
    quote: {
      type: "string",
      description: "The statement to stage, in the user's own words.",
      required: true,
    },
    signal: {
      type: "string",
      description: `Why it is being staged. Defaults to explicit_request. One of ${CANDIDATE_SIGNALS.join(", ")}.`,
      required: false,
    },
    source: {
      type: "string",
      description: `Where it came from. Defaults to manual. One of ${CANDIDATE_SOURCES.join(", ")}.`,
      required: false,
    },
    markers: {
      type: "string",
      description: "Comma-separated markers that triggered the capture.",
      required: false,
    },
    context: {
      type: "string",
      description: "Short surrounding context.",
      required: false,
    },
    harness: {
      type: "string",
      description: `Host CLI. Defaults to unknown. One of ${HARNESSES.join(", ")}.`,
      required: false,
    },
    "session-id": {
      type: "string",
      description: "Session identifier, when the caller knows it.",
      required: false,
    },
    "operation-id": {
      type: "string",
      description: "Idempotency key. Replaying it never files a second candidate.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const markers = optionalString(args, "markers");
    const context = optionalString(args, "context");
    const sessionId = optionalString(args, "session-id");
    const operationId = optionalString(args, "operation-id");
    const result = await appendCandidate(root, config, {
      source: optionalString(args, "source") ?? "manual",
      signal: optionalString(args, "signal") ?? "explicit_request",
      raw_quote: requiredString(args, "quote"),
      raw_markers: markers === undefined
        ? []
        : markers.split(",").map((item) => item.trim()).filter((item) => item.length > 0),
      harness: optionalString(args, "harness") ?? "unknown",
      ...(context === undefined ? {} : { context }),
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    });
    printJson({
      candidate: summarize(result.candidate),
      created: result.created,
      budget: emptyBudget(),
      next: "Nothing is written to the kernel until you review it with `open-brain sync`.",
    });
  },
});

const dropCommand = defineCommand({
  meta: {
    name: "drop",
    description: "Delete active candidates outright. Destructive, so it needs --yes.",
  },
  args: {
    ...rootArgument,
    id: {
      type: "string",
      description: "Comma-separated candidate identifiers to delete.",
      required: false,
    },
    status: {
      type: "string",
      description: "Delete every active candidate with this status.",
      required: false,
    },
    "older-than": {
      type: "string",
      description: "Delete candidates staged more than this many days ago.",
      required: false,
    },
    "include-archived": {
      type: "boolean",
      description: "Also delete already-archived candidates matching the same criteria.",
      default: false,
    },
    source: {
      type: "string",
      description: `Comma-separated candidate source(s) to delete: ${CANDIDATE_SOURCES.join(", ")}.`,
      required: false,
    },
    reason: {
      type: "string",
      description: "Why these candidates are being dropped, recorded on the tombstone.",
      required: false,
    },
    yes: {
      type: "boolean",
      description: "Confirm the deletion. Without it nothing is deleted.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const ids = (optionalString(args, "id") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const status = optionalStatus(args);
    const olderThan = optionalNonNegativeInteger(args, "older-than");
    const includeArchived = booleanArgument(args, "include-archived");
    const sources = optionalSources(args);
    const reason = optionalString(args, "reason");

    if (!booleanArgument(args, "yes")) {
      throw new ExpectedError(
        `Dropping candidates deletes them for good${includeArchived ? ", including their archived copies," : ""}. Re-run with --yes once you are sure.`,
      );
    }
    const result = await dropCandidates(root, config, {
      ...(ids.length === 0 ? {} : { ids }),
      ...(status === undefined ? {} : { status }),
      ...(olderThan === undefined ? {} : { olderThanDays: olderThan }),
      ...(includeArchived ? { includeArchived: true } : {}),
      ...(sources === undefined ? {} : { sources }),
      ...(reason === undefined ? {} : { reason }),
      command: "open-brain staging drop",
    });
    printJson({
      dropped: result.dropped,
      kept: result.kept,
      archived_dropped: result.archived_dropped,
      archive_files: result.archive_files,
      budget: emptyBudget(),
    });
  },
});

const compactCommand = defineCommand({
  meta: {
    name: "compact",
    description: "Move decided candidates into their monthly archive.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    printJson({ ...(await compactStaging(root, config)), budget: emptyBudget() });
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Count what is staged and what still awaits a decision.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const status = await stagingStatus(root, config);
    printJson({ ...status, budget: emptyBudget() });
    if (!isEnabled(config, "capture")) {
      printNotice(
        "Automatic capture is disarmed. `open-brain staging add` still works, and `open-brain capabilities explain capture` says what arming it would do.",
      );
    }
  },
});

export const stagingCommand = defineCommand({
  meta: {
    name: "staging",
    description: "Inspect and manage the staging area, the only free write zone.",
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    add: addCommand,
    drop: dropCommand,
    compact: compactCommand,
    status: statusCommand,
  },
});
