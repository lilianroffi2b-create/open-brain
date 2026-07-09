import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isFreeMode, type FreeMode } from "./config.js";

export const FREE_MODE_STATE_SCHEMA_VERSION = 1;
export const FREE_MODE_STATE_RELATIVE_PATH = join(
  ".open-brain",
  "local",
  "free-mode-state.json",
);

const STATE_KEYS = [
  "schemaVersion",
  "createdAt",
  "updatedAt",
  "mode",
  "dismissedIdeaFingerprints",
] as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface FreeModeLocalState {
  schemaVersion: typeof FREE_MODE_STATE_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  mode: FreeMode;
  dismissedIdeaFingerprints: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function nodeErrorHasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function requireFreeMode(mode: unknown): FreeMode {
  if (!isFreeMode(mode)) {
    throw new TypeError("Free Mode local state contains an invalid mode.");
  }

  return mode;
}

/**
 * Converts an idea into an opaque, deterministic SHA-256 fingerprint. The raw
 * idea is never placed in Free Mode local state.
 */
export function fingerprintIdea(idea: string): string {
  const normalised = idea
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!normalised) {
    throw new TypeError("An idea must contain non-whitespace text.");
  }

  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/**
 * Strictly validates the deliberately tiny local-state schema. Rejecting
 * unexpected keys prevents callers from quietly persisting prompts, secrets,
 * telemetry, or arbitrary conversation content in this file.
 */
export function validateFreeModeLocalState(value: unknown): FreeModeLocalState {
  if (!isRecord(value)) {
    throw new TypeError("Free Mode local state must be a JSON object.");
  }

  const keys = Object.keys(value);
  if (
    keys.length !== STATE_KEYS.length ||
    keys.some((key) => !STATE_KEYS.includes(key as (typeof STATE_KEYS)[number]))
  ) {
    throw new TypeError("Free Mode local state contains unsupported fields.");
  }

  if (value.schemaVersion !== FREE_MODE_STATE_SCHEMA_VERSION) {
    throw new TypeError("Unsupported Free Mode local-state schema version.");
  }

  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new TypeError("Free Mode local state timestamps must be ISO dates.");
  }

  if (!isFreeMode(value.mode)) {
    throw new TypeError("Free Mode local state contains an invalid mode.");
  }

  if (
    !Array.isArray(value.dismissedIdeaFingerprints) ||
    value.dismissedIdeaFingerprints.some(
      (fingerprint) =>
        typeof fingerprint !== "string" || !SHA256_HEX.test(fingerprint),
    )
  ) {
    throw new TypeError("Dismissed ideas must be SHA-256 fingerprints.");
  }

  if (
    new Set(value.dismissedIdeaFingerprints).size !==
    value.dismissedIdeaFingerprints.length
  ) {
    throw new TypeError("Dismissed idea fingerprints must be unique.");
  }

  return {
    schemaVersion: FREE_MODE_STATE_SCHEMA_VERSION,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    mode: value.mode,
    dismissedIdeaFingerprints: [...value.dismissedIdeaFingerprints],
  };
}

export function createFreeModeLocalState(
  mode: FreeMode = "off",
  now: Date = new Date(),
): FreeModeLocalState {
  const timestamp = nowIso(now);
  return {
    schemaVersion: FREE_MODE_STATE_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    mode: requireFreeMode(mode),
    dismissedIdeaFingerprints: [],
  };
}

export function getFreeModeStatePath(vaultRoot: string): string {
  return join(vaultRoot, FREE_MODE_STATE_RELATIVE_PATH);
}

export async function loadFreeModeLocalState(
  vaultRoot: string,
  fallbackMode: FreeMode = "off",
  now: Date = new Date(),
): Promise<FreeModeLocalState> {
  const statePath = getFreeModeStatePath(vaultRoot);

  try {
    const raw = await readFile(statePath, "utf8");
    return validateFreeModeLocalState(JSON.parse(raw) as unknown);
  } catch (error) {
    if (nodeErrorHasCode(error, "ENOENT")) {
      return createFreeModeLocalState(fallbackMode, now);
    }

    throw error;
  }
}

export async function saveFreeModeLocalState(
  vaultRoot: string,
  state: FreeModeLocalState,
): Promise<void> {
  const safeState = validateFreeModeLocalState(state);
  const statePath = getFreeModeStatePath(vaultRoot);
  const stateDirectory = dirname(statePath);
  const temporaryPath = join(
    stateDirectory,
    `.free-mode-${randomUUID()}.tmp`,
  );

  await mkdir(stateDirectory, { recursive: true });

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(safeState, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, statePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function setFreeModeLocalStateMode(
  state: FreeModeLocalState,
  mode: FreeMode,
  now: Date = new Date(),
): FreeModeLocalState {
  const current = validateFreeModeLocalState(state);
  return {
    ...current,
    mode: requireFreeMode(mode),
    updatedAt: nowIso(now),
  };
}

export function isIdeaDismissed(
  state: FreeModeLocalState,
  idea: string,
): boolean {
  const current = validateFreeModeLocalState(state);
  return current.dismissedIdeaFingerprints.includes(fingerprintIdea(idea));
}

/**
 * Adds only an opaque fingerprint to state. The caller can then persist the
 * returned object with saveFreeModeLocalState().
 */
export function dismissIdea(
  state: FreeModeLocalState,
  idea: string,
  now: Date = new Date(),
): FreeModeLocalState {
  const current = validateFreeModeLocalState(state);
  const fingerprint = fingerprintIdea(idea);

  if (current.dismissedIdeaFingerprints.includes(fingerprint)) {
    return current;
  }

  return {
    ...current,
    updatedAt: nowIso(now),
    dismissedIdeaFingerprints: [
      ...current.dismissedIdeaFingerprints,
      fingerprint,
    ],
  };
}
