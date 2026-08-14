import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  MOVEMENT_BY_VERDICT,
  beliefLine,
  beliefsFromVerdict,
  buildInjectionDecision,
  computeMove,
  confidenceCap,
  consumeDormancy,
  consumeVerdicts,
  dormancyMoves,
  injectionFor,
  movesFromVerdicts,
  renderInjection,
  selectForInjection,
} from "../src/learning/confidence.js";
import { buildVerdict } from "../src/learning/evaluator.js";
import { addBelief, beliefsPath, readBeliefDocument } from "../src/learning/store.js";
import {
  CONFIDENCE_CEILING,
  CONFIDENCE_CREATION,
  UNLOCKED_CONFIDENCE_CAP,
  formatTs,
  inferredSurvivalReached,
  parseTs,
  rankForConfidence,
  validateBelief,
  type ApplicationCause,
  type Belief,
  type BeliefOrigin,
  type Verdict,
} from "../src/learning/types.js";

interface Vault {
  root: string;
  config: VaultConfig;
}

async function armedVault(prefix: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "capabilities:\n  learning:\n    enabled: true\n    evaluate: true\n",
    "utf8",
  );
  return { root, config: await loadConfig(root) };
}

const BIRTH = "2026-01-01T09:00:00Z";
const MOVED = "2026-01-02T09:00:00Z";

interface BeliefShape {
  id?: string;
  statement?: string;
  domain?: string;
  origin?: BeliefOrigin;
  confidence?: number;
  locked?: boolean;
  applications?: number;
  corrections?: number;
  opportunities?: number;
  created_at?: string;
  seen_at?: string;
  moved_at?: string;
  validateAt?: string;
}

function makeBelief(shape: BeliefShape = {}): Belief {
  const confidence = shape.confidence ?? CONFIDENCE_CREATION;
  const created = shape.created_at ?? BIRTH;
  const moved = confidence === CONFIDENCE_CREATION ? created : shape.moved_at ?? MOVED;
  const origin = shape.origin ?? "declared";
  const applications = shape.applications ?? 0;
  const belief: Belief = {
    id: shape.id ?? "b_bounded_context",
    statement: shape.statement ?? "Load a bounded context and report its token cost.",
    domain: shape.domain ?? "agentic coding",
    origin,
    evidence: {
      occurrences: origin === "inferred" ? 3 : 1,
      refs: ["test:fixture"],
      quote: "Load a bounded context and report its token cost.",
    },
    rank: rankForConfidence(confidence),
    confidence,
    locked: shape.locked ?? false,
    opportunities: shape.opportunities ?? applications,
    applications,
    corrections: shape.corrections ?? 0,
    created_at: created,
    seen_at: shape.seen_at ?? created,
    moved_at: moved,
    history: confidence === CONFIDENCE_CREATION
      ? [{ ts: created, from: null, to: CONFIDENCE_CREATION, cause: "creation", ref: "test:fixture" }]
      : [
        { ts: created, from: null, to: CONFIDENCE_CREATION, cause: "creation", ref: "test:fixture" },
        {
          ts: moved,
          from: CONFIDENCE_CREATION,
          to: confidence,
          cause: confidence > CONFIDENCE_CREATION ? "application_confirmed" : "application_corrected",
          ref: "dec_20260102T0900_aaaaaaaa",
        },
      ],
  };
  return validateBelief(belief, { now: shape.validateAt ?? "2026-07-01T09:00:00Z" });
}

function verdictFor(
  rule: "belief_confirmed" | "belief_corrected",
  outcome: "good" | "bad",
  beliefs: string[],
  decisionId = "dec_20260702T1015_5f3ac1de",
  evaluatedAt = "2026-07-02T10:20:00Z",
): Verdict {
  return buildVerdict(
    decisionId,
    rule,
    { verdict: outcome, evidence: { beliefs, beliefs_applied: beliefs.length } },
    evaluatedAt,
  );
}

// ---------------------------------------------------------------------------
// The formulas.
// ---------------------------------------------------------------------------

test("the ceiling of an unlocked belief is the top of the active rank, whatever its origin", () => {
  const now = "2026-07-01T09:00:00Z";
  for (const origin of ["declared", "inferred"] as const) {
    assert.equal(confidenceCap(makeBelief({ origin, locked: false }), now), UNLOCKED_CONFIDENCE_CAP);
  }

  // A human hand is the only thing that opens the law rank.
  assert.equal(
    confidenceCap(makeBelief({ origin: "declared", locked: true }), now),
    CONFIDENCE_CEILING,
  );
  const young = makeBelief({ origin: "inferred", locked: true, applications: 2 });
  assert.equal(confidenceCap(young, now), UNLOCKED_CONFIDENCE_CAP);

  const survivor = makeBelief({
    origin: "inferred",
    locked: true,
    applications: 20,
    opportunities: 20,
    corrections: 0,
    created_at: "2026-01-01T09:00:00Z",
  });
  assert.equal(inferredSurvivalReached(survivor, now), true);
  assert.equal(confidenceCap(survivor, now), CONFIDENCE_CEILING);
});

test("the five moves are the only ones, and the lock resists growth as well as decay", () => {
  const now = "2026-07-01T09:00:00Z";
  const base = makeBelief({ confidence: 4 });
  assert.equal(computeMove(base, "application_confirmed", now).to, 5);
  assert.equal(computeMove(base, "application_corrected", now).to, 2);
  assert.equal(computeMove(base, "dormancy", now).to, 3.5);

  const locked = makeBelief({ confidence: 4, locked: true });
  assert.equal(computeMove(locked, "application_confirmed", now).to, 4);
  assert.equal(computeMove(locked, "application_corrected", now).to, 4);
  assert.equal(computeMove(locked, "dormancy", now).to, 4);
  // The counters keep living, because they are facts.
  assert.equal(computeMove(locked, "application_confirmed", now).moves, true);

  const retired = makeBelief({ confidence: -1 });
  assert.equal(computeMove(retired, "dormancy", now).to, -1);

  assert.equal(computeMove(base, "human_engrave", now).to, 8);
  assert.equal(computeMove(base, "human_retract", now).to, -1);
  // Engraving an inferred belief that has not survived stops at the ceiling.
  assert.equal(computeMove(makeBelief({ origin: "inferred" }), "human_engrave", now).to, 6.5);
});

test("a state living above its ceiling is brought back to it by its first automatic move", () => {
  const now = "2026-07-01T09:00:00Z";
  const inherited = makeBelief({ confidence: 8, locked: false });
  const move = computeMove(inherited, "application_confirmed", now);
  assert.equal(move.from, 8);
  assert.equal(move.to, UNLOCKED_CONFIDENCE_CAP);
  assert.equal(rankForConfidence(move.to), "active");
});

test("three corrections neutralize an unlocked belief that reached its ceiling", () => {
  const now = "2026-07-01T09:00:00Z";
  let belief = makeBelief({ confidence: UNLOCKED_CONFIDENCE_CAP });
  const path: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const move = computeMove(belief, "application_corrected", now);
    path.push(move.to);
    belief = {
      ...belief,
      confidence: move.to,
      rank: rankForConfidence(move.to),
      corrections: belief.corrections + 1,
      applications: belief.applications + 1,
      opportunities: belief.opportunities + 1,
    };
  }
  assert.deepEqual(path, [4.5, 2.5, 0.5]);
  assert.equal(rankForConfidence(0.5), "shadow");
});

// ---------------------------------------------------------------------------
// The property, over ten thousand random sequences.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const CAUSES: ApplicationCause[] = [
  "application_confirmed",
  "application_corrected",
  "dormancy",
  "human_engrave",
  "human_retract",
];
const DELTAS_MS = [1_000, 60_000, 3_600_000, 86_400_000, 864_000_000];

function simulate(belief: Belief, cause: ApplicationCause, at: string, now: string): Belief {
  const move = computeMove(belief, cause, now);
  const traced = move.to !== belief.confidence
    || cause === "application_confirmed"
    || cause === "application_corrected"
    || cause === "human_engrave"
    || cause === "human_retract";
  const counters = cause === "application_confirmed" || cause === "application_corrected"
    ? {
      opportunities: belief.opportunities + 1,
      applications: belief.applications + 1,
      corrections: belief.corrections + (cause === "application_corrected" ? 1 : 0),
    }
    : {
      opportunities: belief.opportunities,
      applications: belief.applications,
      corrections: belief.corrections,
    };
  const history = traced
    ? [
      ...belief.history,
      { ts: at, from: belief.confidence, to: move.to, cause, ref: `seq:${at}` },
    ]
    : belief.history;
  return {
    ...belief,
    ...counters,
    confidence: move.to,
    rank: rankForConfidence(move.to),
    locked: move.locked,
    seen_at: cause === "dormancy" ? belief.seen_at : at,
    moved_at: traced ? at : belief.moved_at,
    history,
  };
}

test("property: ten thousand sequences never open the law rank by accident", () => {
  const random = mulberry32(20260726);
  const now = "2026-12-31T00:00:00Z";
  const nowMs = parseTs(now).getTime();
  let lawReached = 0;
  let sequences = 0;

  for (let index = 0; index < 10_000; index += 1) {
    const origin: BeliefOrigin = random() < 0.5 ? "declared" : "inferred";
    const survivor = random() < 0.5;
    const confidence = Math.round((random() * 11 - 1) * 2) / 2;
    const locked = random() < 0.4;
    const applications = survivor ? 20 + Math.floor(random() * 6) : Math.floor(random() * 6);
    const corrections = survivor ? 0 : Math.floor(random() * 3);
    const createdMs = nowMs - (survivor ? 200 : 5) * 86_400_000;
    const startConfidence = origin === "inferred" && confidence >= 7 && !survivor
      ? 6.5
      : confidence;

    let belief = makeBelief({
      origin,
      confidence: startConfidence,
      locked,
      applications,
      corrections,
      opportunities: applications + Math.floor(random() * 3),
      created_at: formatTs(new Date(createdMs)),
      moved_at: formatTs(new Date(createdMs + 3_600_000)),
      seen_at: formatTs(new Date(createdMs + 3_600_000)),
      validateAt: now,
    });

    let cursorMs = parseTs(belief.moved_at).getTime();
    const moves = 1 + Math.floor(random() * 6);
    for (let step = 0; step < moves; step += 1) {
      const cause = CAUSES[Math.floor(random() * CAUSES.length)] ?? "dormancy";
      cursorMs += DELTAS_MS[Math.floor(random() * DELTAS_MS.length)] ?? 1_000;
      belief = simulate(belief, cause, formatTs(new Date(cursorMs)), now);

      // The output has to satisfy the frozen contract, always.
      validateBelief(belief, { now });
      if (!belief.locked) {
        assert.ok(
          belief.confidence <= UNLOCKED_CONFIDENCE_CAP,
          `an unlocked belief reached ${String(belief.confidence)}`,
        );
        assert.notEqual(belief.rank, "law");
      }
      if (belief.origin === "inferred" && belief.rank === "law") {
        assert.ok(
          inferredSurvivalReached(belief, now),
          "an inferred belief reached law without surviving",
        );
      }
      if (belief.rank === "law") {
        lawReached += 1;
      }
    }
    sequences += 1;
  }

  assert.equal(sequences, 10_000);
  // A property that is never exercised passes for the wrong reason.
  assert.ok(lawReached > 0, "no sequence ever reached law, so the property proves nothing");
});

// ---------------------------------------------------------------------------
// Consuming verdicts.
// ---------------------------------------------------------------------------

test("the order of the checks puts armed first, and the table is closed", () => {
  const beliefs = [makeBelief({ id: "b_one" })];
  const now = "2026-07-02T11:00:00Z";

  const disarmed = buildVerdict(
    "dec_20260702T1015_5f3ac1de",
    "rapid_followup",
    { verdict: "bad", evidence: { beliefs: ["b_one"], seconds_before_followup: 10 } },
    "2026-07-02T10:20:00Z",
  );
  assert.equal(disarmed.armed, false);
  const first = movesFromVerdicts(beliefs, [disarmed], now);
  assert.equal(first.applications.length, 0);
  assert.equal(first.ignored[0]?.reason, "disarmed");

  // A pair that is not in the table moves nothing, whatever it says.
  const outOfScope = buildVerdict(
    "dec_20260702T1015_5f3ac1de",
    "sterile_route",
    { verdict: "bad", evidence: { beliefs: ["b_one"], documents_routed: 3 } },
    "2026-07-02T10:20:00Z",
  );
  assert.equal(movesFromVerdicts(beliefs, [outOfScope], now).ignored[0]?.reason, "rule_out_of_scope");

  const noEffect = verdictFor("belief_confirmed", "undetermined" as "good", ["b_one"]);
  assert.equal(movesFromVerdicts(beliefs, [noEffect], now).ignored[0]?.reason, "verdict_no_effect");

  const withoutBelief = buildVerdict(
    "dec_20260702T1015_5f3ac1de",
    "belief_confirmed",
    { verdict: "good", evidence: { beliefs_applied: 1 } },
    "2026-07-02T10:20:00Z",
  );
  assert.equal(
    movesFromVerdicts(beliefs, [withoutBelief], now).ignored[0]?.reason,
    "evidence_without_belief",
  );
  assert.deepEqual(beliefsFromVerdict(withoutBelief), []);

  const unknown = verdictFor("belief_confirmed", "good", ["b_missing"]);
  assert.equal(movesFromVerdicts(beliefs, [unknown], now).ignored[0]?.reason, "unknown_belief");

  assert.equal(MOVEMENT_BY_VERDICT.length, 2);
});

test("the weight of a verdict never multiplies the delta", () => {
  const beliefs = [makeBelief({ id: "b_one", confidence: 4 })];
  const now = "2026-07-02T11:00:00Z";
  const confirmed = verdictFor("belief_confirmed", "good", ["b_one"]);
  const corrected = verdictFor("belief_corrected", "bad", ["b_one"]);

  assert.equal(confirmed.weight, 1);
  assert.equal(corrected.weight, 2);
  assert.equal(movesFromVerdicts(beliefs, [confirmed], now).applications[0]?.confidence, 5);
  assert.equal(movesFromVerdicts(beliefs, [corrected], now).applications[0]?.confidence, 2);
});

test("a verdict moves a belief end to end, and replaying it moves nothing", async (t) => {
  const { root, config } = await armedVault("open-brain-confidence-consume-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(config, root, makeBelief({ id: "b_one", confidence: 4 }));
  const verdict = verdictFor("belief_confirmed", "good", ["b_one"]);

  const first = await consumeVerdicts(config, root, [verdict], { now: "2026-07-02T11:00:00Z" });
  assert.equal(first.applied.length, 1);
  assert.equal(first.applied[0]?.to, 5);
  const moved = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(moved);
  assert.equal(moved.confidence, 5);
  assert.equal(moved.applications, 1);

  const bytes = await readFile(beliefsPath(config, root));
  const mtime = (await stat(beliefsPath(config, root))).mtimeMs;
  for (let pass = 0; pass < 10; pass += 1) {
    const replay = await consumeVerdicts(config, root, [verdict], { now: "2026-07-02T11:00:00Z" });
    assert.equal(replay.applied.length, 0);
    assert.equal(replay.ignored[0]?.reason, "already_consumed");
  }
  assert.deepEqual(await readFile(beliefsPath(config, root)), bytes);
  assert.equal((await stat(beliefsPath(config, root))).mtimeMs, mtime);
});

// ---------------------------------------------------------------------------
// Dormancy.
// ---------------------------------------------------------------------------

test("dormancy counts from max(seen_at, moved_at) and stops when it has nothing left to take", () => {
  const belief = makeBelief({
    confidence: 4,
    created_at: "2026-01-01T09:00:00Z",
    seen_at: "2026-01-10T09:00:00Z",
    moved_at: "2026-01-20T09:00:00Z",
  });
  // Ninety days after the later of the two bounds: three windows.
  const moves = dormancyMoves([belief], "2026-04-20T09:00:00Z");
  assert.equal(moves.length, 3);
  assert.deepEqual(moves.map((move) => move.confidence), [3.5, 3, 2.5]);
  assert.equal(moves[0]?.at, "2026-02-19T09:00:00Z");
  assert.ok(moves.every((move) => move.ref === "dormancy:2026-01-10T09:00:00Z"));

  // Forgotten for three years: the series stops at the floor of the shadow rank
  // instead of billing thirty six pointless windows.
  const forgotten = dormancyMoves([belief], "2029-01-20T09:00:00Z");
  assert.equal(forgotten.length, 9);
  assert.equal(forgotten.at(-1)?.confidence, -0.5);

  // A locked belief never sleeps, and a retired one is already gone.
  assert.deepEqual(dormancyMoves([makeBelief({ confidence: 4, locked: true })], "2029-01-20T09:00:00Z"), []);
  assert.deepEqual(dormancyMoves([makeBelief({ confidence: -1 })], "2029-01-20T09:00:00Z"), []);
});

test("two dormancy passes in a row never bill the same window twice", async (t) => {
  const { root, config } = await armedVault("open-brain-confidence-dormancy-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(
    config,
    root,
    makeBelief({
      id: "b_one",
      confidence: 4,
      created_at: "2026-01-01T09:00:00Z",
      seen_at: "2026-01-10T09:00:00Z",
      moved_at: "2026-01-20T09:00:00Z",
    }),
  );

  const first = await consumeDormancy(config, root, { now: "2026-04-20T09:00:00Z" });
  assert.equal(first.applied.length, 3);
  const after = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(after);
  assert.equal(after.confidence, 2.5);

  const bytes = await readFile(beliefsPath(config, root));
  const second = await consumeDormancy(config, root, { now: "2026-04-20T09:00:00Z" });
  assert.equal(second.applied.length, 0);
  assert.deepEqual(await readFile(beliefsPath(config, root)), bytes);
});

// ---------------------------------------------------------------------------
// Injection.
// ---------------------------------------------------------------------------

test("a law takes its seat everywhere, an active belief only in its own domain", () => {
  const law = makeBelief({ id: "b_law", confidence: 8, locked: true, domain: "writing" });
  const active = makeBelief({ id: "b_active", confidence: 5, domain: "agentic coding" });
  const offDomain = makeBelief({ id: "b_off", confidence: 6, domain: "gardening" });
  const shadow = makeBelief({ id: "b_shadow", confidence: 1, domain: "agentic coding" });
  const retired = makeBelief({ id: "b_retired", confidence: -1, domain: "agentic coding" });
  const beliefs = [law, active, offDomain, shadow, retired];

  const selection = selectForInjection(beliefs, ["agentic", "coding", "route"]);
  assert.deepEqual(selection.applied.map((belief) => belief.id), ["b_law", "b_active"]);
  // A belief in the shadow or retired competes for nothing and loses nothing.
  assert.equal(selection.evicted.some((eviction) => eviction.belief_id === "b_shadow"), false);
  assert.equal(selection.evicted.some((eviction) => eviction.belief_id === "b_retired"), false);
  assert.equal(selection.evicted.some((eviction) => eviction.belief_id === "b_off"), false);

  const line = beliefLine(law);
  assert.match(line, /^- b_law \(law, c=8\): /u);
});

test("the higher confidence takes the seat and the loser is named as evicted", () => {
  const winner = makeBelief({ id: "b_winner", confidence: 6, domain: "agentic coding" });
  const loser = makeBelief({ id: "b_loser", confidence: 4, domain: "agentic coding" });
  const selection = selectForInjection([loser, winner], ["agentic", "coding"]);
  assert.deepEqual(selection.applied.map((belief) => belief.id), ["b_winner"]);
  assert.deepEqual(selection.evicted, [
    { belief_id: "b_loser", winner: "b_winner", rank: "active" },
  ]);
});

test("a line dropped by the cap is never counted as applied and never as evicted", () => {
  const long = `Load a bounded context and report its token cost. ${"Keep the block small enough to be read. ".repeat(6)}`;
  const law = makeBelief({
    id: "b_law",
    confidence: 8,
    locked: true,
    domain: "writing",
    statement: long,
  });
  const active = makeBelief({
    id: "b_active",
    confidence: 5,
    domain: "agentic coding",
    statement: long,
  });
  const injection = renderInjection([law, active], ["agentic", "coding"], {
    max_chars: 450,
    max_law: 1,
    max_active: 1,
    statement_clip: 300,
    drift_alert_tokens: 350,
  });

  assert.equal(injection.budget.truncated, true);
  assert.equal(injection.budget.items_shown, 1);
  assert.equal(injection.applied.length, injection.budget.items_shown);
  assert.equal(injection.cut.length, 2 - injection.budget.items_shown);
  // The cut belief is not an eviction: evictions feed the correction rule, and a
  // lack of room is not a mistake by the belief that got cut.
  assert.equal(injection.evicted.length, 0);
  assert.match(injection.text, /TRUNCATED/u);

  const decision = buildInjectionDecision(injection, { session: "s1", ts: "2026-07-02T10:00:00Z" });
  assert.ok(decision);
  assert.deepEqual(decision.beliefs_applied, injection.applied.map((belief) => belief.id));
  assert.deepEqual(decision.beliefs_evicted, []);
});

test("an injection with nothing to learn writes no journal line", () => {
  const injection = renderInjection([], ["agentic"], {
    max_chars: 1_500,
    max_law: 1,
    max_active: 1,
    statement_clip: 160,
    drift_alert_tokens: 350,
  });
  assert.equal(injection.text, "");
  assert.equal(buildInjectionDecision(injection, { session: "s1" }), undefined);
});

test("the injection reports its cost and its truncation", async (t) => {
  const { root, config } = await armedVault("open-brain-confidence-injection-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(config, root, makeBelief({ id: "b_active", confidence: 5 }));
  const injection = await injectionFor(config, root, ["agentic", "coding"]);
  assert.equal(injection.applied.length, 1);
  assert.equal(injection.budget.items_shown, 1);
  assert.equal(injection.budget.truncated, false);
  assert.ok(injection.budget.token_estimate > 0);
  assert.equal(injection.drift_alert, false);
});

test("the confidence organ refuses to run while learning.evaluate is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-confidence-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const run of [
    async () => consumeVerdicts(DEFAULT_CONFIG, root, []),
    async () => consumeDormancy(DEFAULT_CONFIG, root, {}),
    async () => injectionFor(DEFAULT_CONFIG, root, ["agentic"]),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning\.evaluate is disabled/u);
      return true;
    });
  }
  await assert.rejects(stat(beliefsPath(DEFAULT_CONFIG, root)));
});
