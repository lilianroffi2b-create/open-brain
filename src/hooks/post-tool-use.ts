import { join, sep } from "node:path";

import type { VaultConfig } from "../core/types.js";
import {
  changesFromPayload,
  isNewFile,
  payloadString,
  type FileChange,
} from "./events.js";
import { overBudget, type HookContext, type HookOutcome } from "./runtime.js";
import {
  allowedRootMarkdown,
  isLintExcluded,
  readTextFile,
  relativeVaultPath,
} from "./vault.js";

/**
 * Tells the assistant what it just introduced that does not fit the vault,
 * after the fact and never by undoing it. A lint that guesses wrong has to stay
 * quiet, so every uncertain path here returns no violation: a file outside the
 * vault, a file that is not on disk, an unreadable file, a tool this hook does
 * not understand.
 *
 * Two checks, both about a file that is new to the vault:
 *   1. a new Markdown file landing outside the canonical layers
 *   2. a new Markdown file with no lifecycle front matter
 */

// The values the scanner accepts. Advertising one it would reject would send
// the assistant to write front matter that fails the next scan.
const LIFECYCLES: readonly string[] = ["master", "working", "ephemeral", "data"];

export function lifecycleViolationMessage(): string {
  return `missing lifecycle front matter (lifecycle: ${LIFECYCLES.join("|")})`;
}

/**
 * Front matter has to be opened on the first line and closed again. An
 * unterminated block is not front matter, it is a document that starts with a
 * horizontal rule, and treating it as valid would let the check be bypassed by
 * a typo.
 */
export function hasLifecycleFrontmatter(text: string): boolean {
  const withoutBom = text.replace(/^\uFEFF/u, "");
  const lines = withoutBom.split(/\r?\n/u);
  const first = lines[0];
  if (first === undefined || first.trim() !== "---") {
    return false;
  }
  let lifecycle: string | undefined;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "---") {
      return lifecycle !== undefined && LIFECYCLES.includes(lifecycle);
    }
    if (trimmed.toLowerCase().startsWith("lifecycle:")) {
      lifecycle = trimmed
        .slice("lifecycle:".length)
        .trim()
        .replace(/^["']|["']$/gu, "")
        .toLowerCase();
    }
  }
  return false;
}

export interface LintViolation {
  path: string;
  messages: string[];
}

export function renderLintFeedback(violations: LintViolation[]): string {
  const parts = violations.map(
    (violation) => `${violation.path}: ${violation.messages.join("; ")}`,
  );
  return `[open-brain lint] ${parts.join(" | ")}`;
}

function zoneViolation(relativePath: string, config: VaultConfig): string | undefined {
  const parts = relativePath.split("/");
  if (parts.length === 1) {
    const name = parts[0] ?? "";
    return allowedRootMarkdown().has(name)
      ? undefined
      : `new root-level .md file outside the allowed list (${[...allowedRootMarkdown()].sort().join(", ")})`;
  }
  const top = parts[0] ?? "";
  return config.canonical_dirs.includes(top)
    ? undefined
    : `new .md file outside the canonical layers ('${top}/')`;
}

async function violationsForChange(
  change: FileChange,
  context: HookContext,
  cwd: string | undefined,
): Promise<LintViolation | undefined> {
  if (change.kind === "Delete" || !isNewFile(change)) {
    return undefined;
  }
  const relativePath = relativeVaultPath(context.vaultRoot, change.targetPath, cwd);
  if (relativePath === undefined || isLintExcluded(relativePath, context.config)) {
    return undefined;
  }
  if (!relativePath.toLowerCase().endsWith(".md")) {
    return undefined;
  }

  // Read the file as it stands after the tool ran, not what the tool claimed to
  // write: a file that never landed is not a violation.
  const finalText = await readTextFile(
    join(context.vaultRoot, relativePath.split("/").join(sep)),
  );
  if (finalText === undefined) {
    return undefined;
  }

  const messages: string[] = [];
  const zone = zoneViolation(relativePath, context.config);
  if (zone !== undefined) {
    messages.push(zone);
  }
  if (!hasLifecycleFrontmatter(finalText)) {
    messages.push(lifecycleViolationMessage());
  }
  return messages.length === 0 ? undefined : { path: relativePath, messages };
}

export async function postToolUseHook(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  const changes = changesFromPayload(context.payload);
  if (changes.length === 0) {
    return undefined;
  }
  const cwd = payloadString(context.payload, "cwd");
  const violations: LintViolation[] = [];

  for (const change of changes) {
    if (overBudget(context)) {
      break;
    }
    const violation = await violationsForChange(change, context, cwd);
    if (violation !== undefined) {
      violations.push(violation);
    }
  }

  return violations.length === 0
    ? undefined
    : { block: renderLintFeedback(violations) };
}
