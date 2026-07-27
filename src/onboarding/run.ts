import { createInterface } from "node:readline/promises";

import { estimateTokens, type ContextBudget } from "../core/budget.js";
import type { CapabilityName } from "../core/capabilities.js";
import { ExpectedError } from "../core/errors.js";
import type { VaultConfig } from "../core/types.js";
import {
  applyCapabilities,
  planCapabilities,
  type CapabilityPlan,
  type CapabilityRequest,
} from "./apply.js";
import {
  CAPABILITY_QUESTION_ORDER,
  CONSOLIDATE_CONFIRMATION_PHRASE,
  DEFAULT_QUESTION_CHARS,
  SCOPING_QUESTIONS,
  formatScopingCommand,
  nextCapabilityStep,
  renderCapabilityQuestion,
  skippedCapabilities,
  type CapabilityAnswer,
  type ScopingQuestion,
  type SkippedCapability,
} from "./questions.js";

/**
 * The interactive walk. It asks, it frames before it asks, and it writes once,
 * at the end, behind a single confirmation.
 *
 * Everything here is built so that stopping early is safe. No answer is applied
 * as it is given, so quitting halfway leaves a vault with every capability
 * disarmed, which is a vault that works. The empty answer is never a yes: the
 * enter key skips, and skipping leaves the capability disarmed.
 *
 * Input and output go through OnboardingIo rather than straight to the terminal,
 * so the whole walk can be driven by a scripted transcript in a test and by a
 * real readline in a terminal, with the same code deciding what gets armed.
 */

export interface OnboardingIo {
  interactive: boolean;
  ask(prompt: string): Promise<string>;
  write(text: string): void;
  close(): Promise<void>;
}

export type Consent = "yes" | "no" | "skip" | "quit" | "unclear";

const YES = new Set(["y", "yes"]);
const NO = new Set(["n", "no"]);
const QUIT = new Set(["q", "quit", "exit", "stop"]);

/**
 * An empty answer is a skip and never a yes. That is the whole reason this is a
 * function and not an inline truthiness check: a default that arms would turn
 * the enter key into consent.
 */
export function readConsent(raw: string): Consent {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return "skip";
  }
  if (YES.has(value)) {
    return "yes";
  }
  if (NO.has(value)) {
    return "no";
  }
  if (QUIT.has(value)) {
    return "quit";
  }
  return "unclear";
}

export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true;
}

export function createTerminalIo(): OnboardingIo {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    interactive: true,
    async ask(prompt: string): Promise<string> {
      return await readline.question(prompt);
    },
    write(text: string): void {
      process.stdout.write(text + "\n");
    },
    async close(): Promise<void> {
      readline.close();
      await Promise.resolve();
    },
  };
}

/**
 * The io used when standard input is not a terminal. It can still print, so the
 * caller gets an explanation instead of silence, and asking throws rather than
 * blocking forever on a stream nobody is typing into.
 */
export function createNonInteractiveIo(): OnboardingIo {
  return {
    interactive: false,
    async ask(): Promise<string> {
      await Promise.resolve();
      throw new ExpectedError(
        "The onboarding walk cannot ask a question when standard input is not a terminal.",
      );
    },
    write(text: string): void {
      process.stdout.write(text + "\n");
    },
    async close(): Promise<void> {
      await Promise.resolve();
    },
  };
}

export interface ScopingAnswerRecord {
  id: string;
  answer: string;
  command: string | null;
}

export type OnboardingStatus =
  | "applied"
  | "dry-run"
  | "declined"
  | "abandoned"
  | "nothing-to-do"
  | "not-interactive";

export interface OnboardingRunResult {
  root: string;
  interactive: boolean;
  status: OnboardingStatus;
  answers: CapabilityAnswer[];
  skipped: SkippedCapability[];
  scoping: ScopingAnswerRecord[];
  plan: CapabilityPlan | null;
  applied: boolean;
  next_commands: string[];
  resume: string;
  budget: ContextBudget;
}

export interface RunOnboardingOptions {
  root: string;
  config: VaultConfig;
  io: OnboardingIo;
  dryRun?: boolean;
  maxChars?: number;
}

const RESUME_COMMAND = "open-brain onboarding --interactive";
const NOT_INTERACTIVE_RESUME =
  `This walk asks one question at a time, so it needs a terminal. Standard input is not a terminal here, so nothing was asked and nothing was written: every capability is still disarmed and the vault works as it is. Run \`${RESUME_COMMAND}\` from a terminal, or ask your assistant to run the openbrain-onboarding skill, which asks the same questions in conversation and arms with \`open-brain capabilities enable\`.`;

interface Meter {
  chars: number;
  shown: number;
  truncated: boolean;
}

function emit(io: OnboardingIo, meter: Meter, text: string): void {
  meter.chars += text.length;
  io.write(text);
}

function budgetOf(meter: Meter): ContextBudget {
  return {
    chars: meter.chars,
    token_estimate: estimateTokens("x".repeat(meter.chars)),
    items_shown: meter.shown,
    items_total: CAPABILITY_QUESTION_ORDER.length,
    truncated: meter.truncated,
  };
}

function renderScoping(question: ScopingQuestion): string {
  const lines = [
    question.prompt,
    `  Why: ${question.why}`,
    `  Recorded in: ${question.recordedIn}`,
  ];
  for (const choice of question.choices ?? []) {
    lines.push(`  ${choice.value}: ${choice.label}. ${choice.consequence}`);
  }
  lines.push("  Press enter to skip. Nothing is recorded from a skipped question.");
  return lines.join("\n");
}

async function askScoping(
  io: OnboardingIo,
  meter: Meter,
  records: ScopingAnswerRecord[],
): Promise<boolean> {
  for (const question of SCOPING_QUESTIONS) {
    emit(io, meter, renderScoping(question));
    const raw = (await io.ask("> ")).trim();
    if (QUIT.has(raw.toLowerCase())) {
      return false;
    }
    if (raw.length === 0) {
      continue;
    }
    const command = formatScopingCommand(question, raw);
    records.push({ id: question.id, answer: raw, command: command ?? null });
  }
  return true;
}

/**
 * Asks one yes or no question, re-asking on an answer that is neither. After
 * two unclear answers the question is treated as a no and says so, because
 * guessing at consent is the one thing this walk must never do.
 */
async function askConsent(io: OnboardingIo, prompt: string): Promise<Consent> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const consent = readConsent(await io.ask(prompt));
    if (consent !== "unclear") {
      return consent;
    }
    io.write(
      "Answer y for yes, n for no, enter to skip, or q to stop the walk. Nothing is armed until you say yes.",
    );
  }
  io.write("Still unclear, so this one is left disarmed.");
  return "no";
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

interface FollowUpOutcome {
  armed: boolean;
  roots: string[];
  targets: string[];
  confirmation: string | undefined;
}

async function askFollowUps(
  io: OnboardingIo,
  capability: CapabilityName,
  followUp: { field: "roots" | "targets"; prompt: string; help: string; required: boolean } | undefined,
): Promise<FollowUpOutcome> {
  const outcome: FollowUpOutcome = {
    armed: true,
    roots: [],
    targets: [],
    confirmation: undefined,
  };

  if (followUp !== undefined) {
    io.write(`${followUp.prompt} ${followUp.help}`);
    const values = splitList(await io.ask("> "));
    if (followUp.field === "roots") {
      outcome.roots = values;
    } else {
      outcome.targets = values;
    }
    if (values.length === 0 && followUp.required) {
      io.write(
        `No directory was named, so ${capability} stays disarmed. That was said before the question: consent is per directory, never in general.`,
      );
      outcome.armed = false;
      return outcome;
    }
  }

  if (capability === "learning.consolidate") {
    io.write(
      `Type ${CONSOLIDATE_CONFIRMATION_PHRASE} to arm the only capability that deletes. Anything else leaves it disarmed.`,
    );
    const typed = (await io.ask("> ")).trim();
    if (typed !== CONSOLIDATE_CONFIRMATION_PHRASE) {
      io.write(
        "That is not the confirmation, so consolidation stays disarmed. Nothing will be deleted.",
      );
      outcome.armed = false;
      return outcome;
    }
    outcome.confirmation = typed;
  }

  return outcome;
}

function toRequests(answers: readonly CapabilityAnswer[]): CapabilityRequest[] {
  return answers
    .filter((answer) => answer.armed)
    .map((answer) => ({
      capability: answer.capability,
      enable: true,
      ...(answer.roots === undefined ? {} : { roots: answer.roots }),
      ...(answer.targets === undefined ? {} : { targets: answer.targets }),
      ...(answer.confirmation === undefined ? {} : { confirmation: answer.confirmation }),
    }));
}

function renderRecap(
  plan: CapabilityPlan,
  answers: readonly CapabilityAnswer[],
  skipped: readonly SkippedCapability[],
  nextCommands: readonly string[],
): string {
  const lines = ["", "Recap. Nothing has been written yet.", ""];

  const armed = answers.filter((answer) => answer.armed).map((answer) => answer.capability);
  const refused = answers.filter((answer) => !answer.armed).map((answer) => answer.capability);
  lines.push(`You said yes to: ${armed.length === 0 ? "nothing" : armed.join(", ")}`);
  lines.push(`You said no to: ${refused.length === 0 ? "nothing" : refused.join(", ")}`);
  for (const item of skipped) {
    lines.push(`Not offered, ${item.capability}: ${item.reason}`);
  }

  lines.push("", `Exactly what would be written to ${plan.config_path}:`);
  if (plan.writes.length === 0) {
    lines.push("  nothing. Every capability stays as it is, which means disarmed.");
  } else {
    for (const write of plan.writes) {
      lines.push(`  ${write.key}: ${write.before} -> ${write.after}`);
    }
    lines.push("  Nothing else in that file is touched, comments included.");
  }

  for (const refusal of plan.refusals) {
    lines.push("", `Refused: ${refusal}`);
  }
  for (const note of plan.notes) {
    lines.push(`Note: ${note}`);
  }

  if (nextCommands.length > 0) {
    lines.push(
      "",
      "Your preference answers are not written by this walk. They have their own review boundary, so here are the exact commands:",
    );
    for (const command of nextCommands) {
      lines.push(`  ${command}`);
    }
  }

  return lines.join("\n");
}

function result(
  options: RunOnboardingOptions,
  status: OnboardingStatus,
  parts: {
    answers: CapabilityAnswer[];
    skipped: SkippedCapability[];
    scoping: ScopingAnswerRecord[];
    plan: CapabilityPlan | null;
    applied: boolean;
    nextCommands: string[];
    resume: string;
    meter: Meter;
  },
): OnboardingRunResult {
  return {
    root: options.root,
    interactive: options.io.interactive,
    status,
    answers: parts.answers,
    skipped: parts.skipped,
    scoping: parts.scoping,
    plan: parts.plan,
    applied: parts.applied,
    next_commands: parts.nextCommands,
    resume: parts.resume,
    budget: budgetOf(parts.meter),
  };
}

/**
 * Walks the questions and, only after a single confirmation, applies the
 * capability answers. Every early exit returns the same shape, so a caller
 * never has to guess whether a partial walk wrote anything: it did not.
 */
export async function runOnboarding(
  options: RunOnboardingOptions,
): Promise<OnboardingRunResult> {
  const meter: Meter = { chars: 0, shown: 0, truncated: false };
  const answers = new Map<CapabilityName, CapabilityAnswer>();
  const scoping: ScopingAnswerRecord[] = [];
  const maxChars = options.maxChars ?? DEFAULT_QUESTION_CHARS;

  const finish = (
    status: OnboardingStatus,
    plan: CapabilityPlan | null,
    applied: boolean,
    resume: string,
  ): OnboardingRunResult => result(options, status, {
    answers: [...answers.values()],
    skipped: skippedCapabilities(answers),
    scoping,
    plan,
    applied,
    nextCommands: scoping
      .map((record) => record.command)
      .filter((command): command is string => command !== null),
    resume,
    meter,
  });

  if (!options.io.interactive) {
    // Nothing was asked, so nothing was skipped either: reporting a skip here
    // would suggest a walk happened.
    return result(options, "not-interactive", {
      answers: [],
      skipped: [],
      scoping: [],
      plan: null,
      applied: false,
      nextCommands: [],
      resume: NOT_INTERACTIVE_RESUME,
      meter,
    });
  }

  emit(options.io, meter, [
    "Open Brain onboarding.",
    "",
    "Every capability ships whole and disarmed. This walk asks about each one, tells you what it does, what it reads, what it writes, what it costs and how to turn it off, and then asks. It never recommends.",
    "Nothing is written until the end, behind one confirmation. Press enter to skip a question, which leaves that capability disarmed. Type q at any point to stop: stopping writes nothing.",
  ].join("\n"));

  if (!await askScoping(options.io, meter, scoping)) {
    return finish(
      "abandoned",
      null,
      false,
      `You stopped during the preference questions. Nothing was written and every capability is still disarmed. Run \`${RESUME_COMMAND}\` to start again.`,
    );
  }

  for (;;) {
    const step = nextCapabilityStep(answers);
    if (step === undefined) {
      break;
    }
    const rendered = renderCapabilityQuestion(step, maxChars);
    meter.truncated = meter.truncated || rendered.budget.truncated;
    meter.shown += 1;
    emit(options.io, meter, "");
    emit(options.io, meter, rendered.text);

    const consent = await askConsent(options.io, "> ");
    if (consent === "quit") {
      return finish(
        "abandoned",
        null,
        false,
        `You stopped at ${step.question.capability}. Nothing was written and every capability is still disarmed, which is a vault that works. Run \`${RESUME_COMMAND}\` to start again, or arm one capability at a time with \`open-brain capabilities enable <name>\`.`,
      );
    }
    if (consent !== "yes") {
      answers.set(step.question.capability, {
        capability: step.question.capability,
        armed: false,
      });
      continue;
    }

    const followUp = await askFollowUps(
      options.io,
      step.question.capability,
      step.question.followUp,
    );
    answers.set(step.question.capability, {
      capability: step.question.capability,
      armed: followUp.armed,
      ...(followUp.roots.length === 0 ? {} : { roots: followUp.roots }),
      ...(followUp.targets.length === 0 ? {} : { targets: followUp.targets }),
      ...(followUp.confirmation === undefined ? {} : { confirmation: followUp.confirmation }),
    });
  }

  const requests = toRequests([...answers.values()]);
  const plan = await planCapabilities(options.root, options.config, requests);
  const nextCommands = scoping
    .map((record) => record.command)
    .filter((command): command is string => command !== null);
  emit(
    options.io,
    meter,
    renderRecap(plan, [...answers.values()], skippedCapabilities(answers), nextCommands),
  );

  if (!plan.changes_anything) {
    return finish(
      "nothing-to-do",
      plan,
      false,
      "Nothing to write: every capability is already in the state you asked for, which for a fresh vault means fully disarmed. That vault works. Arm anything later with `open-brain capabilities enable <name>`.",
    );
  }

  if (options.dryRun === true) {
    return finish(
      "dry-run",
      plan,
      false,
      `This was a dry run, so nothing was written. Run \`${RESUME_COMMAND}\` without --dry-run to answer again and apply.`,
    );
  }

  const confirmed = await askConsent(
    options.io,
    `Write these changes to ${plan.config_path}? [y/N] `,
  );
  if (confirmed !== "yes") {
    return finish(
      "declined",
      plan,
      false,
      `Nothing was written and every capability is still disarmed. Run \`${RESUME_COMMAND}\` when you want to answer again.`,
    );
  }

  const applied = await applyCapabilities(options.root, options.config, requests);
  return finish(
    "applied",
    applied.plan,
    applied.applied,
    "Applied. Check what is armed with `open-brain capabilities list`, read any of them with `open-brain capabilities explain <name>`, and turn one off with `open-brain capabilities disable <name>`, which takes effect immediately.",
  );
}
