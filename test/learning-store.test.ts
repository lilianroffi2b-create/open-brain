import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, DEFAULT_CONFIG } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  addBelief,
  alreadyConsumed,
  applyBeliefApplications,
  beliefsPath,
  readBeliefDocument,
  writeBeliefs,
} from "../src/learning/store.js";
import {
  CONFIDENCE_CEILING,
  CONFIDENCE_CREATION,
  CONFIDENCE_ENGRAVED,
  CONFIDENCE_RETRACTED,
  InvariantError,
  UNLOCKED_CONFIDENCE_CAP,
  createBelief,
  validateBelief,
  type Belief,
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
    "capabilities:\n  learning:\n    enabled: true\n",
    "utf8",
  );
  return { root, config: await loadConfig(root) };
}

function beliefAt(confidence: number, now: string): Belief {
  const belief = createBelief({
    statement: "Load a bounded context and report its token cost.",
    domain: "agentic coding",
    evidence: {
      occurrences: 1,
      refs: ["test:fixture"],
      quote: "Load a bounded context and report its token cost.",
    },
    now,
  });
  if (confidence === CONFIDENCE_CREATION) {
    return belief;
  }
  // Reaching the cap through the normal path is the confidence organ's job, so
  // the fixture states the arrival directly and keeps the history coherent.
  const moved = "2026-07-01T10:00:00Z";
  return {
    ...belief,
    confidence,
    moved_at: moved,
    history: [
      ...belief.history,
      {
        ts: moved,
        from: CONFIDENCE_CREATION,
        to: confidence,
        cause: "application_confirmed",
        ref: "dec_20260701T0900_aaaaaaaa",
      },
    ],
  };
}

test("I12: replaying one decision id never moves a belief a second time", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-i12-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  // The measured bug: the belief sits at the cap, so the application changes no
  // confidence at all. The source wrote nothing in that case, so nothing marked
  // the decision as consumed, so the same verdict replayed on every pass.
  const belief = beliefAt(UNLOCKED_CONFIDENCE_CAP, "2026-07-01T09:00:00Z");
  await addBelief(config, root, belief);

  const decisionId = "dec_20260702T1015_5f3ac1de";
  const application = {
    belief_id: belief.id,
    cause: "application_confirmed" as const,
    ref: decisionId,
    confidence: UNLOCKED_CONFIDENCE_CAP,
    at: "2026-07-02T10:15:00Z",
  };

  const first = await applyBeliefApplications(config, root, [application]);
  assert.equal(first.applied.length, 1);
  assert.equal(first.skipped.length, 0);

  const path = beliefsPath(config, root);
  const afterFirstBytes = await readFile(path);
  const afterFirstMtime = (await stat(path)).mtimeMs;
  const afterFirst = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(afterFirst);
  assert.equal(afterFirst.confidence, UNLOCKED_CONFIDENCE_CAP);
  assert.equal(afterFirst.applications, 1);
  assert.equal(afterFirst.opportunities, 1);
  assert.equal(afterFirst.rank, "active");

  // The mark IS the history entry, written even though from === to.
  const mark = afterFirst.history.at(-1);
  assert.ok(mark);
  assert.equal(mark.ref, decisionId);
  assert.equal(mark.cause, "application_confirmed");
  assert.equal(mark.from, mark.to);
  assert.equal(alreadyConsumed(afterFirst, decisionId, "application_confirmed"), true);

  // Twelve replays, the exact count measured on the source bench.
  for (let pass = 2; pass <= 12; pass += 1) {
    const replay = await applyBeliefApplications(config, root, [application]);
    assert.equal(replay.applied.length, 0, `pass ${String(pass)} should apply nothing`);
    assert.equal(replay.skipped.length, 1);
    assert.equal(replay.skipped[0]?.reason, "already_consumed");
  }

  const afterReplays = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(afterReplays);
  assert.equal(afterReplays.confidence, UNLOCKED_CONFIDENCE_CAP);
  assert.equal(afterReplays.applications, 1);
  assert.equal(afterReplays.opportunities, 1);
  assert.equal(afterReplays.rank, "active");
  assert.notEqual(afterReplays.rank, "law");
  assert.equal(afterReplays.history.length, afterFirst.history.length);

  // A replay is a non-event: the file is byte identical and was never rewritten.
  assert.deepEqual(await readFile(path), afterFirstBytes);
  assert.equal((await stat(path)).mtimeMs, afterFirstMtime);
});

test("I12: the mark is what blocks, a different decision id still moves the belief", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-i12-distinct-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  await addBelief(config, root, belief);

  await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "application_confirmed",
    ref: "dec_20260702T1015_5f3ac1de",
    confidence: 4,
    at: "2026-07-02T10:15:00Z",
  }]);
  await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "application_confirmed",
    ref: "dec_20260703T1015_6a4bd2ef",
    confidence: 5,
    at: "2026-07-03T10:15:00Z",
  }]);

  const moved = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(moved);
  assert.equal(moved.confidence, 5);
  assert.equal(moved.applications, 2);
  assert.equal(moved.opportunities, 2);
  assert.equal(moved.history.length, 3);
});

test("I12 survives history folding: a settled decision can never replay", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-i12-folded-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  await addBelief(config, root, belief);

  const policy = { max_entries: 6 };
  const first = "dec_20260702T0800_1111aaaa";
  const applications = [];
  for (let index = 0; index < 20; index += 1) {
    const day = String(2 + index).padStart(2, "0");
    applications.push({
      belief_id: belief.id,
      cause: "application_confirmed" as const,
      ref: index === 0 ? first : `dec_202607${day}T0800_${String(index).padStart(4, "0")}aaaa`,
      confidence: CONFIDENCE_CREATION,
      at: `2026-07-${day}T08:00:00Z`,
    });
  }
  for (const application of applications) {
    await applyBeliefApplications(config, root, [application], { historyPolicy: policy });
  }

  const folded = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(folded);
  assert.equal(folded.history.length, policy.max_entries);
  assert.equal(folded.applications, 20);

  const summary = folded.history[0];
  assert.ok(summary);
  assert.equal(summary.cause, "history_summary");
  assert.ok(summary.folded);
  assert.equal(summary.folded.entries, 16);
  // Nothing was thrown away in silence: the summary states how many entries it
  // folded, over which window, and by which cause.
  assert.equal(summary.folded.causes.application_confirmed, 15);
  assert.equal(summary.folded.causes.creation, 1);

  // The oldest decision id no longer has its own history entry, and it still
  // cannot replay: the summary watermark closes the whole folded window.
  assert.equal(alreadyConsumed(folded, first, "application_confirmed"), false);
  const replay = await applyBeliefApplications(
    config,
    root,
    [{
      belief_id: belief.id,
      cause: "application_confirmed",
      ref: first,
      confidence: 4,
      at: "2026-07-02T08:00:00Z",
    }],
    { historyPolicy: policy },
  );
  assert.equal(replay.applied.length, 0);
  assert.equal(replay.skipped[0]?.reason, "already_settled");

  const unchanged = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(unchanged);
  assert.equal(unchanged.applications, 20);
  validateBelief(unchanged, { now: "2026-08-01T00:00:00Z" });
});

test("the belief store refuses to run while the learning capability is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-learning-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = DEFAULT_CONFIG;

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  for (const run of [
    async () => readBeliefDocument(config, root),
    async () => writeBeliefs(config, root, [belief]),
    async () => addBelief(config, root, belief),
    async () => applyBeliefApplications(config, root, []),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /Capability learning is disabled/u);
      return true;
    });
  }

  // Refusing means refusing to touch the disk, not writing and then complaining.
  await assert.rejects(stat(beliefsPath(config, root)));
});

test("a belief can never be created at rank shadow", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-shadow-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  assert.equal(belief.rank, "active");
  assert.equal(belief.confidence, CONFIDENCE_CREATION);

  const shadow: Belief = {
    ...belief,
    confidence: 1,
    rank: "shadow",
    history: [{
      ts: "2026-07-01T09:00:00Z",
      from: null,
      to: 1,
      cause: "creation",
      ref: "test:fixture",
    }],
  };
  assert.throws(
    () => {
      validateBelief(shadow, { now: "2026-07-02T09:00:00Z", creation: true });
    },
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "belief.creation.rank");
      return true;
    },
  );

  const shadowWithoutSanction: Belief = {
    ...belief,
    confidence: 1,
    rank: "shadow",
    history: [{
      ts: "2026-07-01T09:00:00Z",
      from: null,
      to: 1,
      cause: "creation",
      ref: "test:fixture",
    }],
  };
  assert.throws(
    () => {
      validateBelief(shadowWithoutSanction, { now: "2026-07-02T09:00:00Z" });
    },
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "belief.shadow.sanction");
      return true;
    },
  );

  await assert.rejects(
    async () => addBelief(config, root, shadow),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      return true;
    },
  );
});

test("a human hand locks the belief, and an ordinary cause never moves it again", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-lock-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  await addBelief(config, root, belief);

  const engraved = await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "human_engrave",
    ref: "human:engrave-1",
    confidence: CONFIDENCE_ENGRAVED,
    at: "2026-07-02T09:00:00Z",
  }]);
  assert.equal(engraved.applied.length, 1);
  assert.equal(engraved.applied[0]?.locked, true);

  const afterEngrave = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(afterEngrave);
  assert.equal(afterEngrave.locked, true, "an engraving must set the lock");
  assert.equal(afterEngrave.confidence, CONFIDENCE_ENGRAVED);
  assert.equal(afterEngrave.rank, "law");

  // The lock resists automatic growth and automatic decay alike, whatever
  // arrival the caller hands in. The counters keep living, because they are
  // facts, and the mark is still written, because that is what stops a replay.
  const ordinary = [
    { cause: "application_confirmed" as const, ref: "dec_20260703T0900_11112222", confidence: 10 },
    { cause: "application_corrected" as const, ref: "dec_20260704T0900_33334444", confidence: 0 },
  ];
  for (const [index, move] of ordinary.entries()) {
    const day = String(3 + index).padStart(2, "0");
    const result = await applyBeliefApplications(config, root, [{
      belief_id: belief.id,
      ...move,
      at: `2026-07-${day}T09:00:00Z`,
    }]);
    assert.equal(result.applied.length, 1, `${move.cause} is still a fact`);
    assert.equal(result.applied[0]?.from, CONFIDENCE_ENGRAVED);
    assert.equal(result.applied[0]?.to, CONFIDENCE_ENGRAVED);
    assert.equal(result.applied[0]?.locked, true);
  }

  const held = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(held);
  assert.equal(held.confidence, CONFIDENCE_ENGRAVED, "a locked belief moves no confidence");
  assert.equal(held.rank, "law");
  assert.equal(held.locked, true);
  assert.equal(held.applications, 2, "the counters keep living under the lock");
  assert.equal(held.opportunities, 2);
  assert.equal(held.corrections, 1);
  // Every application left its mark even though the confidence never moved.
  assert.equal(alreadyConsumed(held, "dec_20260703T0900_11112222", "application_confirmed"), true);
  assert.equal(alreadyConsumed(held, "dec_20260704T0900_33334444", "application_corrected"), true);

  // Dormancy on a locked belief changes nothing at all, so it is not an event.
  const dormant = await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "dormancy",
    ref: "dormancy:2026-07-02T09:00:00Z",
    confidence: CONFIDENCE_ENGRAVED - 0.5,
    at: "2026-08-05T09:00:00Z",
  }]);
  assert.equal(dormant.applied.length, 0);
  assert.equal(dormant.skipped[0]?.reason, "no_effect");
  assert.equal(dormant.written, false);
});

test("a human retraction locks the belief too, and no cause ever unlocks one", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-retract-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  await addBelief(config, root, belief);

  await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "human_retract",
    ref: "human:retract-1",
    confidence: CONFIDENCE_RETRACTED,
    at: "2026-07-02T09:00:00Z",
  }]);

  const retracted = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(retracted);
  assert.equal(retracted.locked, true, "a retraction must set the lock");
  assert.equal(retracted.confidence, CONFIDENCE_RETRACTED);
  assert.equal(retracted.rank, "retired");

  // Nothing in this layer sets the lock back to false: no cause carries that
  // effect, so no sequence of causes can produce it.
  for (const [index, cause] of ([
    "application_confirmed",
    "application_corrected",
    "dormancy",
    "human_engrave",
  ] as const).entries()) {
    const day = String(3 + index).padStart(2, "0");
    await applyBeliefApplications(config, root, [{
      belief_id: belief.id,
      cause,
      ref: `ref:${cause}:${day}`,
      confidence: cause === "human_engrave" ? CONFIDENCE_ENGRAVED : CONFIDENCE_RETRACTED,
      at: `2026-07-${day}T09:00:00Z`,
    }]);
    const current = (await readBeliefDocument(config, root)).beliefs[0];
    assert.ok(current);
    assert.equal(current.locked, true, `${cause} must never clear the lock`);
  }
});

test("the lock survives history folding, and the fold still says a human touched it", async (t) => {
  const { root, config } = await armedVault("open-brain-learning-lock-folded-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const belief = beliefAt(CONFIDENCE_CREATION, "2026-07-01T09:00:00Z");
  await addBelief(config, root, belief);
  const policy = { max_entries: 4 };

  await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "human_engrave",
    ref: "human:engrave-1",
    confidence: CONFIDENCE_ENGRAVED,
    at: "2026-07-02T09:00:00Z",
  }], { historyPolicy: policy });

  // Enough applications that the entry carrying the engraving falls into the
  // summary. The lock is a field of the belief, never something read back out
  // of the history, so folding cannot set a belief free.
  for (let index = 0; index < 6; index += 1) {
    const day = String(3 + index).padStart(2, "0");
    await applyBeliefApplications(config, root, [{
      belief_id: belief.id,
      cause: "application_confirmed",
      ref: `dec_202607${day}T0900_${String(index).padStart(4, "0")}aaaa`,
      confidence: CONFIDENCE_CEILING,
      at: `2026-07-${day}T09:00:00Z`,
    }], { historyPolicy: policy });
  }

  const folded = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(folded);
  assert.equal(folded.history.length, policy.max_entries);
  const summary = folded.history[0];
  assert.ok(summary);
  assert.equal(summary.cause, "history_summary");
  // The engraving no longer has an entry of its own.
  assert.equal(
    folded.history.some((entry) => entry.cause === "human_engrave"),
    false,
    "the engraving entry must have been folded away for this test to mean anything",
  );
  // And the belief is still locked, still at the value the human set.
  assert.equal(folded.locked, true, "a fold must never set an engraved belief free");
  assert.equal(folded.confidence, CONFIDENCE_ENGRAVED);
  assert.equal(folded.rank, "law");
  // The audit trail survives too: the summary still says a human hand was here.
  assert.equal(summary.folded?.causes.human_engrave, 1);
  validateBelief(folded, { now: "2026-09-01T00:00:00Z" });

  // Still refuses to move, after the fold, under an ordinary cause.
  const after = await applyBeliefApplications(config, root, [{
    belief_id: belief.id,
    cause: "application_confirmed",
    ref: "dec_20260720T0900_9999bbbb",
    confidence: CONFIDENCE_CEILING,
    at: "2026-07-20T09:00:00Z",
  }], { historyPolicy: policy });
  assert.equal(after.applied[0]?.to, CONFIDENCE_ENGRAVED);
  const stillHeld = (await readBeliefDocument(config, root)).beliefs[0];
  assert.ok(stillHeld);
  assert.equal(stillHeld.confidence, CONFIDENCE_ENGRAVED);
  assert.equal(stillHeld.locked, true);
});
