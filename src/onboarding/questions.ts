import { capText, type CapResult } from "../core/budget.js";
import {
  capabilityParent,
  describeCapability,
  type CapabilityDescription,
  type CapabilityName,
} from "../core/capabilities.js";
import { DEFAULT_CONFIG } from "../core/config.js";

/**
 * The onboarding walk as pure data. No file is read, no question is asked, no
 * byte is written here: run.ts drives this model in a terminal and the
 * openbrain-onboarding skill drives the same model in a conversation, so both
 * paths say exactly the same thing.
 *
 * Two rules shape everything below. The framing always comes before the answer,
 * because nobody should discover after the fact what they armed. And the walk
 * asks: it never decides, never recommends, and never treats silence as a yes.
 *
 * Every capability text comes from describeCapability. This file adds what a
 * question needs on top of a description: the technical implications, what
 * follows from a yes, what follows from a no, and what a yes is not enough to
 * arm on its own.
 */

const DEFAULT_DAILY_CALL_BUDGET = DEFAULT_CONFIG.capabilities.classifier.daily_call_budget;

export const DEFAULT_QUESTION_CHARS = 3_000;
export const DEFAULT_FRAMING_CHARS = 3_000;
export const DEFAULT_PLAN_CHARS = 2_500;

/** The exact words that arm the only capability that deletes. Nothing else does. */
export const CONSOLIDATE_CONFIRMATION_PHRASE = "enable learning.consolidate";

export type ScopingLayer = "identity" | "working-style" | "current-work";

export interface ScopingChoice {
  value: string;
  label: string;
  consequence: string;
  command: string;
}

export interface ScopingQuestion {
  kind: "scoping";
  id: string;
  layer: ScopingLayer;
  prompt: string;
  why: string;
  recordedIn: string;
  /** Command template with a {{answer}} placeholder, when an answer becomes one. */
  commandTemplate?: string;
  choices?: readonly ScopingChoice[];
}

/**
 * The preference framing questions the vault onboarding prompt already asks,
 * in the same order and with the same intent. They are listed here so a single
 * model describes the whole walk, and so the capability questions land where
 * the owner asked for them: right after the preference framing, before anything
 * technical is armed.
 *
 * These answers are not written by this module. They become preference ledger
 * entries and living state notes, which belong to their own commands, so the
 * walk reports the exact command for each answer instead of writing it.
 */
export const SCOPING_QUESTIONS: readonly ScopingQuestion[] = [
  {
    kind: "scoping",
    id: "identity.address",
    layer: "identity",
    prompt: "How should Open Brain address you?",
    why: "It is used in every handoff and every generated document.",
    recordedIn: "10_memory/_state.md, under Who.",
  },
  {
    kind: "scoping",
    id: "identity.work",
    layer: "identity",
    prompt: "What do you work on, in one sentence?",
    why: "It is the standing context every route is read against.",
    recordedIn: "10_memory/_state.md, under Who.",
  },
  {
    kind: "scoping",
    id: "identity.language",
    layer: "identity",
    prompt: "Which language do you want replies in?",
    why: "Open Brain itself is in English; your assistant answers in the language you name.",
    recordedIn: "10_memory/_state.md, under Who.",
  },
  {
    kind: "scoping",
    id: "style.format",
    layer: "working-style",
    prompt: "How long and how structured do you want answers?",
    why: "Answer shape is the preference that changes every single reply.",
    recordedIn: "The preference ledger, and the always-on core at weight 4 or more.",
    commandTemplate:
      "open-brain prefs add --id answer-format --text \"{{answer}}\" --weight 4",
  },
  {
    kind: "scoping",
    id: "style.tone",
    layer: "working-style",
    prompt: "What tone do you want, and what tone do you never want?",
    why: "Tone is easier to state once than to correct one reply at a time.",
    recordedIn: "The preference ledger.",
    commandTemplate: "open-brain prefs add --id tone --text \"{{answer}}\" --weight 3",
  },
  {
    kind: "scoping",
    id: "style.checkpoints",
    layer: "working-style",
    prompt: "When must your assistant stop and ask before acting?",
    why: "This is the boundary between help and damage, so it is stored as a law.",
    recordedIn: "The preference ledger, at weight 5 with status law.",
    commandTemplate:
      "open-brain prefs add --id ask-before-acting --text \"{{answer}}\" --weight 5 --status law",
  },
  {
    kind: "scoping",
    id: "style.hard-rules",
    layer: "working-style",
    prompt: "Is there a hard rule that must never be broken?",
    why: "A law is applied before anything else and is never traded away for convenience.",
    recordedIn: "The preference ledger, at weight 5 with status law.",
    commandTemplate:
      "open-brain prefs add --id hard-rule --text \"{{answer}}\" --weight 5 --status law",
  },
  {
    kind: "scoping",
    id: "style.free-mode",
    layer: "working-style",
    prompt: "Do you want Free Mode calibrated, or off?",
    why:
      "Free Mode is proactive assistant behaviour, not a provider tier and not a price. Calibrated asks only when an evidence-backed alternative materially changes the outcome, and may offer one deferrable idea after work is done.",
    recordedIn: "interaction.free_mode in 00_index/vault.config.yml.",
    choices: [
      {
        value: "off",
        label: "Off",
        consequence:
          "No checkpoints and no optional ideas. Your assistant does what you asked and stops there. This is what a skipped onboarding leaves behind.",
        command: "open-brain free-mode off",
      },
      {
        value: "calibrated",
        label: "Calibrated",
        consequence:
          "At most one checkpoint per request, only at a safe boundary, and at most one optional idea per session. A dismissed idea is never proposed again.",
        command: "open-brain free-mode on",
      },
    ],
  },
  {
    kind: "scoping",
    id: "work.goal",
    layer: "current-work",
    prompt: "What are you working on right now?",
    why: "The living state is read first in every session, so the next one resumes instead of restarting.",
    recordedIn: "10_memory/_state.md, under Current work.",
  },
  {
    kind: "scoping",
    id: "work.next-step",
    layer: "current-work",
    prompt: "What is the immediate next step?",
    why: "A handoff without a next step is a summary, and a summary does not resume work.",
    recordedIn: "10_memory/_state.md, under Handoff.",
  },
  {
    kind: "scoping",
    id: "work.blocker",
    layer: "current-work",
    prompt: "Is anything blocking you?",
    why: "A named blocker is the first thing a fresh session should look at.",
    recordedIn: "10_memory/_state.md, under Handoff.",
  },
];

/**
 * Something a yes alone does not settle, stated before the answer is given.
 * A named path is consent to a directory, not to a disk. A dedicated
 * confirmation is the separate word that arms the only subtractive capability.
 * A declared cost is the one capability that spends money saying so up front.
 */
export interface CapabilityRequirement {
  kind: "named-path" | "dedicated-confirmation" | "declared-cost";
  statement: string;
}

export interface CapabilityFollowUp {
  field: "roots" | "targets";
  prompt: string;
  help: string;
  required: boolean;
}

export interface CapabilityQuestion {
  kind: "capability";
  id: CapabilityName;
  capability: CapabilityName;
  prompt: string;
  description: CapabilityDescription;
  technical: readonly string[];
  ifYes: readonly string[];
  ifNo: readonly string[];
  parent?: CapabilityName;
  requirement?: CapabilityRequirement;
  followUp?: CapabilityFollowUp;
}

/**
 * From the least engaging to the most. Hooks and capture change nothing you
 * cannot see; the evaluator starts to move behaviour; transcripts reach outside
 * the vault; the classifier spends money; consolidation deletes. Asking in this
 * order means nobody meets the subtractive one while still working out what the
 * staging area is.
 */
export const CAPABILITY_QUESTION_ORDER: readonly CapabilityName[] = [
  "hooks",
  "capture",
  "learning",
  "learning.evaluate",
  "transcripts",
  "classifier",
  "learning.consolidate",
];

function question(
  capability: CapabilityName,
  parts: {
    prompt: string;
    technical: readonly string[];
    ifYes: readonly string[];
    ifNo: readonly string[];
    requirement?: CapabilityRequirement;
    followUp?: CapabilityFollowUp;
  },
): CapabilityQuestion {
  const parent = capabilityParent(capability);
  return {
    kind: "capability",
    id: capability,
    capability,
    prompt: parts.prompt,
    description: describeCapability(capability),
    technical: parts.technical,
    ifYes: parts.ifYes,
    ifNo: parts.ifNo,
    ...(parent === undefined ? {} : { parent }),
    ...(parts.requirement === undefined ? {} : { requirement: parts.requirement }),
    ...(parts.followUp === undefined ? {} : { followUp: parts.followUp }),
  };
}

const QUESTIONS: Record<CapabilityName, CapabilityQuestion> = {
  hooks: question("hooks", {
    prompt: "Arm hooks?",
    technical: [
      "Open Brain registers a single command, `open-brain hook <event>`, with your host CLI. There is no script to install and nothing to keep in sync.",
      "Wiring and arming are two different things. `open-brain hooks install` writes the entries in the host settings file; this capability decides whether they do anything. Wired but disarmed, a hook exits immediately without reading the vault.",
      "Every hook has a time budget of 2000 ms. Past it, it returns what it already has and stops. A hook never fails a session.",
      "The pre-effect guard lives in one of these hooks. Without hooks, the kernel is protected after the fact rather than before it.",
    ],
    ifYes: [
      "Session start injects your living state, prompt submission injects the reading route, and end of turn updates the handoff, without you asking for any of it.",
      "A tool call that would overwrite your preference kernel is refused before it runs, with a reason.",
      "You still choose the hosts. Nothing is wired until you run `open-brain hooks install`.",
    ],
    ifNo: [
      "Nothing runs on its own. Open Brain stays a set of commands you or your assistant call on purpose: `open-brain status`, `open-brain route`, `open-brain staging add`.",
      "The pre-effect guard does not run. `open-brain guard <tool>` still answers the same question on demand, before you run the command yourself.",
    ],
    followUp: {
      field: "targets",
      prompt: "Which hosts should be wired?",
      help: "claude-code, codex, both as a comma-separated list, or nothing to decide later. Leaving it empty arms the capability without wiring any host.",
      required: false,
    },
  }),
  capture: question("capture", {
    prompt: "Arm capture?",
    technical: [
      "Capture is deterministic and local. A configurable marker pre-filter decides whether a statement is worth staging; it authorises a look, it never decides what a thing means.",
      "It writes under 10_memory/staging/ and nowhere else. The preference kernel is out of its reach by construction, not by convention.",
      "Nothing staged is ever applied on its own. `open-brain sync` is where a human accepts or rejects, one item at a time.",
      "The markers, the caps and the windows live in your vault config, not in the code. The English defaults are generic on purpose, and you can replace them with your own words, in your own language.",
    ],
    ifYes: [
      "The staging area fills as you work, and you review it when it suits you.",
      "You inherit a review queue. That is the real cost of this one: noise you have to sort.",
    ],
    ifNo: [
      "The staging area still exists and still works. You or your assistant put things in it on purpose with `open-brain staging add`.",
      "Nothing is ever staged behind your back, so there is nothing to review that you did not choose to review.",
    ],
  }),
  learning: question("learning", {
    prompt: "Arm learning?",
    technical: [
      "Two organs, both observational: a decision journal and a set of sensors. They record what was routed, which preference applied, and what the vault looked like at the time.",
      "It concludes nothing and changes no behaviour. Turning observation into a conclusion is a separate capability, asked next.",
      "The history it keeps is capped by design. When the cap is reached the excess is summarised, not silently dropped.",
      "It is the parent of two capabilities: the evaluator, which concludes, and consolidation, which deletes. Neither can run without it.",
    ],
    ifYes: [
      "A journal builds up inside the vault, on disk, and never leaves your machine.",
      "The evaluator becomes available to arm. It is not armed by this answer.",
    ],
    ifNo: [
      "Nothing is recorded about your sessions, and the two capabilities that depend on the journal are not offered at all: they would read something that does not exist.",
      "You lose the ability to ask later what Open Brain did and whether it held up.",
    ],
  }),
  "learning.evaluate": question("learning.evaluate", {
    prompt: "Arm the evaluator?",
    technical: [
      "The evaluator reads the journal and the sensors and moves the confidence of each belief. It adds and updates; it removes nothing.",
      "A decision identifier is consumed exactly once. Replaying the same identifier never moves a belief a second time, whatever the day or the weight.",
      "Confidence changes what Open Brain proposes. This is the first capability in this walk that changes behaviour on its own.",
      "Every change is inspectable with `open-brain learn status` and reversible one at a time with `open-brain learn rollback`.",
    ],
    ifYes: [
      "Beliefs that hold up are applied more readily, and beliefs that do not lose ground.",
      "An unrepresentative stretch of sessions can bias what you get. Reading `open-brain learn status` from time to time is the price.",
    ],
    ifNo: [
      "The journal keeps recording and nothing acts on it. You can read it, and you can arm the evaluator later against the history already collected.",
      "Consolidation is not offered: it removes what the evaluator concluded, and there would be no conclusion.",
    ],
  }),
  transcripts: question("transcripts", {
    prompt: "Arm transcript reading?",
    requirement: {
      kind: "named-path",
      statement:
        "Answering yes here arms nothing on its own. Consent is per directory, never global: the next question asks which directory, and a yes with no directory named leaves transcripts disarmed. That is deliberate, and it is said now rather than discovered later.",
    },
    technical: [
      "This is the only capability that reads outside the vault root. Everything else in Open Brain stays inside its own directory.",
      "It reads only under the directories listed in capabilities.transcripts.roots. Nothing else on your disk is ever opened.",
      "Redaction is on by default. Secrets and obvious identifiers are stripped before anything is written into the vault. Turning it off is a separate edit to the config.",
      "What was derived is inspectable with `open-brain transcripts show` and removable with `open-brain transcripts purge`.",
    ],
    ifYes: [
      "Open Brain can learn from what actually happened in a session, not only from what you typed into it.",
      "Transcripts can contain secrets, client names, and file contents you never meant to keep. Redaction reduces that; it does not abolish it.",
    ],
    ifNo: [
      "Nothing outside this vault is ever opened. That is the default, and it is the strongest privacy position Open Brain has.",
      "You lose the richest source of candidates. What you state on purpose still gets captured.",
    ],
    followUp: {
      field: "roots",
      prompt: "Which directory may Open Brain read transcripts from?",
      help: "One absolute path, or several separated by commas. Nothing is armed without at least one.",
      required: true,
    },
  }),
  classifier: question("classifier", {
    prompt: "Arm the classifier?",
    requirement: {
      kind: "declared-cost",
      statement:
        `This is the only capability in Open Brain that costs money. Everything else is local and free. Armed, a run makes model calls billed by whichever provider your CLI is configured against, capped at ${String(DEFAULT_DAILY_CALL_BUDGET)} calls per day by capabilities.classifier.daily_call_budget in 00_index/vault.config.yml. The cap in force is printed by \`open-brain capabilities list\`, and \`open-brain classify --dry-run\` prints what would be sent and what it would spend before a single call is made.`,
    },
    technical: [
      "It reads staged candidates and nothing else. It never reads transcripts directly and never reads the preference kernel.",
      "Its input is bounded before any call, so a large staging area cannot turn into a large bill.",
      "A run stops when the daily budget is spent. Raising the cap is an explicit edit to the config, never something a run does for you.",
      "Arming it sets the provider to claude-code-subagent, the only provider available today. A classifier armed with provider none would never classify anything.",
    ],
    ifYes: [
      "Candidates reach your review typed, scored and deduplicated instead of as raw text.",
      "The text of staged candidates leaves your machine through your provider, and you pay for it.",
    ],
    ifNo: [
      "Open Brain makes no model call at all, so it costs nothing at all, which is the default it ships with.",
      "Candidates reach your review as you staged them. `open-brain sync` still works, with more reading on your side.",
    ],
  }),
  "learning.consolidate": question("learning.consolidate", {
    prompt: "Arm consolidation?",
    requirement: {
      kind: "dedicated-confirmation",
      statement:
        `This is the only capability in Open Brain that trims a document rather than appending to it. A yes here is not enough: you are then asked to type ${CONSOLIDATE_CONFIRMATION_PHRASE} exactly. No preset arms it, no global --yes arms it, and arming its parent does not arm it.`,
    },
    technical: [
      "It folds the overflow of one document you name into that document's own archive, leaving a pointer behind. It never touches beliefs or their confidence.",
      "It refuses to run in autonomy unless its byte-for-byte reversibility test passes. That safety catch is in the code, not in a guideline.",
      "It takes a cross-process lock before it touches anything, so two runs can never race.",
      "The way back does not need git: `--restore --confirm <path>` restores the document from its own archive on any vault.",
    ],
    ifYes: [
      "A document you name stops growing without bound: its overflow moves to its archive.",
      "Content moves, it does not vanish: it sits in the archive until restored. Arm this deliberately.",
    ],
    ifNo: [
      "This capability never runs. The living state still gets trimmed by the end-of-turn hook on its own when it passes its ceiling; that is separate and does not need this armed.",
      "This is the default, and it is the right default for anyone who is not sure.",
    ],
  }),
};

export function capabilityQuestion(name: CapabilityName): CapabilityQuestion {
  return QUESTIONS[name];
}

export interface CapabilityAnswer {
  capability: CapabilityName;
  armed: boolean;
  roots?: readonly string[];
  targets?: readonly string[];
  /** Present only for learning.consolidate, and only when typed in full. */
  confirmation?: string;
}

export type CapabilityAnswers = ReadonlyMap<CapabilityName, CapabilityAnswer>;

export type QuestionGate =
  | { ask: true; notes: readonly string[] }
  | { ask: false; reason: string };

function armed(answers: CapabilityAnswers, name: CapabilityName): boolean {
  return answers.get(name)?.armed === true;
}

function declined(answers: CapabilityAnswers, name: CapabilityName): boolean {
  const answer = answers.get(name);
  return answer !== undefined && !answer.armed;
}

/**
 * Whether a capability is still worth asking about given what has been answered
 * so far, and what has to be said alongside the question when an earlier refusal
 * changes what a yes would mean.
 *
 * A dependency is never a silent skip: a capability that is not offered says why
 * it is not offered, and a capability whose usefulness shrank says by how much.
 */
export function gateFor(name: CapabilityName, answers: CapabilityAnswers): QuestionGate {
  if (name === "learning.evaluate" && !armed(answers, "learning")) {
    return {
      ask: false,
      reason:
        "learning was not armed, and the evaluator reads the journal that learning writes. Arming learning later makes this question available again.",
    };
  }
  if (name === "learning.consolidate" && !armed(answers, "learning.evaluate")) {
    return {
      ask: false,
      reason:
        "the evaluator was not armed, and consolidation removes what the evaluator concluded. Arming the evaluator later makes this question available again.",
    };
  }

  const notes: string[] = [];
  if (name === "capture" && declined(answers, "hooks")) {
    notes.push(
      "You declined hooks, so nothing will trigger capture on its own. Armed, capture applies to what you or your assistant put through it, which is capture in manual mode: `open-brain staging add` and the commands you run yourself. Arming hooks later turns the automatic side on.",
    );
  }
  if (name === "classifier" && declined(answers, "capture")) {
    notes.push(
      "You declined capture, so the classifier will only ever see candidates you staged by hand. That is a smaller queue and a smaller bill.",
    );
  }
  return { ask: true, notes };
}

export interface CapabilityStep {
  question: CapabilityQuestion;
  /** Position in the full ordered walk, so a skipped question is visibly skipped. */
  position: number;
  total: number;
  notes: readonly string[];
}

export interface SkippedCapability {
  capability: CapabilityName;
  reason: string;
}

/**
 * The next question to ask, or undefined when the walk is over. One question at
 * a time is the whole point: the full framing of seven capabilities is dense,
 * and pouring all of it into a context at once would defeat the reason this
 * product exists.
 */
export function nextCapabilityStep(answers: CapabilityAnswers): CapabilityStep | undefined {
  const total = CAPABILITY_QUESTION_ORDER.length;
  for (let index = 0; index < total; index += 1) {
    const name = CAPABILITY_QUESTION_ORDER[index];
    if (name === undefined || answers.has(name)) {
      continue;
    }
    const gate = gateFor(name, answers);
    if (!gate.ask) {
      continue;
    }
    return {
      question: capabilityQuestion(name),
      position: index + 1,
      total,
      notes: gate.notes,
    };
  }
  return undefined;
}

/** Capabilities that were not offered, each with the reason it was not offered. */
export function skippedCapabilities(answers: CapabilityAnswers): SkippedCapability[] {
  const skipped: SkippedCapability[] = [];
  for (const name of CAPABILITY_QUESTION_ORDER) {
    if (answers.has(name)) {
      continue;
    }
    const gate = gateFor(name, answers);
    if (!gate.ask) {
      skipped.push({ capability: name, reason: gate.reason });
    }
  }
  return skipped;
}

function quoteForShell(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/"/gu, '\\"');
}

/**
 * Turns a scoping answer into the exact command that records it. The walk never
 * runs these: preferences and living state have their own commands and their own
 * review boundary, and onboarding writing them behind a single confirmation
 * would blur that boundary.
 */
export function formatScopingCommand(
  question: ScopingQuestion,
  answer: string,
): string | undefined {
  const text = quoteForShell(answer);
  if (text.length === 0) {
    return undefined;
  }
  if (question.choices) {
    return question.choices.find((choice) => choice.value === text)?.command;
  }
  return question.commandTemplate?.replace("{{answer}}", text.slice(0, 240));
}

function framingLines(description: CapabilityDescription): string[] {
  return [
    `What it does: ${description.whatItDoes}`,
    `What it reads: ${description.whatItReads}`,
    `What it writes: ${description.whatItWrites}`,
    `What it costs: ${description.whatItCosts}`,
    `Risk if armed: ${description.riskIfEnabled}`,
    `How to turn it off: ${description.howToDisable}`,
  ];
}

/**
 * The shared framing block. `capabilities explain` and every question in the
 * walk render from this one function, so there is exactly one wording of what a
 * capability does and nowhere for a second, friendlier version to appear.
 */
export function renderCapabilityFraming(
  description: CapabilityDescription,
  maxChars = DEFAULT_FRAMING_CHARS,
): CapResult {
  const lines = [
    `${description.name}: ${description.title}`,
    ...(description.parent === undefined
      ? []
      : [`Parent capability: ${description.parent}. It never runs while ${description.parent} is disarmed.`]),
    "",
    ...framingLines(description),
  ];
  return capText(lines.join("\n"), maxChars);
}

function bullets(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `  - ${item}`)];
}

/**
 * One question, framed then asked, in that order. The prompt is the last line
 * because the answer must never come before the framing.
 */
export function renderCapabilityQuestion(
  step: CapabilityStep,
  maxChars = DEFAULT_QUESTION_CHARS,
): CapResult {
  const { question: item, notes } = step;
  const lines = [
    `[${String(step.position)}/${String(step.total)}] ${item.description.title}`,
    "",
    ...framingLines(item.description),
    ...bullets("Technically:", item.technical),
    ...bullets("If you say yes:", item.ifYes),
    ...bullets("If you say no:", item.ifNo),
    ...bullets("Given your earlier answers:", notes),
    ...(item.requirement === undefined
      ? []
      : ["", "Before you answer:", `  ${item.requirement.statement}`]),
    "",
    `${item.prompt} Nothing is armed by an empty answer.`,
  ];
  return capText(lines.join("\n"), maxChars);
}

/** The opening sentence of a framing, used where only one line fits. */
function firstSentence(text: string): string {
  const end = text.indexOf(". ");
  return end === -1 ? text : text.slice(0, end + 1);
}

export interface PlanLine {
  capability: CapabilityName;
  position: number;
  title: string;
  headline: string;
}

/**
 * The whole walk in one line per capability, for someone deciding whether to
 * start it. Invariant I11: a preview of seven capabilities has to stay a
 * preview, so the framing itself is reached one capability at a time through
 * `capabilities explain`.
 */
export function renderWalkPlan(maxChars = DEFAULT_PLAN_CHARS): {
  lines: PlanLine[];
  rendered: CapResult;
} {
  const lines: PlanLine[] = CAPABILITY_QUESTION_ORDER.map((name, index) => {
    const item = capabilityQuestion(name);
    return {
      capability: name,
      position: index + 1,
      title: item.description.title,
      headline: firstSentence(
        item.requirement?.statement ?? item.description.riskIfEnabled,
      ),
    };
  });
  const rendered = capText(
    lines
      .map((line) => `${String(line.position)}. ${line.capability}: ${line.title}. ${line.headline}`)
      .join("\n"),
    maxChars,
  );
  return { lines, rendered };
}
