import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renderPreferenceCore } from "./render.js";
import type { PreferenceLedger } from "./types.js";
import { assertValidPreferenceLedger } from "./validation.js";

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

function nodeErrorHasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.openbrain-prefs-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
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

export async function savePreferenceLedger(
  vaultRoot: string,
  ledger: PreferenceLedger,
): Promise<void> {
  assertValidPreferenceLedger(ledger);
  await writeAtomically(
    join(vaultRoot, PREFERENCE_LEDGER_RELATIVE_PATH),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

export async function writePreferenceCore(
  vaultRoot: string,
  ledger: PreferenceLedger,
): Promise<void> {
  await writeAtomically(
    join(vaultRoot, PREFERENCE_CORE_RELATIVE_PATH),
    renderPreferenceCore(ledger),
  );
}
