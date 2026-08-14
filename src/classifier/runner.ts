import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEnabled, requireCapability } from "../core/capabilities.js";
import { ExpectedError } from "../core/errors.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import type { VaultConfig } from "../core/types.js";
import { renderStagedSlice } from "../gate/render.js";
import { syncStaged } from "../gate/review.js";
import type { StagedCandidateView, StagedSlice } from "../gate/types.js";
import {
  DEFAULT_CLASSIFIER_INPUT_CHARS,
  estimateClassifierCost,
  readClassifierUsage,
  recordClassifierCall,
  type ClassifierCost,
} from "./budget.js";
import { MAX_CLASSIFICATION_ITEMS } from "./contract.js";

/**
 * The classifier runner.
 *
 * Open Brain never calls a model itself. It has no provider client, no API key,
 * and no network code, and it is not going to grow one: the host CLI already
 * has a model, a subscription, and a read-only agent surface. So this module
 * prepares a request, bounds it, prices it, books the call, and hands the host
 * a workspace outside the vault to answer in. The host does the thinking; the
 * gate does the deciding; neither of them writes to the kernel.
 *
 * Two properties matter more than anything else here.
 *
 * The capability is checked FIRST, before a single candidate is read, so a
 * default vault can never reach the point where a call would be made. That is
 * invariant I2, and it is what makes "Open Brain costs nothing until you decide
 * otherwise" a fact rather than a claim.
 *
 * The cost is computed and returned BEFORE the request is issued, never after,
 * so a user sees what they are about to spend while they can still decline.
 */

export const CLASSIFICATION_REQUEST_SCHEMA = "open-brain/classification-request/v1";
export const CLASSIFIER_WORKSPACE_PREFIX = "open-brain-classify";
export const CLASSIFICATION_INPUT_FILE = "staged.json";
export const CLASSIFICATION_OUTPUT_FILE = "classification.json";

export interface ClassifierWorkspace {
  directory: string;
  input: string;
  output: string;
}

/**
 * The workspace lives in the system temporary directory, never in the vault. A
 * classifier scratch file is not vault content: it must not be indexed, it must
 * not be committed, and it must not survive a reboot.
 */
export function classifierWorkspace(selectionId: string): ClassifierWorkspace {
  const directory = join(tmpdir(), CLASSIFIER_WORKSPACE_PREFIX, selectionId);
  return {
    directory,
    input: join(directory, CLASSIFICATION_INPUT_FILE),
    output: join(directory, CLASSIFICATION_OUTPUT_FILE),
  };
}

export interface ClassificationPlan {
  schema: typeof CLASSIFICATION_REQUEST_SCHEMA;
  schema_version: number;
  armed: boolean;
  issued: boolean;
  selection_id: string;
  candidate_ids: string[];
  /** The bounded material a classifier would receive, and nothing more. */
  staged: StagedCandidateView[];
  remaining_count: number;
  cost: ClassifierCost;
  workspace: ClassifierWorkspace;
  instructions: string[];
  input_preview: string;
  next: string;
}

export interface ClassifyOptions {
  maxChars?: number | undefined;
  maxItems?: number | undefined;
  now?: Date | undefined;
}

function boundedSlice(
  root: string,
  config: VaultConfig,
  options: ClassifyOptions,
): Promise<StagedSlice> {
  return syncStaged(root, config, {
    limit: Math.min(options.maxItems ?? MAX_CLASSIFICATION_ITEMS, MAX_CLASSIFICATION_ITEMS),
    maxChars: options.maxChars ?? DEFAULT_CLASSIFIER_INPUT_CHARS,
  });
}

function instructionsFor(
  workspace: ClassifierWorkspace,
  selectionId: string,
  count: number,
): string[] {
  return [
    `Read the ${String(count)} staged candidate(s) in ${workspace.input}.`,
    "Classify every one of them. A candidate you cannot justify becomes an item with weak set to true, recommendation reject_only, and evidence_basis insufficient. Never drop one, and never return an empty array.",
    `Write the result as a raw JSON array to ${workspace.output}, using the host's own file write tool. Never use echo, a heredoc, or shell interpolation: classified text is data, and a shell would turn it into commands.`,
    `Then run: open-brain sync prepare --input ${workspace.output} --selection ${selectionId}`,
    "The gate revalidates everything you produced. You propose; it decides what is admissible; the human decides what is written.",
  ];
}

/**
 * Prices a classification without touching a model, a network, or the
 * capability gate. This is what `--dry-run` runs, and it is deliberately
 * available on a vault with nothing armed: a user has to be able to see what a
 * capability would cost before arming it.
 */
export async function planClassification(
  root: string,
  config: VaultConfig,
  options: ClassifyOptions = {},
): Promise<ClassificationPlan> {
  const now = options.now ?? new Date();
  const slice = await boundedSlice(root, config, options);
  const usage = await readClassifierUsage(root, now);
  const armed = isEnabled(config, "classifier");
  const presentation = renderStagedSlice(
    slice.staged,
    options.maxChars ?? DEFAULT_CLASSIFIER_INPUT_CHARS,
  );
  const cost = estimateClassifierCost(config, usage, {
    budget: presentation.budget,
    candidatesTotal: slice.count + slice.remaining_count,
    candidatesSent: slice.count,
    callsPlanned: slice.count === 0 ? 0 : 1,
    armed,
  });
  const workspace = classifierWorkspace(slice.selection_id);

  return {
    schema: CLASSIFICATION_REQUEST_SCHEMA,
    schema_version: 1,
    armed,
    issued: false,
    selection_id: slice.selection_id,
    candidate_ids: slice.candidate_ids,
    staged: slice.staged,
    remaining_count: slice.remaining_count,
    cost,
    workspace,
    instructions: instructionsFor(workspace, slice.selection_id, slice.count),
    input_preview: presentation.text,
    next: slice.count === 0
      ? "Nothing staged to review."
      : armed
        ? `Nothing has been sent yet. Run the same command without --dry-run to book the call and write the request, or classify these ${String(slice.count)} candidate(s) by hand and run \`open-brain sync prepare\` yourself.`
        : "The classifier is disarmed, so no model call can happen. Read what arming it would do with `open-brain capabilities explain classifier`, then arm it with `open-brain capabilities enable classifier`. You can also classify by hand and run `open-brain sync prepare` without ever arming it.",
  };
}

/**
 * Books one call and writes the request. The order is the whole point: the
 * capability, then the provider, then the budget, then the counter, and only
 * then the files the host will read. Every refusal happens before anything is
 * spent or written.
 */
export async function issueClassificationRequest(
  root: string,
  config: VaultConfig,
  options: ClassifyOptions = {},
): Promise<ClassificationPlan> {
  requireCapability(config, "classifier");

  if (config.capabilities.classifier.provider === "none") {
    throw new ExpectedError(
      "The classifier is armed but its provider is none, so no candidate can be classified. Set capabilities.classifier.provider to claude-code-subagent, or disarm the capability so the configuration says what it does.",
    );
  }

  const plan = await planClassification(root, config, options);
  if (plan.candidate_ids.length === 0) {
    throw new ExpectedError(
      "Nothing staged to review, so there is nothing to classify and no call was spent.",
    );
  }
  if (!plan.cost.within_budget) {
    throw new ExpectedError(
      `The daily classifier budget is spent: ${String(plan.cost.calls_spent_today)} call(s) used of ${String(plan.cost.daily_call_budget)}. Nothing was sent. Raise capabilities.classifier.daily_call_budget, or come back tomorrow. Classifying by hand and running \`open-brain sync prepare\` never spends a call.`,
    );
  }

  const now = options.now ?? new Date();
  const usage = await recordClassifierCall(root, now);

  await mkdir(plan.workspace.directory, { recursive: true });
  await atomicWriteText(
    plan.workspace.input,
    `${JSON.stringify(
      {
        schema: CLASSIFICATION_REQUEST_SCHEMA,
        selection_id: plan.selection_id,
        candidate_ids: plan.candidate_ids,
        remaining_count: plan.remaining_count,
        staged: plan.staged,
        instructions: plan.instructions,
      },
      null,
      2,
    )}\n`,
  );

  return {
    ...plan,
    issued: true,
    cost: { ...plan.cost, calls_spent_today: usage.calls, calls_remaining: Math.max(0, plan.cost.daily_call_budget - usage.calls) },
    next: `The call is booked and the request is at ${plan.workspace.input}. Hand it to the read-only classifier agent, have it write ${plan.workspace.output}, then run \`open-brain sync prepare --input ${plan.workspace.output} --selection ${plan.selection_id}\`.`,
  };
}
