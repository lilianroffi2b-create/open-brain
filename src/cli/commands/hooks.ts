import { defineCommand } from "citty";

import { isEnabled } from "../../core/capabilities.js";
import {
  codexHookStatus,
  CODEX_DIFFERENCES,
  HOOK_HOST_SUPPORT,
  installCodexHooks,
  uninstallCodexHooks,
} from "../../hooks/codex.js";
import {
  claudeCodeHookStatus,
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
} from "../../hooks/settings-merge.js";
import { resolveVaultRoot } from "../vault.js";
import { loadConfigForCli, optionalString, printJson, rootArgument } from "../shared.js";

/**
 * Wiring and unwiring the hooks on both hosts, and a status that says three
 * different things clearly: what is wired, what is not, and what is wired but
 * disarmed by the capability gate. The third case is the one that confuses
 * people, so it gets its own field rather than being inferred from two others.
 *
 * Installing the wiring does not arm anything. With capabilities.hooks disabled
 * every hook exits immediately without reading the vault, which means the
 * wiring can be installed once and armed later, or armed and disarmed without
 * touching the host settings file at all.
 */

export type HookTarget = "claude-code" | "codex";

const TARGETS: readonly HookTarget[] = ["claude-code", "codex"];

function requestedTargets(value: string | undefined): HookTarget[] {
  if (value === undefined) {
    return [...TARGETS];
  }
  const requested = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const unknown = requested.filter(
    (part) => !TARGETS.some((target) => target === part),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown hook target(s): ${unknown.join(", ")}. Expected one or more of: ${TARGETS.join(", ")}.`,
    );
  }
  return TARGETS.filter((target) => requested.includes(target));
}

const targetArgument = {
  target: {
    type: "string",
    description: `Comma-separated hosts to wire: ${TARGETS.join(", ")}. Defaults to all of them.`,
    required: false,
  },
} as const;

const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Register the Open Brain hook entry point with the supported host CLIs.",
  },
  args: { ...rootArgument, ...targetArgument },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const targets = requestedTargets(optionalString(args, "target"));
    const results = [];
    for (const target of targets) {
      const result = target === "claude-code"
        ? await installClaudeCodeHooks(root)
        : await installCodexHooks(root);
      results.push({ target, ...result });
    }
    printJson({
      root,
      installed: results,
      capability_armed: isEnabled(config, "hooks"),
      next: isEnabled(config, "hooks")
        ? "The hooks are wired and armed."
        : "The hooks are wired but disarmed. Run `open-brain capabilities enable hooks` to arm them.",
    });
  },
});

const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove only the Open Brain hook entries, leaving every other entry intact.",
  },
  args: { ...rootArgument, ...targetArgument },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const targets = requestedTargets(optionalString(args, "target"));
    const results = [];
    for (const target of targets) {
      const result = target === "claude-code"
        ? await uninstallClaudeCodeHooks(root)
        : await uninstallCodexHooks(root);
      results.push({ target, ...result });
    }
    printJson({ root, uninstalled: results });
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Report what is wired, what is not, and what is wired but disarmed.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const armed = isEnabled(config, "hooks");
    const claude = await claudeCodeHookStatus(root);
    const codex = await codexHookStatus(root);

    const summarize = (
      entries: Array<{ event: string; wired: boolean; occurrences: number }>,
    ) => ({
      wired: entries.filter((entry) => entry.wired).map((entry) => entry.event),
      not_wired: entries.filter((entry) => !entry.wired).map((entry) => entry.event),
      duplicated: entries
        .filter((entry) => entry.occurrences > 1)
        .map((entry) => entry.event),
    });

    printJson({
      root,
      capability_armed: armed,
      armed_note: armed
        ? "capabilities.hooks is enabled, so wired hooks run."
        : "capabilities.hooks is disabled, so every wired hook exits immediately without reading the vault.",
      targets: {
        "claude-code": {
          path: claude.path,
          present: claude.present,
          readable: claude.readable,
          entries_not_owned_by_open_brain: claude.foreign_entries,
          ...summarize(claude.hooks),
        },
        codex: {
          path: codex.path,
          present: codex.present,
          readable: codex.readable,
          entries_not_owned_by_open_brain: codex.foreign_entries,
          ...summarize(codex.hooks),
        },
      },
      host_support: HOOK_HOST_SUPPORT,
      host_differences: CODEX_DIFFERENCES,
    });
  },
});

export const hooksCommand = defineCommand({
  meta: {
    name: "hooks",
    description: "Install, remove, or inspect the hook wiring for the supported host CLIs.",
  },
  subCommands: {
    install: installCommand,
    uninstall: uninstallCommand,
    status: statusCommand,
  },
});
