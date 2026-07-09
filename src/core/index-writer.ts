import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { shardKey } from "./config.js";
import { readJson } from "./catalog.js";
import { sha256 } from "./text.js";
import {
  SCHEMA_VERSION,
  type CatalogEnvelope,
  type CatalogIndexEnvelope,
  type CatalogRecord,
  type FreshnessEnvelope,
  type ScanResult,
  type ShardMetadata,
  type VaultConfig,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = path + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

function formatDeltaTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, "").replace("T", "_").replace("Z", "");
}

function renderDeltaNote(
  rootLabel: string,
  delta: ScanResult["delta"],
  now: Date,
): string {
  const section = (title: string, paths: string[]): string[] => {
    const lines = ["## " + title, ""];
    if (paths.length === 0) {
      lines.push("- none");
    } else {
      for (const path of paths.slice(0, 80)) {
        lines.push("- " + path);
      }
      if (paths.length > 80) {
        lines.push("- " + String(paths.length - 80) + " more");
      }
    }
    lines.push("");
    return lines;
  };

  const lines = [
    "# Scan delta",
    "",
    "Generated: " + now.toISOString(),
    "Root: " + rootLabel + "/",
    "",
    "## Counts",
    "",
    "- added: " + String(delta.added_count),
    "- modified: " + String(delta.modified_count),
    "- removed: " + String(delta.removed_count),
    "",
    ...section("Added", delta.added),
    ...section("Modified", delta.modified),
    ...section("Removed", delta.removed),
  ];
  return lines.join("\n");
}

async function previousShardNames(path: string): Promise<Set<string>> {
  const value = await readJson(path);
  if (!isRecord(value) || !isRecord(value.shards)) {
    return new Set();
  }
  return new Set(Object.keys(value.shards));
}

async function writeShards(
  root: string,
  config: VaultConfig,
  catalog: CatalogEnvelope,
  now: Date,
): Promise<{ shards_written: number; missing_recreated: string[] }> {
  const shardDirectory = join(root, config.paths.catalog_shards);
  const indexPath = join(root, config.paths.catalog_index);
  const priorShards = await previousShardNames(indexPath);
  const groups = new Map<string, CatalogRecord[]>();

  for (const record of catalog.records) {
    const key = shardKey(record.path, catalog.root_label);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  await mkdir(shardDirectory, { recursive: true });
  const currentNames = new Set(groups.keys());
  const existingEntries = await readdir(shardDirectory, { withFileTypes: true });
  const existingNames = new Set(
    existingEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  const missingRecreated = [...priorShards]
    .filter((name) => currentNames.has(name) && !existingNames.has(name + ".json"))
    .sort();

  for (const entry of existingEntries) {
    if (
      entry.isFile()
      && entry.name.endsWith(".json")
      && entry.name !== "catalog_index.json"
      && !currentNames.has(entry.name.slice(0, -5))
    ) {
      await unlink(join(shardDirectory, entry.name));
    }
  }

  const shards: Record<string, ShardMetadata> = {};
  for (const [layer, records] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedRecords = [...records].sort(
      (left, right) => right.read_priority - left.read_priority || left.path.localeCompare(right.path),
    );
    const payload: CatalogEnvelope = {
      schema_version: SCHEMA_VERSION,
      generated_at: now.toISOString(),
      root_label: catalog.root_label,
      records: sortedRecords,
    };
    const content = prettyJson(payload);
    await writeAtomically(join(shardDirectory, layer + ".json"), content);
    shards[layer] = {
      layer,
      docs: sortedRecords.length,
      sha256: sha256(canonicalJson(payload)),
    };
  }

  const index: CatalogIndexEnvelope = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root_label: catalog.root_label,
    shard_count: Object.keys(shards).length,
    total_docs: catalog.records.length,
    shards,
  };
  await writeAtomically(indexPath, prettyJson(index));
  return {
    shards_written: Object.keys(shards).length,
    missing_recreated: missingRecreated,
  };
}

export interface WriteIndexOptions {
  now?: Date;
  writeDelta?: boolean;
}

export interface WriteIndexResult {
  freshness: FreshnessEnvelope;
  delta_path?: string;
}

export async function writeIndexArtifacts(
  root: string,
  config: VaultConfig,
  scan: ScanResult,
  options: WriteIndexOptions = {},
): Promise<WriteIndexResult> {
  const now = options.now ?? new Date(scan.catalog.generated_at);
  await writeAtomically(join(root, config.paths.catalog), prettyJson(scan.catalog));
  await writeAtomically(join(root, config.paths.graph), prettyJson(scan.graph));

  let freshness: FreshnessEnvelope = scan.freshness;
  if (scan.freshness.sharded) {
    const shards = await writeShards(root, config, scan.catalog, now);
    freshness = { ...freshness, shards };
  }

  let deltaPath: string | undefined;
  if (options.writeDelta !== false) {
    const filename = "scan-delta-" + formatDeltaTimestamp(now) + ".md";
    deltaPath = join(config.paths.deltas, filename);
    const fullPath = join(root, deltaPath);
    await writeAtomically(
      fullPath,
      renderDeltaNote(config.root_label, scan.delta, now),
    );
    const deltaDirectory = join(root, config.paths.deltas);
    const deltas = (await readdir(deltaDirectory))
      .filter((entry) => /^scan-delta-\d{4}-\d{2}-\d{2}_\d{6}\.md$/u.test(entry))
      .sort();
    for (const stale of deltas.slice(0, Math.max(0, deltas.length - config.deltas.retention))) {
      await unlink(join(deltaDirectory, stale));
    }
    freshness = {
      ...freshness,
      delta_note: config.root_label + "/" + deltaPath.replace(/\\/gu, "/"),
    };
  }

  await writeAtomically(join(root, config.paths.freshness), prettyJson(freshness));
  return deltaPath ? { freshness, delta_path: deltaPath } : { freshness };
}
