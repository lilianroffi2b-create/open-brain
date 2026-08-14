// Shared CLI plumbing: argument readers, printers, and the common root flag.
// It exists so every command can live in its own file under src/cli/commands/
// and import these from here instead of redefining them.

import pc from "picocolors";

import { loadConfigResult } from "../core/config.js";
import type { VaultConfig } from "../core/types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function argument(args: unknown, name: string): unknown {
  return isRecord(args) ? args[name] : undefined;
}

export function optionalString(args: unknown, name: string): string | undefined {
  const value = argument(args, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanArgument(args: unknown, name: string): boolean {
  return argument(args, name) === true;
}

export function requiredString(args: unknown, name: string): string {
  const value = optionalString(args, name);
  if (!value) {
    throw new Error(`--${name} requires a non-empty value.`);
  }
  return value;
}

export function optionalNonNegativeInteger(
  args: unknown,
  name: string,
): number | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return Number(value);
}

// Tri-state boolean: --core => true, --no-core => false, absent => undefined.
export function optionalBoolean(args: unknown, name: string): boolean | undefined {
  const value = argument(args, name);
  return typeof value === "boolean" ? value : undefined;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printNotice(message: string): void {
  process.stdout.write(`${pc.cyan(message)}\n`);
}

// Loads config for a command and warns once on stderr when the config file
// exists but is unreadable or malformed, without changing the exit code.
export async function loadConfigForCli(root: string): Promise<VaultConfig> {
  const { config, issue } = await loadConfigResult(root);
  if (issue) {
    process.stderr.write(`${pc.yellow("WARNING")} ${issue.message}\n`);
  }
  return config;
}

export const rootArgument = {
  root: {
    type: "string",
    description: "Vault root or a path inside an existing vault.",
  },
} as const;
