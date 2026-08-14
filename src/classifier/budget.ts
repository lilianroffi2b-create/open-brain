import { join } from "node:path";

import { emptyBudget, type ContextBudget } from "../core/budget.js";
import { atomicWriteJson } from "../core/fs-atomic.js";
import { isRecord } from "../staging/candidate.js";
import type { ClassifierProvider, VaultConfig } from "../core/types.js";
import { readTextFile } from "../gate/review.js";

/**
 * What a classification costs, counted and shown BEFORE the call.
 *
 * The classifier is the only organ in Open Brain that spends money. A number
 * printed after the fact is an invoice; a number printed before it is a choice.
 * So the accounting lives here, on its own, and every command that could lead
 * to a model call renders it first.
 *
 * The counter is local and day scoped. It lives under .open-brain/local/,
 * outside the indexed vault, next to the redline record: it is machine state,
 * not vault content, and it must never travel with the vault or land in the
 * index.
 */

export const CLASSIFIER_USAGE_RELATIVE_PATH = join(
  ".open-brain",
  "local",
  "classifier-usage.json",
);

export const CLASSIFIER_USAGE_SCHEMA_VERSION = 1;

/** Default character ceiling of the material handed to a classifier. */
export const DEFAULT_CLASSIFIER_INPUT_CHARS = 24_000;

export interface ClassifierUsage {
  schema_version: number;
  day: string;
  calls: number;
  last_call_at: string | null;
}

export interface ClassifierCost {
  provider: ClassifierProvider;
  armed: boolean;
  daily_call_budget: number;
  calls_spent_today: number;
  calls_remaining: number;
  calls_planned: number;
  candidates_total: number;
  candidates_sent: number;
  /** The cost of the material that would be sent, in the shared vocabulary. */
  input: ContextBudget;
  within_budget: boolean;
  summary: string;
}

/** UTC day, so a budget never resets twice because a machine moved timezone. */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function parseUsage(value: unknown, day: string): ClassifierUsage {
  if (!isRecord(value)) {
    return { schema_version: CLASSIFIER_USAGE_SCHEMA_VERSION, day, calls: 0, last_call_at: null };
  }
  const storedDay = typeof value.day === "string" ? value.day : "";
  const calls = typeof value.calls === "number" && Number.isInteger(value.calls) && value.calls >= 0
    ? value.calls
    : 0;
  if (storedDay !== day) {
    return { schema_version: CLASSIFIER_USAGE_SCHEMA_VERSION, day, calls: 0, last_call_at: null };
  }
  return {
    schema_version: CLASSIFIER_USAGE_SCHEMA_VERSION,
    day,
    calls,
    last_call_at: typeof value.last_call_at === "string" ? value.last_call_at : null,
  };
}

/**
 * Reads today's counter. An unreadable file reads as zero calls spent rather
 * than as an error: a corrupt counter must never be the reason a user cannot
 * run anything, and the worst it can cost is one extra call.
 */
export async function readClassifierUsage(
  root: string,
  now: Date = new Date(),
): Promise<ClassifierUsage> {
  const day = usageDay(now);
  const text = await readTextFile(join(root, CLASSIFIER_USAGE_RELATIVE_PATH));
  if (text === undefined) {
    return { schema_version: CLASSIFIER_USAGE_SCHEMA_VERSION, day, calls: 0, last_call_at: null };
  }
  try {
    return parseUsage(JSON.parse(text) as unknown, day);
  } catch {
    return { schema_version: CLASSIFIER_USAGE_SCHEMA_VERSION, day, calls: 0, last_call_at: null };
  }
}

/**
 * Books one call before it is made. Counting on the way out would let a crash
 * between the request and the answer hide a call that was really paid for, and
 * a budget that undercounts is not a budget.
 */
export async function recordClassifierCall(
  root: string,
  now: Date = new Date(),
): Promise<ClassifierUsage> {
  const usage = await readClassifierUsage(root, now);
  const next: ClassifierUsage = {
    schema_version: CLASSIFIER_USAGE_SCHEMA_VERSION,
    day: usage.day,
    calls: usage.calls + 1,
    last_call_at: now.toISOString(),
  };
  await atomicWriteJson(join(root, CLASSIFIER_USAGE_RELATIVE_PATH), next);
  return next;
}

export interface CostInput {
  budget: ContextBudget;
  candidatesTotal: number;
  candidatesSent: number;
  callsPlanned: number;
  armed: boolean;
}

export function estimateClassifierCost(
  config: VaultConfig,
  usage: ClassifierUsage,
  input: CostInput,
): ClassifierCost {
  const dailyBudget = config.capabilities.classifier.daily_call_budget;
  const remaining = Math.max(0, dailyBudget - usage.calls);
  const withinBudget = input.callsPlanned <= remaining;
  const provider = config.capabilities.classifier.provider;

  const summary = input.armed
    ? `This run sends ${String(input.candidatesSent)} of ${String(input.candidatesTotal)} staged candidate(s), about ${String(input.budget.token_estimate)} input tokens, and spends ${String(input.callsPlanned)} of your ${String(remaining)} remaining call(s) today (daily budget ${String(dailyBudget)}, provider ${provider}).`
    : `The classifier is disarmed, so nothing is sent and nothing is spent. Armed, this run would send ${String(input.candidatesSent)} of ${String(input.candidatesTotal)} staged candidate(s), about ${String(input.budget.token_estimate)} input tokens, and one call out of a daily budget of ${String(dailyBudget)}.`;

  return {
    provider,
    armed: input.armed,
    daily_call_budget: dailyBudget,
    calls_spent_today: usage.calls,
    calls_remaining: remaining,
    calls_planned: input.callsPlanned,
    candidates_total: input.candidatesTotal,
    candidates_sent: input.candidatesSent,
    input: input.budget,
    within_budget: withinBudget,
    summary,
  };
}

export function emptyClassifierBudget(): ContextBudget {
  return emptyBudget();
}
