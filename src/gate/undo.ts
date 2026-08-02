import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { emptyBudget } from "../core/budget.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import { sha256 } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import {
  assertValidPreferenceLedger,
  withPreferenceLock,
  writeThroughRedline,
} from "../prefs/index.js";
import { isRecord, nowTimestamp } from "../staging/candidate.js";
import { assertHumanPresence, type HumanPresence } from "./presence.js";
import {
  batchPaths,
  loadBatch,
  loadBatchState,
  loadPresentation,
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
 *
 * Undo writes to the preference kernel, so it is a door into it, and a door is
 * defined by its weakest lock. It therefore asks for exactly what `sync
 * validate` asks for, a terminal on standard input and the token `sync show`
 * printed for this batch, and it trusts its own record no further than it can
 * check it: every snapshot carries a hash, the hash is verified before a single
 * byte is written back, and restored ledger content goes through the same
 * validator as a ledger written by hand. A record whose hash is missing is
 * refused rather than restored, because a snapshot nothing can check is a
 * snapshot anybody can write.
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
  const recorded = typeof value.sha256 === "string" ? value.sha256 : null;

  // A snapshot of a file that did not exist restores nothing, it deletes. So it
  // must carry nothing to restore: content or a hash next to existed:false is a
  // record somebody built by hand, not one the gate wrote.
  if (!existed) {
    if (content !== null || recorded !== null) {
      throw new SyncGateError(
        `${origin} says the file did not exist before the batch, yet carries content or a hash. The undo record was modified and is refused.`,
      );
    }
    return {
      kind: kind as UndoTargetKind,
      path: value.path,
      existed: false,
      sha256: null,
      bytes: null,
      content: null,
    };
  }

  if (content === null) {
    throw new SyncGateError(
      `${origin} says the file existed but carries no content, so it cannot be restored.`,
    );
  }
  // Unconditional, and fail closed on an absent hash. Verifying only when a hash
  // happens to be there means deleting one key turns the check off, which makes
  // the check a formality and the whole record forgeable.
  if (recorded === null) {
    throw new SyncGateError(
      `${origin} carries content to restore but no hash of it. A snapshot nothing can check is a snapshot anybody can write, so it is refused. Nothing was changed.`,
    );
  }
  if (sha256(content) !== recorded) {
    throw new SyncGateError(
      `${origin} does not match its own recorded hash. The undo record was modified and is refused.`,
    );
  }
  return {
    kind: kind as UndoTargetKind,
    path: value.path,
    existed,
    sha256: recorded,
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

/**
 * The trace of a reversal that started and has not finished.
 *
 * Undo puts files back one at a time, so between the first one and the last one
 * the vault matches neither the state the batch left nor the state before it. A
 * reversal interrupted in there used to be unresumable: the drift check compared
 * the disk with the seal, the files already put back no longer matched it, and
 * every retry was refused for a drift the reversal itself had caused. This
 * record is what makes the second run a continuation rather than a stranger: it
 * names what is already back, so those files are checked against the state they
 * were restored to and the rest against the seal, exactly as they should be.
 *
 * It is mutable and short lived, unlike everything else the gate writes. It
 * exists only between the first restore and the undone marker, and the marker is
 * what replaces it.
 */
export const SYNC_UNDOING_SCHEMA = "open-brain/sync-undoing/v1";

export interface UndoProgress {
  schema: typeof SYNC_UNDOING_SCHEMA;
  schema_version: number;
  batch_id: string;
  started_at: string;
  restored: string[];
  removed: string[];
}

export function parseUndoProgress(value: unknown, origin: string): UndoProgress {
  if (!isRecord(value) || value.schema !== SYNC_UNDOING_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${SYNC_UNDOING_SCHEMA} document.`);
  }
  const paths = (field: string): string[] => {
    const list = value[field];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
      throw new SyncGateError(`${origin}.${field} must be an array of paths.`);
    }
    return list.filter((item): item is string => typeof item === "string");
  };
  return {
    schema: SYNC_UNDOING_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : SYNC_SCHEMA_VERSION,
    batch_id: typeof value.batch_id === "string" ? value.batch_id : "",
    started_at: typeof value.started_at === "string" ? value.started_at : "",
    restored: paths("restored"),
    removed: paths("removed"),
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
 * Reads a ledger the record wants to put back, and refuses anything the ledger
 * validator would refuse from any other writer.
 *
 * The hash of the snapshot proves the bytes are the ones that were recorded. It
 * says nothing about what those bytes are, and the redline records whatever
 * reaches it, so a ledger restored without this check would be published as a
 * legitimate write and then verify clean forever after.
 */
function assertRestorableLedger(content: string, path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new SyncGateError(
      `The undo record restores ${path}, but its content is not valid JSON, so it is not a ledger. Nothing was changed.`,
    );
  }
  try {
    assertValidPreferenceLedger(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyncGateError(
      `The undo record restores ${path}, but its content is not a valid preference ledger: ${detail} Nothing was changed.`,
    );
  }
}

async function writeUndoProgress(path: string, progress: UndoProgress): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(progress, null, 2)}\n`);
}

/**
 * Turns whatever the filesystem raised into the one error type the CLI knows how
 * to print, and says the two things the person in front of it needs: how far the
 * reversal got, and that running it again continues from there. A stack trace
 * would have told them neither.
 */
function reversalFailed(
  batchId: string,
  target: UndoTargetSnapshot,
  error: unknown,
  alreadyDone: number,
): SyncGateError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SyncGateError(
    `Batch ${batchId} could not be reversed: ${target.path} could not be put back (${detail}). ${String(alreadyDone)} file(s) were already restored or deleted, and that is recorded in ${batchId}.undoing.json, so running the same command again resumes from there instead of starting over. Fix what blocked this file first: nothing else was changed.`,
  );
}

/**
 * Runs the content checks that must happen before the first byte moves. A
 * reversal that refuses halfway through has already written half of what it was
 * refusing, so everything a record can be refused for is decided here.
 */
function assertRestorableRecord(record: UndoRecord): void {
  for (const target of record.targets) {
    if (target.kind === "preference_ledger" && target.existed) {
      assertRestorableLedger(target.content ?? "", target.path);
    }
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

/**
 * What a caller offers as proof that this reversal is a human decision.
 *
 * The shape mirrors gate/types.ts DecisionProof on purpose: the two doors into
 * the kernel answer to one contract, and a proof that is easier to produce on
 * one of them is the one an agent will use. A replay carries nothing, and it is
 * only ever accepted for an undo that is already recorded as under way, where
 * the human said yes before the first byte moved.
 */
export type UndoProof =
  | { kind: "human"; confirm: string; presence: HumanPresence }
  | { kind: "replay" };

export interface UndoOptions {
  /** Destructive by nature, so the caller has to say yes on purpose. */
  yes?: boolean;
  /** What proves this reversal is a human decision. See gate/presence.ts. */
  proof: UndoProof;
}

/**
 * Refuses a reversal that nothing ties to a human.
 *
 * Two independent facts, the same two `sync validate` demands. A terminal on
 * standard input answers "is anybody there", which no composed command line can
 * fabricate about itself. The token `sync show` printed for this batch answers
 * "does the caller know which batch this is", which a batch identifier does not:
 * the identifier is written in every listing, the token is printed in one place.
 * The escape hatch removes the first and leaves the second, exactly as it does
 * on the other door.
 */
async function assertUndoProof(
  root: string,
  config: VaultConfig,
  batchId: string,
  // Typed as optional for callers that are not compiled against this signature.
  // A missing proof is not a missing argument, it is a missing human.
  proof: UndoProof | undefined,
): Promise<void> {
  if (proof === undefined) {
    throw new SyncGateError(
      `Reversing batch ${batchId} writes to the preference kernel and this call carries no proof that a human asked for it. Run \`open-brain sync undo ${batchId} --yes --confirm <the token sync show prints>\` from a terminal.`,
    );
  }
  if (proof.kind === "replay") {
    throw new SyncGateError(
      `No reversal of batch ${batchId} is under way, so there is nothing to replay. Reverse it with \`open-brain sync undo ${batchId} --yes --confirm <the token sync show prints>\`.`,
    );
  }
  assertHumanPresence(proof.presence, "`open-brain sync undo`");

  const presented = await loadPresentation(root, config, batchId);
  if (!presented) {
    throw new SyncGateError(
      `Batch ${batchId} was never presented, so there is no token to prove this reversal was asked for by somebody who read it. Run \`open-brain sync show --batch ${batchId}\` first: it prints a short confirmation token to pass back with --confirm.`,
    );
  }
  if (proof.confirm.trim().length === 0) {
    throw new SyncGateError(
      `This command needs --confirm <token>. \`open-brain sync show --batch ${batchId}\` prints the token, and retyping it is what proves this batch was read rather than named. It has no default, on purpose: undo writes to the preference kernel.`,
    );
  }
  if (proof.confirm.trim().toLowerCase() !== presented.token) {
    throw new SyncGateError(
      `The confirmation token does not match the one \`open-brain sync show --batch ${batchId}\` printed. Nothing was changed. Present the batch again and retype the token it gives you.`,
    );
  }
}

/**
 * Reverses one applied batch, file by file, from its own record.
 */
export async function undoBatch(
  root: string,
  config: VaultConfig,
  batchId: string,
  options: UndoOptions,
): Promise<UndoResult> {
  return withSyncLock(root, async () => {
    const batch = await loadBatch(root, config, batchId);
    const paths = batchPaths(root, config, batch.batch_id);
    const progressPath = join(paths.directory, `${batch.batch_id}.undoing.json`);

    const undoneValue = await readJson(paths.undone, `${batchId}.undone.json`);
    if (undoneValue !== undefined) {
      // The marker replaces the progress record, including after a crash that
      // landed between the two writes.
      await removeFile(progressPath);
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
    assertRestorableRecord(record);

    const progressValue = await readJson(progressPath, `${batchId}.undoing.json`);
    const progress = progressValue === undefined
      ? undefined
      : parseUndoProgress(progressValue, `${batchId}.undoing.json`);

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

    // What an interrupted reversal claims to have put back, kept to the targets
    // this batch actually has: a path the record does not know is a path nothing
    // below verifies, and an unverified claim must never count as progress.
    const snapshots = new Map(record.targets.map((target) => [target.path, target]));
    const known = new Set(
      seal.targets.map((target) => target.path).filter((path) => snapshots.has(path)),
    );
    const restored: string[] = (progress?.restored ?? []).filter((path) => known.has(path));
    const removed: string[] = (progress?.removed ?? []).filter((path) => known.has(path));
    const done = new Set([...restored, ...removed]);

    // The single condition of the whole module: the disk still holds exactly
    // what the batch left behind. What an interrupted reversal already put back
    // is held to the other end of the same record instead, since that is the
    // state this very command wrote there.
    const drifted: string[] = [];
    for (const target of seal.targets) {
      const current = await readTextFile(join(root, target.path));
      const actual = current === undefined ? null : sha256(current);
      if (done.has(target.path)) {
        const snapshot = snapshots.get(target.path);
        const before = snapshot?.existed === true ? snapshot.sha256 : null;
        if (snapshot !== undefined && actual === before) {
          continue;
        }
        drifted.push(
          `${target.path} was put back by the interrupted reversal and has changed again since`,
        );
        continue;
      }
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

    // Who is asking. Nothing has been written at this point, and the answer
    // depends on whether this run starts a reversal or finishes one.
    //
    // A reversal that is genuinely half done asks for nothing again, for the
    // same reason a resume of an apply asks for nothing: the human said yes
    // before the first byte moved, and finishing what that yes started is
    // bookkeeping, not a second decision. Refusing there would leave the vault
    // half reverted with no way out. The waiver rests on evidence rather than on
    // the record's word, because the record is a file anybody can write: every
    // target it calls done was just compared with the state this command would
    // have restored it to, and a record that claims nothing waives nothing.
    if (done.size === 0) {
      await assertUndoProof(root, config, batch.batch_id, options.proof);
    }

    if (options.yes !== true) {
      throw new SyncGateError(
        `Reversing batch ${batch.batch_id} rewrites ${String(record.targets.length)} file(s) back to the state recorded before it was applied, and deletes the ones it created. Re-run with --yes once you are sure.`,
      );
    }

    const kernelTargets = record.targets.filter(
      (target) => target.kind === "preference_ledger" || target.kind === "preference_core",
    );
    const otherTargets = record.targets.filter(
      (target) => target.kind !== "preference_ledger" && target.kind !== "preference_core",
    );

    // Opened before the first byte moves, so an interruption anywhere after this
    // line is a reversal that can be finished rather than one that is stuck.
    const started: UndoProgress = progress !== undefined && done.size > 0
      ? { ...progress, restored: [...restored], removed: [...removed] }
      : {
        schema: SYNC_UNDOING_SCHEMA,
        schema_version: SYNC_SCHEMA_VERSION,
        batch_id: batch.batch_id,
        started_at: nowTimestamp(),
        restored: [],
        removed: [],
      };
    if (done.size === 0) {
      await writeUndoProgress(progressPath, started);
    }

    const step = async (target: UndoTargetSnapshot): Promise<void> => {
      if (done.has(target.path)) {
        return;
      }
      try {
        await restoreTarget(root, batch.batch_id, target, restored, removed);
      } catch (error) {
        throw reversalFailed(batch.batch_id, target, error, done.size);
      }
      done.add(target.path);
      await writeUndoProgress(progressPath, {
        ...started,
        restored: [...restored],
        removed: [...removed],
      });
    };

    if (kernelTargets.length > 0) {
      await withPreferenceLock(root, async () => {
        for (const target of kernelTargets) {
          await step(target);
        }
      });
    }
    for (const target of otherTargets) {
      await step(target);
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
    await removeFile(progressPath);

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
