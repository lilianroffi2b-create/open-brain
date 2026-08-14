import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_NAMES,
  describeCapability,
  type CapabilityName,
} from "../src/core/capabilities.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import {
  CAPABILITY_QUESTION_ORDER,
  CONSOLIDATE_CONFIRMATION_PHRASE,
  DEFAULT_QUESTION_CHARS,
  SCOPING_QUESTIONS,
  capabilityQuestion,
  formatScopingCommand,
  gateFor,
  nextCapabilityStep,
  renderCapabilityFraming,
  renderCapabilityQuestion,
  renderWalkPlan,
  skippedCapabilities,
  type CapabilityAnswer,
} from "../src/onboarding/questions.js";

/**
 * The walk as a pure model: what is asked, in which order, what is said before
 * the answer, and what is not offered at all once an earlier answer made it
 * meaningless. No file is touched by anything in this file.
 */

const EM_DASH = String.fromCodePoint(0x2014);

function answers(entries: Array<[CapabilityName, boolean]>): Map<CapabilityName, CapabilityAnswer> {
  return new Map(
    entries.map(([capability, armed]) => [capability, { capability, armed }]),
  );
}

test("the walk asks about every capability, from the least to the most engaging", () => {
  assert.deepEqual([...CAPABILITY_QUESTION_ORDER], [
    "hooks",
    "capture",
    "learning",
    "learning.evaluate",
    "transcripts",
    "classifier",
    "learning.consolidate",
  ]);
  assert.equal(CAPABILITY_QUESTION_ORDER.length, CAPABILITY_NAMES.length);
  for (const name of CAPABILITY_NAMES) {
    assert.ok(
      CAPABILITY_QUESTION_ORDER.includes(name),
      `${name} must be asked about, not shipped silently`,
    );
  }
  // The one that deletes is asked last, after everything else is understood.
  assert.equal(CAPABILITY_QUESTION_ORDER.at(-1), "learning.consolidate");
});

test("every question frames from describeCapability and states both outcomes", () => {
  for (const name of CAPABILITY_QUESTION_ORDER) {
    const question = capabilityQuestion(name);
    assert.equal(question.capability, name);
    // One source of truth: the question quotes the description, it never
    // paraphrases it into a friendlier second version.
    assert.equal(question.description, describeCapability(name));
    assert.ok(question.technical.length >= 2, `${name} must state its technical implications`);
    assert.ok(question.ifYes.length >= 2, `${name} must say what follows from a yes`);
    assert.ok(question.ifNo.length >= 2, `${name} must say what is lost by a no`);
    for (const line of [...question.technical, ...question.ifYes, ...question.ifNo]) {
      assert.ok(line.trim().length > 20, `${name} has a hollow line: ${line}`);
      assert.ok(!line.includes(EM_DASH), `${name} must not contain an em dash`);
    }
  }
});

test("a child is not offered when its parent was refused, and the reason is given", () => {
  const refusedLearning = answers([["hooks", false], ["capture", false], ["learning", false]]);
  const step = nextCapabilityStep(refusedLearning);
  assert.equal(step?.question.capability, "transcripts", "the evaluator must be skipped entirely");

  const skipped = skippedCapabilities(refusedLearning);
  const evaluate = skipped.find((item) => item.capability === "learning.evaluate");
  assert.ok(evaluate, "a skipped capability is never silently skipped");
  assert.match(evaluate.reason, /journal that learning writes/u);

  const armedLearning = answers([["hooks", true], ["capture", true], ["learning", true]]);
  assert.equal(nextCapabilityStep(armedLearning)?.question.capability, "learning.evaluate");
});

test("consolidation is offered only once the evaluator is armed", () => {
  const withoutEvaluator = answers([
    ["hooks", false],
    ["capture", false],
    ["learning", true],
    ["learning.evaluate", false],
    ["transcripts", false],
    ["classifier", false],
  ]);
  assert.equal(nextCapabilityStep(withoutEvaluator), undefined);
  const reason = skippedCapabilities(withoutEvaluator)
    .find((item) => item.capability === "learning.consolidate")?.reason;
  assert.match(String(reason), /the evaluator was not armed/u);

  const withEvaluator = new Map(withoutEvaluator);
  withEvaluator.set("learning.evaluate", { capability: "learning.evaluate", armed: true });
  assert.equal(
    nextCapabilityStep(withEvaluator)?.question.capability,
    "learning.consolidate",
  );
});

test("capture is still offered after a refused hooks, and says it becomes manual", () => {
  const gate = gateFor("capture", answers([["hooks", false]]));
  assert.equal(gate.ask, true);
  assert.ok(gate.ask && gate.notes.length === 1);
  const note = gate.ask ? gate.notes[0] ?? "" : "";
  assert.match(note, /manual mode/u);
  assert.match(note, /staging add/u);

  const armed = gateFor("capture", answers([["hooks", true]]));
  assert.deepEqual(armed.ask ? armed.notes : ["gate should ask"], []);
});

test("transcripts says a path is required before the answer, never after", () => {
  const question = capabilityQuestion("transcripts");
  assert.equal(question.requirement?.kind, "named-path");
  assert.match(String(question.requirement?.statement), /arms nothing on its own/u);
  assert.equal(question.followUp?.field, "roots");
  assert.equal(question.followUp?.required, true);

  const step = nextCapabilityStep(answers([
    ["hooks", false],
    ["capture", false],
    ["learning", false],
  ]));
  assert.equal(step?.question.capability, "transcripts");
  const rendered = renderCapabilityQuestion(step ?? { question, position: 1, total: 7, notes: [] });
  const requirementAt = rendered.text.indexOf("Before you answer:");
  const promptAt = rendered.text.indexOf(question.prompt);
  assert.ok(requirementAt > -1, "the requirement must be rendered");
  assert.ok(promptAt > requirementAt, "the framing must come before the question");
});

test("the classifier declares the money, the cap and where the cap is read", () => {
  const question = capabilityQuestion("classifier");
  assert.equal(question.requirement?.kind, "declared-cost");
  const statement = String(question.requirement?.statement);
  assert.match(statement, /only capability in Open Brain that costs money/u);
  assert.ok(
    statement.includes(String(DEFAULT_CONFIG.capabilities.classifier.daily_call_budget)),
    "the daily call budget must be the one a fresh vault ships with",
  );
  assert.match(statement, /daily_call_budget/u);
  assert.match(statement, /capabilities list/u);
  assert.match(statement, /classify --dry-run/u);
});

test("consolidation says it trims a document, that it is alone in doing so, and how it arms", () => {
  const question = capabilityQuestion("learning.consolidate");
  assert.equal(question.requirement?.kind, "dedicated-confirmation");
  const statement = String(question.requirement?.statement);
  assert.match(statement, /only capability in Open Brain that trims a document/u);
  assert.ok(statement.includes(CONSOLIDATE_CONFIRMATION_PHRASE));
  assert.match(statement, /No preset arms it/u);
  assert.match(statement, /--yes/u);
  assert.match(String(question.description.riskIfEnabled), /git/iu);
});

test("invariant I11: a question and a framing are capped and never silently cut", () => {
  for (let index = 0; index < CAPABILITY_QUESTION_ORDER.length; index += 1) {
    const previous = new Map<CapabilityName, CapabilityAnswer>();
    for (let earlier = 0; earlier < index; earlier += 1) {
      const name = CAPABILITY_QUESTION_ORDER[earlier];
      if (name !== undefined) {
        previous.set(name, { capability: name, armed: true });
      }
    }
    const step = nextCapabilityStep(previous);
    assert.ok(step, `step ${String(index)} should exist`);
    const rendered = renderCapabilityQuestion(step);
    assert.equal(rendered.budget.truncated, false, `${step.question.capability} must fit its cap`);
    assert.ok(
      rendered.budget.chars <= DEFAULT_QUESTION_CHARS,
      `${step.question.capability} must respect the cap`,
    );
    assert.ok(rendered.budget.token_estimate > 0);

    const tight = renderCapabilityQuestion(step, 600);
    assert.equal(tight.budget.truncated, true);
    assert.ok(tight.budget.chars <= 600);
    assert.match(tight.text, /TRUNCATED/u);
  }

  for (const name of CAPABILITY_NAMES) {
    const framing = renderCapabilityFraming(describeCapability(name));
    assert.equal(framing.budget.truncated, false);
    assert.ok(framing.budget.chars <= 2_000, `${name} explain must stay one screen`);
    for (const field of ["What it does", "What it reads", "What it writes", "What it costs", "Risk if armed", "How to turn it off"]) {
      assert.ok(framing.text.includes(field), `${name} framing must include ${field}`);
    }
  }
});

test("the walk preview stays a preview instead of pouring seven framings at once", () => {
  const walk = renderWalkPlan();
  assert.equal(walk.lines.length, CAPABILITY_QUESTION_ORDER.length);
  assert.equal(walk.rendered.budget.truncated, false);
  assert.ok(
    walk.rendered.budget.chars < 1_500,
    "a preview of the whole walk must cost far less than one framing per capability",
  );
  const framings = CAPABILITY_NAMES
    .map((name) => renderCapabilityFraming(describeCapability(name)).budget.chars)
    .reduce((total, chars) => total + chars, 0);
  assert.ok(walk.rendered.budget.chars * 5 < framings);
});

test("the preference framing questions come with their exact recording command", () => {
  assert.ok(SCOPING_QUESTIONS.length >= 8);
  const identity = SCOPING_QUESTIONS.filter((question) => question.layer === "identity");
  const style = SCOPING_QUESTIONS.filter((question) => question.layer === "working-style");
  const work = SCOPING_QUESTIONS.filter((question) => question.layer === "current-work");
  assert.ok(identity.length >= 3 && style.length >= 4 && work.length >= 3);

  const format = SCOPING_QUESTIONS.find((question) => question.id === "style.format");
  assert.ok(format);
  assert.equal(
    formatScopingCommand(format, 'Short blocks, no filler, "always" structured'),
    'open-brain prefs add --id answer-format --text "Short blocks, no filler, \\"always\\" structured" --weight 4',
  );
  assert.equal(formatScopingCommand(format, "   "), undefined);

  const freeMode = SCOPING_QUESTIONS.find((question) => question.id === "style.free-mode");
  assert.ok(freeMode?.choices);
  assert.equal(formatScopingCommand(freeMode, "calibrated"), "open-brain free-mode on");
  assert.equal(formatScopingCommand(freeMode, "off"), "open-brain free-mode off");
  // An answer that is neither choice arms nothing rather than guessing.
  assert.equal(formatScopingCommand(freeMode, "maybe"), undefined);
});

test("the walk terminates, and answering everything leaves nothing to ask", () => {
  const collected = new Map<CapabilityName, CapabilityAnswer>();
  const asked: CapabilityName[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const step = nextCapabilityStep(collected);
    if (step === undefined) {
      break;
    }
    asked.push(step.question.capability);
    collected.set(step.question.capability, {
      capability: step.question.capability,
      armed: true,
    });
  }
  assert.deepEqual(asked, [...CAPABILITY_QUESTION_ORDER]);
  assert.equal(nextCapabilityStep(collected), undefined);
  assert.deepEqual(skippedCapabilities(collected), []);
});
