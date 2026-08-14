import assert from "node:assert/strict";
import test from "node:test";

import {
  BELIEF_ID_MAX_CHARS,
  CONFIDENCE_CREATION,
  DISARMED_RULES,
  InvariantError,
  LINE_MAX_BYTES,
  QUOTE_MAX_CHARS,
  RANK_ACTIVE_FLOOR,
  RANK_LAW_FLOOR,
  RANK_SHADOW_FLOOR,
  SchemaError,
  UNLOCKED_CONFIDENCE_CAP,
  createBelief,
  fitLine,
  formatTs,
  inferredSurvivalReached,
  nowTs,
  parseTs,
  rankForConfidence,
  slugifyBeliefId,
  validateBelief,
  validateBeliefDocument,
  validateConsolidation,
  validateDecision,
  validateObservation,
  validateVerdict,
  type Belief,
} from "../src/learning/types.js";

const NOW = "2026-07-20T09:00:00Z";
const CREATED = "2026-07-01T09:00:00Z";
const QUOTE = "Load a bounded context and report its token cost.";

function baseBelief(): Belief {
  return createBelief({
    statement: QUOTE,
    domain: "agentic coding",
    evidence: { occurrences: 1, refs: ["test:fixture"], quote: QUOTE },
    now: CREATED,
  });
}

type Mutation = (belief: Record<string, unknown>) => void;

function mutated(change: Mutation): Record<string, unknown> {
  const belief = JSON.parse(JSON.stringify(baseBelief())) as Record<string, unknown>;
  change(belief);
  return belief;
}

function expectInvariant(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof InvariantError, `expected an InvariantError for ${code}`);
    assert.equal(error.invariant, code);
    return true;
  });
}

test("rank bounds are closed on the left and open on the right, with no overlap", () => {
  assert.equal(rankForConfidence(-1), "retired");
  assert.equal(rankForConfidence(-0.5), "retired");
  assert.equal(rankForConfidence(RANK_SHADOW_FLOOR), "shadow");
  assert.equal(rankForConfidence(2.5), "shadow");
  assert.equal(rankForConfidence(RANK_ACTIVE_FLOOR), "active");
  assert.equal(rankForConfidence(UNLOCKED_CONFIDENCE_CAP), "active");
  assert.equal(rankForConfidence(RANK_LAW_FLOOR), "law");
  assert.equal(rankForConfidence(10), "law");
});

test("a belief is born at confidence 3 and rank active, and nowhere else", () => {
  const belief = createBelief({
    statement: QUOTE,
    evidence: { quote: QUOTE },
    now: CREATED,
  });
  assert.equal(belief.confidence, CONFIDENCE_CREATION);
  assert.equal(belief.rank, "active");
  assert.equal(belief.domain, "general");
  assert.equal(belief.origin, "declared");
  assert.equal(belief.opportunities, 0);
  assert.equal(belief.applications, 0);
  assert.equal(belief.history.length, 1);
  assert.equal(belief.history[0]?.cause, "creation");
  assert.equal(belief.history[0]?.from, null);
  assert.equal(belief.moved_at, belief.created_at);
  assert.equal(belief.seen_at, belief.created_at);

  // The rule is in the type, not in a comment: CreateBeliefInput has no rank
  // and no confidence, so shadow cannot be asked for. Handing one in through
  // the raw shape is refused by the contract.
  expectInvariant("belief.creation.rank", () => {
    validateBelief(
      mutated((raw) => {
        raw.rank = "shadow";
        raw.confidence = 1;
        const history = raw.history as Array<Record<string, unknown>>;
        const first = history[0];
        if (first) {
          first.to = 1;
        }
      }),
      { now: NOW, creation: true },
    );
  });
});

test("a belief id derived from a statement is a valid, bounded id", () => {
  const id = slugifyBeliefId("Load a bounded CONTEXT and report its token cost, always.");
  assert.match(id, /^b_[a-z0-9]+(?:_[a-z0-9]+)*$/u);
  assert.ok(id.length <= BELIEF_ID_MAX_CHARS);
  assert.throws(() => slugifyBeliefId("!!! ???"), (error: unknown) => {
    assert.ok(error instanceof SchemaError);
    return true;
  });
});

test("every named belief invariant has a negative test that names it", () => {
  const cases: Array<[string, Mutation, Parameters<typeof validateBelief>[1]?]> = [
    ["belief.keys.unknown", (raw) => {
      raw.extra = 1;
    }],
    ["belief.keys.missing", (raw) => {
      delete raw.domain;
    }],
    ["belief.id.format", (raw) => {
      raw.id = "not-a-belief-id";
    }],
    ["belief.statement", (raw) => {
      raw.statement = "   ";
    }],
    ["belief.origin", (raw) => {
      raw.origin = "guessed";
    }],
    ["belief.rank.coherence", (raw) => {
      raw.rank = "law";
    }],
    ["belief.confidence.range", (raw) => {
      raw.confidence = 42;
    }],
    ["belief.counters", (raw) => {
      raw.applications = -1;
    }],
    ["belief.counters.coherence", (raw) => {
      raw.applications = 2;
      raw.opportunities = 1;
    }],
    ["belief.dates.order", (raw) => {
      raw.seen_at = "2026-06-01T09:00:00Z";
    }],
    ["belief.moved_at.coherence", (raw) => {
      raw.moved_at = "2026-07-02T09:00:00Z";
    }],
    ["belief.history.shape", (raw) => {
      raw.history = [];
    }],
    ["belief.history.monotonic", (raw) => {
      raw.history = [
        { ts: CREATED, from: null, to: 3, cause: "creation", ref: "r" },
        { ts: CREATED, from: 3, to: 3, cause: "application_confirmed", ref: "dec" },
      ];
    }],
    ["belief.history.from", (raw) => {
      raw.history = [
        { ts: CREATED, from: null, to: 3, cause: "creation", ref: "r" },
        { ts: "2026-07-02T09:00:00Z", from: null, to: 3, cause: "application_confirmed", ref: "d" },
      ];
      raw.moved_at = "2026-07-02T09:00:00Z";
    }],
    ["belief.history.summary.shape", (raw) => {
      raw.history = [
        { ts: CREATED, from: 3, to: 3, cause: "history_summary", ref: "summary:2" },
      ];
    }],
    ["belief.evidence.quote.cap", (raw) => {
      (raw.evidence as Record<string, unknown>).quote = "x".repeat(QUOTE_MAX_CHARS + 1);
    }],
    ["belief.evidence.refs", (raw) => {
      (raw.evidence as Record<string, unknown>).refs = [""];
    }],
    ["belief.inferred.occurrences", (raw) => {
      raw.origin = "inferred";
    }],
    ["belief.inferred.refs", (raw) => {
      raw.origin = "inferred";
      const evidence = raw.evidence as Record<string, unknown>;
      evidence.occurrences = 3;
      evidence.refs = [];
    }],
    ["belief.ledger_ref.origin", (raw) => {
      raw.origin = "inferred";
      const evidence = raw.evidence as Record<string, unknown>;
      evidence.occurrences = 3;
      raw.ledger_ref = "pref_bounded_context";
    }],
    ["ts.format", (raw) => {
      raw.created_at = "2026-07-01 09:00:00";
    }],
  ];

  for (const [code, change, options] of cases) {
    expectInvariant(code, () => validateBelief(mutated(change), options ?? { now: NOW }));
  }

  // The quote of a declared belief must be found literally in its source.
  expectInvariant("belief.declared.quote.literal", () => {
    validateBelief(baseBelief(), { now: NOW, sourceText: "a completely different turn" });
  });
  validateBelief(baseBelief(), { now: NOW, sourceText: `before ${QUOTE} after` });

  // Rank shadow is a sanction, so it demands a move that is not the creation.
  expectInvariant("belief.shadow.sanction", () => {
    validateBelief(
      mutated((raw) => {
        raw.rank = "shadow";
        raw.confidence = 1;
        const history = raw.history as Array<Record<string, unknown>>;
        const first = history[0];
        if (first) {
          first.to = 1;
        }
      }),
      { now: NOW },
    );
  });

  // An inferred belief cannot sit at law before it has survived.
  expectInvariant("belief.inferred.law", () => {
    validateBelief(
      mutated((raw) => {
        raw.origin = "inferred";
        (raw.evidence as Record<string, unknown>).occurrences = 3;
        raw.confidence = 8;
        raw.rank = "law";
        raw.locked = true;
        raw.history = [
          { ts: CREATED, from: null, to: 3, cause: "creation", ref: "r" },
          { ts: "2026-07-02T09:00:00Z", from: 3, to: 8, cause: "human_engrave", ref: "human" },
        ];
        raw.moved_at = "2026-07-02T09:00:00Z";
      }),
      { now: NOW },
    );
  });
});

test("the survival threshold of an inferred belief needs all three conditions", () => {
  const survivor: Belief = {
    ...baseBelief(),
    origin: "inferred",
    evidence: { occurrences: 3, refs: ["r"], quote: QUOTE },
    applications: 20,
    opportunities: 20,
    corrections: 0,
  };
  assert.equal(inferredSurvivalReached(survivor, "2026-09-30T09:00:00Z"), true);
  assert.equal(inferredSurvivalReached(survivor, "2026-07-20T09:00:00Z"), false);
  assert.equal(
    inferredSurvivalReached({ ...survivor, corrections: 1 }, "2026-09-30T09:00:00Z"),
    false,
  );
  assert.equal(
    inferredSurvivalReached({ ...survivor, applications: 19 }, "2026-09-30T09:00:00Z"),
    false,
  );
});

test("a belief document refuses duplicate ids and reads older versions", () => {
  const belief = baseBelief();
  expectInvariant("belief.id.unique", () => {
    validateBeliefDocument({
      schema_version: 1,
      updated_at: NOW,
      beliefs: [belief, belief],
    });
  });

  // Backward tolerant: a document written before schema_version existed reads
  // as version 1 rather than being refused.
  const legacy = validateBeliefDocument({ updated_at: NOW, beliefs: [belief] });
  assert.equal(legacy.schema_version, 1);
  assert.deepEqual(legacy.operations, []);
});

test("timestamps are UTC with second precision, and nothing else is accepted", () => {
  assert.match(nowTs(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(formatTs(new Date("2026-07-20T09:00:00.512Z")), "2026-07-20T09:00:00Z");
  assert.equal(parseTs(NOW).getTime(), Date.parse(NOW));
  for (const bad of ["2026-07-20T09:00:00+02:00", "2026-07-20T09:00:00.000Z", "2026-07-20"]) {
    expectInvariant("ts.format", () => parseTs(bad));
  }
});

test("a decision entry is refused when it contradicts itself", () => {
  const valid = {
    schema_version: 1,
    id: "dec_20260720T0900_1a2b3c4d",
    ts: NOW,
    session: "session-1",
    type: "route",
    input: { hash: `sha1:${"a".repeat(40)}`, summary: "route request" },
    options: ["engineering"],
    choice: "engineering",
    score: null,
    beliefs_applied: ["b_bounded_context"],
    beliefs_evicted: [],
    documents: [],
    cost: { tokens_estimated: 0, ms: 0 },
    verdict: null,
  };
  assert.equal(validateDecision(valid).id, valid.id);
  // A line written before versioning still reads.
  const legacy = { ...valid } as Record<string, unknown>;
  delete legacy.schema_version;
  assert.equal(validateDecision(legacy).schema_version, 1);

  const cases: Array<[string, Record<string, unknown>]> = [
    ["decision.id.format", { ...valid, id: "dec_bad" }],
    ["decision.type", { ...valid, type: "consolidate" }],
    ["decision.session", { ...valid, session: "" }],
    ["decision.input.hash.format", { ...valid, input: { hash: "abc", summary: "s" } }],
    [
      "decision.input.summary.cap",
      { ...valid, input: { hash: valid.input.hash, summary: "x".repeat(161) } },
    ],
    ["decision.choice.coherence", { ...valid, choice: "writing" }],
    [
      "decision.beliefs.disjoint",
      { ...valid, beliefs_evicted: ["b_bounded_context"] },
    ],
    ["decision.beliefs.id", { ...valid, beliefs_applied: ["bounded_context"] }],
    ["decision.keys.unknown", { ...valid, extra: true }],
  ];
  for (const [code, entry] of cases) {
    expectInvariant(code, () => validateDecision(entry));
  }
});

test("a verdict without evidence is an opinion, and a disarmed rule stays disarmed", () => {
  const valid = {
    schema_version: 1,
    decision_id: "dec_20260720T0900_1a2b3c4d",
    rule: "belief_confirmed",
    verdict: "good",
    weight: 1,
    armed: true,
    evidence: { beliefs: ["b_bounded_context"], turns_observed: 3 },
    evaluated_at: NOW,
  };
  assert.equal(validateVerdict(valid).rule, "belief_confirmed");

  expectInvariant("verdict.evidence.empty", () => validateVerdict({ ...valid, evidence: {} }));
  expectInvariant("verdict.weight", () => validateVerdict({ ...valid, weight: 3 }));
  expectInvariant("verdict.rule", () => validateVerdict({ ...valid, rule: "sterile_routes" }));
  for (const rule of DISARMED_RULES) {
    expectInvariant("verdict.armed.disarmed", () => validateVerdict({ ...valid, rule }));
    // The same rule is accepted as long as it stays disarmed.
    assert.equal(validateVerdict({ ...valid, rule, armed: false }).armed, false);
  }
});

test("an observation carries facts only, and a documentary one names its document", () => {
  const valid = {
    schema_version: 1,
    id: "obs_20260720_0001",
    sensor: "circulation",
    ts: NOW,
    subject: "OpenBrain/10_memory/_state.md@2026-07",
    population: "OpenBrain/10_memory/_state.md",
    measure: { reads: 2, reads_transcript: 2, reads_graft: 0 },
    derived: { graft_share: 0 },
  };
  assert.equal(validateObservation(valid).sensor, "circulation");
  assert.equal(
    validateObservation(valid, { population: ["OpenBrain/10_memory/_state.md"] }).id,
    valid.id,
  );

  const withoutPopulation = { ...valid } as Record<string, unknown>;
  delete withoutPopulation.population;
  expectInvariant("observation.population.required", () =>
    validateObservation(withoutPopulation));
  expectInvariant("observation.population.unknown", () =>
    validateObservation(valid, { population: ["OpenBrain/20_contexts/other.md"] }));
  expectInvariant("observation.sensor", () =>
    validateObservation({ ...valid, sensor: "charge" }));
  expectInvariant("observation.id.format", () =>
    validateObservation({ ...valid, id: "obs_1" }));
  // A measure is strictly numeric. A boolean is not a number here.
  expectInvariant("observation.measure", () =>
    validateObservation({ ...valid, measure: { reads: true } }));
  expectInvariant("observation.measure", () =>
    validateObservation({ ...valid, measure: {} }));
});

test("a consolidation record can never claim to have grown or to have kept nothing", () => {
  const digest = "a".repeat(64);
  const other = "b".repeat(64);
  const valid = {
    schema_version: 1,
    id: "dec_20260720T0900_1a2b3c4d",
    ts: NOW,
    type: "consolidated",
    document: "10_memory/_state.md",
    before: { size: 120_000, sha256: digest },
    after: { size: 19_000, sha256: other },
    blocks: [{
      archive: "90_archive/consolidation/_state/2026-07.md",
      period: "2026-07-22/2026-07-25",
      entries: 7,
      size: 103_420,
      sha256_block: "c".repeat(64),
      reread_ok: true,
    }],
    deconsolidation_verified: true,
  };
  assert.equal(validateConsolidation(valid).type, "consolidated");

  expectInvariant("consolidation.size.monotonic_decrease", () =>
    validateConsolidation({ ...valid, after: { size: 130_000, sha256: other } }));
  expectInvariant("consolidation.blocks.empty", () =>
    validateConsolidation({ ...valid, blocks: [] }));
  expectInvariant("consolidation.blocks.archive.zone", () =>
    validateConsolidation({
      ...valid,
      blocks: [{ ...valid.blocks[0], archive: "90_archive/../../etc/passwd" }],
    }));
  // On an abort the living document must be untouched, byte for byte.
  expectInvariant("consolidation.abort.document_untouched", () =>
    validateConsolidation({ ...valid, deconsolidation_verified: false }));
  assert.equal(
    validateConsolidation({
      ...valid,
      deconsolidation_verified: false,
      after: { size: 120_000, sha256: digest },
    }).deconsolidation_verified,
    false,
  );
});

test("fitLine never clears a truncation flag and never empties a floor-one list", () => {
  const already = fitLine({ id: "x", truncated: true, note: "short" });
  assert.equal(already.record.truncated, true);
  assert.equal(already.truncated, true);

  const block = (archiveLength: number) => ({
    archive: "9".repeat(archiveLength),
    period: "2026-07-22/2026-07-25",
    entries: 7,
    size: 1,
    sha256_block: "c".repeat(64),
    reread_ok: true,
  });
  const wide = {
    id: "dec_20260720T0900_1a2b3c4d",
    ts: NOW,
    type: "consolidated",
    document: "10_memory/_state.md",
    blocks: Array.from({ length: 5 }, () => block(2_000)),
  };
  const fitted = fitLine(wide, LINE_MAX_BYTES);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.record.blocks.length, 1, "a floor-one list stops at one element");
  assert.equal(fitted.record.id, wide.id);
  assert.equal(fitted.record.document, wide.document);

  // A single element that still overflows is shrunk, never dropped: the list
  // keeps its floor and the essential fields keep their value.
  const single = { ...wide, blocks: [block(6_000)] };
  const shrunk = fitLine(single, LINE_MAX_BYTES);
  assert.equal(shrunk.record.blocks.length, 1);
  assert.ok((shrunk.record.blocks[0]?.archive.length ?? 0) < 6_000);
  assert.equal(shrunk.record.blocks[0]?.reread_ok, true);
  assert.equal(shrunk.record.type, "consolidated");
});
