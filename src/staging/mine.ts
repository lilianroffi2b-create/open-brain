import { estimateTokens, type ContextBudget } from "../core/budget.js";
import { tokenize } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import { listTranscriptFiles } from "../transcripts/consent.js";
import { readConsentedTranscript, type HumanMessage } from "../transcripts/reader.js";
import {
  detectSignal,
  loadCaptureSettings,
  type CaptureSettings,
} from "./markers.js";

/**
 * Offline mining, read only, invoked by a human and by nothing else.
 *
 * It answers one question: which corrections keep coming back. A correction
 * said once is a bad turn; the same correction said in three different sessions
 * is a preference the user has been repeating to a tool that never listened.
 * Recurrence across distinct sessions is the whole signal, which is why a
 * cluster that lives inside a single session is never reported.
 *
 * It writes nothing, ever. It proposes tokens and the sentences behind them,
 * and a human decides whether any of it becomes a preference. That separation
 * is the point: the miner reads the widest surface in the product, so it is
 * also the organ with the least authority.
 */

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MIN_SESSIONS = 3;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_CLUSTERS = 20;
const DEFAULT_SAMPLES_PER_CLUSTER = 2;
const SAMPLE_CHARS = 160;
const MIN_TOKEN_LENGTH = 4;

/**
 * Function words with no topic of their own. Generic English only: the
 * reference list carried names, a product name, and personal in-jokes, none of
 * which belong in a public default. A user whose sessions are in another
 * language should expect this list to be useless and to need their own.
 */
export const MINING_STOPWORDS: readonly string[] = [
  "about", "after", "again", "against", "already", "also", "always", "another",
  "anything", "around", "back", "because", "been", "before", "being", "better",
  "between", "both", "case", "code", "could", "does", "doing", "done", "down",
  "each", "else", "even", "ever", "every", "file", "files", "first", "from",
  "give", "going", "good", "have", "here", "into", "just", "keep", "kind",
  "know", "last", "left", "like", "line", "lines", "look", "made", "make",
  "many", "more", "most", "much", "must", "need", "never", "next", "nice",
  "only", "open", "other", "over", "part", "please", "point",
  "really", "right", "same", "see", "should", "since", "some", "still",
  "such", "sure", "take", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "thing", "things", "think", "this", "those",
  "through", "time", "type", "under", "until", "used", "using", "very", "want",
  "well", "were", "what", "when", "where", "which", "while", "will", "with",
  "without", "work", "would", "your",
];

const STOPWORD_SET = new Set(MINING_STOPWORDS);

export interface MineOptions {
  sinceDays?: number | undefined;
  minOccurrences?: number | undefined;
  minSessions?: number | undefined;
  maxFiles?: number | undefined;
  maxClusters?: number | undefined;
  settings?: CaptureSettings | undefined;
}

export interface MineSample {
  session_id: string | null;
  quote: string;
}

export interface MineCluster {
  token: string;
  occurrences: number;
  sessions: number;
  samples: MineSample[];
}

export interface MineReport {
  files_examined: number;
  listing_truncated: boolean;
  messages_examined: number;
  corrections_found: number;
  clusters: MineCluster[];
  budget: ContextBudget;
  truncated: boolean;
  redacted: boolean;
  min_occurrences: number;
  min_sessions: number;
}

interface Accumulator {
  occurrences: number;
  sessions: Set<string>;
  samples: MineSample[];
}

function sampleOf(message: HumanMessage): MineSample {
  const compact = message.text.replace(/\s+/gu, " ").trim();
  const points = Array.from(compact);
  return {
    session_id: message.session_id,
    quote: points.length <= SAMPLE_CHARS ? compact : `${points.slice(0, SAMPLE_CHARS).join("")}...`,
  };
}

/**
 * Scans the consented transcript directories for recurring corrections.
 *
 * Bounded three ways, per invariant I11: a ceiling on files opened, the reader's
 * own ceiling on bytes and messages per file, and a ceiling on clusters
 * reported. What was left out is in the report, not in a comment.
 */
export async function mineTranscripts(
  vaultRoot: string,
  config: VaultConfig,
  options: MineOptions = {},
): Promise<MineReport> {
  const settings = options.settings ?? await loadCaptureSettings(vaultRoot);
  const minOccurrences = Math.max(1, options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES);
  const minSessions = Math.max(1, options.minSessions ?? DEFAULT_MIN_SESSIONS);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxClusters = Math.max(1, options.maxClusters ?? DEFAULT_MAX_CLUSTERS);

  const listing = await listTranscriptFiles(vaultRoot, config, {
    maxFiles,
    ...(options.sinceDays === undefined
      ? {}
      : { sinceMs: Date.now() - options.sinceDays * 86_400_000 }),
  });

  const accumulators = new Map<string, Accumulator>();
  let messages = 0;
  let corrections = 0;
  let redacted = false;
  let truncated = listing.truncated;

  for (const file of listing.files) {
    let read;
    try {
      read = await readConsentedTranscript(vaultRoot, config, file.path, {
        maxBytes: settings.limits.transcript_max_bytes,
        maxLines: settings.limits.transcript_max_lines,
        maxMessages: settings.limits.max_messages_per_scan,
      });
    } catch {
      // An unreadable transcript is skipped, never fatal: a mining run over a
      // hundred files must not die on one truncated file.
      continue;
    }
    redacted = redacted || read.redacted;
    truncated = truncated || read.truncated;
    messages += read.messages.length;

    for (const message of read.messages) {
      const detection = detectSignal(
        {
          text: message.text,
          hasAssistantContext: message.assistant_context !== null,
        },
        settings.markers,
      );
      if (detection.signal !== "correction") {
        continue;
      }
      corrections += 1;
      const sessionKey = message.session_id ?? file.path;
      for (const token of new Set(tokenize(message.text))) {
        if (token.length < MIN_TOKEN_LENGTH || STOPWORD_SET.has(token) || /^\d+$/u.test(token)) {
          continue;
        }
        const accumulator = accumulators.get(token)
          ?? { occurrences: 0, sessions: new Set<string>(), samples: [] };
        accumulator.occurrences += 1;
        accumulator.sessions.add(sessionKey);
        if (accumulator.samples.length < DEFAULT_SAMPLES_PER_CLUSTER) {
          accumulator.samples.push(sampleOf(message));
        }
        accumulators.set(token, accumulator);
      }
    }
  }

  const clusters: MineCluster[] = [];
  for (const [token, accumulator] of accumulators) {
    if (accumulator.occurrences < minOccurrences || accumulator.sessions.size < minSessions) {
      continue;
    }
    clusters.push({
      token,
      occurrences: accumulator.occurrences,
      sessions: accumulator.sessions.size,
      samples: accumulator.samples,
    });
  }
  clusters.sort((left, right) => (
    right.sessions - left.sessions
    || right.occurrences - left.occurrences
    || left.token.localeCompare(right.token)
  ));

  const shown = clusters.slice(0, maxClusters);
  const rendered = shown
    .map((cluster) => `${cluster.token} ${String(cluster.occurrences)} ${String(cluster.sessions)}`)
    .join("\n");
  const budget: ContextBudget = {
    chars: rendered.length,
    token_estimate: estimateTokens(rendered),
    items_shown: shown.length,
    items_total: clusters.length,
    truncated: truncated || clusters.length > shown.length,
  };

  return {
    files_examined: listing.files.length,
    listing_truncated: listing.truncated,
    messages_examined: messages,
    corrections_found: corrections,
    clusters: shown,
    budget,
    truncated: budget.truncated,
    redacted,
    min_occurrences: minOccurrences,
    min_sessions: minSessions,
  };
}
