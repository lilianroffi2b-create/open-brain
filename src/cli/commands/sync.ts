import { defineCommand } from "citty";

import { ExpectedError } from "../../core/errors.js";
import { parseApprovedIndices, resumeBatch, validateApply } from "../../gate/apply.js";
import {
  prepareBatchFromFile,
  showBatch,
  syncPending,
  syncStaged,
} from "../../gate/review.js";
import { undoBatch } from "../../gate/undo.js";
import {
  argument,
  booleanArgument,
  loadConfigForCli,
  optionalNonNegativeInteger,
  optionalString,
  printJson,
  printNotice,
  requiredString,
  rootArgument,
} from "../shared.js";
import { resolveVaultRoot } from "../vault.js";

/**
 * The human gate, on the command line.
 *
 * Every subcommand prints one parseable JSON document on stdout and nothing
 * else, so a host CLI can drive the whole protocol without scraping prose. The
 * order is fixed and the help says so: pending first, then staged, then
 * prepare, then show, then validate. A batch that already exists is resumed,
 * never reclassified.
 *
 * The validation command deliberately has no default. `--approve` must be
 * typed, even to reject everything, because a copyable command that approves by
 * default is a command that will eventually write something nobody read.
 */

function maxCharsArgument(args: unknown, name = "max-chars"): number | undefined {
  const value = optionalNonNegativeInteger(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (value < 500) {
    throw new ExpectedError(`--${name} must be at least 500 characters.`);
  }
  return value;
}

const pendingCommand = defineCommand({
  meta: {
    name: "pending",
    description: "List the batches that still need you. Run this before anything else.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    printJson(await syncPending(root, config));
  },
});

const stagedCommand = defineCommand({
  meta: {
    name: "staged",
    description: "Return the next deterministic slice of staged candidates and its selection id.",
  },
  args: {
    ...rootArgument,
    limit: {
      type: "string",
      description: "Cap the number of candidates in the slice. Defaults to 200.",
      required: false,
    },
    "max-chars": {
      type: "string",
      description: "Character cap of the slice. Candidates beyond it wait for the next one.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const limit = optionalNonNegativeInteger(args, "limit");
    const maxChars = maxCharsArgument(args);
    printJson(await syncStaged(root, config, {
      ...(limit === undefined ? {} : { limit }),
      ...(maxChars === undefined ? {} : { maxChars }),
    }));
  },
});

const prepareCommand = defineCommand({
  meta: {
    name: "prepare",
    description: "Turn a classification file into an immutable batch waiting for your decision.",
  },
  args: {
    ...rootArgument,
    input: {
      type: "string",
      description: "Path to the JSON array the classifier wrote. Never a shell heredoc.",
      required: true,
    },
    selection: {
      type: "string",
      description: "The selection id returned by `sync staged`, so a moved slice is caught.",
      required: false,
    },
    "max-chars": {
      type: "string",
      description: "Character cap of the presentation returned with the batch.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const selectionId = optionalString(args, "selection");
    const maxChars = maxCharsArgument(args);
    printJson(await prepareBatchFromFile(root, config, requiredString(args, "input"), {
      ...(selectionId === undefined ? {} : { selectionId }),
      ...(maxChars === undefined ? {} : { maxChars }),
    }));
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Present a batch item by item, capped, with the cost of the presentation.",
  },
  args: {
    ...rootArgument,
    batch: {
      type: "string",
      description: "Batch identifier.",
      required: true,
    },
    from: {
      type: "string",
      description: "First item to show, 1 based. Used to read past a truncation.",
      required: false,
    },
    "max-chars": {
      type: "string",
      description: "Character cap of the presentation.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const from = optionalNonNegativeInteger(args, "from");
    const maxChars = maxCharsArgument(args);
    printJson(await showBatch(root, config, requiredString(args, "batch"), {
      ...(from === undefined ? {} : { from: Math.max(0, from - 1) }),
      ...(maxChars === undefined ? {} : { maxChars }),
    }));
  },
});

const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Pick a batch back up after an interruption. Never runs a classifier.",
  },
  args: {
    ...rootArgument,
    batch: {
      type: "string",
      description: "Batch identifier.",
      required: true,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    printJson(await resumeBatch(root, config, requiredString(args, "batch")));
  },
});

/**
 * Reads --approve without ever defaulting it. An empty string is a real answer
 * that means "reject everything"; an absent flag is not an answer at all.
 */
function approveArgument(args: unknown): string {
  const value = argument(args, "approve");
  if (typeof value !== "string") {
    throw new ExpectedError(
      "This command needs --approve. Pass the item numbers you approve, for example --approve \"1,3\", or an empty string --approve \"\" to reject every item. It has no default, on purpose: nothing is written unless you name it.",
    );
  }
  return value;
}

const validateArguments = {
  ...rootArgument,
  batch: {
    type: "string",
    description: "Batch identifier.",
    required: true,
  },
  approve: {
    type: "string",
    description:
      "Comma separated item numbers you approve, or an empty string to reject everything. Required, never defaulted.",
    required: false,
  },
} as const;

async function runValidate(args: unknown): Promise<void> {
  const root = await resolveVaultRoot(optionalString(args, "root"));
  const config = await loadConfigForCli(root);
  const result = await validateApply(root, config, {
    batchId: requiredString(args, "batch"),
    approve: approveArgument(args),
  });
  printJson(result);
  for (const warning of result.warnings) {
    printNotice(warning);
  }
}

const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Freeze your decision and apply exactly it. The only command that writes.",
  },
  args: validateArguments,
  async run({ args }) {
    await runValidate(args);
  },
});

const applyCommand = defineCommand({
  meta: {
    name: "apply",
    description: "Alias of validate.",
  },
  args: validateArguments,
  async run({ args }) {
    await runValidate(args);
  },
});

const undoCommand = defineCommand({
  meta: {
    name: "undo",
    description:
      "Reverse an applied batch from its own record. No git, no assumption: the state of every file before the batch is stored next to it.",
  },
  args: {
    batch: {
      type: "positional",
      description: "Batch identifier.",
      required: true,
    },
    ...rootArgument,
    yes: {
      type: "boolean",
      description: "Confirm the reversal. Without it nothing is written.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    printJson(await undoBatch(root, config, requiredString(args, "batch"), {
      yes: booleanArgument(args, "yes"),
    }));
  },
});

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "The human gate: review staged candidates and apply only what you approve.",
  },
  subCommands: {
    pending: pendingCommand,
    staged: stagedCommand,
    prepare: prepareCommand,
    show: showCommand,
    resume: resumeCommand,
    validate: validateCommand,
    apply: applyCommand,
    undo: undoCommand,
  },
});

export { parseApprovedIndices };
