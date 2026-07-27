import { capItems, type ContextBudget } from "../core/budget.js";
import { requireCapability } from "../core/capabilities.js";
import { ExpectedError } from "../core/errors.js";
import type { VaultConfig } from "../core/types.js";
import { computeMove } from "./confidence.js";
import { foldHistory, readBeliefDocument, writeBeliefs } from "./store.js";
import {
  DEFAULT_HISTORY_POLICY,
  MOVE_CAUSES,
  TS_STEP_MS,
  formatTs,
  isTs,
  nowTs,
  parseTs,
  rankForConfidence,
  validateBelief,
  type ApplicationCause,
  type Belief,
  type BeliefHistoryEntry,
  type HistoryPolicy,
} from "./types.js";

/**
 * The way back. It is what makes the rest of this layer acceptable: a loop that
 * moves confidences on its own is only tolerable while its moves can be undone.
 *
 * It brings beliefs back to the state they were in on a given date WITHOUT ever
 * erasing a history entry. It does not rewind, it adds: a corrective move, with
 * a ref of the form `revert:<date>`, appended like any other. An audit trail
 * that can be rewritten is not an audit trail.
 *
 * It never consults the OFF sentinel, on purpose: a way back that refuses to
 * work once the layer is switched off is the opposite of the service expected
 * from it. It asks for the `learning` capability only, never for evaluate and
 * never for consolidate.
 */

export const REVERT_REF_PREFIX = "revert:";

/** The five causes are a closed set, and reverting does not add a sixth. */
export const REVERT_CAUSES: readonly ApplicationCause[] = ["human_engrave", "human_retract"];

export type RevertRefusalReason = "unexpressible_target" | "not_yet_born";

export interface BeliefStateAtDate {
  belief_id: string;
  existed: boolean;
  confidence: number;
  rank: string;
  /** History entries at or before the target date. */
  entries_considered: number;
}

export interface RevertEntry {
  belief_id: string;
  from: number;
  to: number;
  cause: ApplicationCause;
  ts: string;
}

export interface RevertRefusal {
  belief_id: string;
  target: number;
  reason: RevertRefusalReason;
  /** What the two available causes can express, so the refusal is actionable. */
  reachable: number[];
}

export interface RevertPlan {
  target_date: string;
  instant: string;
  operation_id: string;
  entries: RevertEntry[];
  refusals: RevertRefusal[];
  unchanged: string[];
  text: string;
  budget: ContextBudget;
}

export interface RevertResult {
  plan: RevertPlan;
  /** False when nothing had to be written, including on an identical replay. */
  written: boolean;
}

export class RevertError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "RevertError";
  }
}

/**
 * The confidence a belief carried on a date, read from its own history. A folded
 * summary is read like any other entry: it carries the confidence the window it
 * folded ended on, so folding never blinds the way back.
 */
export function stateAtDate(belief: Belief, date: string): BeliefStateAtDate {
  const considered = belief.history.filter((entry) => entry.ts <= date);
  const last = considered[considered.length - 1];
  if (!last) {
    return {
      belief_id: belief.id,
      existed: false,
      confidence: belief.confidence,
      rank: belief.rank,
      entries_considered: 0,
    };
  }
  return {
    belief_id: belief.id,
    existed: true,
    confidence: last.to,
    rank: rankForConfidence(last.to),
    entries_considered: considered.length,
  };
}

/**
 * The cause that lands exactly on the target, or nothing. The contract of causes
 * is closed at five moves and reverting adds no sixth one, so it can only offer
 * what a human engrave and a human retract express. A target neither of them
 * reaches is refused and named, never approximated.
 */
export function causeForTarget(
  belief: Belief,
  target: number,
  now: string,
): { cause: ApplicationCause; to: number } | undefined {
  for (const cause of REVERT_CAUSES) {
    const move = computeMove(belief, cause, now);
    if (move.to === target) {
      return { cause, to: move.to };
    }
  }
  return undefined;
}

function reachableTargets(belief: Belief, now: string): number[] {
  return REVERT_CAUSES.map((cause) => computeMove(belief, cause, now).to);
}

function instantFor(belief: Belief, now: string): string {
  const last = belief.history[belief.history.length - 1];
  const lastMs = last ? parseTs(last.ts).getTime() : Number.NEGATIVE_INFINITY;
  const nowMs = parseTs(now).getTime();
  return nowMs > lastMs ? now : formatTs(new Date(lastMs + TS_STEP_MS));
}

export interface RevertOptions {
  /** The date to come back to, as a timestamp of the layer. */
  date: string;
  /** Restrict the plan to these beliefs. Absent means all of them. */
  ids?: readonly string[];
  now?: string;
  maxChars?: number;
  historyPolicy?: HistoryPolicy;
}

function renderPlan(
  entries: readonly RevertEntry[],
  refusals: readonly RevertRefusal[],
  maxChars: number,
): { text: string; budget: ContextBudget } {
  const items = [
    ...entries.map((entry) =>
      `move ${entry.belief_id}: ${String(entry.from)} -> ${String(entry.to)} (${entry.cause})`),
    ...refusals.map((refusal) =>
      `refused ${refusal.belief_id}: ${refusal.reason}, target ${String(refusal.target)}`),
  ];
  const capped = capItems(items, (item) => item, maxChars);
  return { text: capped.text, budget: capped.budget };
}

function planFor(
  beliefs: readonly Belief[],
  options: RevertOptions,
  now: string,
): RevertPlan {
  if (!isTs(options.date)) {
    throw new RevertError(
      `"${options.date}" is not a timestamp of the form YYYY-MM-DDTHH:MM:SSZ, so there is no date to come back to.`,
    );
  }
  const wanted = options.ids === undefined ? undefined : new Set(options.ids);
  const entries: RevertEntry[] = [];
  const refusals: RevertRefusal[] = [];
  const unchanged: string[] = [];

  for (const belief of beliefs) {
    if (wanted !== undefined && !wanted.has(belief.id)) {
      continue;
    }
    const state = stateAtDate(belief, options.date);
    if (!state.existed) {
      // The belief did not exist on that date. Removing it is a subtractive act
      // and this organ is not one.
      refusals.push({
        belief_id: belief.id,
        target: state.confidence,
        reason: "not_yet_born",
        reachable: reachableTargets(belief, now),
      });
      continue;
    }
    if (state.confidence === belief.confidence) {
      unchanged.push(belief.id);
      continue;
    }
    const match = causeForTarget(belief, state.confidence, now);
    if (!match) {
      refusals.push({
        belief_id: belief.id,
        target: state.confidence,
        reason: "unexpressible_target",
        reachable: reachableTargets(belief, now),
      });
      continue;
    }
    entries.push({
      belief_id: belief.id,
      from: belief.confidence,
      to: match.to,
      cause: match.cause,
      ts: instantFor(belief, now),
    });
  }

  const rendered = renderPlan(entries, refusals, options.maxChars ?? 4_000);
  return {
    target_date: options.date,
    instant: now,
    operation_id: `${REVERT_REF_PREFIX}${now}`,
    entries,
    refusals,
    unchanged,
    text: rendered.text,
    budget: rendered.budget,
  };
}

/** A simulation, and the default. Nothing is written by planning a way back. */
export async function planRevert(
  config: VaultConfig,
  root: string,
  options: RevertOptions,
): Promise<RevertPlan> {
  requireCapability(config, "learning");
  const now = options.now ?? nowTs();
  const document = await readBeliefDocument(config, root);
  return planFor(document.beliefs, options, now);
}

function applyEntry(
  belief: Belief,
  entry: RevertEntry,
  date: string,
  policy: HistoryPolicy,
  now: string,
): Belief {
  const history: BeliefHistoryEntry[] = [
    ...belief.history,
    {
      ts: entry.ts,
      from: entry.from,
      to: entry.to,
      cause: entry.cause,
      ref: `${REVERT_REF_PREFIX}${date}`,
    },
  ];
  const next: Belief = {
    ...belief,
    confidence: entry.to,
    rank: rankForConfidence(entry.to),
    // A human cause locks the belief, and a lock is never lifted by anything.
    locked: true,
    seen_at: entry.ts,
    moved_at: entry.ts,
    history: foldHistory(history, policy),
  };
  return validateBelief(next, { now });
}

/**
 * Applies the plan. The operation id is derived from the instant, so replaying
 * the same revert is a non event: the store recognises it and leaves the file
 * byte for byte as it is.
 */
export async function revert(
  config: VaultConfig,
  root: string,
  options: RevertOptions & { write?: boolean },
): Promise<RevertResult> {
  requireCapability(config, "learning");
  const now = options.now ?? nowTs();
  const document = await readBeliefDocument(config, root);
  const plan = planFor(document.beliefs, options, now);
  if (options.write !== true || plan.entries.length === 0) {
    return { plan, written: false };
  }

  const policy = options.historyPolicy ?? DEFAULT_HISTORY_POLICY;
  const byId = new Map(plan.entries.map((entry) => [entry.belief_id, entry]));
  const beliefs = document.beliefs.map((belief) => {
    const entry = byId.get(belief.id);
    return entry ? applyEntry(belief, entry, options.date, policy, now) : belief;
  });

  const result = await writeBeliefs(config, root, beliefs, {
    operationId: plan.operation_id,
    now,
  });
  return { plan, written: result.written };
}

/** The causes a producer of this layer may write, exposed for a caller that renders them. */
export function knownCauses(): readonly string[] {
  return MOVE_CAUSES;
}
