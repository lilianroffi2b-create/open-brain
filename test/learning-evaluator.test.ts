import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  ARMED_RULES,
  MANUAL_SESSION,
  VERDICT_WEIGHTS,
  evaluate,
  readVerdicts,
  runEvaluatorPass,
  verdictDigest,
  verdictsPath,
  type SessionWitness,
} from "../src/learning/evaluator.js";
import { buildDecision, writeEntry } from "../src/learning/journal.js";
import { DEFAULT_LEARNING_TUNING } from "../src/learning/sensors/index.js";
import type { DecisionEntry, Verdict, VerdictRule } from "../src/learning/types.js";

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

const WINDOWS = DEFAULT_LEARNING_TUNING.evaluator;

interface DecisionShape {
  id: string;
  ts: string;
  session?: string;
  type?: DecisionEntry["type"];
  documents?: string[];
  applied?: string[];
  evicted?: string[];
  text?: string;
}

function decision(shape: DecisionShape): DecisionEntry {
  return buildDecision({
    id: shape.id,
    ts: shape.ts,
    session: shape.session ?? "session-1",
    type: shape.type ?? "route",
    input: { text: shape.text ?? `prompt ${shape.id}`, summary: `summary ${shape.id}` },
    documents: shape.documents ?? [],
    beliefs_applied: shape.applied ?? [],
    beliefs_evicted: shape.evicted ?? [],
  });
}

function witness(shape: Partial<SessionWitness> & { session: string }): SessionWitness {
  return {
    session: shape.session,
    last_ts: shape.last_ts ?? "2026-07-01T09:00:00Z",
    reads: shape.reads ?? [],
    writes: shape.writes ?? [],
  };
}

function pick(verdicts: readonly Verdict[], rule: VerdictRule, decisionId?: string): Verdict[] {
  return verdicts.filter((verdict) =>
    verdict.rule === rule && (decisionId === undefined || verdict.decision_id === decisionId));
}

// ---------------------------------------------------------------------------
// The seven rules.
// ---------------------------------------------------------------------------

test("a sterile route is only called sterile when a witness could see it", () => {
  const routed = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    documents: ["10_memory/_state.md", "20_contexts/brief.md"],
  });

  const blind = evaluate({ now: "2026-07-02T09:00:00Z", decisions: [routed] });
  assert.equal(pick(blind, "sterile_route")[0]?.verdict, "undetermined");
  assert.equal(
    pick(blind, "sterile_route")[0]?.evidence.reason,
    "session_without_transcript",
  );

  const opened = evaluate({
    now: "2026-07-02T09:00:00Z",
    decisions: [routed],
    sessions: [witness({
      session: "session-1",
      last_ts: "2026-07-01T10:00:00Z",
      reads: [{ path: "10_memory/_state.md", ts: "2026-07-01T09:01:00Z" }],
    })],
  });
  const good = pick(opened, "sterile_route")[0];
  assert.equal(good?.verdict, "good");
  assert.equal(good?.evidence.documents_opened, 1);
  assert.equal(good?.evidence.documents_sterile, 1);

  const ignored = evaluate({
    now: "2026-07-02T09:00:00Z",
    decisions: [routed],
    sessions: [witness({ session: "session-1", last_ts: "2026-07-01T10:00:00Z" })],
  });
  assert.equal(pick(ignored, "sterile_route")[0]?.verdict, "bad");

  // Nothing routed inside the measurable scope is not a failure, it is a blank.
  const outside = evaluate({
    now: "2026-07-02T09:00:00Z",
    decisions: [routed],
    population: ["30_skills/other.md"],
  });
  assert.equal(pick(outside, "sterile_route")[0]?.evidence.reason, "no_document_in_population");
});

test("one eviction is one correction, carried by the last application before it", () => {
  const first = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    applied: ["b_one"],
  });
  const second = decision({
    id: "dec_20260701T0901_22222222",
    ts: "2026-07-01T09:01:00Z",
    applied: ["b_one"],
  });
  const eviction = decision({
    id: "dec_20260701T0902_33333333",
    ts: "2026-07-01T09:02:00Z",
    evicted: ["b_one"],
  });

  const verdicts = evaluate({
    now: "2026-07-03T09:00:00Z",
    decisions: [first, second, eviction],
  });
  const bad = pick(verdicts, "belief_corrected").filter((verdict) => verdict.verdict === "bad");
  assert.equal(bad.length, 1, "a single correction produced more than one bad verdict");
  assert.equal(bad[0]?.decision_id, second.id);
  assert.equal(bad[0]?.evidence.beliefs_corrected, 1);
  assert.deepEqual(bad[0]?.evidence.beliefs, ["b_one"]);
  assert.equal(bad[0]?.weight, 2);
  assert.equal(bad[0]?.armed, true);

  // Two distinct evictions of the same belief are two corrections.
  const again = decision({
    id: "dec_20260701T0903_44444444",
    ts: "2026-07-01T09:03:00Z",
    applied: ["b_one"],
  });
  const secondEviction = decision({
    id: "dec_20260701T0904_55555555",
    ts: "2026-07-01T09:04:00Z",
    evicted: ["b_one"],
  });
  const both = evaluate({
    now: "2026-07-03T09:00:00Z",
    decisions: [first, second, eviction, again, secondEviction],
  });
  assert.equal(
    pick(both, "belief_corrected").filter((verdict) => verdict.verdict === "bad").length,
    2,
  );
});

test("an incomplete window never confirms, even once the session is closed", () => {
  const anchor = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    applied: ["b_one"],
  });
  const followers = [
    decision({ id: "dec_20260701T0901_22222222", ts: "2026-07-01T09:01:00Z" }),
    decision({ id: "dec_20260701T0902_33333333", ts: "2026-07-01T09:02:00Z" }),
  ];

  for (let turns = 0; turns < WINDOWS.confirmation_window_turns; turns += 1) {
    const verdicts = evaluate({
      // Long closed, and with a witness: the window alone must still refuse.
      now: "2026-07-10T09:00:00Z",
      decisions: [anchor, ...followers.slice(0, turns)],
      sessions: [witness({ session: "session-1", last_ts: "2026-07-01T09:05:00Z" })],
    });
    const verdict = pick(verdicts, "belief_confirmed", anchor.id)[0];
    assert.equal(verdict?.verdict, "undetermined", `turns=${String(turns)}`);
    assert.equal(verdict?.evidence.reason, "window_incomplete", `turns=${String(turns)}`);
    assert.equal(verdict?.evidence.turns_observed, turns);
  }
});

test("a confirmation needs a complete window, a closed session and an external witness", () => {
  const anchor = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    applied: ["b_one"],
  });
  const followers = [
    decision({ id: "dec_20260701T0901_22222222", ts: "2026-07-01T09:01:00Z" }),
    decision({ id: "dec_20260701T0902_33333333", ts: "2026-07-01T09:02:00Z" }),
    decision({ id: "dec_20260701T0903_44444444", ts: "2026-07-01T09:03:00Z" }),
  ];
  const decisions = [anchor, ...followers];

  // The layer writes the journal itself, so without a witness it would be
  // rewarding itself on its own trace.
  const alone = evaluate({ now: "2026-07-10T09:00:00Z", decisions });
  assert.equal(
    pick(alone, "belief_confirmed", anchor.id)[0]?.evidence.reason,
    "session_without_transcript",
  );

  const open = evaluate({
    now: "2026-07-01T10:00:00Z",
    decisions,
    sessions: [witness({ session: "session-1", last_ts: "2026-07-01T09:30:00Z" })],
  });
  assert.equal(pick(open, "belief_confirmed", anchor.id)[0]?.evidence.reason, "session_open");

  const closed = evaluate({
    now: "2026-07-10T09:00:00Z",
    decisions,
    sessions: [witness({ session: "session-1", last_ts: "2026-07-01T09:30:00Z" })],
  });
  const confirmed = pick(closed, "belief_confirmed", anchor.id)[0];
  assert.equal(confirmed?.verdict, "good");
  assert.equal(confirmed?.evidence.corrections, 0);
  assert.equal(confirmed?.weight, 1);
});

test("a belief is confirmed at most once per session, and the earliest application carries it", () => {
  const first = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    applied: ["b_one"],
  });
  const later = decision({
    id: "dec_20260701T0901_22222222",
    ts: "2026-07-01T09:01:00Z",
    applied: ["b_one"],
  });
  const decisions = [
    first,
    later,
    decision({ id: "dec_20260701T0902_33333333", ts: "2026-07-01T09:02:00Z" }),
    decision({ id: "dec_20260701T0903_44444444", ts: "2026-07-01T09:03:00Z" }),
    decision({ id: "dec_20260701T0904_55555555", ts: "2026-07-01T09:04:00Z" }),
  ];

  const verdicts = evaluate({
    now: "2026-07-10T09:00:00Z",
    decisions,
    sessions: [witness({ session: "session-1", last_ts: "2026-07-01T09:30:00Z" })],
  });
  assert.equal(pick(verdicts, "belief_confirmed").length, 1);
  assert.equal(pick(verdicts, "belief_confirmed")[0]?.decision_id, first.id);
});

test("an eviction anywhere in the session stops the confirmation", () => {
  const anchor = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    applied: ["b_one"],
  });
  const decisions = [
    anchor,
    decision({ id: "dec_20260701T0901_22222222", ts: "2026-07-01T09:01:00Z", evicted: ["b_one"] }),
    decision({ id: "dec_20260701T0902_33333333", ts: "2026-07-01T09:02:00Z" }),
    decision({ id: "dec_20260701T0903_44444444", ts: "2026-07-01T09:03:00Z" }),
  ];
  const verdicts = evaluate({
    now: "2026-07-10T09:00:00Z",
    decisions,
    sessions: [witness({ session: "session-1", last_ts: "2026-07-01T09:30:00Z" })],
  });
  const confirmed = pick(verdicts, "belief_confirmed", anchor.id)[0];
  assert.equal(confirmed?.verdict, "undetermined");
  assert.equal(confirmed?.evidence.corrections, 1);
});

test("a dead output is only called dead once its window has closed", () => {
  const produced = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    type: "produced",
  });
  const wrote = witness({
    session: "session-1",
    last_ts: "2026-07-01T10:00:00Z",
    writes: [{ path: "50_outputs/report.md", ts: "2026-07-01T09:05:00Z" }],
  });

  const early = evaluate({
    now: "2026-07-02T09:00:00Z",
    decisions: [produced],
    sessions: [wrote],
  });
  assert.equal(pick(early, "dead_output")[0]?.evidence.reason, "window_not_closed");

  const blind = evaluate({
    now: "2026-07-20T09:00:00Z",
    decisions: [produced],
    sessions: [witness({ session: "session-1", last_ts: "2026-07-01T10:00:00Z" })],
  });
  assert.equal(pick(blind, "dead_output")[0]?.evidence.reason, "no_write_in_transcript");

  const dead = evaluate({
    now: "2026-07-20T09:00:00Z",
    decisions: [produced],
    sessions: [wrote],
  });
  assert.equal(pick(dead, "dead_output")[0]?.verdict, "bad");
  assert.equal(pick(dead, "dead_output")[0]?.evidence.files_dead, 1);

  const reread = evaluate({
    now: "2026-07-20T09:00:00Z",
    decisions: [produced],
    sessions: [{
      ...wrote,
      reads: [{ path: "50_outputs/report.md", ts: "2026-07-03T09:00:00Z" }],
    }],
  });
  assert.equal(pick(reread, "dead_output")[0]?.verdict, "good");
});

test("the three rules that cannot conclude are carried honestly, never armed", () => {
  const route = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    documents: ["10_memory/_state.md"],
  });
  const followup = decision({ id: "dec_20260701T0901_22222222", ts: "2026-07-01T09:00:30Z" });
  const produced = decision({
    id: "dec_20260701T0902_33333333",
    ts: "2026-07-01T09:02:00Z",
    type: "produced",
  });

  const verdicts = evaluate({
    now: "2026-07-10T09:00:00Z",
    decisions: [route, followup, produced],
  });

  const rapid = pick(verdicts, "rapid_followup", route.id)[0];
  assert.ok(rapid);
  // Measured, and disarmed by the contract itself.
  assert.equal(rapid.armed, false);
  assert.equal(rapid.verdict, "bad");
  assert.equal(rapid.evidence.seconds_before_followup, 30);

  const wasted = pick(verdicts, "wasted_load", route.id)[0];
  assert.equal(wasted?.verdict, "undetermined");
  assert.equal(wasted?.armed, false);
  assert.equal(wasted?.evidence.reason, "context_citation_not_observable");

  const shipped = pick(verdicts, "deliverable_shipped", produced.id)[0];
  assert.equal(shipped?.verdict, "undetermined");
  assert.equal(shipped?.armed, false);
  assert.equal(shipped?.evidence.reason, "source_unavailable");

  assert.deepEqual([...ARMED_RULES].sort(), [
    "belief_confirmed",
    "belief_corrected",
    "dead_output",
    "sterile_route",
  ]);
  assert.equal(VERDICT_WEIGHTS.belief_corrected, 2);
});

test("an entry of manual origin is never evaluated", () => {
  const manual = decision({
    id: "dec_20260701T0900_11111111",
    ts: "2026-07-01T09:00:00Z",
    session: MANUAL_SESSION,
    documents: ["10_memory/_state.md"],
  });
  assert.deepEqual(evaluate({ now: "2026-07-10T09:00:00Z", decisions: [manual] }), []);
});

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

test("two passes in a row write no duplicate, and a verdict that changes writes a new line", async (t) => {
  const { root, config } = await armedVault("open-brain-evaluator-pass-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeEntry(
    config,
    root,
    decision({
      id: "dec_20260701T0900_11111111",
      ts: "2026-07-01T09:00:00Z",
      documents: ["10_memory/_state.md"],
    }),
  );

  const first = await runEvaluatorPass(config, root, { now: "2026-07-02T09:00:00Z" });
  assert.equal(first.ran, true);
  assert.ok(first.computed > 0);
  assert.equal(first.written, first.computed);
  assert.equal(first.unchanged, 0);

  const second = await runEvaluatorPass(config, root, { now: "2026-07-02T10:00:00Z" });
  assert.equal(second.computed, first.computed);
  assert.equal(second.written, 0, "re-evaluating to the same conclusion is not an event");
  assert.equal(second.unchanged, second.computed);

  // A window that closes, or a witness that appears, is a new fact.
  const changed = await runEvaluatorPass(config, root, {
    now: "2026-07-02T11:00:00Z",
    sessions: [witness({
      session: "session-1",
      last_ts: "2026-07-01T09:30:00Z",
      reads: [{ path: "10_memory/_state.md", ts: "2026-07-01T09:01:00Z" }],
    })],
  });
  assert.ok(changed.written > 0);

  const read = await readVerdicts(config, root, { limit: 50 });
  assert.ok(read.verdicts.length > 0);
  assert.equal(read.invalid, 0);
  assert.ok(read.budget.token_estimate > 0);
  assert.equal(read.budget.items_shown, read.verdicts.length);

  const digests = new Set(read.verdicts.map((verdict) => verdictDigest(verdict)));
  assert.equal(digests.size, read.verdicts.length, "the same verdict was written twice");
});

test("the evaluator refuses to run while learning.evaluate is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-evaluator-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    async () => runEvaluatorPass(DEFAULT_CONFIG, root, {}),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning\.evaluate is disabled/u);
      return true;
    },
  );
  await assert.rejects(stat(verdictsPath(DEFAULT_CONFIG, root)));
});

test("the OFF sentinel stops the evaluator without raising", async (t) => {
  const { root, config } = await armedVault("open-brain-evaluator-off-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "10_memory", "learning"), { recursive: true });
  await writeFile(
    join(root, "10_memory", "learning", "OFF.flag"),
    '{"disabled_at":"2026-07-02T09:00:00Z"}\n',
    "utf8",
  );
  const report = await runEvaluatorPass(config, root, { now: "2026-07-02T10:00:00Z" });
  assert.equal(report.ran, false);
  assert.equal(report.reason, "disabled");
  assert.equal(report.written, 0);
});
