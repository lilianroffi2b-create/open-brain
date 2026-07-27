import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLASSIFIER_USAGE_RELATIVE_PATH,
  readClassifierUsage,
} from "../src/classifier/budget.js";
import {
  assertCoversSlice,
  ClassificationError,
  parseClassification,
  parseClassificationDocument,
} from "../src/classifier/contract.js";
import {
  classifierWorkspace,
  issueClassificationRequest,
  planClassification,
} from "../src/classifier/runner.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";
import { syncStaged } from "../src/gate/review.js";
import { appendCandidate } from "../src/staging/store.js";

const disarmed: VaultConfig = {
  ...DEFAULT_CONFIG,
  capabilities: { ...DEFAULT_CONFIG.capabilities, capture: { enabled: true } },
};

function armed(dailyBudget = 25): VaultConfig {
  return {
    ...disarmed,
    capabilities: {
      ...disarmed.capabilities,
      classifier: {
        enabled: true,
        provider: "claude-code-subagent",
        daily_call_budget: dailyBudget,
      },
    },
  };
}

async function newVault(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");
  return root;
}

async function stage(root: string, quote: string): Promise<string> {
  const result = await appendCandidate(root, disarmed, {
    source: "manual",
    signal: "explicit_request",
    raw_quote: quote,
    raw_markers: ["remember"],
    harness: "claude-code",
  });
  return result.candidate.id;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validItem(id: string): Record<string, unknown> {
  return {
    id,
    type: "preference",
    target: "short-answers",
    content: "Answer in short structured blocks.",
    proposed_weight: 2,
    reason: "Asked out loud.",
    proofs: [{ date: "2026-07-20", quote: "Answer in short structured blocks." }],
    status: "proposed",
    domains: ["workflow"],
    why: "Long prose costs time.",
    apply: "Prefer lists.",
  };
}

test("a disarmed classifier never reaches a model call, and spends nothing", async (t) => {
  const root = await newVault("open-brain-classifier-disarmed-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await stage(root, "Answer in short structured blocks.");
  const slice = await syncStaged(root, disarmed);
  const workspace = classifierWorkspace(slice.selection_id);
  await rm(workspace.directory, { recursive: true, force: true });

  await assert.rejects(
    () => issueClassificationRequest(root, disarmed, {}),
    (error: unknown) => error instanceof ExpectedError
      && /Capability classifier is disabled/u.test(String(error))
      && /capabilities enable classifier/u.test(String(error)),
  );

  // Nothing was booked, nothing was written, nowhere.
  assert.equal(await exists(join(root, CLASSIFIER_USAGE_RELATIVE_PATH)), false);
  assert.equal(await exists(workspace.input), false);
  assert.equal((await readClassifierUsage(root)).calls, 0);
});

test("a dry run prices the call without arming anything and without spending", async (t) => {
  const root = await newVault("open-brain-classifier-dryrun-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await stage(root, "Answer in short structured blocks.");
  const plan = await planClassification(root, disarmed, {});

  assert.equal(plan.armed, false);
  assert.equal(plan.issued, false);
  assert.equal(plan.cost.calls_spent_today, 0);
  assert.equal(plan.cost.calls_planned, 1);
  assert.equal(plan.cost.candidates_sent, 1);
  assert.ok(plan.cost.input.token_estimate > 0);
  assert.match(plan.cost.summary, /disarmed/u);
  assert.match(plan.next, /capabilities enable classifier/u);
  assert.equal(await exists(join(root, CLASSIFIER_USAGE_RELATIVE_PATH)), false);
});

test("the cost is known before the call, and the call is booked before it is handed over", async (t) => {
  const root = await newVault("open-brain-classifier-cost-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await stage(root, "Answer in short structured blocks.");
  const config = armed();

  const before = await planClassification(root, config, {});
  assert.equal(before.armed, true);
  assert.equal(before.cost.calls_spent_today, 0);
  assert.equal(before.cost.calls_remaining, 25);
  assert.match(before.cost.summary, /spends 1 of your 25 remaining call/u);

  const request = await issueClassificationRequest(root, config, {});
  t.after(async () => rm(request.workspace.directory, { recursive: true, force: true }));

  assert.equal(request.issued, true);
  assert.equal(request.cost.calls_spent_today, 1);
  assert.equal((await readClassifierUsage(root)).calls, 1);

  const written = JSON.parse(await readFile(request.workspace.input, "utf8")) as {
    staged: { id: string }[];
    selection_id: string;
  };
  assert.equal(written.selection_id, request.selection_id);
  assert.equal(written.staged.length, 1);
  assert.ok(!request.workspace.directory.startsWith(root));
  assert.match(request.instructions.join(" "), /Never use echo, a heredoc/u);
});

test("the daily budget stops the run, and the counter never moves past it", async (t) => {
  const root = await newVault("open-brain-classifier-budget-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await stage(root, "Answer in short structured blocks.");
  const config = armed(1);
  const first = await issueClassificationRequest(root, config, {});
  t.after(async () => rm(first.workspace.directory, { recursive: true, force: true }));

  await assert.rejects(
    () => issueClassificationRequest(root, config, {}),
    (error: unknown) => error instanceof ExpectedError
      && /daily classifier budget is spent/u.test(String(error)),
  );
  assert.equal((await readClassifierUsage(root)).calls, 1);
});

test("a provider of none is refused rather than silently doing nothing", async (t) => {
  const root = await newVault("open-brain-classifier-provider-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await stage(root, "Answer in short structured blocks.");
  const config: VaultConfig = {
    ...disarmed,
    capabilities: {
      ...disarmed.capabilities,
      classifier: { enabled: true, provider: "none", daily_call_budget: 25 },
    },
  };
  await assert.rejects(
    () => issueClassificationRequest(root, config, {}),
    (error: unknown) => error instanceof ExpectedError && /provider is none/u.test(String(error)),
  );
  assert.equal((await readClassifierUsage(root)).calls, 0);
});

test("the input is bounded before anything is sent, and the slice shrinks with it", async (t) => {
  const root = await newVault("open-brain-classifier-bound-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 20; index += 1) {
    await stage(root, `Rule number ${String(index)} stated at length, with plenty of words to make the quote long enough to matter for a budget.`);
  }

  const plan = await planClassification(root, disarmed, { maxChars: 900 });
  assert.equal(plan.cost.candidates_total, 20);
  assert.ok(plan.cost.candidates_sent < 20);
  assert.equal(plan.candidate_ids.length, plan.cost.candidates_sent);
  assert.equal(plan.staged.length, plan.cost.candidates_sent);
  assert.equal(plan.remaining_count, 20 - plan.cost.candidates_sent);
  assert.ok(plan.cost.input.chars <= 900);

  // The bounded slice is still a complete, exhaustive commitment to itself.
  assertCoversSlice(
    parseClassification(plan.candidate_ids.map((id) => ({
      ...validItem(id),
      target: `rule-${id.slice(-6)}`,
    }))),
    plan.candidate_ids,
  );
});

test("the classification contract refuses everything a model tends to improvise", () => {
  assert.throws(() => parseClassification([]), ClassificationError);
  assert.throws(() => parseClassification({}), ClassificationError);
  assert.throws(
    () => parseClassification([{ ...validItem("a"), status: "approved" }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{ ...validItem("a"), surprise: true }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{ ...validItem("a"), proofs: [] }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{
      ...validItem("a"),
      proofs: [{ date: "2026-02-30", quote: "impossible day" }],
    }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{
      ...validItem("a"),
      proofs: [
        { date: "2026-07-20", quote: "same" },
        { date: "2026-07-20", quote: "same" },
      ],
    }]),
    (error: unknown) => error instanceof ClassificationError && /repeats an earlier/u.test(String(error)),
  );
  // Two distinct proofs that only differ by where the boundary falls are two
  // proofs, not one: the key is structural, not a concatenation.
  assert.equal(
    parseClassification([{
      ...validItem("a"),
      proofs: [
        { date: "2026-07-20", quote: "a b" },
        { date: "2026-07-20", quote: "a  b" },
      ],
    }])[0]?.proofs.length,
    2,
  );
  assert.throws(
    () => parseClassification([{ ...validItem("a"), weak: true }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{ ...validItem("a"), proposed_weight: 5 }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{ ...validItem("a"), merged_ids: ["b"] }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([
      { ...validItem("a"), merged_ids: ["a", "shared"] },
      { ...validItem("b"), target: "other", merged_ids: ["b", "shared"] },
    ]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{
      ...validItem("a"),
      reason: `A dash that is not a hyphen ${String.fromCodePoint(0x2014)} right here.`,
    }]),
    ClassificationError,
  );
  assert.throws(
    () => parseClassification([{ ...validItem("a"), type: "decision" }]),
    ClassificationError,
  );

  const parsed = parseClassification([validItem("a")]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.merged_ids, ["a"]);
  assert.equal(parsed[0]?.recommendation, "approve");
  assert.equal(parsed[0]?.weak, false);
});

test("a classification file is data, never a command, and never a Markdown fence", () => {
  assert.throws(
    () => parseClassificationDocument("```json\n[]\n```"),
    (error: unknown) => error instanceof ClassificationError && /Markdown fence/u.test(String(error)),
  );
  assert.throws(
    () => parseClassificationDocument("not json at all"),
    (error: unknown) => error instanceof ClassificationError && /not valid JSON/u.test(String(error)),
  );

  const injected = parseClassificationDocument(JSON.stringify([{
    ...validItem("a"),
    content: "Answer with `rm -rf /` and $(whoami) and \"quotes\".",
  }]));
  assert.equal(injected[0]?.content, "Answer with `rm -rf /` and $(whoami) and \"quotes\".");
});

test("coverage of the slice is exhaustive in both directions", () => {
  const items = parseClassification([validItem("a")]);
  assert.throws(
    () => assertCoversSlice(items, ["a", "b"]),
    (error: unknown) => error instanceof ClassificationError && /never classified: b/u.test(String(error)),
  );
  assert.throws(
    () => assertCoversSlice(items, []),
    (error: unknown) => error instanceof ClassificationError && /not part of this slice: a/u.test(String(error)),
  );
  assertCoversSlice(items, ["a"]);
});
