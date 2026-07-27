import { defineCommand } from "citty";

import { capText, type ContextBudget } from "../../core/budget.js";
import {
  CAPABILITY_NAMES,
  capabilityIssues,
  capabilityParent,
  describeCapability,
  isEnabled,
  type CapabilityName,
} from "../../core/capabilities.js";
import { ExpectedError } from "../../core/errors.js";
import type { VaultConfig } from "../../core/types.js";
import {
  applyCapabilities,
  capabilityChildren,
  normalizeConsentPath,
  parseCapabilityName,
  type CapabilityRequest,
} from "../../onboarding/apply.js";
import {
  CONSOLIDATE_CONFIRMATION_PHRASE,
  DEFAULT_FRAMING_CHARS,
  renderCapabilityFraming,
} from "../../onboarding/questions.js";
import {
  booleanArgument,
  loadConfigForCli,
  optionalNonNegativeInteger,
  optionalString,
  printJson,
  requiredString,
  rootArgument,
} from "../shared.js";
import { resolveVaultRoot } from "../vault.js";

/**
 * The capability surface: what is armed, what a capability actually does, and
 * the two commands that change the answer.
 *
 * explain is the command a suspicious user runs before arming anything, so it
 * prints prose rather than a payload, and it prints the same prose the
 * onboarding walk recites. There is one wording of what a capability does, in
 * describeCapability, and everything else quotes it.
 *
 * Note on flags: --root is the vault root everywhere in this CLI, so the
 * directory a user consents to for transcripts is named --path. Making --root
 * mean two different things in the same binary would be a trap, and this
 * command exists to remove traps.
 */

const MIN_EXPLAIN_CHARS = 400;

interface CapabilityRow {
  name: CapabilityName;
  enabled: boolean;
  declared: boolean;
  parent: CapabilityName | null;
  title: string;
  detail: Record<string, unknown>;
}

function declaredValue(config: VaultConfig, name: CapabilityName): boolean {
  const capabilities = config.capabilities;
  switch (name) {
    case "hooks":
      return capabilities.hooks.enabled;
    case "capture":
      return capabilities.capture.enabled;
    case "transcripts":
      return capabilities.transcripts.enabled;
    case "classifier":
      return capabilities.classifier.enabled;
    case "learning":
      return capabilities.learning.enabled;
    case "learning.evaluate":
      return capabilities.learning.evaluate;
    case "learning.consolidate":
      return capabilities.learning.consolidate;
  }
}

function detailFor(config: VaultConfig, name: CapabilityName): Record<string, unknown> {
  const capabilities = config.capabilities;
  switch (name) {
    case "hooks":
      return { targets: [...capabilities.hooks.targets] };
    case "transcripts":
      return {
        roots: [...capabilities.transcripts.roots],
        redact: capabilities.transcripts.redact,
      };
    case "classifier":
      return {
        provider: capabilities.classifier.provider,
        daily_call_budget: capabilities.classifier.daily_call_budget,
      };
    default:
      return {};
  }
}

function rowFor(config: VaultConfig, name: CapabilityName): CapabilityRow {
  const parent = capabilityParent(name);
  return {
    name,
    enabled: isEnabled(config, name),
    declared: declaredValue(config, name),
    parent: parent ?? null,
    title: describeCapability(name).title,
    detail: detailFor(config, name),
  };
}

function stateLines(config: VaultConfig, name: CapabilityName): string[] {
  const lines: string[] = [];
  const enabled = isEnabled(config, name);
  const declared = declaredValue(config, name);
  const parent = capabilityParent(name);

  lines.push(`Status: ${enabled ? "armed" : "disarmed"}.`);
  if (declared && !enabled && parent !== undefined) {
    lines.push(
      `It says enabled in the config, but ${parent} is disarmed, so it never runs. That is reported by \`open-brain doctor\` and treated as disarmed everywhere.`,
    );
  }

  if (name === "hooks") {
    const targets = config.capabilities.hooks.targets;
    lines.push(
      `Hosts declared: ${targets.length === 0 ? "none, so nothing calls the hooks yet" : targets.join(", ")}.`,
    );
  }
  if (name === "transcripts") {
    const roots = config.capabilities.transcripts.roots;
    lines.push(
      `Directories consented to: ${roots.length === 0 ? "none, so nothing outside this vault is ever read" : roots.join(", ")}.`,
    );
    lines.push(`Redaction: ${config.capabilities.transcripts.redact ? "on" : "off"}.`);
  }
  if (name === "classifier") {
    lines.push(
      `Provider: ${config.capabilities.classifier.provider}. Daily cap in force: ${String(config.capabilities.classifier.daily_call_budget)} model calls.`,
    );
  }

  lines.push(
    enabled
      ? `Turn it off: open-brain capabilities disable ${name}`
      : `Arm it: open-brain capabilities enable ${name}${armingHint(name)}`,
  );
  return lines;
}

function armingHint(name: CapabilityName): string {
  if (name === "transcripts") {
    return " --path <directory>";
  }
  if (name === "learning.consolidate") {
    return ` --confirm "${CONSOLIDATE_CONFIRMATION_PHRASE}"`;
  }
  if (name === "hooks") {
    return " --target claude-code";
  }
  return "";
}

function explainChars(args: unknown): number {
  const value = optionalNonNegativeInteger(args, "max-chars");
  if (value === undefined) {
    return DEFAULT_FRAMING_CHARS;
  }
  if (value < MIN_EXPLAIN_CHARS) {
    throw new ExpectedError(
      `--max-chars must be at least ${String(MIN_EXPLAIN_CHARS)} characters, or the framing stops being a framing.`,
    );
  }
  return value;
}

function budgetLine(budget: ContextBudget): string {
  return `[budget] ${String(budget.chars)} chars, about ${String(budget.token_estimate)} tokens${budget.truncated ? ", TRUNCATED" : ""}`;
}

function listValues(args: unknown, ...names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const raw = optionalString(args, name);
    if (raw === undefined) {
      continue;
    }
    for (const item of raw.split(",")) {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !values.includes(trimmed)) {
        values.push(trimmed);
      }
    }
  }
  return values;
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "Show what is armed, what is not, and any configuration that contradicts itself.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const rows = CAPABILITY_NAMES.map((name) => rowFor(config, name));
    const issues = capabilityIssues(config);
    const armed = rows.filter((row) => row.enabled).map((row) => row.name);

    printJson({
      root,
      armed,
      disarmed: rows.filter((row) => !row.enabled).map((row) => row.name),
      capabilities: rows,
      issues,
      next: armed.length === 0
        ? "Every capability is disarmed, so Open Brain reads nothing outside this vault and costs nothing. Read one with `open-brain capabilities explain <name>`."
        : "Read any of them with `open-brain capabilities explain <name>`. Disarming takes effect immediately.",
      budget: {
        chars: 0,
        token_estimate: 0,
        items_shown: rows.length,
        items_total: CAPABILITY_NAMES.length,
        truncated: false,
      },
    });
  },
});

const explainCommand = defineCommand({
  meta: {
    name: "explain",
    description: "Say what a capability does, reads, writes, costs, risks, and how to turn it off.",
  },
  args: {
    name: {
      type: "positional",
      description: `Capability name. One of: ${CAPABILITY_NAMES.join(", ")}.`,
      required: true,
    },
    ...rootArgument,
    json: {
      type: "boolean",
      description: "Print the structured description instead of the prose.",
      default: false,
    },
    "max-chars": {
      type: "string",
      description: `Character cap for the framing. Defaults to ${String(DEFAULT_FRAMING_CHARS)}.`,
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const name = parseCapabilityName(requiredString(args, "name"));
    const description = describeCapability(name);
    const issues = capabilityIssues(config).filter((issue) => issue.startsWith(name));
    const cap = explainChars(args);

    if (booleanArgument(args, "json")) {
      const framing = renderCapabilityFraming(description, cap);
      printJson({
        root,
        capability: rowFor(config, name),
        description,
        issues,
        budget: framing.budget,
      });
      return;
    }

    const framing = renderCapabilityFraming(description, cap);
    const body = [
      framing.text,
      "",
      ...stateLines(config, name),
      ...(issues.length === 0 ? [] : ["", ...issues.map((issue) => `Anomaly: ${issue}`)]),
    ].join("\n");
    const rendered = capText(body, cap);
    process.stdout.write(`${rendered.text}\n${budgetLine(rendered.budget)}\n`);
  },
});

const enableCommand = defineCommand({
  meta: {
    name: "enable",
    description: "Arm one capability, after checking that arming it can actually mean something.",
  },
  args: {
    name: {
      type: "positional",
      description: `Capability name. One of: ${CAPABILITY_NAMES.join(", ")}.`,
      required: true,
    },
    ...rootArgument,
    path: {
      type: "string",
      description: "Directory Open Brain may read transcripts from. Required to arm transcripts, comma separated for several.",
      required: false,
    },
    "transcripts-root": {
      type: "string",
      description: "Alias of --path, for consent to a transcript directory.",
      required: false,
    },
    target: {
      type: "string",
      description: "Host CLIs to declare for hooks: claude-code, codex, comma separated.",
      required: false,
    },
    provider: {
      type: "string",
      description: "Classifier provider: none or claude-code-subagent. Defaults to claude-code-subagent when arming.",
      required: false,
    },
    confirm: {
      type: "string",
      description: `Dedicated confirmation for learning.consolidate. Must be exactly: ${CONSOLIDATE_CONFIRMATION_PHRASE}`,
      required: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would be written without writing it.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const name = parseCapabilityName(requiredString(args, "name"));
    const paths = listValues(args, "path", "transcripts-root").map(
      (item) => normalizeConsentPath(item),
    );
    const targets = listValues(args, "target");
    const provider = optionalString(args, "provider");
    const confirmation = optionalString(args, "confirm");

    if (provider !== undefined && provider !== "none" && provider !== "claude-code-subagent") {
      throw new ExpectedError(
        "--provider must be none or claude-code-subagent.",
      );
    }

    const request: CapabilityRequest = {
      capability: name,
      enable: true,
      ...(paths.length === 0 ? {} : { roots: paths }),
      ...(targets.length === 0 ? {} : { targets }),
      ...(provider === undefined ? {} : { provider }),
      ...(confirmation === undefined ? {} : { confirmation }),
    };

    const result = await applyCapabilities(root, config, [request], {
      dryRun: booleanArgument(args, "dry-run"),
    });
    const refusal = result.plan.refusals[0];
    if (refusal !== undefined) {
      throw new ExpectedError(refusal);
    }

    printJson({
      root,
      capability: name,
      applied: result.applied,
      already_armed: result.already_current,
      writes: result.plan.writes,
      notes: result.plan.notes,
      next: result.applied
        ? `Armed. Turn it off at any time with \`open-brain capabilities disable ${name}\`, which takes effect immediately.`
        : result.already_current
          ? `Nothing to do: ${name} was already in that state, and the config file was not touched.`
          : "Dry run, so nothing was written.",
    });
  },
});

const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description: "Disarm one capability and everything that depends on it, effective immediately.",
  },
  args: {
    name: {
      type: "positional",
      description: `Capability name. One of: ${CAPABILITY_NAMES.join(", ")}.`,
      required: true,
    },
    ...rootArgument,
    "dry-run": {
      type: "boolean",
      description: "Show what would be written without writing it.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const name = parseCapabilityName(requiredString(args, "name"));

    const result = await applyCapabilities(
      root,
      config,
      [{ capability: name, enable: false }],
      { dryRun: booleanArgument(args, "dry-run") },
    );

    printJson({
      root,
      capability: name,
      applied: result.applied,
      already_disarmed: result.already_current,
      children_disarmed: capabilityChildren(name),
      writes: result.plan.writes,
      notes: result.plan.notes,
      next: result.applied
        ? "Disarmed. The organ stops on the next command, and nothing it wrote is deleted."
        : result.already_current
          ? `Nothing to do: ${name} was already disarmed, and the config file was not touched.`
          : "Dry run, so nothing was written.",
    });
  },
});

export const capabilitiesCommand = defineCommand({
  meta: {
    name: "capabilities",
    description: "Inspect, explain, arm and disarm what this vault is allowed to do.",
  },
  subCommands: {
    list: listCommand,
    explain: explainCommand,
    enable: enableCommand,
    disable: disableCommand,
  },
});
