import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadCatalog } from "../core/catalog.js";
import { isEnabled, requireCapability } from "../core/capabilities.js";
import { atomicWriteJson } from "../core/fs-atomic.js";
import { toPosixPath } from "../core/text.js";
import type { CatalogRecord, VaultConfig } from "../core/types.js";
import { DEFAULT_LOADER_FILENAMES } from "../loaders/markers.js";
import { LEARNING_DIRECTORY_NAME, learningDirectory } from "./store.js";
import { LEARNING_SCHEMA_VERSION, SchemaError, nowTs } from "./types.js";

/**
 * The documentary scope sensors are allowed to measure, plus the shared OFF
 * sentinel.
 *
 * Why the scope has to exist: without it a sensor would count its own traces as
 * routable documents. A file written by the learning layer would then show up
 * with zero circulation and become a candidate for its own removal, which is a
 * self-referential loop rather than a measurement.
 */

export const POPULATION_FILENAME = "population.json";
export const OFF_FLAG_FILENAME = "OFF.flag";

export interface Population {
  schema_version: number;
  updated_at: string;
  total: number;
  documents: string[];
}

export function populationPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), POPULATION_FILENAME);
}

/**
 * The sentinel lives next to the data it guards, and its suffix is deliberately
 * outside the text suffixes the scanner accepts. Even if a directory exclusion
 * changed, the suffix filter alone keeps it out of the catalog: defence in
 * depth, not redundancy.
 */
export function offFlagPath(config: VaultConfig, root: string): string {
  return join(learningDirectory(config, root), OFF_FLAG_FILENAME);
}

export interface BuildPopulationOptions {
  /** Extra path prefixes to keep out, relative to the vault root. */
  exclude?: readonly string[];
  /** Root-level filenames to keep out, defaulting to the host loader files. */
  loaders?: readonly string[];
  now?: string;
}

function stripRootLabel(path: string, rootLabel: string): string {
  const prefix = `${rootLabel}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Path prefixes a sensor must never measure: everything the learning layer
 * writes itself, and the archive, which is where documents go to stop being
 * read on purpose.
 */
export function defaultPopulationExclusions(config: VaultConfig): string[] {
  return [
    `${config.paths.memory}/${LEARNING_DIRECTORY_NAME}/`,
    `${config.paths.archive}/`,
  ];
}

/**
 * Derives the sensor scope from the catalog. Reading the catalog in full is
 * legitimate here because this is an index derivation, not a question being
 * answered: nothing about this list is injected into a model.
 */
export function buildPopulation(
  config: VaultConfig,
  records: readonly CatalogRecord[],
  options: BuildPopulationOptions = {},
): Population {
  const exclusions = [
    ...defaultPopulationExclusions(config),
    ...(options.exclude ?? []),
  ].map((prefix) => toPosixPath(prefix));
  const loaders = new Set(options.loaders ?? DEFAULT_LOADER_FILENAMES);

  const documents: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const path = toPosixPath(record.path);
    const relative = stripRootLabel(path, config.root_label);
    if (loaders.has(relative)) {
      continue;
    }
    if (exclusions.some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    documents.push(path);
  }
  documents.sort();

  return {
    schema_version: LEARNING_SCHEMA_VERSION,
    updated_at: options.now ?? nowTs(),
    total: documents.length,
    documents,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePopulation(value: unknown): Population {
  if (!isRecord(value)) {
    throw new SchemaError("A population must be a JSON object.");
  }
  if (!Array.isArray(value.documents) || value.documents.some((item) => typeof item !== "string")) {
    throw new SchemaError("A population must carry an array of document paths.");
  }
  const documents = value.documents as string[];
  const total = typeof value.total === "number" ? value.total : documents.length;
  if (total !== documents.length) {
    throw new SchemaError("A population whose total disagrees with its list is not usable.");
  }
  return {
    schema_version: typeof value.schema_version === "number"
      ? value.schema_version
      : LEARNING_SCHEMA_VERSION,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : nowTs(),
    total,
    documents,
  };
}

export async function readPopulation(
  config: VaultConfig,
  root: string,
): Promise<Population | undefined> {
  requireCapability(config, "learning");
  try {
    return validatePopulation(JSON.parse(await readFile(populationPath(config, root), "utf8")));
  } catch (error) {
    if (error instanceof SchemaError) {
      throw error;
    }
    return undefined;
  }
}

export async function writePopulation(
  config: VaultConfig,
  root: string,
  population: Population,
): Promise<void> {
  requireCapability(config, "learning");
  await atomicWriteJson(populationPath(config, root), validatePopulation(population));
}

/** Rebuilds the scope from the current catalog and stores it. */
export async function refreshPopulation(
  config: VaultConfig,
  root: string,
  options: BuildPopulationOptions = {},
): Promise<Population> {
  requireCapability(config, "learning");
  const population = buildPopulation(config, await loadCatalog(root, config), options);
  await writePopulation(config, root, population);
  return population;
}

/**
 * True when the layer must not act. A disarmed capability answers true without
 * reading a single byte, which is what keeps a default vault from touching the
 * disk at all.
 *
 * Scope matters: this sentinel is meant to stop the acts that are both
 * autonomous and subtractive. It must never be consulted by a way back, such as
 * a rollback or a deconsolidation, because a way back that refuses to work once
 * the layer is switched off is the opposite of the service expected from it.
 */
export async function isLearningDisabled(config: VaultConfig, root: string): Promise<boolean> {
  if (!isEnabled(config, "learning")) {
    return true;
  }
  try {
    await stat(offFlagPath(config, root));
    return true;
  } catch {
    return false;
  }
}

export async function disableLearning(config: VaultConfig, root: string): Promise<void> {
  requireCapability(config, "learning");
  await atomicWriteJson(offFlagPath(config, root), { disabled_at: nowTs() });
}

export async function enableLearning(config: VaultConfig, root: string): Promise<void> {
  requireCapability(config, "learning");
  await rm(offFlagPath(config, root), { force: true });
}

/**
 * True when this path is inside the scope sensors may measure. Kept separate
 * from buildPopulation so a sensor can check one path without loading the whole
 * list.
 */
export function isInPopulation(population: Population, path: string): boolean {
  return population.documents.includes(toPosixPath(path));
}
