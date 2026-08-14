import { defineCommand } from "citty";

import { PARITY_REFERENCE, renderParity } from "../../core/parity.js";
import { booleanArgument, printJson } from "../shared.js";

/**
 * Shows the frozen parity reference: which modules of the private Python
 * engine this port has already matched, captured once against one named
 * commit. See PARITY.md to move it.
 */
export const parityCommand = defineCommand({
  meta: {
    name: "parity",
    description: "Show the frozen parity reference against the private Python engine.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Print the parity reference as JSON instead of a rendered table.",
      default: false,
    },
  },
  async run({ args }) {
    if (booleanArgument(args, "json")) {
      printJson(PARITY_REFERENCE);
      return;
    }
    process.stdout.write(`${renderParity()}\n`);
  },
});
