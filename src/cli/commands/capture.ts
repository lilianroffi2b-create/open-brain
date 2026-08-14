import { defineCommand } from "citty";

import { capItems, emptyBudget } from "../../core/budget.js";
import { isEnabled } from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import { scanTranscriptForCandidates } from "../../staging/capture.js";
import {
  loadCaptureSettings,
  MARKER_PACK_NOTICE,
  normalizeForMatch,
} from "../../staging/markers.js";
import { mineTranscripts } from "../../staging/mine.js";
import { REDACTION_NOTICE } from "../../transcripts/redact.js";
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
 * The offline half of capture, for every CLI that has no hooks.
 *
 * `capture scan` is the pre-compaction organ made manual: the same detection,
 * over a transcript a human hands it, filing the same candidates. `capture
 * mine` is the read-only pass that looks for corrections that keep coming back.
 * `capture markers` prints the pre-filter that is actually in force, because a
 * filter nobody can inspect is a filter nobody can fix.
 */

const DEFAULT_MINE_CHARS = 4_000;
const DEFAULT_SINCE_DAYS = 30;

const scanCommand = defineCommand({
  meta: {
    name: "scan",
    description: "Replay the capture detection over one transcript and stage what it finds.",
  },
  args: {
    ...rootArgument,
    transcript: {
      type: "string",
      description: "Path to the transcript file to scan.",
      required: true,
    },
    "max-messages": {
      type: "string",
      description: "Human messages to examine from the end of the file.",
      required: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Report what would be staged without staging anything.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const dryRun = booleanArgument(args, "dry-run");
    const maxMessages = optionalNonNegativeInteger(args, "max-messages");
    const result = await scanTranscriptForCandidates(
      root,
      config,
      requiredString(args, "transcript"),
      {
        dryRun,
        ...(maxMessages === undefined ? {} : { maxMessages: Math.max(1, maxMessages) }),
      },
    );

    printJson({
      dry_run: result.dry_run,
      examined: result.examined,
      matched: result.matched,
      filed: result.filed,
      staged: result.staged.map((row) => ({
        id: row.id,
        signal: row.signal,
        source: row.source,
        markers: row.raw_markers,
      })),
      session: result.read.session,
      redaction: {
        applied: config.capabilities.transcripts.redact,
        replacements: result.read.redactions,
      },
      budget: result.budget,
      next: result.dry_run
        ? "Nothing was written. Re-run without --dry-run to stage these candidates."
        : "Nothing reaches the kernel until you review it with `open-brain sync`.",
    });
    if (result.read.truncated) {
      printNotice(
        `Only the end of the transcript was read (${String(result.read.bytes_read)} bytes, ${String(result.read.lines_read)} lines). Earlier messages were not examined.`,
      );
    }
    if (!config.capabilities.transcripts.redact) {
      printNotice(
        "Redaction is off for this vault, so quotes were staged exactly as they were typed.",
      );
    }
  },
});

const mineCommand = defineCommand({
  meta: {
    name: "mine",
    description: "Read only: find corrections that keep coming back across distinct sessions.",
  },
  args: {
    ...rootArgument,
    since: {
      type: "string",
      description: `Only look at transcripts modified in the last N days. Defaults to ${String(DEFAULT_SINCE_DAYS)}.`,
      required: false,
    },
    "min-occurrences": {
      type: "string",
      description: "Minimum times a token must appear in corrections. Defaults to 3.",
      required: false,
    },
    "min-sessions": {
      type: "string",
      description: "Minimum distinct sessions it must appear in. Defaults to 3.",
      required: false,
    },
    "max-chars": {
      type: "string",
      description: `Character cap for the report. Defaults to ${String(DEFAULT_MINE_CHARS)}.`,
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const maxChars = optionalNonNegativeInteger(args, "max-chars") ?? DEFAULT_MINE_CHARS;
    if (maxChars < 200) {
      throw new ExpectedError("--max-chars must be at least 200 characters.");
    }
    const report = await mineTranscripts(root, config, {
      sinceDays: optionalNonNegativeInteger(args, "since") ?? DEFAULT_SINCE_DAYS,
      minOccurrences: optionalNonNegativeInteger(args, "min-occurrences"),
      minSessions: optionalNonNegativeInteger(args, "min-sessions"),
    });
    const capped = capItems(
      report.clusters,
      (cluster) => `${cluster.token}  ${String(cluster.occurrences)} occurrence(s) across ${String(cluster.sessions)} session(s)`,
      maxChars,
    );

    printJson({
      files_examined: report.files_examined,
      listing_truncated: report.listing_truncated,
      messages_examined: report.messages_examined,
      corrections_found: report.corrections_found,
      min_occurrences: report.min_occurrences,
      min_sessions: report.min_sessions,
      clusters: report.clusters.slice(0, capped.budget.items_shown),
      budget: capped.budget,
      next: "This command writes nothing. Stage anything worth keeping yourself with `open-brain staging add`.",
    });
    printNotice(REDACTION_NOTICE);
  },
});

const markersCommand = defineCommand({
  meta: {
    name: "markers",
    description: "Print the capture pre-filter that is actually in force.",
  },
  args: {
    ...rootArgument,
    test: {
      type: "string",
      description: "Show how one sentence is normalized before matching.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const settings = await loadCaptureSettings(root);
    const sample = optionalString(args, "test");

    printJson({
      source: settings.source,
      capture_enabled: isEnabled(config, "capture"),
      packs: settings.markers.packs.map((pack) => ({
        id: pack.id,
        explicit_request: pack.explicit_request.length,
        correction: pack.correction.length,
        correction_lead: pack.correction_lead.length,
        praise: pack.praise.length,
      })),
      marker_limits: settings.markers.limits,
      capture_limits: settings.limits,
      unknown_packs: settings.unknown_packs,
      ...(sample === undefined ? {} : { normalized: normalizeForMatch(sample).trim() }),
      budget: emptyBudget(),
      config_keys: [
        "capture.markers.packs",
        "capture.markers.custom",
        "capture.markers.limits.max_correction_chars",
        "capture.markers.limits.negation_window_chars",
        "capture.markers.limits.meta_window_chars",
        "capture.markers.limits.max_markers_per_message",
        "capture.limits.max_messages_per_scan",
        "capture.limits.max_candidates_per_scan",
        "capture.limits.transcript_max_bytes",
        "capture.limits.transcript_max_lines",
      ],
    });
    printNotice(MARKER_PACK_NOTICE);
    if (settings.unknown_packs.length > 0) {
      printNotice(
        `Unknown marker pack(s) named in the config and ignored: ${settings.unknown_packs.join(", ")}.`,
      );
    }
  },
});

export const captureCommand = defineCommand({
  meta: {
    name: "capture",
    description: "Offline capture for CLIs with no hooks, and the pre-filter behind it.",
  },
  subCommands: {
    scan: scanCommand,
    mine: mineCommand,
    markers: markersCommand,
  },
});
