import { defineCommand } from "citty";

import { isEnabled } from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import {
  issueClassificationRequest,
  planClassification,
} from "../../classifier/runner.js";
import {
  booleanArgument,
  loadConfigForCli,
  optionalNonNegativeInteger,
  optionalString,
  printJson,
  printNotice,
  rootArgument,
} from "../shared.js";
import { resolveVaultRoot } from "../vault.js";

/**
 * The classifier, on the command line.
 *
 * It ships disarmed. On a vault where `capabilities.classifier` is off, this
 * command can still price a run and show exactly what would be sent, and it can
 * never make a model call: the capability is checked before a request is
 * issued, and Open Brain has no model client of its own to fall back on.
 *
 * The cost always comes before the spend. A dry run prints it and stops; a real
 * run prints it and then books one call against the daily budget. Either way
 * the number is on the screen before anything leaves the machine.
 */

export const classifyCommand = defineCommand({
  meta: {
    name: "classify",
    description:
      "Prepare a classification of the staged slice. Disarmed by default; --dry-run prices it without spending anything.",
  },
  args: {
    ...rootArgument,
    "dry-run": {
      type: "boolean",
      description: "Show what would be sent and what it would cost. Makes no call.",
      default: false,
    },
    "max-items": {
      type: "string",
      description: "Cap the number of candidates sent. Defaults to 200.",
      required: false,
    },
    "max-chars": {
      type: "string",
      description: "Cap the characters sent. Candidates beyond it wait for the next slice.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const maxItems = optionalNonNegativeInteger(args, "max-items");
    const maxChars = optionalNonNegativeInteger(args, "max-chars");
    if (maxChars !== undefined && maxChars < 500) {
      throw new ExpectedError("--max-chars must be at least 500 characters.");
    }
    const options = {
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(maxChars === undefined ? {} : { maxChars }),
    };

    if (booleanArgument(args, "dry-run")) {
      const plan = await planClassification(root, config, options);
      printJson(plan);
      printNotice(plan.cost.summary);
      if (!isEnabled(config, "classifier")) {
        printNotice(
          "The classifier is disarmed, so this run cost nothing and could not have cost anything. `open-brain capabilities explain classifier` says exactly what arming it would do.",
        );
      }
      return;
    }

    const request = await issueClassificationRequest(root, config, options);
    printJson(request);
    printNotice(request.cost.summary);
  },
});
