import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import { findVaultConfigPath } from "../core/config.js";
import { normalize } from "../core/text.js";
import { MAX_RAW_MARKERS, type CandidateSignal } from "./types.js";

/**
 * The capture pre-filter: deterministic, configurable, and deliberately dumb.
 *
 * One design rule governs this whole module, and everything downstream depends
 * on it holding:
 *
 *   A pre-filter authorises a spend. It never decides content.
 *
 * It answers "something may be happening in this message" and nothing else. It
 * never summarises, never rewrites, never picks what is worth keeping. What
 * gets staged is the user's own sentence, verbatim; what a human later reads in
 * the review is that sentence, not a marker's opinion of it. A pre-filter that
 * started choosing content would be a classifier with none of a classifier's
 * accountability.
 *
 * The lists are data, not code. The reference implementation shipped thirty
 * hand-tuned phrases of spoken French, calibrated on one person over a year,
 * with thresholds measured on that one person's corpus. Translating them would
 * have produced a filter that never fires. What ports is the mechanism:
 * accent-insensitive normalization, phrase matching on word boundaries, a
 * negation window before a match, a metalinguistic filter after it, and a
 * length ceiling on what can count as a terse correction.
 *
 * The English pack below is generic and it is honest about that. It will miss
 * how you actually speak. Writing your own pack, in your own language, is the
 * first place where personalisation stops being a slogan.
 *
 * One heuristic from the reference is deliberately absent: detecting that a
 * session is ending from the tone of a sentence. It was calibrated on one
 * person's way of closing a day, and a false positive on a stranger is a tool
 * announcing the end of a session that has barely started. The reminder that
 * replaced it counts what is actually staged and says nothing when there is
 * nothing.
 */

export interface MarkerPack {
  id: string;
  explicit_request: string[];
  correction: string[];
  correction_lead: string[];
  praise: string[];
  praise_negations: string[];
  praise_meta_words: string[];
}

export interface MarkerLimits {
  /** Above this, a message is an essay, not a terse correction. */
  max_correction_chars: number;
  /** How far before a praise phrase a negation still cancels it. */
  negation_window_chars: number;
  /** How far after a praise phrase a metalinguistic word still cancels it. */
  meta_window_chars: number;
  /** Never more than this many markers on one candidate. */
  max_markers_per_message: number;
}

export interface MarkerConfig {
  packs: MarkerPack[];
  limits: MarkerLimits;
}

export interface CaptureLimits {
  /** Human messages examined by one pre-compaction or offline scan. */
  max_messages_per_scan: number;
  /** Candidates one scan may file at once. */
  max_candidates_per_scan: number;
  /** Bytes read from the end of a transcript. */
  transcript_max_bytes: number;
  /** Lines parsed from that window. */
  transcript_max_lines: number;
}

export interface CaptureSettings {
  markers: MarkerConfig;
  limits: CaptureLimits;
  /** Where the values came from, so `capture markers` can say so. */
  source: "vault-config" | "defaults";
  /** Packs named in the config that do not exist, reported and ignored. */
  unknown_packs: string[];
}

/**
 * A generic English pack. It fires on a handful of unambiguous formulations and
 * nothing else, which is the correct trade for a default that has never heard
 * the person using it: a filter that stays quiet costs a missed candidate, a
 * filter that fires everywhere costs the user's trust in the review queue.
 */
export const ENGLISH_MARKER_PACK: MarkerPack = {
  id: "en",
  explicit_request: [
    "remember this",
    "remember that",
    "keep this in mind",
    "make a note of this",
    "write this down",
    "save this preference",
    "store this preference",
    "add this to my preferences",
    "make this a rule",
    "from now on",
    "going forward",
    "for future reference",
    "every time from now",
    "memorize this",
  ],
  correction: [
    "that is not what I asked",
    "that's not what I asked",
    "I did not ask for",
    "I didn't ask for",
    "you misunderstood",
    "you got it wrong",
    "that is wrong",
    "that's wrong",
    "that is incorrect",
    "that's incorrect",
    "not like that",
    "I told you",
    "I already said",
    "stop doing that",
    "do not do that",
    "don't do that",
    "you keep doing",
    "still wrong",
    "no I meant",
  ],
  correction_lead: [
    "no",
    "nope",
    "wrong",
    "incorrect",
    "again",
  ],
  praise: [
    "that is perfect",
    "that's perfect",
    "exactly what I wanted",
    "that is exactly right",
    "that's exactly right",
    "exactly right",
    "well done",
    "nailed it",
    "much better",
    "that is the right approach",
    "that's the right approach",
  ],
  praise_negations: [
    "not",
    "isn t",
    "is not",
    "wasn t",
    "was not",
    "never",
    "hardly",
    "barely",
    "far from",
  ],
  praise_meta_words: [
    "would be",
    "could be",
    "should be",
    "if it",
    "when it",
    "for example",
    "imagine",
    "hypothetically",
  ],
};

export const BUILT_IN_PACKS: Readonly<Record<string, MarkerPack>> = {
  en: ENGLISH_MARKER_PACK,
};

export const DEFAULT_MARKER_LIMITS: MarkerLimits = {
  max_correction_chars: 1_200,
  negation_window_chars: 12,
  meta_window_chars: 24,
  max_markers_per_message: 8,
};

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  max_messages_per_scan: 40,
  max_candidates_per_scan: 10,
  transcript_max_bytes: 512_000,
  transcript_max_lines: 4_000,
};

export function defaultMarkerConfig(): MarkerConfig {
  return {
    packs: [ENGLISH_MARKER_PACK],
    limits: { ...DEFAULT_MARKER_LIMITS },
  };
}

export function defaultCaptureSettings(): CaptureSettings {
  return {
    markers: defaultMarkerConfig(),
    limits: { ...DEFAULT_CAPTURE_LIMITS },
    source: "defaults",
    unknown_packs: [],
  };
}

/**
 * Accent-free, case-free, punctuation-free, with one space between every word
 * and one space at each end. Padding both ends is what turns a plain substring
 * search into a word-boundary search without a regular expression per phrase.
 */
export function normalizeForMatch(text: string): string {
  const stripped = normalize(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return stripped.length === 0 ? "" : ` ${stripped} `;
}

function normalizePhrase(phrase: string): string {
  return normalizeForMatch(phrase).trim();
}

interface CompiledPack {
  id: string;
  explicit_request: string[];
  correction: string[];
  correction_lead: string[];
  praise: string[];
  praise_negations: string[];
  praise_meta_words: string[];
}

function compilePack(pack: MarkerPack): CompiledPack {
  return {
    id: pack.id,
    explicit_request: pack.explicit_request.map(normalizePhrase).filter((item) => item.length > 0),
    correction: pack.correction.map(normalizePhrase).filter((item) => item.length > 0),
    correction_lead: pack.correction_lead.map(normalizePhrase).filter((item) => item.length > 0),
    praise: pack.praise.map(normalizePhrase).filter((item) => item.length > 0),
    praise_negations: pack.praise_negations.map(normalizePhrase).filter((item) => item.length > 0),
    praise_meta_words: pack.praise_meta_words.map(normalizePhrase).filter((item) => item.length > 0),
  };
}

function findPhrase(haystack: string, phrase: string): number {
  return haystack.indexOf(` ${phrase} `);
}

export interface Detection {
  signal: CandidateSignal | undefined;
  markers: string[];
}

export interface DetectionInput {
  text: string;
  /** Whether the assistant said something before this message in the session. */
  hasAssistantContext: boolean;
}

function negated(
  haystack: string,
  at: number,
  negations: readonly string[],
  window: number,
): boolean {
  const from = Math.max(0, at - window);
  const before = haystack.slice(from, at + 1);
  return negations.some((negation) => before.includes(` ${negation} `));
}

function metalinguistic(
  haystack: string,
  at: number,
  phrase: string,
  metaWords: readonly string[],
  window: number,
): boolean {
  const start = Math.max(0, at - window);
  const end = Math.min(haystack.length, at + phrase.length + 2 + window);
  const around = haystack.slice(start, end);
  return metaWords.some((word) => around.includes(` ${word} `));
}

/**
 * The whole pre-filter. Returns the signal a message may carry and the literal
 * phrases that fired, and nothing else: no summary, no target, no opinion about
 * what the sentence means.
 *
 * The order is not negotiable. An explicit instruction outranks everything,
 * because the user said so out loud. A correction outranks praise, because a
 * message that both corrects and compliments is a correction. Praise splits on
 * whether the assistant had actually produced anything to praise: without that
 * context it is `praise_weak`, which the store can never approve.
 */
export function detectSignal(input: DetectionInput, config: MarkerConfig): Detection {
  const haystack = normalizeForMatch(input.text);
  if (haystack.length === 0) {
    return { signal: undefined, markers: [] };
  }
  const packs = config.packs.map((pack) => compilePack(pack));
  const limits = config.limits;
  const cap = Math.max(1, Math.min(limits.max_markers_per_message, MAX_RAW_MARKERS));
  const markers: string[] = [];

  const collect = (phrase: string): void => {
    if (markers.length < cap && !markers.includes(phrase)) {
      markers.push(phrase);
    }
  };

  for (const pack of packs) {
    for (const phrase of pack.explicit_request) {
      if (findPhrase(haystack, phrase) !== -1) {
        collect(phrase);
      }
    }
  }
  if (markers.length > 0) {
    return { signal: "explicit_request", markers };
  }

  if (haystack.length <= limits.max_correction_chars) {
    for (const pack of packs) {
      for (const phrase of pack.correction) {
        if (findPhrase(haystack, phrase) !== -1) {
          collect(phrase);
        }
      }
      for (const lead of pack.correction_lead) {
        if (haystack.startsWith(` ${lead} `)) {
          collect(lead);
        }
      }
    }
    if (markers.length > 0) {
      return { signal: "correction", markers };
    }
  }

  for (const pack of packs) {
    for (const phrase of pack.praise) {
      const at = findPhrase(haystack, phrase);
      if (at === -1) {
        continue;
      }
      if (negated(haystack, at, pack.praise_negations, limits.negation_window_chars)) {
        continue;
      }
      if (
        metalinguistic(haystack, at, phrase, pack.praise_meta_words, limits.meta_window_chars)
      ) {
        continue;
      }
      collect(phrase);
    }
  }
  if (markers.length > 0) {
    return { signal: input.hasAssistantContext ? "praise" : "praise_weak", markers };
  }

  return { signal: undefined, markers: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readPack(value: unknown, index: number): MarkerPack | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" && value.id.trim().length > 0
    ? value.id.trim()
    : `custom-${String(index + 1)}`;
  const pack: MarkerPack = {
    id,
    explicit_request: stringList(value.explicit_request, []),
    correction: stringList(value.correction, []),
    correction_lead: stringList(value.correction_lead, []),
    praise: stringList(value.praise, []),
    praise_negations: stringList(value.praise_negations, []),
    praise_meta_words: stringList(value.praise_meta_words, []),
  };
  const total = pack.explicit_request.length + pack.correction.length
    + pack.correction_lead.length + pack.praise.length;
  return total === 0 ? undefined : pack;
}

/**
 * Reads the capture section of the vault config directly, tolerantly, and
 * without touching the typed loader. The typed configuration does not carry
 * these keys yet; when it does, this reader keeps working unchanged and the
 * pure functions above can simply be handed a MarkerConfig instead.
 *
 * Every value is optional and every malformed value falls back to the default,
 * because a typo in a marker list must degrade the filter, never break a hook.
 */
export async function loadCaptureSettings(vaultRoot: string): Promise<CaptureSettings> {
  const configPath = await findVaultConfigPath(vaultRoot);
  if (configPath === undefined) {
    return defaultCaptureSettings();
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(configPath, "utf8")) as unknown;
  } catch {
    return defaultCaptureSettings();
  }
  if (!isRecord(parsed) || !isRecord(parsed.capture)) {
    return defaultCaptureSettings();
  }

  const capture = parsed.capture;
  const markerSection = isRecord(capture.markers) ? capture.markers : {};
  const limitSection = isRecord(capture.limits) ? capture.limits : {};
  const markerLimits = isRecord(markerSection.limits) ? markerSection.limits : {};

  const requested = stringList(markerSection.packs, ["en"]);
  const packs: MarkerPack[] = [];
  const unknown: string[] = [];
  for (const id of requested) {
    const pack = BUILT_IN_PACKS[id];
    if (pack === undefined) {
      unknown.push(id);
      continue;
    }
    packs.push(pack);
  }
  if (Array.isArray(markerSection.custom)) {
    markerSection.custom.forEach((entry, index) => {
      const pack = readPack(entry, index);
      if (pack !== undefined) {
        packs.push(pack);
      }
    });
  }

  return {
    markers: {
      packs: packs.length === 0 ? [ENGLISH_MARKER_PACK] : packs,
      limits: {
        max_correction_chars: positiveInteger(
          markerLimits.max_correction_chars,
          DEFAULT_MARKER_LIMITS.max_correction_chars,
        ),
        negation_window_chars: positiveInteger(
          markerLimits.negation_window_chars,
          DEFAULT_MARKER_LIMITS.negation_window_chars,
        ),
        meta_window_chars: positiveInteger(
          markerLimits.meta_window_chars,
          DEFAULT_MARKER_LIMITS.meta_window_chars,
        ),
        max_markers_per_message: positiveInteger(
          markerLimits.max_markers_per_message,
          DEFAULT_MARKER_LIMITS.max_markers_per_message,
        ),
      },
    },
    limits: {
      max_messages_per_scan: positiveInteger(
        limitSection.max_messages_per_scan,
        DEFAULT_CAPTURE_LIMITS.max_messages_per_scan,
      ),
      max_candidates_per_scan: positiveInteger(
        limitSection.max_candidates_per_scan,
        DEFAULT_CAPTURE_LIMITS.max_candidates_per_scan,
      ),
      transcript_max_bytes: positiveInteger(
        limitSection.transcript_max_bytes,
        DEFAULT_CAPTURE_LIMITS.transcript_max_bytes,
      ),
      transcript_max_lines: positiveInteger(
        limitSection.transcript_max_lines,
        DEFAULT_CAPTURE_LIMITS.transcript_max_lines,
      ),
    },
    source: "vault-config",
    unknown_packs: unknown,
  };
}

/** The honesty notice `capture markers` prints under the active lists. */
export const MARKER_PACK_NOTICE =
  "The default pack is generic English. It was not calibrated on how you speak, so it will miss most of what you would have wanted staged. Add your own phrases, in your own language, under capture.markers.custom in the vault config. A pre-filter only decides whether to look at a message; it never decides what the message means.";
