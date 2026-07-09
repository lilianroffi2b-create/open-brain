import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { catalogEnvelopeFromValue, readJson } from "./catalog.js";
import { canonicalJson } from "./index-writer.js";
import { countChangedSince } from "./scan.js";
import { sha256 } from "./text.js";
import type {
  CatalogIndexEnvelope,
  FreshnessEnvelope,
  VaultConfig,
} from "./types.js";

export type HealthSeverity = "ok" | "warning" | "error";

export interface HealthCheck {
  name: string;
  severity: HealthSeverity;
  detail: string;
}

export interface VaultHealthReport {
  healthy: boolean;
  stale: boolean;
  index_available: boolean;
  checked_at: string;
  checks: HealthCheck[];
}

export interface HealthOptions {
  now?: Date;
  maxFreshnessAgeMs?: number;
}

const DEFAULT_MAX_FRESHNESS_AGE_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFreshness(value: unknown): FreshnessEnvelope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.generated_at !== "string" ||
    typeof value.source_count !== "number" ||
    typeof value.catalog_sha256 !== "string" ||
    typeof value.sharded !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as FreshnessEnvelope;
}

function asCatalogIndex(value: unknown): CatalogIndexEnvelope | undefined {
  if (!isRecord(value) || !isRecord(value.shards)) {
    return undefined;
  }
  if (
    typeof value.total_docs !== "number" ||
    typeof value.shard_count !== "number" ||
    typeof value.root_label !== "string"
  ) {
    return undefined;
  }
  return value as unknown as CatalogIndexEnvelope;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkShardIntegrity(
  root: string,
  config: VaultConfig,
  catalogRecords: number,
): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const indexPath = join(root, config.paths.catalog_index);
  const catalogIndex = asCatalogIndex(await readJson(indexPath));

  if (!catalogIndex) {
    return [{
      name: "shards",
      severity: "error",
      detail: "Shard index is missing or invalid.",
    }];
  }

  const shardEntries = Object.entries(catalogIndex.shards).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (catalogIndex.shard_count !== shardEntries.length) {
    checks.push({
      name: "shards",
      severity: "error",
      detail: "Shard index count does not match its metadata entries.",
    });
  }

  let totalDocs = 0;
  for (const [name, metadata] of shardEntries) {
    if (!isRecord(metadata) || typeof metadata.docs !== "number" || typeof metadata.sha256 !== "string") {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard metadata is invalid.",
      });
      continue;
    }
    totalDocs += metadata.docs;
    const path = join(root, config.paths.catalog_shards, `${name}.json`);
    const value = await readJson(path);
    const envelope = catalogEnvelopeFromValue(value);
    if (!envelope) {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard file is missing or invalid.",
      });
      continue;
    }
    if (envelope.records.length !== metadata.docs) {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard record count does not match metadata.",
      });
    }
    if (sha256(canonicalJson(value)) !== metadata.sha256) {
      checks.push({
        name: `shard:${name}`,
        severity: "error",
        detail: "Shard checksum does not match metadata.",
      });
    }
  }

  if (totalDocs !== catalogIndex.total_docs || totalDocs !== catalogRecords) {
    checks.push({
      name: "shards",
      severity: "error",
      detail: "Shard document totals do not match the aggregate catalog.",
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: "shards",
      severity: "ok",
      detail: `${shardEntries.length} shard(s) match the aggregate catalog.`,
    });
  }
  return checks;
}

/** Checks vault structure, index freshness, and sharded catalog integrity. */
export async function checkVaultHealth(
  root: string,
  config: VaultConfig,
  options: HealthOptions = {},
): Promise<VaultHealthReport> {
  const now = options.now ?? new Date();
  const maxFreshnessAgeMs = options.maxFreshnessAgeMs ?? DEFAULT_MAX_FRESHNESS_AGE_MS;
  const checks: HealthCheck[] = [];

  for (const directory of config.canonical_dirs) {
    const present = await directoryExists(join(root, directory));
    checks.push({
      name: `directory:${directory}`,
      severity: present ? "ok" : "error",
      detail: present
        ? "Present."
        : "Missing canonical directory.",
    });
  }

  const catalogPath = join(root, config.paths.catalog);
  const freshnessPath = join(root, config.paths.freshness);
  const catalog = catalogEnvelopeFromValue(await readJson(catalogPath));
  const freshness = asFreshness(await readJson(freshnessPath));
  const indexAvailable = Boolean(catalog && freshness);
  let stale = !indexAvailable;

  if (!catalog) {
    checks.push({ name: "catalog", severity: "error", detail: "Catalog is missing or invalid. Run open-brain scan to build the index." });
  }
  if (!freshness) {
    checks.push({ name: "freshness", severity: "error", detail: "Freshness index is missing or invalid." });
  }

  if (catalog && freshness) {
    const generatedAt = new Date(freshness.generated_at);
    const age = now.getTime() - generatedAt.getTime();
    if (Number.isNaN(generatedAt.getTime())) {
      stale = true;
      checks.push({ name: "freshness", severity: "error", detail: "Freshness timestamp is invalid." });
    } else if (age > maxFreshnessAgeMs) {
      stale = true;
      checks.push({ name: "freshness", severity: "warning", detail: "Index freshness is stale." });
    } else {
      checks.push({ name: "freshness", severity: "ok", detail: "Index freshness is current." });
    }

    if (!Number.isNaN(generatedAt.getTime())) {
      const changed = await countChangedSince(root, config, generatedAt);
      if (changed > 0) {
        stale = true;
        checks.push({
          name: "changes",
          severity: "warning",
          detail: `${changed} vault file(s) changed since the last scan.`,
        });
      } else {
        checks.push({
          name: "changes",
          severity: "ok",
          detail: "No vault files changed since the last scan.",
        });
      }
    }

    if (freshness.source_count !== catalog.records.length) {
      stale = true;
      checks.push({ name: "catalog", severity: "error", detail: "Catalog count does not match freshness." });
    }
    if (freshness.catalog_sha256 !== sha256(canonicalJson(catalog.records))) {
      stale = true;
      checks.push({ name: "catalog", severity: "error", detail: "Catalog checksum does not match freshness." });
    } else {
      checks.push({ name: "catalog", severity: "ok", detail: "Catalog matches freshness." });
    }

    if (freshness.sharded) {
      checks.push(...await checkShardIntegrity(root, config, catalog.records.length));
    } else {
      const shardIndexPath = join(root, config.paths.catalog_index);
      const shardIndexPresent = await fileExists(shardIndexPath);
      checks.push({
        name: "shards",
        severity: shardIndexPresent ? "warning" : "ok",
        detail: shardIndexPresent
          ? "Shard index is present while sharding is disabled."
          : "Sharding is disabled.",
      });
    }
  }

  return {
    healthy: checks.every((check) => check.severity !== "error"),
    stale,
    index_available: indexAvailable,
    checked_at: now.toISOString(),
    checks,
  };
}
