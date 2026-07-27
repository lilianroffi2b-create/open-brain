import { defineCommand } from "citty";

import { capText } from "../../core/budget.js";
import { ExpectedError } from "../../core/errors.js";
import { evaluateGuard, protectedRelativePaths } from "../../staging/guard.js";
import {
  isRecord,
  loadConfigForCli,
  optionalString,
  printJson,
  requiredString,
  rootArgument,
} from "../shared.js";
import { resolveVaultRoot } from "../vault.js";

/**
 * The guard, usable on its own. It answers the same question the pre-tool-use
 * hook asks, with the same code, so a user can check a command before running
 * it and a maintainer can reproduce a refusal without a host CLI.
 */

const REASON_CHARS = 2_000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toolInputFromFlags(args: unknown): Record<string, unknown> | undefined {
  const command = optionalString(args, "command");
  const file = optionalString(args, "file");
  const patch = optionalString(args, "patch");
  const cwd = optionalString(args, "cwd");
  const input: Record<string, unknown> = {};
  if (command !== undefined) {
    input.command = command;
  }
  if (file !== undefined) {
    input.file_path = file;
  }
  if (patch !== undefined) {
    input.patch = patch;
  }
  if (cwd !== undefined) {
    input.cwd = cwd;
  }
  return Object.keys(input).length === 0 ? undefined : input;
}

export const guardCommand = defineCommand({
  meta: {
    name: "guard",
    description: "Ask the pre-effect guard whether a tool call would write to the preference kernel.",
  },
  args: {
    tool: {
      type: "positional",
      description: "Tool name, for example Bash, Write, Edit, or apply_patch.",
      required: true,
    },
    ...rootArgument,
    command: {
      type: "string",
      description: "Shell command to judge, for a shell tool.",
      required: false,
    },
    file: {
      type: "string",
      description: "File path to judge, for a file tool.",
      required: false,
    },
    patch: {
      type: "string",
      description: "Patch text to judge, for a patch tool.",
      required: false,
    },
    cwd: {
      type: "string",
      description: "Working directory the command would run in. Defaults to the vault root.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const tool = requiredString(args, "tool");

    let toolInput = toolInputFromFlags(args);
    if (toolInput === undefined) {
      const raw = (await readStdin()).trim();
      if (raw.length === 0) {
        throw new ExpectedError(
          "guard needs something to judge: pass --command, --file, or --patch, or pipe a JSON tool input on stdin.",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new ExpectedError("The tool input on stdin is not valid JSON.");
      }
      if (!isRecord(parsed)) {
        throw new ExpectedError("The tool input on stdin must be a JSON object.");
      }
      toolInput = parsed;
    }

    const verdict = evaluateGuard({ tool, toolInput, vaultRoot: root, config });
    const reason = capText(verdict.reason ?? "", REASON_CHARS);
    printJson({
      tool,
      decision: verdict.decision,
      ...(verdict.reason === undefined ? {} : { reason: reason.text }),
      ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
      protected_paths: protectedRelativePaths(config),
      budget: reason.budget,
    });
    if (verdict.decision === "deny") {
      process.exitCode = 1;
    }
  },
});
