import { capItems, emptyBudget, estimateTokens, type ContextBudget } from "../core/budget.js";
import { requireCapability } from "../core/capabilities.js";
import { tokenize } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import { buildDecision, writeEntryTolerant } from "./journal.js";
import { isLearningDisabled } from "./population.js";
import {
  DEFAULT_LEARNING_TUNING,
  readLearningTuning,
  type InjectionTuning,
} from "./sensors/index.js";
import {
  alreadyConsumed,
  applyBeliefApplications,
  readBeliefDocument,
  type ApplyResult,
  type BeliefApplication,
} from "./store.js";
import {
  CONFIDENCE_CEILING,
  CONFIDENCE_ENGRAVED,
  CONFIDENCE_FLOOR,
  CONFIDENCE_RETRACTED,
  DELTA_APPLICATION_CONFIRMED,
  DELTA_APPLICATION_CORRECTED,
  DELTA_DORMANCY,
  DORMANCY_DAYS,
  UNLOCKED_CONFIDENCE_CAP,
  formatTs,
  inferredSurvivalReached,
  nowTs,
  parseTs,
  rankForConfidence,
  type ApplicationCause,
  type Belief,
  type Verdict,
  type VerdictOutcome,
  type VerdictRule,
} from "./types.js";

/**
 * The organ that replaces a human gate. It computes where a confidence lands and
 * which beliefs earn a place in the injected block. It never writes: the store
 * records, this decides what number the store is going to record.
 *
 * The two rules that can move a belief both require it to have been APPLIED,
 * therefore injected. That is why a belief is born active rather than in the
 * shadow: a belief born in the shadow would never be injected, therefore never
 * evaluated, therefore never promoted. It would be a terminal state dressed up
 * as a starting one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The closed and exhaustive table of what a verdict does to a belief. Any pair
 * missing from it moves nothing at all, which is what keeps a new rule from
 * silently gaining the power to change a confidence.
 */
export const MOVEMENT_BY_VERDICT: ReadonlyArray<
  { rule: VerdictRule; verdict: VerdictOutcome; cause: ApplicationCause }
> = [
  { rule: "belief_confirmed", verdict: "good", cause: "application_confirmed" },
  { rule: "belief_corrected", verdict: "bad", cause: "application_corrected" },
];

export const MOVING_RULES: readonly VerdictRule[] = MOVEMENT_BY_VERDICT.map((entry) => entry.rule);

export type IgnoredReason =
  | "disarmed"
  | "rule_out_of_scope"
  | "verdict_no_effect"
  | "evidence_without_belief"
  | "unknown_belief"
  | "already_consumed";

export interface IgnoredVerdict {
  decision_id: string;
  rule: VerdictRule;
  reason: IgnoredReason;
  belief_id?: string;
}

/**
 * A belief never becomes a law on its own. While `locked` is false the ceiling
 * is the top of the active rank, whatever the origin, so automatic growth cannot
 * cross into law and only a human hand opens that door. The cheapest path to a
 * universal law used to be a declared belief seeded at three and a few sessions
 * without a correction, which is exactly what the injected header promises not
 * to do.
 */
export function confidenceCap(belief: Belief, now: string = nowTs()): number {
  if (!belief.locked) {
    return UNLOCKED_CONFIDENCE_CAP;
  }
  if (belief.origin === "declared") {
    return CONFIDENCE_CEILING;
  }
  return inferredSurvivalReached(belief, now) ? CONFIDENCE_CEILING : UNLOCKED_CONFIDENCE_CAP;
}

export interface MoveOutcome {
  belief_id: string;
  cause: ApplicationCause;
  from: number;
  to: number;
  cap: number;
  locked: boolean;
  /** False when the cause has no effect at all on this belief. */
  moves: boolean;
}

interface CounterProjection {
  opportunities: number;
  applications: number;
  corrections: number;
  locked: boolean;
}

function project(belief: Belief, cause: ApplicationCause): CounterProjection {
  switch (cause) {
    case "application_confirmed":
      return {
        opportunities: belief.opportunities + 1,
        applications: belief.applications + 1,
        corrections: belief.corrections,
        locked: belief.locked,
      };
    case "application_corrected":
      return {
        opportunities: belief.opportunities + 1,
        applications: belief.applications + 1,
        corrections: belief.corrections + 1,
        locked: belief.locked,
      };
    case "human_engrave":
    case "human_retract":
      return {
        opportunities: belief.opportunities,
        applications: belief.applications,
        corrections: belief.corrections,
        locked: true,
      };
    case "dormancy":
      return {
        opportunities: belief.opportunities,
        applications: belief.applications,
        corrections: belief.corrections,
        locked: belief.locked,
      };
  }
}

function rawArrival(belief: Belief, cause: ApplicationCause): number {
  switch (cause) {
    case "human_engrave":
      return CONFIDENCE_ENGRAVED;
    case "human_retract":
      return CONFIDENCE_RETRACTED;
    case "application_confirmed":
      return belief.locked ? belief.confidence : belief.confidence + DELTA_APPLICATION_CONFIRMED;
    case "application_corrected":
      return belief.locked ? belief.confidence : belief.confidence + DELTA_APPLICATION_CORRECTED;
    case "dormancy":
      return belief.locked || belief.rank === "retired"
        ? belief.confidence
        : belief.confidence + DELTA_DORMANCY;
  }
}

/**
 * Where one cause lands one belief. The ceiling is applied without exception,
 * including to a state that already lives above it: its first automatic move
 * brings it back down to the ceiling. Protecting such a state instead produced
 * an immediate counter example, an inferred belief engraved at eight taking a
 * correction, whose survival threshold then failed and whose own contract
 * refused to read it back.
 */
export function computeMove(
  belief: Belief,
  cause: ApplicationCause,
  now: string = nowTs(),
): MoveOutcome {
  const projected = project(belief, cause);
  const cap = confidenceCap({ ...belief, ...projected }, now);
  const raw = rawArrival(belief, cause);
  const to = Math.max(Math.min(raw, cap), CONFIDENCE_FLOOR);
  const counterMoves = projected.opportunities !== belief.opportunities
    || projected.locked !== belief.locked;
  return {
    belief_id: belief.id,
    cause,
    from: belief.confidence,
    to,
    cap,
    locked: projected.locked,
    moves: to !== belief.confidence || counterMoves,
  };
}

/**
 * The join of the whole learning loop. Only evidence.beliefs is read, and it is
 * never guessed from the journal: a verdict that does not carry the beliefs it
 * judged moves nothing.
 */
export function beliefsFromVerdict(verdict: Verdict): string[] {
  const beliefs = verdict.evidence.beliefs;
  if (!Array.isArray(beliefs)) {
    return [];
  }
  return beliefs.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0);
}

function causeFor(verdict: Verdict): ApplicationCause | undefined {
  return MOVEMENT_BY_VERDICT.find(
    (entry) => entry.rule === verdict.rule && entry.verdict === verdict.verdict,
  )?.cause;
}

export interface MovesFromVerdicts {
  applications: BeliefApplication[];
  ignored: IgnoredVerdict[];
}

/**
 * Turns verdicts into applications the store can record. The order of the checks
 * is part of the contract: `armed` is tested FIRST, so no path can reach a
 * confidence move from underneath a disarmed rule.
 *
 * The weight of a verdict is a priority for the evaluator; it never multiplies a
 * delta. The deltas are plus one and minus two, and nothing modulates them.
 */
export function movesFromVerdicts(
  beliefs: readonly Belief[],
  verdicts: readonly Verdict[],
  now: string = nowTs(),
): MovesFromVerdicts {
  const known = new Map(beliefs.map((belief) => [belief.id, belief]));
  const applications: BeliefApplication[] = [];
  const ignored: IgnoredVerdict[] = [];
  const batch = new Set<string>();

  for (const verdict of verdicts) {
    if (verdict.armed !== true) {
      ignored.push({ decision_id: verdict.decision_id, rule: verdict.rule, reason: "disarmed" });
      continue;
    }
    const cause = causeFor(verdict);
    if (cause === undefined) {
      ignored.push({
        decision_id: verdict.decision_id,
        rule: verdict.rule,
        reason: MOVING_RULES.includes(verdict.rule) ? "verdict_no_effect" : "rule_out_of_scope",
      });
      continue;
    }
    if (verdict.decision_id.trim().length === 0) {
      ignored.push({
        decision_id: verdict.decision_id,
        rule: verdict.rule,
        reason: "rule_out_of_scope",
      });
      continue;
    }
    const targets = beliefsFromVerdict(verdict);
    if (targets.length === 0) {
      ignored.push({
        decision_id: verdict.decision_id,
        rule: verdict.rule,
        reason: "evidence_without_belief",
      });
      continue;
    }
    for (const id of targets) {
      const belief = known.get(id);
      if (!belief) {
        ignored.push({
          decision_id: verdict.decision_id,
          rule: verdict.rule,
          reason: "unknown_belief",
          belief_id: id,
        });
        continue;
      }
      const key = `${id}|${verdict.decision_id}|${cause}`;
      if (batch.has(key) || alreadyConsumed(belief, verdict.decision_id, cause)) {
        ignored.push({
          decision_id: verdict.decision_id,
          rule: verdict.rule,
          reason: "already_consumed",
          belief_id: id,
        });
        continue;
      }
      batch.add(key);
      const move = computeMove(belief, cause, now);
      applications.push({
        belief_id: id,
        cause,
        ref: verdict.decision_id,
        confidence: move.to,
        at: verdict.evaluated_at,
      });
    }
  }
  return { applications, ignored };
}

/**
 * The windows a belief slept through. The start of the count is
 * max(seen_at, moved_at) and not seen_at alone: without that second bound the
 * same window would be billed again on every pass, and the idempotency mark is
 * worth nothing here because the ref of a dormancy repeats from one window to
 * the next. Consulting it would freeze dormancy after the first window.
 *
 * The series also stops as soon as it has no more work to do: a belief forgotten
 * for three years does not owe thirty six pointless moves.
 */
export function dormancyMoves(
  beliefs: readonly Belief[],
  now: string = nowTs(),
): BeliefApplication[] {
  const applications: BeliefApplication[] = [];
  const nowMs = parseTs(now).getTime();
  const windowMs = DORMANCY_DAYS * DAY_MS;

  for (const belief of beliefs) {
    if (belief.locked || belief.rank === "retired") {
      continue;
    }
    const seenMs = parseTs(belief.seen_at).getTime();
    const movedMs = parseTs(belief.moved_at).getTime();
    const startMs = Math.max(seenMs, movedMs);
    const elapsed = nowMs - startMs;
    if (elapsed < windowMs) {
      continue;
    }
    const windows = Math.floor(elapsed / windowMs);
    const useful = belief.confidence >= 0 ? Math.floor(belief.confidence / 0.5) + 1 : 0;
    let running: Belief = belief;
    for (let index = 0; index < Math.min(windows, useful); index += 1) {
      const at = formatTs(new Date(startMs + windowMs * (index + 1)));
      const move = computeMove(running, "dormancy", now);
      if (move.to === running.confidence) {
        break;
      }
      applications.push({
        belief_id: belief.id,
        cause: "dormancy",
        ref: `dormancy:${belief.seen_at}`,
        confidence: move.to,
        at,
      });
      running = { ...running, confidence: move.to, rank: rankForConfidence(move.to) };
    }
  }
  return applications;
}

export interface ConsumeReport {
  ran: boolean;
  reason?: string;
  applied: ApplyResult["applied"];
  skipped: ApplyResult["skipped"];
  ignored: IgnoredVerdict[];
  written: boolean;
}

const IDLE_REPORT: ConsumeReport = {
  ran: false,
  applied: [],
  skipped: [],
  ignored: [],
  written: false,
};

export interface ConsumeOptions {
  now?: string;
  operationId?: string;
}

/**
 * The stage that was missing until the loop closed: without it the layer
 * measures, writes, and never learns. It computes; the store records.
 */
export async function consumeVerdicts(
  config: VaultConfig,
  root: string,
  verdicts: readonly Verdict[],
  options: ConsumeOptions = {},
): Promise<ConsumeReport> {
  requireCapability(config, "learning.evaluate");
  if (await isLearningDisabled(config, root)) {
    return { ...IDLE_REPORT, reason: "disabled" };
  }
  const now = options.now ?? nowTs();
  const document = await readBeliefDocument(config, root);
  const { applications, ignored } = movesFromVerdicts(document.beliefs, verdicts, now);
  const applyOptions = options.operationId === undefined
    ? { now }
    : { now, operationId: options.operationId };
  const result = await applyBeliefApplications(config, root, applications, applyOptions);
  return {
    ran: true,
    applied: result.applied,
    skipped: result.skipped,
    ignored,
    written: result.written,
  };
}

/**
 * Dormancy runs AFTER the verdicts, never before: a confirmation refreshes
 * seen_at, so a belief confirmed during this very pass must not be billed as
 * dormant a second earlier.
 */
export async function consumeDormancy(
  config: VaultConfig,
  root: string,
  options: ConsumeOptions = {},
): Promise<ConsumeReport> {
  requireCapability(config, "learning.evaluate");
  if (await isLearningDisabled(config, root)) {
    return { ...IDLE_REPORT, reason: "disabled" };
  }
  const now = options.now ?? nowTs();
  const document = await readBeliefDocument(config, root);
  const applications = dormancyMoves(document.beliefs, now);
  const applyOptions = options.operationId === undefined
    ? { now }
    : { now, operationId: options.operationId };
  const result = await applyBeliefApplications(config, root, applications, applyOptions);
  return {
    ran: true,
    applied: result.applied,
    skipped: result.skipped,
    ignored: [],
    written: result.written,
  };
}

// ---------------------------------------------------------------------------
// Injection.
// ---------------------------------------------------------------------------

export interface Eviction {
  belief_id: string;
  /** The belief that took the place, so an eviction is never anonymous. */
  winner: string;
  rank: "law" | "active";
}

export interface Selection {
  applied: Belief[];
  evicted: Eviction[];
  candidates: Belief[];
}

function byConfidenceThenId(left: Belief, right: Belief): number {
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Two seats, and a budget of its own. A law takes the first, with no condition
 * on the domain, because a law holds everywhere and that is what tells it apart
 * from an active belief. An active belief takes the second only when its domain
 * is the one being routed.
 *
 * Declared preferences are neither read nor touched here. They are computed
 * elsewhere and they cannot be disputed by construction: without that separate
 * budget, a belief born at three would always lose to a weighted preference,
 * would never be applied, would never be evaluated, and the blockage of the
 * human gate would reappear one floor down.
 */
export function selectForInjection(
  beliefs: readonly Belief[],
  routeTokens: readonly string[],
  tuning: InjectionTuning = DEFAULT_LEARNING_TUNING.injection,
): Selection {
  const tokens = new Set(routeTokens);
  const laws = beliefs.filter((belief) => belief.rank === "law").sort(byConfidenceThenId);
  const actives = beliefs
    .filter((belief) => {
      if (belief.rank !== "active") {
        return false;
      }
      const domain = tokenize(belief.domain);
      return domain.length > 0 && domain.every((token) => tokens.has(token));
    })
    .sort(byConfidenceThenId);

  const appliedLaws = laws.slice(0, tuning.max_law);
  const appliedActives = actives.slice(0, tuning.max_active);
  const evicted: Eviction[] = [];
  const winnerLaw = appliedLaws[0]?.id;
  const winnerActive = appliedActives[0]?.id;
  for (const belief of laws.slice(tuning.max_law)) {
    if (winnerLaw !== undefined) {
      evicted.push({ belief_id: belief.id, winner: winnerLaw, rank: "law" });
    }
  }
  for (const belief of actives.slice(tuning.max_active)) {
    if (winnerActive !== undefined) {
      evicted.push({ belief_id: belief.id, winner: winnerActive, rank: "active" });
    }
  }

  return {
    applied: [...appliedLaws, ...appliedActives],
    evicted,
    candidates: [...laws, ...actives],
  };
}

export function clipStatement(statement: string, max: number): string {
  const compact = statement.replace(/\s+/gu, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= max) {
    return compact;
  }
  const head = characters.slice(0, max).join("");
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[,.;:-]+$/u, "")}...`;
}

export function beliefLine(
  belief: Belief,
  clip: number = DEFAULT_LEARNING_TUNING.injection.statement_clip,
): string {
  return `- ${belief.id} (${belief.rank}, c=${String(belief.confidence)}): ${clipStatement(belief.statement, clip)}`;
}

export function measureDrift(text: string): number {
  return estimateTokens(text);
}

export interface Injection {
  text: string;
  /** Only the beliefs whose line survived intact into the rendered block. */
  applied: Belief[];
  /** Lines the cap dropped. Never counted as evictions. */
  cut: Belief[];
  evicted: Eviction[];
  budget: ContextBudget;
  drift_tokens: number;
  drift_alert: boolean;
}

/**
 * Renders the injected block under its cap and reports what it cost.
 *
 * A line the cap dropped is a belief the model NEVER saw. It is reported as cut,
 * it is not journaled as applied, and above all it is not filed as evicted:
 * evictions feed the correction rule, so filing a budget cut there would turn a
 * lack of room into a bad verdict against a belief that did nothing wrong.
 */
export function renderInjection(
  beliefs: readonly Belief[],
  routeTokens: readonly string[],
  tuning: InjectionTuning = DEFAULT_LEARNING_TUNING.injection,
): Injection {
  const selection = selectForInjection(beliefs, routeTokens, tuning);
  if (selection.applied.length === 0) {
    return {
      text: "",
      applied: [],
      cut: [],
      evicted: selection.evicted,
      budget: emptyBudget(),
      drift_tokens: 0,
      drift_alert: false,
    };
  }
  const capped = capItems(
    selection.applied,
    (belief) => beliefLine(belief, tuning.statement_clip),
    tuning.max_chars,
  );
  const shown = capped.budget.items_shown;
  const drift = measureDrift(capped.text);
  return {
    text: capped.text,
    applied: selection.applied.slice(0, shown),
    cut: selection.applied.slice(shown),
    evicted: selection.evicted,
    budget: capped.budget,
    drift_tokens: drift,
    drift_alert: drift > tuning.drift_alert_tokens,
  };
}

export interface InjectionLogOptions {
  session: string;
  ts?: string;
  routeQuery?: string;
}

/**
 * Builds the journal entry of an injection, and only when there is something to
 * learn from it. A route that applied nothing and evicted nothing teaches
 * nothing, so it adds no line.
 */
export function buildInjectionDecision(
  injection: Injection,
  options: InjectionLogOptions,
): ReturnType<typeof buildDecision> | undefined {
  if (
    injection.applied.length === 0
    && injection.evicted.length === 0
    && !injection.drift_alert
  ) {
    return undefined;
  }
  const decisionInput: { text: string; summary: string } = {
    text: options.routeQuery ?? injection.text,
    summary: `injected ${String(injection.applied.length)} belief(s), evicted ${String(injection.evicted.length)}`,
  };
  return buildDecision({
    session: options.session,
    type: "belief_applied",
    input: decisionInput,
    beliefs_applied: injection.applied.map((belief) => belief.id),
    beliefs_evicted: injection.evicted.map((eviction) => eviction.belief_id),
    cost: { tokens_estimated: injection.drift_tokens },
    ...(options.ts === undefined ? {} : { ts: options.ts }),
  });
}

export async function logInjection(
  config: VaultConfig,
  root: string,
  injection: Injection,
  options: InjectionLogOptions,
): Promise<boolean> {
  const entry = buildInjectionDecision(injection, options);
  if (!entry) {
    return false;
  }
  return (await writeEntryTolerant(config, root, entry, "learning.confidence")) !== undefined;
}

export interface InjectionOptions {
  tuning?: InjectionTuning;
}

/**
 * The disk facing form: reads the belief population and renders the block. It
 * concludes which belief is worth a seat, so it lives behind learning.evaluate
 * and touches nothing while that capability is disarmed.
 */
export async function injectionFor(
  config: VaultConfig,
  root: string,
  routeTokens: readonly string[],
  options: InjectionOptions = {},
): Promise<Injection> {
  requireCapability(config, "learning.evaluate");
  const tuning = options.tuning ?? (await readLearningTuning(root)).injection;
  const document = await readBeliefDocument(config, root);
  return renderInjection(document.beliefs, routeTokens, tuning);
}
