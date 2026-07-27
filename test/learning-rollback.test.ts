import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import { consumeVerdicts } from "../src/learning/confidence.js";
import { buildVerdict } from "../src/learning/evaluator.js";
import { offFlagPath } from "../src/learning/population.js";
import { RevertError, planRevert, revert, stateAtDate } from "../src/learning/rollback.js";
import { addBelief, beliefsPath, readBeliefDocument } from "../src/learning/store.js";
import {
  CONFIDENCE_CREATION,
  rankForConfidence,
  validateBelief,
  type Belief,
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

function makeBelief(id: string, confidence = CONFIDENCE_CREATION): Belief {
  const belief: Belief = {
    id,
    statement: "Load a bounded context and report its token cost.",
    domain: "agentic coding",
    origin: "declared",
    evidence: {
      occurrences: 1,
      refs: ["test:fixture"],
      quote: "Load a bounded context and report its token cost.",
    },
    rank: rankForConfidence(confidence),
    confidence,
    locked: false,
    opportunities: 0,
    applications: 0,
    corrections: 0,
    created_at: BIRTH,
    seen_at: BIRTH,
    moved_at: BIRTH,
    history: [{ ts: BIRTH, from: null, to: CONFIDENCE_CREATION, cause: "creation", ref: "test:fixture" }],
  };
  return validateBelief(belief, { now: "2026-07-01T09:00:00Z" });
}

function confirmed(id: string, decisionId: string, evaluatedAt: string): Verdict {
  return buildVerdict(
    decisionId,
    "belief_confirmed",
    { verdict: "good", evidence: { beliefs: [id], beliefs_applied: 1 } },
    evaluatedAt,
  );
}

test("the state at a date is read from the history, and planning writes nothing", async (t) => {
  const { root, config } = await armedVault("open-brain-rollback-plan-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(config, root, makeBelief("b_one"));
  await consumeVerdicts(
    config,
    root,
    [confirmed("b_one", "dec_20260201T0900_11111111", "2026-02-01T09:00:00Z")],
    { now: "2026-02-01T10:00:00Z" },
  );
  await consumeVerdicts(
    config,
    root,
    [confirmed("b_one", "dec_20260301T0900_22222222", "2026-03-01T09:00:00Z")],
    { now: "2026-03-01T10:00:00Z" },
  );

  const belief = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(belief);
  assert.equal(belief.confidence, 5);
  assert.equal(belief.history.length, 3);

  assert.deepEqual(stateAtDate(belief, "2026-02-15T00:00:00Z"), {
    belief_id: "b_one",
    existed: true,
    confidence: 4,
    rank: "active",
    entries_considered: 2,
  });
  assert.equal(stateAtDate(belief, "2025-12-01T00:00:00Z").existed, false);

  const bytes = await readFile(beliefsPath(config, root));
  const plan = await planRevert(config, root, {
    date: "2026-02-15T00:00:00Z",
    now: "2026-07-01T09:00:00Z",
  });
  // A target of four is neither what an engrave expresses nor what a retract
  // does, so the plan refuses it by name instead of approximating it.
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.refusals.length, 1);
  assert.equal(plan.refusals[0]?.reason, "unexpressible_target");
  assert.equal(plan.refusals[0]?.target, 4);
  assert.deepEqual(plan.refusals[0]?.reachable, [8, -1]);
  assert.ok(plan.text.includes("refused b_one"));
  assert.ok(plan.budget.chars > 0);
  assert.deepEqual(await readFile(beliefsPath(config, root)), bytes);
});

test("a revert adds a corrective move and never shortens the history", async (t) => {
  const { root, config } = await armedVault("open-brain-rollback-write-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(config, root, makeBelief("b_one"));
  // Retracted by a human hand, then reverted to the day before that.
  await revert(config, root, {
    date: BIRTH,
    now: "2026-02-01T09:00:00Z",
    write: true,
    ids: ["b_one"],
  });
  const retracted = await revert(config, root, {
    date: "2026-01-01T08:00:00Z",
    now: "2026-02-02T09:00:00Z",
    write: true,
  });
  assert.equal(retracted.plan.refusals[0]?.reason, "not_yet_born");

  // Bring a belief that has been engraved back to a state a cause can express.
  await addBelief(config, root, makeBelief("b_two"));
  const engraved = await revert(config, root, {
    date: "2026-06-01T09:00:00Z",
    now: "2026-06-01T09:00:00Z",
    write: true,
    ids: ["b_two"],
  });
  assert.equal(engraved.plan.entries.length, 0);
  assert.equal(engraved.plan.unchanged.length, 1);

  const document = await readBeliefDocument(config, root);
  const one = document.beliefs.find((belief) => belief.id === "b_one");
  assert.ok(one);
  assert.equal(one.history.length, 1, "an unreachable target must not have moved anything");
});

test("a belief retracted by hand comes back, and the way back is idempotent", async (t) => {
  const { root, config } = await armedVault("open-brain-rollback-idempotent-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(config, root, makeBelief("b_one"));
  // Take it to minus one first, which is exactly what a human retract expresses.
  const retracted = await revert(config, root, {
    date: "2026-01-01T09:00:00Z",
    now: "2026-03-01T09:00:00Z",
    write: true,
  });
  assert.equal(retracted.plan.unchanged.length, 1);

  await consumeVerdicts(
    config,
    root,
    [confirmed("b_one", "dec_20260401T0900_11111111", "2026-04-01T09:00:00Z")],
    { now: "2026-04-01T10:00:00Z" },
  );
  const moved = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(moved);
  assert.equal(moved.confidence, 4);

  // Coming back to the birth state means a target of three, which neither cause
  // expresses, so it is refused. Coming back to minus one is expressible.
  const plan = await planRevert(config, root, {
    date: "2026-01-01T09:00:00Z",
    now: "2026-05-01T09:00:00Z",
  });
  assert.equal(plan.refusals[0]?.reason, "unexpressible_target");

  const applied = await revert(config, root, {
    date: "2026-01-01T09:00:00Z",
    now: "2026-05-01T09:00:00Z",
    write: true,
  });
  assert.equal(applied.written, false);
  assert.equal(applied.plan.operation_id, "revert:2026-05-01T09:00:00Z");
});

test("a revert that does move something is a non event when it is replayed", async (t) => {
  const { root, config } = await armedVault("open-brain-rollback-replay-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  // A belief whose state at the target date is exactly what a retract expresses.
  const belief = makeBelief("b_one");
  const retracted: Belief = validateBelief({
    ...belief,
    confidence: -1,
    rank: "retired",
    locked: true,
    seen_at: "2026-02-02T09:00:00Z",
    moved_at: "2026-02-02T09:00:00Z",
    history: [
      ...belief.history,
      {
        ts: "2026-02-01T09:00:00Z",
        from: CONFIDENCE_CREATION,
        to: -1,
        cause: "human_retract",
        ref: "cli:retract",
      },
      {
        ts: "2026-02-02T09:00:00Z",
        from: -1,
        to: -1,
        cause: "human_retract",
        ref: "cli:retract-again",
      },
    ],
  }, { now: "2026-07-01T09:00:00Z" });
  const engraved: Belief = validateBelief({
    ...retracted,
    confidence: 8,
    rank: "law",
    moved_at: "2026-03-01T09:00:00Z",
    seen_at: "2026-03-01T09:00:00Z",
    history: [
      ...retracted.history,
      {
        ts: "2026-03-01T09:00:00Z",
        from: -1,
        to: 8,
        cause: "human_engrave",
        ref: "cli:engrave",
      },
    ],
  }, { now: "2026-07-01T09:00:00Z" });
  await addBelief(config, root, engraved);

  const first = await revert(config, root, {
    date: "2026-02-15T00:00:00Z",
    now: "2026-07-01T09:00:00Z",
    write: true,
  });
  assert.equal(first.written, true);
  assert.equal(first.plan.entries.length, 1);
  assert.equal(first.plan.entries[0]?.to, -1);
  assert.equal(first.plan.entries[0]?.cause, "human_retract");

  const back = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(back);
  assert.equal(back.confidence, -1);
  assert.equal(back.rank, "retired");
  assert.equal(back.locked, true);
  // Nothing was erased: the way back adds, it never rewinds.
  assert.equal(back.history.length, engraved.history.length + 1);
  assert.equal(back.history.at(-1)?.ref, "revert:2026-02-15T00:00:00Z");

  const bytes = await readFile(beliefsPath(config, root));
  const mtime = (await stat(beliefsPath(config, root))).mtimeMs;
  const replay = await revert(config, root, {
    date: "2026-02-15T00:00:00Z",
    now: "2026-07-01T09:00:00Z",
    write: true,
  });
  assert.equal(replay.written, false);
  assert.deepEqual(await readFile(beliefsPath(config, root)), bytes);
  assert.equal((await stat(beliefsPath(config, root))).mtimeMs, mtime);
});

test("the way back works while the layer is switched off", async (t) => {
  const { root, config } = await armedVault("open-brain-rollback-off-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await addBelief(config, root, makeBelief("b_one"));
  await mkdir(join(root, "10_memory", "learning"), { recursive: true });
  await writeFile(offFlagPath(config, root), '{"disabled_at":"2026-07-01T09:00:00Z"}\n', "utf8");

  // The sentinel stops what is autonomous and subtractive. A way back is
  // neither, so it keeps working: refusing here would be the opposite of the
  // service expected from it.
  const plan = await planRevert(config, root, {
    date: "2026-06-01T09:00:00Z",
    now: "2026-07-01T09:00:00Z",
  });
  assert.equal(plan.unchanged.length, 1);
});

test("a revert needs the learning capability and a real date", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-rollback-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    async () => planRevert(DEFAULT_CONFIG, root, { date: "2026-06-01T09:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning is disabled/u);
      return true;
    },
  );

  const { root: armed, config } = await armedVault("open-brain-rollback-date-");
  t.after(async () => rm(armed, { recursive: true, force: true }));
  await assert.rejects(
    async () => planRevert(config, armed, { date: "yesterday" }),
    (error: unknown) => {
      assert.ok(error instanceof RevertError);
      return true;
    },
  );
});
