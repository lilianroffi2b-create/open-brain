import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { lockPathFor, withLock, type LockOptions } from "../core/lock.js";
import {
  applyPreferenceOperation,
  type PreferenceOperationInput,
  type PreferenceOperationOutcome,
} from "./ledger.js";
import { syncPreferenceMirrors, type PreferenceMirrorSyncResult } from "./mirror.js";
import { writeThroughRedline } from "./redline.js";
import { renderPreferenceCore } from "./render.js";
import type { Preference, PreferenceLedger } from "./types.js";
import { assertValidPreferenceLedger, shouldAutoRegen } from "./validation.js";

export const PREFERENCE_LEDGER_RELATIVE_PATH = join(
  "10_memory",
  "preferences",
  "_ledger.json",
);
export const PREFERENCE_CORE_RELATIVE_PATH = join(
  "10_memory",
  "preferences",
  "_core.md",
);

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

export async function loadPreferenceLedger(
  vaultRoot: string,
): Promise<PreferenceLedger> {
  const path = join(vaultRoot, PREFERENCE_LEDGER_RELATIVE_PATH);
  try {
    const raw = await readFile(path, "utf8");
    const ledger = JSON.parse(raw) as unknown;
    assertValidPreferenceLedger(ledger);
    return ledger;
  } catch (error) {
    if (nodeErrorHasCode(error, "ENOENT")) {
      throw new Error(`Preference ledger does not exist: ${path}.`);
    }
    throw error;
  }
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
