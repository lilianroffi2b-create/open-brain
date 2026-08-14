import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ExpectedError } from "../core/errors.js";
import { lockPathFor, withLock, type LockOptions } from "../core/lock.js";
import { decodeText } from "../core/text.js";
import {
  applyPreferenceOperation,
  type PreferenceOperationInput,
  type PreferenceOperationOutcome,
} from "./ledger.js";
import { syncPreferenceMirrors, type PreferenceMirrorSyncResult } from "./mirror.js";
import { REDLINE_TARGET_PATHS, writeThroughRedline } from "./redline.js";
import { renderPreferenceCore } from "./render.js";
import type { Preference, PreferenceLedger } from "./types.js";
import { assertValidPreferenceLedger, shouldAutoRegen } from "./validation.js";

// One place decides where the kernel lives, and it is the one that has to find
// those files without a record to point at them.
export const PREFERENCE_LEDGER_RELATIVE_PATH = REDLINE_TARGET_PATHS.ledger;
export const PREFERENCE_CORE_RELATIVE_PATH = REDLINE_TARGET_PATHS.core;

/** Named lock guarding every read-modify-write cycle on the preference kernel. */
export const PREFERENCE_LOCK_NAME = "prefs";

function nodeErrorHasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * The ledger is not there at all. A vault before its first preference is in
 * this state, and so is a vault whose kernel was never seeded, so callers that
 * can work without a ledger catch this one and only this one.
 */
export class PreferenceLedgerMissingError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "PreferenceLedgerMissingError";
  }
}

/**
 * The ledger is there and cannot be used. Never the same fact as absence, and
 * never reported as one: telling somebody to create what they already have is
 * how a diagnosis loop closes on itself.
 */
export class PreferenceLedgerUnreadableError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "PreferenceLedgerUnreadableError";
  }
}

/** What to do about a kernel file that exists and cannot be read. */
const REPAIR_HINT =
  "Repair or restore that file before writing to the kernel again: `open-brain init` refuses to "
  + "overwrite an existing vault and `open-brain prefs add` will not write over a ledger it cannot "
  + "read. The hash and provenance of the last recorded write are in .open-brain/local/, and the "
  + "bytes before the last applied batch are in that batch's undo record.";

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the ledger, and names exactly what is wrong with it when it cannot.
 *
 * Every way of failing here used to arrive at the caller as a raw crash with no
 * filename: a byte order mark, which is what Windows editors write by default,
 * an empty file, a truncated write, a directory where the file should be. They
 * are all one sentence apart from each other and the reader needs that sentence,
 * so each one is caught, named, and pointed at the file it is about.
 */
export async function loadPreferenceLedger(
  vaultRoot: string,
): Promise<PreferenceLedger> {
  const path = join(vaultRoot, PREFERENCE_LEDGER_RELATIVE_PATH);

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (nodeErrorHasCode(error, "ENOENT")) {
      throw new PreferenceLedgerMissingError(
        `No preference ledger at ${path}. Create one with \`open-brain prefs add\`, or run \`open-brain init\` if this directory is not a vault yet.`,
      );
    }
    if (nodeErrorHasCode(error, "EISDIR")) {
      throw new PreferenceLedgerUnreadableError(
        `${path} is a directory, and the preference ledger is a file. ${REPAIR_HINT}`,
      );
    }
    throw new PreferenceLedgerUnreadableError(
      `${path} exists and cannot be read (${errorDetail(error)}). ${REPAIR_HINT}`,
    );
  }

  // decodeText strips a byte order mark and refuses binary outright, which is
  // the difference between "your editor added three bytes" and a stack trace.
  let text: string;
  try {
    text = decodeText(bytes).text;
  } catch (error) {
    throw new PreferenceLedgerUnreadableError(
      `${path} is not text (${errorDetail(error)}), so it is not a preference ledger. ${REPAIR_HINT}`,
    );
  }

  if (text.trim().length === 0) {
    throw new PreferenceLedgerUnreadableError(
      `${path} is empty. An empty file is not an empty ledger: a ledger with no preferences still carries its schema. ${REPAIR_HINT}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new PreferenceLedgerUnreadableError(
      `${path} is not valid JSON (${errorDetail(error)}). ${REPAIR_HINT}`,
    );
  }

  try {
    assertValidPreferenceLedger(parsed);
  } catch (error) {
    throw new PreferenceLedgerUnreadableError(
      `${errorDetail(error)} It was read from ${path}. ${REPAIR_HINT}`,
    );
  }
  return parsed;
}

/** Provenance recorded with every kernel write. See prefs/redline.ts. */
export interface PreferenceWriteContext {
  /** The command performing the write, for example "prefs log". */
  command: string;
  operationId?: string;
}

const DEFAULT_WRITE_CONTEXT: PreferenceWriteContext = { command: "prefs" };

export async function savePreferenceLedger(
  vaultRoot: string,
  ledger: PreferenceLedger,
  context: PreferenceWriteContext = DEFAULT_WRITE_CONTEXT,
): Promise<void> {
  assertValidPreferenceLedger(ledger);
  await writeThroughRedline(vaultRoot, {
    target: "ledger",
    relativePath: PREFERENCE_LEDGER_RELATIVE_PATH,
    content: `${JSON.stringify(ledger, null, 2)}\n`,
    command: context.command,
    validation: "assertValidPreferenceLedger",
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
  });
}

export async function writePreferenceCore(
  vaultRoot: string,
  ledger: PreferenceLedger,
  context: PreferenceWriteContext = DEFAULT_WRITE_CONTEXT,
): Promise<void> {
  await writeThroughRedline(vaultRoot, {
    target: "core",
    relativePath: PREFERENCE_CORE_RELATIVE_PATH,
    content: renderPreferenceCore(ledger),
    command: context.command,
    validation: "renderPreferenceCore",
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
  });
}

/**
 * Runs fn while holding the preference lock of this vault.
 *
 * The lock covers the whole read-modify-write cycle, never the write alone: a
 * ledger read before the lock is stale by construction, and two concurrent
 * writers would each save a ledger built from a state the other has already
 * replaced. Reentrance is refused by the lock itself, so a command that needs
 * both a mutation and a regeneration must wrap them in one call to this
 * function and use the unlocked helpers inside.
 */
export function withPreferenceLock<T>(
  vaultRoot: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return withLock(lockPathFor(vaultRoot, PREFERENCE_LOCK_NAME), fn, {
    holder: "open-brain prefs",
    ...options,
  });
}

/**
 * Rewrites the rendered core and the loader mirrors from a ledger. Does not take
 * the lock: callers run it inside withPreferenceLock, or inside a mutation that
 * already holds it.
 */
export async function regeneratePreferenceOutputs(
  vaultRoot: string,
  ledger: PreferenceLedger,
  context: PreferenceWriteContext = DEFAULT_WRITE_CONTEXT,
): Promise<PreferenceMirrorSyncResult[]> {
  await writePreferenceCore(vaultRoot, ledger, context);
  return syncPreferenceMirrors(vaultRoot, ledger);
}

export interface PreferenceOperationOptions {
  now?: Date;
  /** Command name recorded as the provenance of every resulting write. */
  command?: string;
  lock?: LockOptions;
  /**
   * Checked against the ledger as it is INSIDE the lock, just before the
   * operation is applied, and expected to throw when it does not hold.
   *
   * A caller that checks a precondition before calling this function has
   * checked a ledger that is already stale: the lock is taken here, so anything
   * read before it belongs to a vault that another writer may have changed
   * since. That gap is not theoretical. The sync gate preflights every approved
   * item against the ledger, then freezes the decision, then writes, and a
   * `prefs log` from another terminal in between used to be enough for a weight
   * bump computed from 3 to land on a preference that already weighed 4. The
   * hook exists so the last word on a precondition is spoken under the lock,
   * where it cannot be overtaken.
   */
  precondition?: (ledger: PreferenceLedger) => void;
}

export interface PreferenceOperationResult {
  outcome: PreferenceOperationOutcome;
  /** The ledger as it stands on disk once the call returns. */
  ledger: PreferenceLedger;
  preference?: Preference;
  regenerated: boolean;
  mirrors: PreferenceMirrorSyncResult[];
}

/**
 * Performs one identified preference mutation end to end: takes the lock, reads
 * the ledger inside it, applies the operation, and publishes the result through
 * the redline. A replay or a conflict writes nothing at all.
 */
export async function runPreferenceOperation(
  vaultRoot: string,
  input: PreferenceOperationInput,
  options: PreferenceOperationOptions = {},
): Promise<PreferenceOperationResult> {
  const command = options.command ?? `prefs ${input.kind}`;
  const context: PreferenceWriteContext = {
    command,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
  };

  return withPreferenceLock(vaultRoot, async () => {
    // Read inside the lock: anything the caller read before is already stale.
    const ledger = await loadPreferenceLedger(vaultRoot);
    // And checked here rather than by the caller, for exactly the same reason.
    options.precondition?.(ledger);
    const outcome = applyPreferenceOperation(ledger, input, options.now ?? new Date());
    if (outcome.kind !== "applied") {
      return {
        outcome,
        ledger,
        ...(outcome.kind === "replayed" && outcome.preference
          ? { preference: outcome.preference }
          : {}),
        regenerated: false,
        mirrors: [],
      };
    }

    await savePreferenceLedger(vaultRoot, outcome.ledger, context);
    const regenerated = shouldAutoRegen(outcome.preference);
    const mirrors = regenerated
      ? await regeneratePreferenceOutputs(vaultRoot, outcome.ledger, context)
      : [];
    return {
      outcome,
      ledger: outcome.ledger,
      preference: outcome.preference,
      regenerated,
      mirrors,
    };
  }, options.lock ?? {});
}
