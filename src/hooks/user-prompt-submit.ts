import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { capText, type ContextBudget } from "../core/budget.js";
import { routeVault } from "../core/route.js";
import { tokenize } from "../core/text.js";
import type { RouteResult, VaultConfig } from "../core/types.js";
import { promptSubmitCapture } from "../staging/capture.js";
import { isRecord, payloadString } from "./events.js";
import {
  composeHookOutcomes,
  overBudget,
  runOrgan,
  type HookContext,
  type HookOutcome,
} from "./runtime.js";
import { readTextFile } from "./vault.js";

/**
 * Open Brain already had a router. What it did not have was a reason for the
 * assistant to call it. This hook removes the remembering: every substantive
 * prompt arrives with its route, its first reads, and the preferences that
 * apply to that domain already attached.
 *
 * It stays quiet far more often than it speaks. A greeting, a slash command, or
 * a one-word follow-up gets nothing, and neither does a prompt whose best route
 * scores below the confidence floor: injecting a wrong route costs more than
 * injecting none.
 */

export const MAX_INJECTION_CHARS = 1_500;
export const MIN_PROMPT_CHARS = 40;
export const MIN_ROUTE_SCORE = 4;
export const MAX_DOMAIN_PREFERENCES = 3;
export const MIN_INJECTED_PREFERENCE_WEIGHT = 4;
export const MAX_READ_FIRST_FILES = 3;
export const APPLY_CLIP = 160;
export const INTENT_CLIP = 120;
export const RULE_CLIP = 200;

/**
 * Acknowledgements and connectors that carry no request of their own. The
 * standalone words need a word boundary so "going" is not read as "go", and the
 * connectors only count as a leading word followed by a space so "android" is
 * not read as "and".
 */
const ACKNOWLEDGEMENT = /^(?:(?:ok|okay|yes|yep|yeah|no|nope|thanks|thx|continue|go|stop|again|redo|perfect|nice|great|done)\b|(?:and|also|plus)\s)/iu;

export function isMicroTurn(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_CHARS) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  if (trimmed.split(/\s+/u).length <= 1) {
    return true;
  }
  return ACKNOWLEDGEMENT.test(trimmed);
}

export function clip(text: string, limit: number): string {
  const compact = text.split(/\s+/u).join(" ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  const cut = compact.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  const head = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:-]+$/u, "");
  return (head.length > 0 ? head : compact.slice(0, limit)) + "...";
}

export interface RouteMeta {
  triggers: string[];
  activeRule?: string;
}

/**
 * Reads the two fields of a single route that the router itself does not
 * return: its triggers, used to widen the token set a preference is matched
 * against, and its optional active rule. A broken routing file yields empty
 * metadata rather than blocking the injection of everything else.
 */
export function readRouteMeta(routingText: string, routeName: string): RouteMeta {
  let parsed: unknown;
  try {
    parsed = parseYaml(routingText) as unknown;
  } catch {
    return { triggers: [] };
  }
  if (!isRecord(parsed) || !isRecord(parsed.routes)) {
    return { triggers: [] };
  }
  const route = parsed.routes[routeName];
  if (!isRecord(route)) {
    return { triggers: [] };
  }
  const triggers = Array.isArray(route.triggers)
    ? route.triggers.filter((item): item is string => typeof item === "string")
    : [];
  const activeRule = typeof route.active_rule === "string" && route.active_rule.trim().length > 0
    ? route.active_rule.trim()
    : undefined;
  return activeRule === undefined ? { triggers } : { triggers, activeRule };
}

interface DomainPreference {
  id: string;
  weight: number;
  apply: string;
  domains: string[];
}

function readDomainPreferences(value: unknown): DomainPreference[] {
  if (!isRecord(value) || !Array.isArray(value.preferences)) {
    return [];
  }
  const preferences: DomainPreference[] = [];
  for (const entry of value.preferences) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = entry.id;
    const weight = entry.weight;
    const apply = entry.apply;
    if (
      typeof id !== "string"
      || typeof weight !== "number"
      || !Number.isInteger(weight)
      || typeof apply !== "string"
      || apply.trim().length === 0
      || entry.status === "retired"
    ) {
      continue;
    }
    const domains = Array.isArray(entry.domains)
      ? entry.domains.filter((item): item is string => typeof item === "string")
      : [];
    preferences.push({ id, weight, apply: apply.trim(), domains });
  }
  return preferences;
}

function isSubsetOf(tokens: string[], universe: ReadonlySet<string>): boolean {
  return tokens.length > 0 && tokens.every((token) => universe.has(token));
}

/**
 * Preferences whose domain is entirely contained in the route's own vocabulary.
 * Containment, not overlap: a single shared word is not evidence that a
 * preference belongs to this request, and an off-topic preference in every
 * prompt is how an assistant learns to ignore the block.
 */
export function domainPreferenceLines(
  ledger: unknown,
  routeTokens: ReadonlySet<string>,
): string[] {
  return readDomainPreferences(ledger)
    .filter((preference) => preference.weight >= MIN_INJECTED_PREFERENCE_WEIGHT)
    .filter((preference) => preference.domains.some(
      (domain) => isSubsetOf(tokenize(domain), routeTokens),
    ))
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    .slice(0, MAX_DOMAIN_PREFERENCES)
    .map((preference) => `- ${preference.id}: ${clip(preference.apply, APPLY_CLIP)}`);
}

/** Synthesis pages first, detail documents next, three at most. */
export function selectIndexFiles(readOrder: string[]): string[] {
  const entries = readOrder.filter((entry) => entry.length > 0);
  const indexes = entries.filter((entry) => entry.endsWith("_index.md"));
  const chosen = [...indexes.slice(0, MAX_READ_FIRST_FILES)];
  for (const entry of entries) {
    if (chosen.length >= MAX_READ_FIRST_FILES) {
      break;
    }
    if (!chosen.includes(entry)) {
      chosen.push(entry);
    }
  }
  return chosen.slice(0, MAX_READ_FIRST_FILES);
}

export interface InjectionBlock {
  text: string;
  budget: ContextBudget;
}

export function buildInjectionBlock(
  result: RouteResult,
  meta: RouteMeta,
  applyLines: string[],
  maxChars: number,
): InjectionBlock {
  const lines: string[] = [
    `SUGGESTED ROUTE: ${result.route} (score ${String(result.route_score)})`
    + (result.intent.length > 0 ? ` - ${clip(result.intent, INTENT_CLIP)}` : ""),
  ];
  const readFirst = selectIndexFiles(result.read_order);
  if (readFirst.length > 0) {
    lines.push(`READ FIRST: ${readFirst.join(", ")}`);
  }
  if (meta.activeRule !== undefined) {
    lines.push(`ACTIVE RULE: ${clip(meta.activeRule, RULE_CLIP)}`);
  }
  if (applyLines.length > 0) {
    lines.push("APPLY (domain preferences):", ...applyLines);
  }
  const capped = capText(lines.join("\n"), maxChars);
  return { text: capped.text, budget: capped.budget };
}

function routeTokenSet(result: RouteResult, meta: RouteMeta): Set<string> {
  const material = [
    result.route.split("_").join(" "),
    result.intent,
    ...meta.triggers,
  ].join(" ");
  return new Set(tokenize(material));
}

async function readLedger(vaultRoot: string, config: VaultConfig): Promise<unknown> {
  const text = await readTextFile(
    join(vaultRoot, config.paths.memory, "preferences", "_ledger.json"),
  );
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function userPromptSubmitHook(
  context: HookContext,
): Promise<HookOutcome | undefined> {
  // Runs first and unconditionally: an explicit "remember this" is filed
  // whether or not the prompt is also substantial enough to earn a route
  // injection, and a capture that fails here must never cost the route.
  const capture = overBudget(context)
    ? undefined
    : await runOrgan(() => promptSubmitCapture(context));

  const prompt = payloadString(context.payload, "prompt");
  if (prompt === undefined || isMicroTurn(prompt)) {
    return capture;
  }

  const result = await routeVault(context.vaultRoot, context.config, prompt);
  if (
    result.route.length === 0
    || result.route === "default"
    || !Number.isInteger(result.route_score)
    || result.route_score < MIN_ROUTE_SCORE
  ) {
    return capture;
  }

  const routingText = overBudget(context)
    ? undefined
    : await readTextFile(join(context.vaultRoot, context.config.paths.routing));
  const meta = routingText === undefined
    ? { triggers: [] }
    : readRouteMeta(routingText, result.route);

  const applyLines = overBudget(context)
    ? []
    : domainPreferenceLines(
      await readLedger(context.vaultRoot, context.config),
      routeTokenSet(result, meta),
    );

  const block = buildInjectionBlock(result, meta, applyLines, MAX_INJECTION_CHARS);
  if (block.text.length === 0) {
    return capture;
  }
  const base: HookOutcome = { context: block.text, budget: block.budget };
  return composeHookOutcomes(base, capture, MAX_INJECTION_CHARS);
}
