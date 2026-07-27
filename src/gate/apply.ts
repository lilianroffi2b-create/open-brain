import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { emptyBudget } from "../core/budget.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import { runVaultScan } from "../core/scan.js";
import { sha256, toPosixPath } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import { DEFAULT_LOADER_FILENAMES } from "../loaders/markers.js";
import {
  isPreferenceWeight,
  loadPreferenceLedger,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  readPreferenceOperations,
  runPreferenceOperation,
} from "../prefs/index.js";
import type { PreferenceLedger } from "../prefs/types.js";
import { computeDecisionHash, nowTimestamp } from "../staging/candidate.js";
import { compactStaging, getCandidate, transitionCandidate } from "../staging/store.js";
import {
  BATCH_DECISION_SCHEMA,
  STAGING_SCHEMA_VERSION,
  type BatchItem,
  type BatchState,
  type CandidateStatus,
  type MemoryWritePayload,
  type PreferenceWritePayload,
  type StagingBatch,
  type WeightWritePayload,
} from "../staging/types.js";
import {
  batchPaths,
  derivePhase,
  initialBatchState,
  loadBatch,
  loadBatchDecision,
  loadBatchState,
  readTextFile,
  resolveMemoryTarget,
  saveBatchState,
  withSyncLock,
  writeImmutableJson,
} from "./review.js";
import {
  SYNC_SCHEMA_VERSION,
  SYNC_UNDO_SCHEMA,
  SYNC_UNDO_SEAL_SCHEMA,
  SyncGateError,
  type ItemPreflight,
  type UndoRecord,
  type UndoSeal,
  type UndoSealTarget,
  type UndoTargetKind,
  type UndoTargetSnapshot,
  type ValidateResult,
} from "./types.js";

/**
 * The write half of the gate.
 *
 * The order of validateApply is not an implementation detail, it is the
 * contract: every step is a resume point, and every step before the decision
 * file is written can refuse without leaving a single byte behind. Once the
 * decision is frozen the run becomes replayable rather than reversible, which
 * is why the undo record is written before the first destination and sealed
 * after the last one.
 */

const APPROVE_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Parses the human's answer. An absent flag is refused by the caller, never
 * defaulted: a command that approves everything when you forget an argument is
 * a command that will eventually approve everything by accident.
 */
export function parseApprovedIndices(raw: string, itemCount: number): number[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  const indices: number[] = [];
  for (const part of parts) {
    if (!APPROVE_PATTERN.test(part)) {
      throw new SyncGateError(
        `"${part}" is not an item number. Pass the numbers you approve, comma separated, for example --approve "1,3". Pass an empty string to reject everything.`,
      );
    }
    const index = Number(part);
    if (index > itemCount) {
      throw new SyncGateError(
        `This batch has ${String(itemCount)} item(s), so ${String(index)} is not one of them.`,
      );
    }
    if (indices.includes(index)) {
      throw new SyncGateError(`Item ${String(index)} is listed twice.`);
    }
    indices.push(index);
  }
  return [...indices].sort((left, right) => left - right);
}

function refFor(item: BatchItem): string {
  switch (item.write.kind) {
    case "preference":
      return `preference:${item.write.args.id}`;
    case "weight":
      return item.write.mode === "bump"
        ? `weight:${item.write.args.id}:${String(item.write.args.weight)}`
        : `evidence:${item.write.args.id}:${String(item.write.args.weight)}`;
    case "memory":
      return item.write.target;
    case "reject_only":
      return "none";
  }
}

function ledgerHasOperation(ledger: PreferenceLedger, operationId: string): boolean {
  return readPreferenceOperations(ledger)
    .some((record) => record.operation_id === operationId);
}

async function preflightPreference(
  item: BatchItem,
  write: PreferenceWritePayload,
  ledger: PreferenceLedger | undefined,
): Promise<ItemPreflight> {
  if (!ledger) {
    throw new SyncGateError(
      "This batch creates a preference, but no preference ledger exists in this vault. Nothing was applied.",
    );
  }
  if (ledgerHasOperation(ledger, item.operation_id)) {
    return {
      index: item.index,
      operation_id: item.operation_id,
      verdict: "already_applied",
      ref: refFor(item),
      detail: `Preference ${write.args.id} was already created by this exact operation.`,
    };
  }
  if (ledger.preferences.some((preference) => preference.id === write.args.id)) {
    throw new SyncGateError(
      `Item ${String(item.index)} would create preference ${write.args.id}, but a preference with that id appeared since the batch was prepared. Nothing was applied. Re-run the review so the batch is built against the ledger as it is now.`,
    );
  }
  return {
    index: item.index,
    operation_id: item.operation_id,
    verdict: "pending",
    ref: refFor(item),
    detail: `Preference ${write.args.id} will be created at weight ${String(write.args.weight)}.`,
  };
}

async function preflightWeight(
  item: BatchItem,
  write: WeightWritePayload,
  ledger: PreferenceLedger | undefined,
): Promise<ItemPreflight> {
  if (!ledger) {
    throw new SyncGateError(
      "This batch changes a preference weight, but no preference ledger exists in this vault. Nothing was applied.",
    );
  }
  if (ledgerHasOperation(ledger, item.operation_id)) {
    return {
      index: item.index,
      operation_id: item.operation_id,
      verdict: "already_applied",
      ref: refFor(item),
      detail: `The evidence for ${write.args.id} was already recorded by this exact operation.`,
    };
  }
  const preference = ledger.preferences.find((entry) => entry.id === write.args.id);
  if (!preference) {
    throw new SyncGateError(
      `Item ${String(item.index)} changes preference ${write.args.id}, which no longer exists in the ledger. Nothing was applied.`,
    );
  }
  if (preference.weight !== write.precondition.expected_current_weight) {
    throw new SyncGateError(
      `Item ${String(item.index)} expects ${write.args.id} to weigh ${String(write.precondition.expected_current_weight)}, but it weighs ${String(preference.weight)} now. Nothing was applied. Re-run the review so the proposal is computed from the current weight.`,
    );
  }
  return {
    index: item.index,
    operation_id: item.operation_id,
    verdict: "pending",
    ref: refFor(item),
    detail: `${write.args.id} moves from ${String(preference.weight)} to ${String(write.args.weight)}.`,
  };
}

async function preflightMemory(
  root: string,
  config: VaultConfig,
  item: BatchItem,
  write: MemoryWritePayload,
): Promise<ItemPreflight> {
  const resolved = await resolveMemoryTarget(root, config, write.target);
  const existing = await readTextFile(resolved.absolutePath);
  const actual = existing === undefined ? undefined : sha256(existing);

  if (actual === write.content_sha256) {
    return {
      index: item.index,
      operation_id: item.operation_id,
      verdict: "already_applied",
      ref: refFor(item),
      detail: `${write.target} already holds exactly the proposed content.`,
    };
  }

  if (write.precondition.expected_sha256 === "absent") {
    if (existing !== undefined) {
      throw new SyncGateError(
        `Item ${String(item.index)} would create ${write.target}, but that note exists now with different content. Nothing was applied.`,
      );
    }
    return {
      index: item.index,
      operation_id: item.operation_id,
      verdict: "pending",
      ref: refFor(item),
      detail: `${write.target} will be created.`,
    };
  }

  if (actual !== write.precondition.expected_sha256) {
    throw new SyncGateError(
      `Item ${String(item.index)} expects ${write.target} to hash to ${write.precondition.expected_sha256.slice(0, 12)}, and it hashes to ${actual === undefined ? "nothing, the file is gone" : actual.slice(0, 12)}. Nothing was applied, and the note on disk was left exactly as it is.`,
    );
  }

  return {
    index: item.index,
    operation_id: item.operation_id,
    verdict: "pending",
    ref: refFor(item),
    detail: `${write.target} will be rewritten.`,
  };
}

async function preflightItem(
  root: string,
  config: VaultConfig,
  item: BatchItem,
  ledger: PreferenceLedger | undefined,
): Promise<ItemPreflight> {
  switch (item.write.kind) {
    case "preference":
      return preflightPreference(item, item.write, ledger);
    case "weight":
      return preflightWeight(item, item.write, ledger);
    case "memory":
      return preflightMemory(root, config, item, item.write);
    case "reject_only":
      throw new SyncGateError(
        `Item ${String(item.index)} is a recorded rejection and has no destination. It can never be approved.`,
      );
  }
}

/** Statuses a candidate of a decided batch may legitimately be found in. */
const RESUMABLE_CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  "proposed",
  "approved",
  "applying",
  "applied",
  "apply_failed",
  "rejected",
];

async function preflightCandidates(
  root: string,
  config: VaultConfig,
  batch: StagingBatch,
  approved: readonly number[],
): Promise<void> {
  for (const item of batch.items) {
    const isApproved = approved.includes(item.index);
    for (const candidateId of item.merged_ids) {
      const row = await getCandidate(root, config, candidateId);
      if (!row) {
        throw new SyncGateError(
          `Candidate ${candidateId} of item ${String(item.index)} is gone from the staging store. Nothing was applied.`,
        );
      }
      if (row.batch_id !== batch.batch_id) {
        throw new SyncGateError(
          `Candidate ${candidateId} belongs to batch ${String(row.batch_id)}, not to ${batch.batch_id}. Nothing was applied.`,
        );
      }
      if (row.gate_item_index !== item.index || row.type !== item.type || row.target !== item.target) {
        throw new SyncGateError(
          `Candidate ${candidateId} no longer carries the classification this batch was built from. Nothing was applied.`,
        );
      }
      if (!RESUMABLE_CANDIDATE_STATUSES.some((status) => status === row.status)) {
        throw new SyncGateError(
          `Candidate ${candidateId} is ${row.status}, which is not compatible with applying this batch. Nothing was applied.`,
        );
      }
      if (row.status === "applied" && !isApproved) {
        throw new SyncGateError(
          `Candidate ${candidateId} is recorded as applied although item ${String(item.index)} is rejected. Nothing was applied.`,
        );
      }
      if (row.status === "rejected" && isApproved) {
        throw new SyncGateError(
          `Candidate ${candidateId} is recorded as rejected although item ${String(item.index)} is approved. Nothing was applied.`,
        );
      }
    }
  }
}

/**
 * Moves one candidate, skipping the move when the candidate is already past it.
 * A resume replays the whole sequence, so every transition has to be a no-op
 * the second time rather than an illegal edge.
 */
async function advanceCandidate(
  root: string,
  config: VaultConfig,
  candidateId: string,
  status: CandidateStatus,
  options: {
    batchId: string;
    operationId: string;
    skipWhen: readonly CandidateStatus[];
    appliedRef?: string;
    applyError?: string;
  },
): Promise<void> {
  const row = await getCandidate(root, config, candidateId);
  if (!row) {
    throw new SyncGateError(`Candidate ${candidateId} is gone from the staging store.`);
  }
  // A candidate that is already where this move would put it needs no move at
  // all, and by then it may well be archived, where nothing can move any more.
  if (row.status === status || options.skipWhen.some((skip) => skip === row.status)) {
    return;
  }
  await transitionCandidate(root, config, {
    id: candidateId,
    status,
    batchId: options.batchId,
    operationId: options.operationId,
    ...(options.appliedRef === undefined ? {} : { appliedRef: options.appliedRef }),
    ...(options.applyError === undefined ? {} : { applyError: options.applyError }),
  });
}

function undoTargetsForItems(
  root: string,
  config: VaultConfig,
  items: readonly BatchItem[],
): { kind: UndoTargetKind; path: string }[] {
  const targets: { kind: UndoTargetKind; path: string }[] = [];
  const touchesKernel = items.some(
    (item) => item.write.kind === "preference" || item.write.kind === "weight",
  );
  if (touchesKernel) {
    targets.push({
      kind: "preference_ledger",
      path: toPosixPath(PREFERENCE_LEDGER_RELATIVE_PATH),
    });
    targets.push({ kind: "preference_core", path: toPosixPath(PREFERENCE_CORE_RELATIVE_PATH) });
    for (const filename of DEFAULT_LOADER_FILENAMES) {
      targets.push({ kind: "loader_mirror", path: filename });
    }
  }
  for (const item of items) {
    if (item.write.kind === "memory") {
      targets.push({ kind: "memory_note", path: item.write.target });
    }
  }
  return targets;
}

async function snapshotTarget(
  root: string,
  target: { kind: UndoTargetKind; path: string },
): Promise<UndoTargetSnapshot> {
  const content = await readTextFile(join(root, target.path));
  if (content === undefined) {
    return {
      kind: target.kind,
      path: target.path,
      existed: false,
      sha256: null,
      bytes: null,
      content: null,
    };
  }
  return {
    kind: target.kind,
    path: target.path,
    existed: true,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

async function sealTarget(
  root: string,
  target: { kind: UndoTargetKind; path: string },
): Promise<UndoSealTarget> {
  const content = await readTextFile(join(root, target.path));
  return {
    kind: target.kind,
    path: target.path,
    exists: content !== undefined,
    sha256: content === undefined ? null : sha256(content),
  };
}

async function applyPreference(
  root: string,
  write: PreferenceWritePayload,
  operationId: string,
): Promise<void> {
  if (!isPreferenceWeight(write.args.weight)) {
    throw new SyncGateError(
      `Preference ${write.args.id} carries an impossible weight ${String(write.args.weight)}.`,
    );
  }
  const result = await runPreferenceOperation(
    root,
    {
      kind: "add",
      operationId,
      id: write.args.id,
      text: write.args.statement,
      weight: write.args.weight,
      date: write.args.date,
      domains: write.args.domains,
      why: write.args.why,
      apply: write.args.apply,
      source: write.args.source,
      quote: write.args.quote,
    },
    { command: "sync validate" },
  );
  if (result.outcome.kind === "conflict") {
    throw new SyncGateError(
      `Preference ${write.args.id} was not created: ${result.outcome.detail}`,
    );
  }
}

async function applyWeight(
  root: string,
  write: WeightWritePayload,
  operationId: string,
): Promise<void> {
  if (!isPreferenceWeight(write.args.weight)) {
    throw new SyncGateError(
      `Preference ${write.args.id} carries an impossible weight ${String(write.args.weight)}.`,
    );
  }
  const result = await runPreferenceOperation(
    root,
    {
      kind: "log",
      operationId,
      id: write.args.id,
      signal: write.args.signal,
      date: write.args.date,
      weight: write.args.weight,
      quote: write.args.quote,
    },
    { command: "sync validate" },
  );
  if (result.outcome.kind === "conflict") {
    throw new SyncGateError(
      `The weight of ${write.args.id} was not changed: ${result.outcome.detail}`,
    );
  }
}

async function applyMemory(
  root: string,
  config: VaultConfig,
  write: MemoryWritePayload,
): Promise<void> {
  const resolved = await resolveMemoryTarget(root, config, write.target);
  await atomicWriteText(resolved.absolutePath, write.content);
  const written = await readFile(resolved.absolutePath, "utf8");
  if (sha256(written) !== write.content_sha256) {
    throw new SyncGateError(
      `${write.target} was written but does not hash to the approved content. The destination is not in the state the batch describes.`,
    );
  }
}

async function applyDestination(
  root: string,
  config: VaultConfig,
  item: BatchItem,
): Promise<void> {
  switch (item.write.kind) {
    case "preference":
      await applyPreference(root, item.write, item.operation_id);
      return;
    case "weight":
      await applyWeight(root, item.write, item.operation_id);
      return;
    case "memory":
      await applyMemory(root, config, item.write);
      return;
    case "reject_only":
      throw new SyncGateError(
        `Item ${String(item.index)} has no destination and must never be applied.`,
      );
  }
}

async function loadLedgerIfAny(root: string): Promise<PreferenceLedger | undefined> {
  try {
    return await loadPreferenceLedger(root);
  } catch {
    return undefined;
  }
}

export interface ValidateInput {
  batchId: string;
  /** The literal value of --approve. An empty string rejects everything. */
  approve: string;
}

/**
 * Freezes the human decision and applies exactly it.
 *
 * Nothing before step 8 writes anything a later run has to undo, and nothing
 * after step 8 depends on the human being present again: the decision file is
 * the commit point of the review, and everything past it is replayable from
 * disk alone.
 */
export async function validateApply(
  root: string,
  config: VaultConfig,
  input: ValidateInput,
): Promise<ValidateResult> {
  return withSyncLock(root, async () => {
    // 1. Load and verify the batch and the state.
    const batch = await loadBatch(root, config, input.batchId);
    const paths = batchPaths(root, config, batch.batch_id);
    let state = await loadBatchState(root, config, batch.batch_id)
      ?? await saveBatchState(root, config, initialBatchState(batch));

    // 2. Parse the answer.
    const approved = parseApprovedIndices(input.approve, batch.items.length);

    // 3. A recorded rejection can never be approved.
    const forbidden = approved.filter((index) => {
      const item = batch.items[index - 1];
      return item !== undefined && item.recommendation === "reject_only";
    });
    if (forbidden.length > 0) {
      throw new SyncGateError(
        `Item(s) ${forbidden.join(", ")} are recorded rejections: the evidence behind them is insufficient, so the gate cannot write them whatever you choose. Remove them from --approve. Nothing was applied.`,
      );
    }

    // 4. Compute the signed decision and refuse a second, different one.
    const rejected = batch.items
      .map((item) => item.index)
      .filter((index) => !approved.includes(index));
    const hash = computeDecisionHash(approved, rejected);
    if (state.decision !== null && state.decision.hash !== hash) {
      throw new SyncGateError(
        `Batch ${batch.batch_id} already carries a different decision (approved ${state.decision.approved_indices.join(", ") || "nothing"}). A decision is frozen once. Resume it with \`open-brain sync resume --batch ${batch.batch_id}\`.`,
      );
    }
    const existingDecision = await loadBatchDecision(root, config, batch.batch_id);
    if (existingDecision && existingDecision.decision.hash !== hash) {
      throw new SyncGateError(
        `Batch ${batch.batch_id} was already decided differently (approved ${existingDecision.decision.approved_indices.join(", ") || "nothing"}). The frozen decision wins. Resume it with \`open-brain sync resume --batch ${batch.batch_id}\`.`,
      );
    }

    const approvedItems = approved
      .map((index) => batch.items[index - 1])
      .filter((item): item is BatchItem => item !== undefined);

    // 5. Preflight every approved item. No mutation happens in this pass.
    const ledger = await loadLedgerIfAny(root);
    const preflights = new Map<number, ItemPreflight>();
    for (const item of approvedItems) {
      preflights.set(item.index, await preflightItem(root, config, item, ledger));
    }

    // 6. Preflight the candidates themselves.
    await preflightCandidates(root, config, batch, approved);

    // 7. No contradiction rules in Open Brain: the shape stays for stability.
    const warnings: string[] = [];

    // 8. Freeze the decision on disk.
    await writeImmutableJson(
      paths.decision,
      {
        schema: BATCH_DECISION_SCHEMA,
        schema_version: STAGING_SCHEMA_VERSION,
        batch_id: batch.batch_id,
        decision: { approved_indices: approved, rejected_indices: rejected, hash },
      },
      "The decision for this batch",
    );

    // 9. Record it in the state.
    if (state.decision === null || state.phase === "proposed") {
      state = await saveBatchState(root, config, {
        ...state,
        phase: "decided",
        decision: { approved_indices: approved, rejected_indices: rejected, hash },
      });
    }

    // 10. Move every candidate to the side the human put it on.
    for (const item of batch.items) {
      const isApproved = approved.includes(item.index);
      for (const candidateId of item.merged_ids) {
        await advanceCandidate(root, config, candidateId, isApproved ? "approved" : "rejected", {
          batchId: batch.batch_id,
          operationId: `${batch.batch_id}:${isApproved ? "approve" : "reject"}:${candidateId}`,
          skipWhen: isApproved
            ? ["approved", "applying", "applied", "apply_failed"]
            : ["rejected"],
        });
      }
    }

    // 11. Enter the applying phase.
    if (state.phase !== "applying") {
      state = await saveBatchState(root, config, { ...state, phase: "applying" });
    }

    // 11b. Record what every destination looked like BEFORE the first write.
    // This is the only moment the pre-state still exists, and the record is
    // immutable so a resume reuses the original one instead of snapshotting a
    // half-applied vault.
    const undoTargets = undoTargetsForItems(root, config, approvedItems);
    const undoAlreadyRecorded = (await readTextFile(paths.undo)) !== undefined;
    if (undoTargets.length > 0 && !undoAlreadyRecorded) {
      const snapshots: UndoTargetSnapshot[] = [];
      for (const target of undoTargets) {
        snapshots.push(await snapshotTarget(root, target));
      }
      const record: UndoRecord = {
        schema: SYNC_UNDO_SCHEMA,
        schema_version: SYNC_SCHEMA_VERSION,
        batch_id: batch.batch_id,
        recorded_at: nowTimestamp(),
        approved_indices: approved,
        targets: snapshots,
      };
      await writeImmutableJson(paths.undo, record, "The undo record for this batch");
    }

    // 12. Apply every approved item, in index order.
    const refs: Record<string, string> = {};
    for (const item of approvedItems) {
      const preflight = preflights.get(item.index);
      if (!preflight) {
        throw new SyncGateError(`Item ${String(item.index)} was never preflighted.`);
      }
      const operation = state.operations[item.operation_id];
      if (!operation) {
        throw new SyncGateError(
          `Batch ${batch.batch_id} has no recorded operation for item ${String(item.index)}. The state file does not describe this batch.`,
        );
      }
      if (operation.status === "applied" && preflight.verdict !== "already_applied") {
        throw new SyncGateError(
          `Item ${String(item.index)} is recorded as applied, but its destination does not hold the approved content. Nothing further was applied. Inspect ${refFor(item)} before running this again.`,
        );
      }

      for (const candidateId of item.merged_ids) {
        await advanceCandidate(root, config, candidateId, "applying", {
          batchId: batch.batch_id,
          operationId: `${batch.batch_id}:applying:${candidateId}`,
          skipWhen: ["applying", "applied"],
        });
      }

      try {
        if (preflight.verdict !== "already_applied") {
          state = await saveBatchState(root, config, {
            ...state,
            operations: {
              ...state.operations,
              [item.operation_id]: {
                ...operation,
                status: "applying",
                attempts: operation.attempts + 1,
                error: null,
              },
            },
          });
          await applyDestination(root, config, item);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        state = await saveBatchState(root, config, {
          ...state,
          phase: "apply_failed",
          operations: {
            ...state.operations,
            [item.operation_id]: {
              ...operation,
              status: "apply_failed",
              attempts: operation.attempts + 1,
              error: detail,
            },
          },
        });
        for (const candidateId of item.merged_ids) {
          await advanceCandidate(root, config, candidateId, "apply_failed", {
            batchId: batch.batch_id,
            operationId: `${batch.batch_id}:failed:${candidateId}`,
            skipWhen: ["apply_failed"],
            applyError: detail,
          });
        }
        throw new SyncGateError(
          `Item ${String(item.index)} could not be applied: ${detail} The batch is left in apply_failed and can be resumed with \`open-brain sync resume --batch ${batch.batch_id}\`.`,
        );
      }

      const ref = refFor(item);
      refs[String(item.index)] = ref;
      state = await saveBatchState(root, config, {
        ...state,
        operations: {
          ...state.operations,
          [item.operation_id]: {
            ...operation,
            status: "applied",
            attempts: preflight.verdict === "already_applied"
              ? operation.attempts
              : operation.attempts + 1,
            ref,
            error: null,
          },
        },
      });
      for (const candidateId of item.merged_ids) {
        await advanceCandidate(root, config, candidateId, "applied", {
          batchId: batch.batch_id,
          operationId: `${batch.batch_id}:applied:${candidateId}`,
          skipWhen: [],
          appliedRef: ref,
        });
      }
    }

    // 13. Reindex once, and only when a note actually reached the vault.
    let reindexed = false;
    const approvedMemory = approvedItems.some((item) => item.write.kind === "memory");
    if (approvedMemory && !state.scan_done) {
      try {
        await runVaultScan(root, config);
        reindexed = true;
        state = await saveBatchState(root, config, { ...state, scan_done: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(
          `A memory note was written but the index could not be refreshed (${detail}). The note is on disk. Run \`open-brain scan\` when you can.`,
        );
      }
    }

    // 14. Every approved operation must be applied, or the batch is not done.
    const unfinished = approvedItems.filter(
      (item) => state.operations[item.operation_id]?.status !== "applied",
    );
    if (unfinished.length > 0) {
      throw new SyncGateError(
        `Item(s) ${unfinished.map((item) => String(item.index)).join(", ")} are still not applied. The batch stays open.`,
      );
    }

    // 14b. Seal the undo record with what the destinations look like now.
    // Both records carry the moment they were taken, so a replay must reuse the
    // originals rather than write a second, differently timestamped copy.
    const sealAlreadyWritten = (await readTextFile(paths.seal)) !== undefined;
    if (undoTargets.length > 0 && !sealAlreadyWritten) {
      const sealed: UndoSealTarget[] = [];
      for (const target of undoTargets) {
        sealed.push(await sealTarget(root, target));
      }
      const seal: UndoSeal = {
        schema: SYNC_UNDO_SEAL_SCHEMA,
        schema_version: SYNC_SCHEMA_VERSION,
        batch_id: batch.batch_id,
        sealed_at: nowTimestamp(),
        targets: sealed,
      };
      await writeImmutableJson(paths.seal, seal, "The undo seal for this batch");
    }

    // 15. The batch is complete.
    if (state.phase !== "complete") {
      state = await saveBatchState(root, config, { ...state, phase: "complete" });
    }

    // 16. Archive the candidates, once every one of them is terminal.
    if (!state.compacted) {
      for (const item of batch.items) {
        for (const candidateId of item.merged_ids) {
          const row = await getCandidate(root, config, candidateId);
          if (row && row.status !== "applied" && row.status !== "rejected") {
            throw new SyncGateError(
              `Candidate ${candidateId} is ${row.status} and cannot be archived yet. The batch stays open.`,
            );
          }
        }
      }
      await compactStaging(root, config);
      state = await saveBatchState(root, config, { ...state, compacted: true });
    }

    return {
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: batch.batch_id,
      approved_indices: approved,
      rejected_indices: rejected,
      phase: state.phase,
      compacted: state.compacted,
      reindexed,
      refs,
      warnings,
      undo_available: undoTargets.length > 0,
      budget: emptyBudget(),
      next: undoTargets.length > 0
        ? `Applied. If this was wrong, reverse it with \`open-brain sync undo ${batch.batch_id}\`: the state of every file before the batch is recorded next to it.`
        : "Applied. Nothing was written to a destination, so there is nothing to reverse.",
    };
  });
}

export interface ResumeResult {
  schema_version: number;
  batch_id: string;
  phase: string;
  resumed: boolean;
  result: ValidateResult | null;
  next: string;
}

/**
 * Picks a batch back up after a crash, without ever running the classifier
 * again. With a frozen decision it replays exactly that decision; without one it
 * hands the batch back to the human, which is the only correct move: a resume
 * must never invent a choice nobody made.
 */
export async function resumeBatch(
  root: string,
  config: VaultConfig,
  batchId: string,
): Promise<ResumeResult> {
  const batch = await loadBatch(root, config, batchId);
  const decision = await loadBatchDecision(root, config, batchId);
  const stateBefore = await loadBatchState(root, config, batchId);
  const phase = derivePhase(stateBefore, decision);

  const frozen = decision?.decision ?? stateBefore?.decision ?? null;
  if (!frozen) {
    if (!stateBefore) {
      await withSyncLock(root, async () => {
        await saveBatchState(root, config, initialBatchState(batch));
      });
    }
    return {
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: batchId,
      phase,
      resumed: true,
      result: null,
      next: `Batch ${batchId} was never decided, so there is nothing to replay. Present it with \`open-brain sync show --batch ${batchId}\` and decide with \`open-brain sync validate --batch ${batchId} --approve "<indices or empty>"\`.`,
    };
  }

  const result = await validateApply(root, config, {
    batchId,
    approve: frozen.approved_indices.join(","),
  });
  return {
    schema_version: SYNC_SCHEMA_VERSION,
    batch_id: batchId,
    phase: result.phase,
    resumed: true,
    result,
    next: result.next,
  };
}
