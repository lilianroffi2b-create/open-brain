import { defineCommand } from "citty";

import { CAPABILITY_NAMES, isEnabled } from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import {
  DEFAULT_QUESTION_CHARS,
  SCOPING_QUESTIONS,
  renderWalkPlan,
} from "../../onboarding/questions.js";
import {
  createNonInteractiveIo,
  createTerminalIo,
  isInteractiveTerminal,
  runOnboarding,
  type OnboardingIo,
} from "../../onboarding/run.js";
import {
  booleanArgument,
  loadConfigForCli,
  optionalNonNegativeInteger,
  optionalString,
  printJson,
  rootArgument,
} from "../shared.js";
import { resolveVaultRoot } from "../vault.js";

/**
 * Two modes, on purpose. Without --interactive the command describes the walk
 * in one line per capability, which is what someone deciding whether to start
 * needs and all an assistant should ever load at once. With --interactive it
 * runs the walk, one question at a time, and writes once at the end behind a
 * single confirmation.
 *
 * Neither mode arms anything by itself, and an interrupted walk writes nothing
 * at all: a vault whose onboarding was abandoned halfway is a vault with every
 * capability disarmed, which is a vault that works.
 */

const MIN_QUESTION_CHARS = 600;

function questionChars(args: unknown): number {
  const value = optionalNonNegativeInteger(args, "max-chars");
  if (value === undefined) {
    return DEFAULT_QUESTION_CHARS;
  }
  if (value < MIN_QUESTION_CHARS) {
    throw new ExpectedError(
      `--max-chars must be at least ${String(MIN_QUESTION_CHARS)} characters, or a question stops carrying its own framing.`,
    );
  }
  return value;
}

export const onboardingCommand = defineCommand({
  meta: {
    name: "onboarding",
    description: "Frame every capability, then ask. Nothing is armed without an explicit yes.",
  },
  args: {
    ...rootArgument,
    interactive: {
      type: "boolean",
      description: "Run the walk in this terminal, one question at a time.",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Run the walk and show the result without writing anything.",
      default: false,
    },
    "max-chars": {
      type: "string",
      description: `Character cap for one question. Defaults to ${String(DEFAULT_QUESTION_CHARS)}.`,
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const maxChars = questionChars(args);

    if (!booleanArgument(args, "interactive")) {
      const walk = renderWalkPlan();
      printJson({
        root,
        armed: CAPABILITY_NAMES.filter((name) => isEnabled(config, name)),
        preference_questions: SCOPING_QUESTIONS.map((question) => ({
          id: question.id,
          layer: question.layer,
          prompt: question.prompt,
        })),
        capability_questions: walk.lines,
        how_to_run: [
          "open-brain onboarding --interactive, to answer in this terminal.",
          "Ask your assistant for the openbrain-onboarding skill, to answer in conversation.",
          "open-brain capabilities explain <name>, to read one capability in full before deciding.",
        ],
        note: "Nothing is armed by running this. The full framing of a capability is reached one capability at a time, so a preview stays a preview.",
        budget: walk.rendered.budget,
      });
      return;
    }

    const io: OnboardingIo = isInteractiveTerminal()
      ? createTerminalIo()
      : createNonInteractiveIo();
    try {
      const result = await runOnboarding({
        root,
        config,
        io,
        maxChars,
        ...(booleanArgument(args, "dry-run") ? { dryRun: true } : {}),
      });
      printJson(result);
    } finally {
      await io.close();
    }
  },
});
