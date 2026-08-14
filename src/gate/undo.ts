import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { emptyBudget } from "../core/budget.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import { loadVaultSecret, sealsMatch, vaultMac, type VaultSecret } from "../core/secret.js";
import { sha256, toPosixPath } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import { DEFAULT_LOADER_FILENAMES } from "../loaders/markers.js";
import {
  assertValidPreferenceLedger,
  REDLINE_TARGET_PATHS,
  withPreferenceLock,
  writeThroughRedline,
} from "../prefs/index.js";
import { isRecord, nowTimestamp } from "../staging/candidate.js";
import { assertHumanPresence, type HumanPresence } from "./presence.js";
import {
  assertMemoryTargetShape,
  batchPaths,
  loadBatch,
  loadBatchState,
  loadPresentation,
  readTextFile,
  resolveMemoryTarget,
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
 *
 * That last sentence was the whole problem, because it was also true of the
 * check itself. The hash was a plain sha256 over the snapshot, so whoever wrote
 * the snapshot could write its hash, and every rule above amounted to asking a
 * forger to be consistent. The record, the post-apply seal, the progress record
 * and the undone marker are therefore all keyed with the vault secret, which
 * lives outside the vault (core/secret.ts). The per snapshot hashes stay: they
 * answer "are these the bytes this record names", which is still worth checking
 * and gives a far better error message. The key answers the other question, the
 * one nothing here could answer before: did this gate write this record at all.
 */

/** Domain tags, so a seal written for one record never fits another. */
const UNDO_RECORD_DOMAIN = "open-brain/sync-undo-record/v1";
const UNDO_SEAL_DOMAIN = "open-brain/sync-undo-seal/v1";
const UNDO_PROGRESS_DOMAIN = "open-brain/sync-undoing/v1";
const UNDONE_DOMAIN = "open-brain/sync-undone/v1";

/**
 * The seal of an undo record, over every byte of it that decides what gets
 * written back.
 *
 * Without it, the record was a plain JSON file whose only defence was a sha256
 * of each snapshot, computed with a function this package exports: rewriting a
 * snapshot and recomputing its hash took one line, and the reversal would then
 * dutifully write an attacker's ledger into the kernel with the full provenance
 * of a legitimate restore. Keyed with the vault secret, the record can still be
 * read and edited by anybody, and any edit at all makes it unusable.
 */
export function sealUndoRecord(
  record: Omit<UndoRecord, "seal">,
  secret: VaultSecret,
): string {
  return vaultMac(secret, UNDO_RECORD_DOMAIN, JSON.stringify([
    record.schema,
    record.schema_version,
    record.batch_id,
    record.recorded_at,
    record.approved_indices,
    record.targets.map((target) => [
      target.kind,
      target.path,
      target.existed,
      target.sha256,
      target.bytes,
      target.content,
    ]),
  ]));
}

/** The seal of the post-apply fingerprint, the other end of the same record. */
export function sealUndoSeal(seal: Omit<UndoSeal, "seal">, secret: VaultSecret): string {
  return vaultMac(secret, UNDO_SEAL_DOMAIN, JSON.stringify([
    seal.schema,
    seal.schema_version,
    seal.batch_id,
    seal.sealed_at,
    seal.targets.map((target) => [target.kind, target.path, target.exists, target.sha256]),
  ]));
}

/** The seal of the undone marker, so "already reversed" is not just a claim. */
export function sealUndoneMarker(
  marker: Omit<UndoneMarker, "seal">,
  secret: VaultSecret,
): string {
  return vaultMac(secret, UNDONE_DOMAIN, JSON.stringify([
    marker.schema,
    marker.schema_version,
    marker.batch_id,
    marker.undone_at,
    marker.restored,
    marker.removed,
  ]));
}

/**
 * Where each kind of target is allowed to live, exactly.
 *
 * A snapshot path used to travel straight from the record into join(root, path)
 * and then into a write or an unlink, with nothing between the two but the
 * assumption that the gate had written the record. An absolute path, or one
 * carrying enough of "..", therefore reached any file the user could write,
 * anywhere on the machine, and undo would happily put "content" there or delete
 * what was already there. So the kind of a target now decides its location
 * rather than merely describing it: the three kernel and loader kinds have one
 * legal path each, and a note is held to the same rule as a note written by the
 * gate itself, which is the rule in review.ts and not a second copy of it.
 */
function assertUndoTargetPath(
  config: VaultConfig,
  kind: UndoTargetKind,
  path: string,
  origin: string,
): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new SyncGateError(`${origin}.path must be a non-empty string.`);
  }
  const relative = toPosixPath(path);
  if (
    relative.startsWith("/")
    || /^[a-zA-Z]:/u.test(relative)
    || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new SyncGateError(
      `${origin}.path is ${path}, which is absolute or walks out of the vault. An undo record only ever names files inside the vault it belongs to, so it is refused and nothing was changed.`,
    );
  }

  switch (kind) {
    case "preference_ledger":
    case "preference_core": {
      const expected = toPosixPath(
        kind === "preference_ledger" ? REDLINE_TARGET_PATHS.ledger : REDLINE_TARGET_PATHS.core,
      );
      if (relative !== expected) {
        throw new SyncGateError(
          `${origin} claims to be the ${kind} and points at ${relative}, which is not ${expected}. A snapshot that names one file and restores another is refused.`,
        );
      }
      return relative;
    }
    case "loader_mirror": {
      if (!DEFAULT_LOADER_FILENAMES.some((filename) => filename === relative)) {
        throw new SyncGateError(
          `${origin} claims to be a loader mirror and points at ${relative}, which is not one of ${DEFAULT_LOADER_FILENAMES.join(", ")}. It is refused.`,
        );
      }
      return relative;
    }
    case "memory_note":
      // Exactly the rule a memory item goes through when it is written, so a
      // reversal can never reach a file the apply could not have reached.
      return assertMemoryTargetShape(config, relative);
  }
}

function parseSnapshot(
  value: unknown,
  origin: string,
  config: VaultConfig,
): UndoTargetSnapshot {
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
  const path = assertUndoTargetPath(config, kind as UndoTargetKind, value.path, origin);
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
      path,
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
    path,
    existed,
    sha256: recorded,
    bytes: typeof value.bytes === "number" ? value.bytes : null,
    content,
  };
}

export function parseUndoRecord(
  value: unknown,
  origin: string,
  config: VaultConfig,
): UndoRecord {
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
      parseSnapshot(target, `${origin}.targets[${String(index)}]`, config)),
    seal: typeof value.seal === "string" ? value.seal : "",
  };
}

export function parseUndoSeal(
  value: unknown,
  origin: string,
  config: VaultConfig,
): UndoSeal {
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
      path: assertUndoTargetPath(config, kind as UndoTargetKind, target.path, where),
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
    seal: typeof value.seal === "string" ? value.seal : "",
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
  /**
   * The waiver token. Written when the human proof was accepted, and the only
   * thing that lets a later run skip that proof. See assertUndoProof.
   */
  seal: string;
}

/**
 * The seal of a reversal in flight, which is the token that waives the proof of
 * a human on the run that finishes it.
 *
 * This is the whole of defect 2. The waiver used to rest on a file called
 * <batch>.undoing.json being present and self consistent, and that file is
 * inside the vault: an agent that could write a note could write it too, claim a
 * reversal of its own choosing was under way, and reverse the preference kernel
 * with no terminal, no token, and nobody asked. The seal moves the waiver from
 * something the caller asserts to something only a run holding the vault key
 * could have produced, which is exactly the difference between a claim and a
 * fact.
 */
export function sealUndoProgress(
  progress: Omit<UndoProgress, "seal">,
  secret: VaultSecret,
): string {
  return vaultMac(secret, UNDO_PROGRESS_DOMAIN, JSON.stringify([
    progress.schema,
    progress.schema_version,
    progress.batch_id,
    progress.started_at,
    progress.restored,
    progress.removed,
  ]));
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
    seal: typeof value.seal === "string" ? value.seal : "",
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

async function writeUndoProgress(
  path: string,
  progress: Omit<UndoProgress, "seal">,
  secret: VaultSecret,
): Promise<void> {
  const sealed: UndoProgress = { ...progress, seal: sealUndoProgress(progress, secret) };
  await atomicWriteText(path, `${JSON.stringify(sealed, null, 2)}\n`);
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
  config: VaultConfig,
  batchId: string,
  snapshot: UndoTargetSnapshot,
  restored: string[],
  removed: string[],
): Promise<void> {
  // A note goes through the same resolution as a note written by the gate, so
  // the last check before the write is the symlink walk rather than the shape
  // check alone: a directory swapped for a link between the parse and here is
  // the one hole the shape check on its own cannot close.
  const absolute = snapshot.kind === "memory_note"
    ? (await resolveMemoryTarget(root, config, snapshot.path)).absolutePath
    : join(root, snapshot.path);

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
 * only ever accepted for an undo whose progress record carries the seal of this
 * vault, which is to say one a run of this gate really did start, where the
 * human said yes before the first byte moved.
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
 * Refuses an "already reversed" answer that this gate did not write. Ending the
 * command is a decision too: a marker anybody could drop in the directory would
 * make a batch unreversible forever, and would do it silently.
 */
function assertUndoneMarker(value: unknown, origin: string, secret: VaultSecret): void {
  if (!isRecord(value) || value.schema !== SYNC_UNDONE_SCHEMA) {
    throw new SyncGateError(`${origin} is not a ${SYNC_UNDONE_SCHEMA} document.`);
  }
  const marker: Omit<UndoneMarker, "seal"> = {
    schema: SYNC_UNDONE_SCHEMA,
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : SYNC_SCHEMA_VERSION,
    batch_id: typeof value.batch_id === "string" ? value.batch_id : "",
    undone_at: typeof value.undone_at === "string" ? value.undone_at : "",
    restored: Array.isArray(value.restored)
      ? value.restored.filter((item): item is string => typeof item === "string")
      : [],
    removed: Array.isArray(value.removed)
      ? value.removed.filter((item): item is string => typeof item === "string")
      : [],
  };
  if (!sealsMatch(
    typeof value.seal === "string" ? value.seal : "",
    sealUndoneMarker(marker, secret),
  )) {
    throw new SyncGateError(
      `${origin} says this batch was already reversed, and does not carry the seal of this vault. A marker anybody can write would be a way to make a batch permanently irreversible, so it is refused and nothing was changed.`,
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

    const secret = await loadVaultSecret(root);

    const undoneValue = await readJson(paths.undone, `${batchId}.undone.json`);
    if (undoneValue !== undefined) {
      // "Already reversed" ends the command, so it has to be a fact rather than
      // a claim: a marker anybody could drop here would make a batch permanently
      // irreversible by saying it already had been.
      assertUndoneMarker(undoneValue, `${batchId}.undone.json`, secret);
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
    const record = parseUndoRecord(recordValue, `${batchId}.undo.json`, config);
    assertRestorableRecord(record);
    // Last of the record checks, and the one nothing gets past. The checks above
    // name a precise fault in a record this gate did write, which is what a
    // person repairing a half-written vault needs to read; this one answers the
    // other question, whether this gate wrote the record at all.
    if (!sealsMatch(record.seal, sealUndoRecord(record, secret))) {
      throw new SyncGateError(
        `${batchId}.undo.json does not carry the seal of this vault. An undo record decides which bytes get written back into the preference kernel, so it is only ever trusted when it was written by a run of this gate holding the vault key, which lives outside the vault. It is refused and nothing was changed.`,
      );
    }

    const progressValue = await readJson(progressPath, `${batchId}.undoing.json`);
    const parsedProgress = progressValue === undefined
      ? undefined
      : parseUndoProgress(progressValue, `${batchId}.undoing.json`);
    // A progress record that this gate did not write claims nothing, and is not
    // an error either: it is simply not evidence, so the reversal starts from
    // the beginning and asks a human, exactly as it would with no file at all.
    const progress = parsedProgress !== undefined
      && sealsMatch(parsedProgress.seal, sealUndoProgress(parsedProgress, secret))
      ? parsedProgress
      : undefined;

    const sealValue = await readJson(paths.seal, `${batchId}.undo-seal.json`);
    if (sealValue === undefined) {
      throw new SyncGateError(
        `Batch ${batch.batch_id} was never sealed, which means its apply did not finish. Finish it with \`open-brain sync resume --batch ${batch.batch_id}\` first, then undo it. Reversing a half-applied batch from an unfinished record would leave the vault in a third state that matches nothing.`,
      );
    }
    const seal = parseUndoSeal(sealValue, `${batchId}.undo-seal.json`, config);
    if (!sealsMatch(seal.seal, sealUndoSeal(seal, secret))) {
      throw new SyncGateError(
        `${batchId}.undo-seal.json does not carry the seal of this vault. It is the fingerprint every target is compared against before anything is written back, so a forged one would let a reversal run against a vault that has moved. It is refused and nothing was changed.`,
      );
    }

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
    // half reverted with no way out.
    //
    // What makes that safe is what "half done" is allowed to mean. It is not the
    // word of a file in the vault: an unsealed progress record was dropped
    // above, so its claims never reach `done` and this branch is not taken.
    // Only a record carrying the seal of a run that held the vault key counts,
    // and on top of that every target it calls done was just compared with the
    // state this command would have restored it to. A claim nobody could have
    // written and that the disk confirms is evidence; a file with the right name
    // never was.
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
    // line is a reversal that can be finished rather than one that is stuck. It
    // is sealed as it is written, which is what makes it the token the run that
    // finishes this one presents in place of a second human.
    const started: Omit<UndoProgress, "seal"> = progress !== undefined && done.size > 0
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
      await writeUndoProgress(progressPath, started, secret);
    }

    const step = async (target: UndoTargetSnapshot): Promise<void> => {
      if (done.has(target.path)) {
        return;
      }
      try {
        await restoreTarget(root, config, batch.batch_id, target, restored, removed);
      } catch (error) {
        throw reversalFailed(batch.batch_id, target, error, done.size);
      }
      done.add(target.path);
      await writeUndoProgress(progressPath, {
        ...started,
        restored: [...restored],
        removed: [...removed],
      }, secret);
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

    const unsealedMarker: Omit<UndoneMarker, "seal"> = {
      schema: SYNC_UNDONE_SCHEMA,
      schema_version: SYNC_SCHEMA_VERSION,
      batch_id: batch.batch_id,
      undone_at: nowTimestamp(),
      restored: [...restored].sort(),
      removed: [...removed].sort(),
    };
    const marker: UndoneMarker = {
      ...unsealedMarker,
      seal: sealUndoneMarker(unsealedMarker, secret),
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
