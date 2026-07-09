import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { shardKey } from "./config.js";
import type {
  CatalogEnvelope,
  CatalogIndexEnvelope,
  CatalogRecord,
  VaultConfig,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogRecord(value: unknown): value is CatalogRecord {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.domain === "string";
}

export function recordsFromCatalog(value: unknown): CatalogRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isCatalogRecord);
  }
  if (isRecord(value) && Array.isArray(value.records)) {
    return value.records.filter(isCatalogRecord);
  }
  return [];
}

export function catalogEnvelopeFromValue(value: unknown): CatalogEnvelope | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return undefined;
  }
  const schemaVersion = value.schema_version;
  const generatedAt = value.generated_at;
  const rootLabel = value.root_label;
  if (
    typeof schemaVersion !== "number"
    || typeof generatedAt !== "string"
    || typeof rootLabel !== "string"
  ) {
    return undefined;
  }
  return {
    schema_version: schemaVersion,
    generated_at: generatedAt,
    root_label: rootLabel,
    records: value.records.filter(isCatalogRecord),
  };
}

export async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function readCatalogFile(path: string): Promise<CatalogRecord[]> {
  return recordsFromCatalog(await readJson(path));
}

async function readCatalogIndex(path: string): Promise<CatalogIndexEnvelope | undefined> {
  const value = await readJson(path);
  if (!isRecord(value) || !isRecord(value.shards)) {
    return undefined;
  }
  if (
    typeof value.schema_version !== "number"
    || typeof value.generated_at !== "string"
    || typeof value.root_label !== "string"
    || typeof value.shard_count !== "number"
    || typeof value.total_docs !== "number"
  ) {
    return undefined;
  }
  return value as unknown as CatalogIndexEnvelope;
}

export async function loadCatalog(
  root: string,
  config: VaultConfig,
  layers?: Iterable<string>,
): Promise<CatalogRecord[]> {
  const aggregatePath = join(root, config.paths.catalog);
  if (!layers) {
    return readCatalogFile(aggregatePath);
  }

  const wanted = [...new Set(layers)];
  const index = await readCatalogIndex(join(root, config.paths.catalog_index));
  if (index) {
    const records: CatalogRecord[] = [];
    let loadedAny = false;
    for (const layer of wanted) {
      if (!Object.hasOwn(index.shards, layer)) {
        continue;
      }
      const shardRecords = await readCatalogFile(
        join(root, config.paths.catalog_shards, layer + ".json"),
      );
      if (shardRecords.length > 0) {
        records.push(...shardRecords);
        loadedAny = true;
      }
    }
    if (loadedAny) {
      return records;
    }
  }

  const aggregate = await readCatalogFile(aggregatePath);
  const wantedSet = new Set(wanted);
  return aggregate.filter((record) => wantedSet.has(shardKey(record.path, config.root_label)));
}
