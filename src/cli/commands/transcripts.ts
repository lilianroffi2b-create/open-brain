import { defineCommand } from "citty";

import { capItems, emptyBudget, type ContextBudget } from "../../core/budget.js";
import { isEnabled } from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import { dropCandidates, listCandidates } from "../../staging/store.js";
import { CANDIDATE_SOURCES, type CandidateSource } from "../../staging/types.js";
import {
  consentSummary,
  ENABLE_COMMAND,
  listTranscriptFiles,
} from "../../transcripts/consent.js";
import { readConsentedTranscript } from "../../transcripts/reader.js";
import {
  REDACTION_COVERED,
  REDACTION_NOT_COVERED,
  REDACTION_NOTICE,
} from "../../transcripts/redact.js";
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
 * The transcripts surface: see what is consented, read a bounded sample of one
 * file, and erase everything ever derived from any of them.
 *
 * `purge` is not a convenience. A capability that reads the most sensitive file
 * on the machine is only acceptable if the user can undo it completely and can
 * see exactly what the undo removed, which is why it reports identifiers rather
 * than a count and names what it could not remove.
 */

const DEFAULT_SCAN_CHARS = 4_000;
const DEFAULT_SHOW_CHARS = 8_000;
const DEFAULT_SHOW_MESSAGES = 20;

/** Sources whose material was read out of a session transcript. */
export const TRANSCRIPT_DERIVED_SOURCES: readonly CandidateSource[] = ["turn_end", "pre_compact"];

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

function truncationNext(budget: ContextBudget, hint: string): string | undefined {
  return budget.truncated
    ? `${String(Math.max(0, budget.items_total - budget.items_shown))} item(s) were not shown. ${hint}`
    : undefined;
}

const scanCommand = defineCommand({
  meta: {
    name: "scan",
    description: "List the transcript files inside the directories you consented to.",
  },
  args: {
    ...rootArgument,
    "max-files": {
      type: "string",
      description: "Stop after this many files. Defaults to 200.",
      required: false,
    },
    "max-chars": {
      type: "string",
      description: `Character cap for the listing. Defaults to ${String(DEFAULT_SCAN_CHARS)}.`,
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const consent = consentSummary(config);
    if (!consent.enabled) {
      printJson({
        consent,
        files: [],
        budget: emptyBudget(),
        next: `Nothing outside this vault was read. The transcripts capability is disarmed, and arming it requires naming a directory: \`${ENABLE_COMMAND}\`.`,
      });
      return;
    }

    const listing = await listTranscriptFiles(root, config, {
      maxFiles: optionalNonNegativeInteger(args, "max-files"),
    });
    const capped = capItems(
      listing.files,
      (file) => `${file.path}  ${String(file.size)} bytes  ${file.modified_at}`,
      maxChars(args, DEFAULT_SCAN_CHARS),
    );
    const next = truncationNext(
      capped.budget,
      "Raise --max-chars or narrow the consented directories.",
    );
    printJson({
      consent,
      roots: listing.roots.map((entry) => ({
        declared: entry.declared,
        resolved: entry.real ?? entry.lexical,
        exists: entry.real !== undefined,
      })),
      files: listing.files.slice(0, capped.budget.items_shown),
      scanned_entries: listing.scanned_entries,
      budget: capped.budget,
      ...(next === undefined ? {} : { next }),
    });
    if (!consent.redact) {
      printNotice(
        "Redaction is off for this vault. Anything captured from these transcripts is written to the vault exactly as it was typed.",
      );
    }
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Read a bounded, redacted sample of one consented transcript.",
  },
  args: {
    ...rootArgument,
    transcript: {
      type: "string",
      description: "Path to the transcript file to sample.",
      required: true,
    },
    "max-messages": {
      type: "string",
      description: `Human messages to keep from the end. Defaults to ${String(DEFAULT_SHOW_MESSAGES)}.`,
      required: false,
    },
    "max-chars": {
      type: "string",
      description: `Character cap for the sample. Defaults to ${String(DEFAULT_SHOW_CHARS)}.`,
      required: false,
    },
    raw: {
      type: "boolean",
      description: "Show the text without redaction. Off by default.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const maxMessages = optionalNonNegativeInteger(args, "max-messages") ?? DEFAULT_SHOW_MESSAGES;
    const raw = booleanArgument(args, "raw");
    const read = await readConsentedTranscript(
      root,
      config,
      requiredString(args, "transcript"),
      { maxMessages: Math.max(1, maxMessages), ...(raw ? { redact: false } : {}) },
    );

    const capped = capItems(
      read.messages,
      (message) => `[${message.timestamp ?? "no timestamp"}] ${message.text.replace(/\s+/gu, " ").trim()}`,
      maxChars(args, DEFAULT_SHOW_CHARS),
    );
    printJson({
      session: read.session,
      messages: read.messages.slice(0, capped.budget.items_shown).map((message) => ({
        timestamp: message.timestamp,
        turn_id: message.turn_id,
        event_id: message.event_id,
        text: message.text,
      })),
      bytes_read: read.bytes_read,
      lines_read: read.lines_read,
      window: read.window,
      redaction: {
        applied: !raw,
        replacements: read.redactions,
        covers: REDACTION_COVERED,
        does_not_cover: REDACTION_NOT_COVERED,
      },
      budget: capped.budget,
      ...(read.truncated
        ? {
          next: `Only the last ${String(read.bytes_read)} bytes of the file were read, so earlier messages are not in this sample. Raise --max-messages to keep more of the window.`,
        }
        : {}),
    });
    if (raw) {
      printNotice(
        "This output is unredacted. It may contain keys, tokens, credentials, and addresses exactly as they appear in the session.",
      );
    }
  },
});

const purgeCommand = defineCommand({
  meta: {
    name: "purge",
    description: "Delete every candidate ever derived from a transcript, and say which ones.",
  },
  args: {
    ...rootArgument,
    "include-prompt": {
      type: "boolean",
      description: "Also delete candidates captured from a submitted prompt.",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "List what would be deleted without deleting it.",
      default: false,
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
    const sources: CandidateSource[] = booleanArgument(args, "include-prompt")
      ? [...TRANSCRIPT_DERIVED_SOURCES, "prompt_submit"]
      : [...TRANSCRIPT_DERIVED_SOURCES];

    const active = await listCandidates(root, config);
    const all = await listCandidates(root, config, { includeArchived: true });
    const activeIds = new Set(active.map((row) => row.id));
    const derived = all.filter((row) => sources.includes(row.source));
    const removable = derived.filter((row) => activeIds.has(row.id));
    const archived = derived.filter((row) => !activeIds.has(row.id));

    const perSource: Record<string, number> = {};
    for (const source of CANDIDATE_SOURCES) {
      const count = removable.filter((row) => row.source === source).length;
      if (count > 0) {
        perSource[source] = count;
      }
    }

    const dryRun = booleanArgument(args, "dry-run");
    if (!dryRun && !booleanArgument(args, "yes")) {
      throw new ExpectedError(
        `This deletes ${String(derived.length)} candidate(s) derived from your transcripts (${String(removable.length)} active, ${String(archived.length)} archived), for good. Re-run with --dry-run to see the list, or with --yes to delete them.`,
      );
    }

    // Archived candidates are erased here too: the archive is append-only for
    // its own sake, but a transcript purge is a privacy erasure, and content
    // that survives it in an archive file would make the command a half-truth.
    const outcome = dryRun || derived.length === 0
      ? {
        dropped: removable.map((row) => row.id),
        archived_dropped: archived.map((row) => row.id),
        archive_files: [],
      }
      : await dropCandidates(root, config, {
        sources,
        includeArchived: true,
        reason: "user requested a full transcript-derived purge",
        command: "open-brain transcripts purge",
      });

    printJson({
      dry_run: dryRun,
      sources,
      deleted: outcome.dropped,
      deleted_count: outcome.dropped.length,
      deleted_by_source: perSource,
      deleted_archived: outcome.archived_dropped,
      deleted_archived_count: outcome.archived_dropped.length,
      archive_files: outcome.archive_files,
      budget: emptyBudget(),
      next: outcome.dropped.length === 0 && outcome.archived_dropped.length === 0
        ? "Nothing derived from a transcript was found."
        : "Every candidate derived from a transcript was deleted, active and archived. Nothing derived from a transcript remains, in the staging area or in its archive.",
    });
    if (isEnabled(config, "transcripts")) {
      printNotice(REDACTION_NOTICE);
    }
  },
});

export const transcriptsCommand = defineCommand({
  meta: {
    name: "transcripts",
    description: "Read session transcripts from directories you named, and erase what came out.",
  },
  subCommands: {
    scan: scanCommand,
    show: showCommand,
    purge: purgeCommand,
  },
});
