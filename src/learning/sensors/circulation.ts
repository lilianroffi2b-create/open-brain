import { readJournal, type JournalReadOptions } from "../journal.js";
import type { VaultConfig } from "../../core/types.js";
import { nowTs, type Observation } from "../types.js";

/**
 * The circulation sensor: how often each document of the population is actually
 * read, per month, from two independent sources.
 *
 * A sensor measures facts and concludes nothing. Everything here is a count, a
 * date and a source; there is no judgement about whether a number is good, and
 * nothing in this file can move a belief.
 *
 * What it measures is a FLOOR, never a total. A read performed outside the
 * sources below, a shell command, another tool, another assistant, leaves no
 * trace any of this can see. Every consumer of these numbers has to treat them
 * as a lower bound, which is why the report says so in as many words.
 */

export const CIRCULATION_SENSOR = "circulation";

/** The measures this sensor produces, and the only ones. */
export const CIRCULATION_MEASURES = ["reads", "reads_transcript", "reads_graft"] as const;

export interface DocumentRead {
  document: string;
  ts: string;
  session: string;
}

export interface TranscriptScan {
  events: DocumentRead[];
  /** Opaque per source cursors, to hand back on the next pass. */
  cursors: Record<string, number>;
  /**
   * True when the source had to start over, because a file shrank or a cursor
   * was misaligned. A pass that re-read everything REPLACES the previous total
   * instead of adding to it, which is what stops six reads from becoming twelve.
   */
  from_zero: boolean;
  /** Sources that could not be read, named rather than swallowed. */
  failures: string[];
}

/**
 * The seam between this sensor and whatever writes session transcripts. No
 * adapter ships in this lot: transcripts live outside the vault, so reading them
 * is gated on its own capability and belongs to the transcripts module.
 */
export interface TranscriptSource {
  scan: (cursors: Record<string, number>, readTools: readonly string[]) => Promise<TranscriptScan>;
}

export interface CirculationInput {
  /** Reads observed through the graft, taken from the decision journal. */
  graft: readonly DocumentRead[];
  /** Reads observed in session transcripts, empty when that capability is off. */
  transcript: readonly DocumentRead[];
  /** Subject to previous measure, so an incremental pass can carry totals over. */
  previous: ReadonlyMap<string, Observation>;
  /** True when the transcript side was re-read from the start. */
  transcriptFromZero: boolean;
  /** Documents a sensor is allowed to measure. Absent means no filtering. */
  population?: readonly string[] | undefined;
  now?: string;
}

export interface CirculationTally {
  subject: string;
  document: string;
  month: string;
  reads_transcript: number;
  reads_graft: number;
}

export function circulationSubject(document: string, ts: string): string {
  return `${document}@${ts.slice(0, 7)}`;
}

/**
 * Groups raw reads by document and month. The graft side is recomputed from the
 * journal on every pass, so it always replaces; the transcript side is a
 * cumulative counter, so it adds unless the source restarted from zero.
 */
export function aggregateReads(input: CirculationInput): CirculationTally[] {
  const allowed = input.population === undefined ? undefined : new Set(input.population);
  const tallies = new Map<string, CirculationTally>();

  const touch = (read: DocumentRead): CirculationTally | undefined => {
    if (allowed !== undefined && !allowed.has(read.document)) {
      return undefined;
    }
    const subject = circulationSubject(read.document, read.ts);
    const existing = tallies.get(subject);
    if (existing) {
      return existing;
    }
    const created: CirculationTally = {
      subject,
      document: read.document,
      month: read.ts.slice(0, 7),
      reads_transcript: 0,
      reads_graft: 0,
    };
    tallies.set(subject, created);
    return created;
  };

  for (const read of input.graft) {
    const tally = touch(read);
    if (tally) {
      tally.reads_graft += 1;
    }
  }
  for (const read of input.transcript) {
    const tally = touch(read);
    if (tally) {
      tally.reads_transcript += 1;
    }
  }

  // Carry the previous totals over. The graft component is authoritative and
  // recomputed, so only the transcript component accumulates.
  for (const [subject, previous] of input.previous) {
    const tally = tallies.get(subject);
    const carried = input.transcriptFromZero ? 0 : previous.measure.reads_transcript ?? 0;
    if (!tally) {
      if (carried === 0) {
        continue;
      }
      const parts = subject.split("@");
      const document = parts.slice(0, -1).join("@");
      const month = parts[parts.length - 1] ?? "";
      if (allowed !== undefined && !allowed.has(document)) {
        continue;
      }
      tallies.set(subject, {
        subject,
        document,
        month,
        reads_transcript: carried,
        reads_graft: 0,
      });
      continue;
    }
    tally.reads_transcript += carried;
  }

  return [...tallies.values()].sort((left, right) =>
    left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0);
}

export function roundShare(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export interface CirculationObservationDraft {
  subject: string;
  population: string;
  measure: Record<string, number>;
  derived: Record<string, number>;
  ts: string;
}

/**
 * Turns tallies into observation drafts. The measures are strictly numeric by
 * contract, so no wording, no verdict and no adjective can ever slip into a
 * sensor reading.
 */
export function buildCirculationDrafts(
  tallies: readonly CirculationTally[],
  now: string = nowTs(),
): CirculationObservationDraft[] {
  return tallies.map((tally) => {
    const reads = tally.reads_transcript + tally.reads_graft;
    return {
      subject: tally.subject,
      population: tally.document,
      ts: now,
      measure: {
        reads,
        reads_transcript: tally.reads_transcript,
        reads_graft: tally.reads_graft,
      },
      derived: {
        graft_share: reads === 0 ? 0 : roundShare(tally.reads_graft / reads),
      },
    };
  });
}

export interface GraftReadOptions {
  /** Inclusive lower bound, so a pass can look at the months it cares about. */
  since?: string;
  limit?: number;
  maxPartitions?: number;
}

/**
 * The reads Open Brain performed itself, taken from the route decisions of the
 * journal. Bounded like every other read of this layer: it takes a limit and a
 * number of monthly partitions, and it never dumps the journal.
 */
export async function graftReadsFromJournal(
  config: VaultConfig,
  root: string,
  options: GraftReadOptions = {},
): Promise<{ reads: DocumentRead[]; truncated: boolean; scanned: number }> {
  const readOptions: JournalReadOptions = {
    limit: options.limit ?? 2_000,
    maxPartitions: options.maxPartitions ?? 2,
    types: ["route"],
  };
  if (options.since !== undefined) {
    readOptions.since = options.since;
  }
  const journal = await readJournal(config, root, readOptions);
  const reads: DocumentRead[] = [];
  for (const entry of journal.entries) {
    if (entry.type === "consolidated") {
      continue;
    }
    for (const document of entry.documents) {
      reads.push({ document, ts: entry.ts, session: entry.session });
    }
  }
  return { reads, truncated: journal.budget.truncated, scanned: journal.entries.length };
}
