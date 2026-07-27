import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { emptyBudget } from "../core/budget.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import { sha256 } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import { withPreferenceLock, writeThroughRedline } from "../prefs/index.js";
import { isRecord, nowTimestamp } from "../staging/candidate.js";
import {
  batchPaths,
  loadBatch,
  loadBatchState,
  readTextFile,
  withSyncLock,
  writeImmutableJson,
} from "./review.js";
import {
  SYNC_SCHEMA_VERSION,
  SYNC_UNDO_SCHEMA,
  SYNC_UNDO_SEAL_SCHEMA,
  SYNC_UNDONE_SCHEMA,
  SyncGateError,
  type UndoRecord,
  type UndoResult,
  type UndoSeal,
  type UndoSealTarget,
  type UndoTargetKind,
  type UndoTargetSnapshot,
  type UndoneMarker,
} from "./types.js";

/**
 * Undo by record, not by version control.
 *
 * The gate this one is ported from claimed to be reversible because the vault
 * it lived in happened to be a git repository. That is a property of the vault,
 * not of the gate: on a vault that is not versioned, nothing was reversible at
 * all. So the reversal is built here, with no dependency and no assumption
 * about the surrounding directory.
 *
 * The rule is narrow on purpose. Undo restores the exact bytes recorded before
 * the batch was applied, and only when every target still holds exactly the
 * bytes the batch left behind. If anything moved since, undo refuses and names
 * what moved: overwriting a change somebody made afterwards would be a second
 * unwanted write, not the reversal of the first one.
 *
 * What undo does NOT do is rewrite history. The batch stays recorded as
 * applied, and its candidates stay archived with the decision that was made.
 * The files go back; the fact that you once said yes does not.
 */

function parseSnapshot(value: unknown, origin: string): UndoTargetSnapshot {
  if (!isRecord(value)) {
    throw new SyncGateError(`${origin} must be an object.`);
  }
  const kind = value.kind;
  if (
    kind !== "preference_ledger"
    && kind !== "preference_core"
    && kind !== "loader_mirror"
    && kind !== "memory_note"
  ) {
    throw new SyncGateError(`${origin}.kind is not an undo target kind.`);
  }
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new SyncGateError(`${origin}.path must be a non-empty string.`);
  }
  const existed = value.existed === true;
  const content = typeof value.content === "string" ? value.content : null;
  if (existed && content === null) {
    throw new SyncGateError(
      `${origin} says the file existed but carries no content, so it cannot be restored.`,
    );
  }
  if (existed && typeof value.sha256 === "string" && sha256(content ?? "") !== value.sha256) {
    throw new SyncGateError(
      `${origin} does not match its own recorded hash. The undo record was modified and is refused.`,
    );
  }
  return {
    kind: kind as UndoTargetKind,
    path: value.path,
    existed,
    sha256: typeof value.sha256 === "string" ? value.sha256 : null,
    bytes: typeof value.bytes === "number" ? value.bytes : null,
    content,
  };
}

export function parseUndoRecord(value: unknown, origin: string): UndoRecord {
  if (!isRecord(value) || value.schema !== SYNC_UNDO_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${SYNC_UNDO_SCHEMA} document.`);
  }
  if (!Array.isArray(value.targets)) {
    throw new SyncGateError(`${origin}.targets must be an array.`);
  }
  return {
    schema: SYNC_UNDO_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : SYNC_SCHEMA_VERSION,
    batch_id: typeof value.batch_id === "string" ? value.batch_id : "",
    recorded_at: typeof value.recorded_at === "string" ? value.recorded_at : "",
    approved_indices: Array.isArray(value.approved_indices)
      ? value.approved_indices.filter((item): item is number => typeof item === "number")
      : [],
    targets: value.targets.map((target, index) =>
      parseSnapshot(target, `${origin}.targets[${String(index)}]`)),
  };
}

export function parseUndoSeal(value: unknown, origin: string): UndoSeal {
  if (!isRecord(value) || value.schema !== SYNC_UNDO_SEAL_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${SYNC_UNDO_SEAL_SCHEMA} document.`);
  }
  if (!Array.isArray(value.targets)) {
    throw new SyncGateError(`${origin}.targets must be an array.`);
  }
  const targets: UndoSealTarget[] = value.targets.map((target, index) => {
    const where = `${origin}.targets[${String(index)}]`;
    if (!isRecord(target) || typeof target.path !== "string") {
      throw new SyncGateError(`${where} must carry a path.`);
    }
    const kind = target.kind;
    if (
      kind !== "preference_ledger"
      && kind !== "preference_core"
      && kind !== "loader_mirror"
      && kind !== "memory_note"
    ) {
      throw new SyncGateError(`${where}.kind is not an undo target kind.`);
    }
    return {
      kind: kind as UndoTargetKind,
      path: target.path,
      exists: target.exists === true,
      sha256: typeof target.sha256 === "string" ? target.sha256 : null,
    };
  });
  return {
    schema: SYNC_UNDO_SEAL_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : SYNC_SCHEMA_VERSION,
    batch_id: typeof value.batch_id === "string" ? value.batch_id : "",
    sealed_at: typeof value.sealed_at === "string" ? value.sealed_at : "",
    targets,
  };
}

async function readJson(path: string, origin: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyncGateError(`${origin} is not valid JSON, so it cannot be trusted to reverse anything.`);
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/**
 * Restores one target. The preference kernel goes back through the redline, so
 * the reversal is recorded with the same provenance machinery as the write it
 * reverses: an undo that left no trace would be exactly the kind of unrecorded
 * kernel write the redline exists to detect.
 */
async function restoreTarget(
  root: string,
  batchId: string,
  snapshot: UndoTargetSnapshot,
  restored: string[],
  removed: string[],
): Promise<void> {
  const absolute = join(root, snapshot.path);

  if (!snapshot.existed) {
    await removeFile(absolute);
    removed.push(snapshot.path);
    return;
  }

  const content = snapshot.content ?? "";
  if (snapshot.kind === "preference_ledger" || snapshot.kind === "preference_core") {
    await writeThroughRedline(root, {
      target: snapshot.kind === "preference_ledger" ? "ledger" : "core",
      relativePath: snapshot.path,
      content,
      command: "sync undo",
      validation: "undo-record",
      operationId: `${batchId}:undo:${snapshot.kind}`,
    });
    restored.push(snapshot.path);
    return;
  }

  await atomicWriteText(absolute, content);
  restored.push(snapshot.path);
}

export interface UndoOptions {
  /** Destructive by nature, so the caller has to say yes on purpose. */
  yes?: boolean;
}

/**
 * Reverses one applied batch, file by file, from its own record.
 */
export async function undoBatch(
  root: string,
  config: VaultConfig,
  batchId: string,
  options: UndoOptions = {},
): Promise<UndoResult> {
  return withSyncLock(root, async () => {
    const batch = await loadBatch(root, config, batchId);
    const paths = batchPaths(root, config, batch.batch_id);

    const undoneValue = await readJson(paths.undone, `${batchId}.undone.json`);
    if (undoneValue !== undefined) {
      const undoneAt = isRecord(undoneValue) && typeof undoneValue.undone_at === "string"
        ? undoneValue.undone_at
        : "an earlier run";
      return {
        schema_version: SYNC_SCHEMA_VERSION,
        batch_id: batch.batch_id,
        restored: [],
        removed: [],
        already_undone: true,
        budget: emptyBudget(),
        next: `Batch ${batch.batch_id} was already reversed on ${undoneAt}. Nothing was changed.`,
      };
    }

    const recordValue = await readJson(paths.undo, `${batchId}.undo.json`);
    if (recordValue === undefined) {
      throw new SyncGateError(
        `Batch ${batch.batch_id} has no undo record, which means it never wrote to a destination. There is nothing to reverse.`,
      );
    }
    const record = parseUndoRecord(recordValue, `${batchId}.undo.json`);

    const sealValue = await readJson(paths.seal, `${batchId}.undo-seal.json`);
    if (sealValue === undefined) {
      throw new SyncGateError(
        `Batch ${batch.batch_id} was never sealed, which means its apply did not finish. Finish it with \`open-brain sync resume --batch ${batch.batch_id}\` first, then undo it. Reversing a half-applied batch from an unfinished record would leave the vault in a third state that matches nothing.`,
      );
    }
    const seal = parseUndoSeal(sealValue, `${batchId}.undo-seal.json`);

    const state = await loadBatchState(root, config, batch.batch_id);
    if (state && state.phase !== "complete") {
      throw new SyncGateError(
        `Batch ${batch.batch_id} is in phase ${state.phase}, not complete. Resume it before reversing it.`,
      );
    }

    // The single condition of the whole module: the disk still holds exactly
    // what the batch left behind.
    const drifted: string[] = [];
    for (const target of seal.targets) {
      const current = await readTextFile(join(root, target.path));
      const actual = current === undefined ? null : sha256(current);
      const expected = target.exists ? target.sha256 : null;
      if (actual === expected) {
        continue;
      }
      if (expected === null) {
        drifted.push(`${target.path} did not exist after the batch and exists now`);
      } else if (actual === null) {
        drifted.push(`${target.path} was deleted after the batch was applied`);
      } else {
        drifted.push(
          `${target.path} changed after the batch was applied (expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)})`,
        );
      }
    }
    if (drifted.length > 0) {
      throw new SyncGateError(
        `Batch ${batch.batch_id} cannot be reversed because the vault moved since it was applied: ${drifted.join("; ")}. Nothing was changed. Reversing now would overwrite work done after the batch, which is not what undo is for. Restore or re-apply those files by hand, then run this again.`,
      );
    }

    if (options.yes !== true) {
      throw new SyncGateError(
        `Reversing batch ${batch.batch_id} rewrites ${String(record.targets.length)} file(s) back to the state recorded before it was applied, and deletes the ones it created. Re-run with --yes once you are sure.`,
      );
    }

    const restored: string[] = [];
    const removed: string[] = [];
    const kernelTargets = record.targets.filter(
      (target) => target.kind === "preference_ledger" || target.kind === "preference_core",
    );
    const otherTargets = record.targets.filter(
      (target) => target.kind !== "preference_ledger" && target.kind !== "preference_core",
    );

    if (kernelTargets.length > 0) {
      await withPreferenceLock(root, async () => {
        for (const target of kernelTargets) {
          await restoreTarget(root, batch.batch_id, target, restored, removed);
        }
      });
    }
    for (const target of otherTargets) {
      await restoreTarget(root, batch.batch_id, target, restored, removed);
    }

    const marker: UndoneMarker = {
      schema: SYNC_UNDONE_SCHEMA,
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: batch.batch_id,
      undone_at: nowTimestamp(),
      restored: [...restored].sort(),
      removed: [...removed].sort(),
    };
    await writeImmutableJson(paths.undone, marker, "The undo marker for this batch");

    return {
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: batch.batch_id,
      restored: marker.restored,
      removed: marker.removed,
      already_undone: false,
      budget: emptyBudget(),
      next: `Reversed. ${String(marker.restored.length)} file(s) were restored to the bytes recorded before the batch, and ${String(marker.removed.length)} file(s) it had created were deleted. The batch itself stays on record as applied and then reversed: its history is not rewritten.`,
    };
  });
}
