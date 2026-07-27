import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { shardKey } from "./config.js";
import { readJson } from "./catalog.js";
import { atomicWriteSet, type AtomicWriteEntry } from "./fs-atomic.js";
import { lockPathFor, withLock, type LockOptions } from "./lock.js";
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

/** Named lock guarding the whole scan cycle: read the vault, then publish. */
export const SCAN_LOCK_NAME = "scan";

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

interface ShardPlan {
  entries: AtomicWriteEntry[];
  removals: string[];
  summary: { shards_written: number; missing_recreated: string[] };
}

/**
 * Lists the shard index and per-layer shard files left behind when a vault
 * shrinks below the shard threshold. Only files named in the prior index (plus
 * the index itself) are listed, so the aggregate catalog, graph, and freshness
 * artifacts are never touched.
 */
async function planStaleShardRemoval(
  root: string,
  config: VaultConfig,
): Promise<string[]> {
  const indexPath = join(root, config.paths.catalog_index);
  const shardDirectory = join(root, config.paths.catalog_shards);
  const removals = [...await previousShardNames(indexPath)]
    .sort()
    .map((name) => join(shardDirectory, name + ".json"));
  removals.push(indexPath);
  return removals;
}

async function planShards(
  root: string,
  config: VaultConfig,
  catalog: CatalogEnvelope,
  now: Date,
): Promise<ShardPlan> {
  const shardDirectory = join(root, config.paths.catalog_shards);
  const indexPath = join(root, config.paths.catalog_index);
  const priorShards = await previousShardNames(indexPath);
  const groups = new Map<string, CatalogRecord[]>();

  for (const record of catalog.records) {
    const key = shardKey(record.path, catalog.root_label);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const currentNames = new Set(groups.keys());
  const existingEntries = await readdir(shardDirectory, { withFileTypes: true })
    .catch(() => []);
  const existingNames = new Set(
    existingEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  const missingRecreated = [...priorShards]
    .filter((name) => currentNames.has(name) && !existingNames.has(name + ".json"))
    .sort();

  const removals = existingEntries
    .filter((entry) =>
      entry.isFile()
      && entry.name.endsWith(".json")
      && entry.name !== "catalog_index.json"
      && !currentNames.has(entry.name.slice(0, -5)))
    .map((entry) => join(shardDirectory, entry.name));

  const entries: AtomicWriteEntry[] = [];
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
    entries.push({ path: join(shardDirectory, layer + ".json"), content: prettyJson(payload) });
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
  entries.push({ path: indexPath, content: prettyJson(index) });

  return {
    entries,
    removals,
    summary: {
      shards_written: Object.keys(shards).length,
      missing_recreated: missingRecreated,
    },
  };
}

async function planDeltaRotation(
  root: string,
  config: VaultConfig,
  publishedName: string,
): Promise<string[]> {
  const deltaDirectory = join(root, config.paths.deltas);
  const deltas = (await readdir(deltaDirectory).catch(() => []))
    .filter((entry) =>
      /^scan-delta-\d{4}-\d{2}-\d{2}_\d{9}\.md$/u.test(entry)
      && entry !== publishedName)
    .sort();
  // The note about to be published is not on disk yet, so it takes one slot of
  // the retention window.
  const excess = deltas.length + 1 - config.deltas.retention;
  return deltas.slice(0, Math.max(0, excess)).map((name) => join(deltaDirectory, name));
}

export interface WriteIndexOptions {
  now?: Date;
  writeDelta?: boolean;
  /**
   * Set when the caller already holds the scan lock, as runVaultScan does.
   * Reentrant locking is refused, so a caller that wraps its own read and write
   * in one lock must say so here.
   */
  locked?: boolean;
  lock?: LockOptions;
}

export interface WriteIndexResult {
  freshness: FreshnessEnvelope;
  delta_path?: string;
}

/**
 * The full set of files a scan publishes, plus the files that become obsolete
 * once it has landed. Exposed so a caller can inspect the commit sequence, and
 * so a test can stop between the two phases.
 */
export interface IndexPublicationPlan {
  /** Written as one set. freshness.json is last: it is the commit point. */
  entries: AtomicWriteEntry[];
  /** Deleted only after every entry above has been published and flushed. */
  removals: string[];
  freshness: FreshnessEnvelope;
  delta_path?: string;
}

/**
 * Builds the publication plan without touching the target files.
 *
 * Publish before delete. An index that briefly holds an obsolete shard is still
 * a complete index; an index whose shards were deleted before the replacements
 * landed is amputated, and a crash in that window loses documents that a rescan
 * has no way to know were ever there. The freshness manifest is written last
 * because it carries catalog_sha256: as long as it is the old one, readers can
 * tell the set is mid-flight.
 */
export async function planIndexArtifacts(
  root: string,
  config: VaultConfig,
  scan: ScanResult,
  options: WriteIndexOptions = {},
): Promise<IndexPublicationPlan> {
  const now = options.now ?? new Date(scan.catalog.generated_at);
  const entries: AtomicWriteEntry[] = [
    { path: join(root, config.paths.catalog), content: prettyJson(scan.catalog) },
    { path: join(root, config.paths.graph), content: prettyJson(scan.graph) },
  ];
  const removals: string[] = [];

  let freshness: FreshnessEnvelope = scan.freshness;
  if (scan.freshness.sharded) {
    const shards = await planShards(root, config, scan.catalog, now);
    entries.push(...shards.entries);
    removals.push(...shards.removals);
    freshness = { ...freshness, shards: shards.summary };
  } else {
    removals.push(...await planStaleShardRemoval(root, config));
  }

  let deltaPath: string | undefined;
  if (options.writeDelta !== false) {
    const filename = "scan-delta-" + formatDeltaTimestamp(now) + ".md";
    deltaPath = join(config.paths.deltas, filename);
    entries.push({
      path: join(root, deltaPath),
      content: renderDeltaNote(config.root_label, scan.delta, now),
    });
    removals.push(...await planDeltaRotation(root, config, filename));
    freshness = {
      ...freshness,
      delta_note: config.root_label + "/" + deltaPath.replace(/\\/gu, "/"),
    };
  }

  entries.push({ path: join(root, config.paths.freshness), content: prettyJson(freshness) });
  return deltaPath
    ? { entries, removals, freshness, delta_path: deltaPath }
    : { entries, removals, freshness };
}

async function publishIndexPlan(plan: IndexPublicationPlan): Promise<WriteIndexResult> {
  const published = new Set(plan.entries.map((entry) => entry.path));
  await atomicWriteSet(plan.entries);
  // Only now, with every replacement on disk and every parent directory
  // flushed, may anything be removed. A path that the plan also republished is
  // never removed: it was replaced, not made obsolete.
  for (const path of plan.removals) {
    if (!published.has(path)) {
      await unlink(path).catch(() => undefined);
    }
  }
  return plan.delta_path
    ? { freshness: plan.freshness, delta_path: plan.delta_path }
    : { freshness: plan.freshness };
}

/**
 * Publishes the whole index set, then prunes what the set made obsolete.
 *
 * Takes the scan lock unless the caller already holds it, because two processes
 * publishing overlapping sets can interleave their renames and leave a catalog
 * from one run beside the shards of another.
 */
export async function writeIndexArtifacts(
  root: string,
  config: VaultConfig,
  scan: ScanResult,
  options: WriteIndexOptions = {},
): Promise<WriteIndexResult> {
  const run = async (): Promise<WriteIndexResult> =>
    publishIndexPlan(await planIndexArtifacts(root, config, scan, options));
  if (options.locked === true) {
    return run();
  }
  return withLock(lockPathFor(root, SCAN_LOCK_NAME), run, {
    holder: "open-brain scan",
    ...(options.lock ?? {}),
  });
}
