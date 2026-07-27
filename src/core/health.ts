import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { PREFERENCE_LEDGER_RELATIVE_PATH } from "../prefs/io.js";
import { validatePreferenceLedger } from "../prefs/validation.js";
import { catalogEnvelopeFromValue, readJson } from "./catalog.js";
import { loadConfigResult } from "./config.js";
import { canonicalJson } from "./index-writer.js";
import { auditReachability } from "./reachability.js";
import { loadRouting } from "./route.js";
import { countChangedSince } from "./scan.js";
import { sha256 } from "./text.js";
import type {
  CatalogIndexEnvelope,
  CatalogRecord,
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
  /**
   * Audit the reading path as well: indexes, the links they make, and the
   * layers routes can reach. It reads every `_index.md` in the vault, so it is
   * off unless asked for; `health` asks for it, `status` does not, because
   * `status` runs on every session start.
   */
  reachability?: boolean;
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

/**
 * Checks that the preference kernel is a well-formed Hermes ledger. `health`
 * is the command whose name promises the vault is sound, so it has to look at
 * the kernel too: a corrupt registry that `health` calls healthy is a false
 * promise, even though `doctor` and `prefs validate` already catch it.
 */
async function checkPreferenceKernel(root: string): Promise<HealthCheck> {
  const path = join(root, PREFERENCE_LEDGER_RELATIVE_PATH);
  const raw = await readJson(path);
  if (raw === undefined) {
    return {
      name: "preferences",
      severity: "error",
      detail: "Preference ledger is missing or is not valid JSON. Run open-brain prefs validate for detail.",
    };
  }
  const result = validatePreferenceLedger(raw);
  if (!result.valid) {
    return {
      name: "preferences",
      severity: "error",
      detail: `Preference ledger is invalid: ${result.errors.join(" ")}`,
    };
  }
  return {
    name: "preferences",
    severity: "ok",
    detail: "Preference ledger is well formed.",
  };
}

function sample(values: readonly string[], limit = 3): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit
    ? `${shown}, and ${String(values.length - limit)} more`
    : shown;
}

/**
 * Checks that documents can be arrived at, not just that they were indexed.
 *
 * These are warnings and never errors. An unreachable folder is a defect in
 * what the vault says about itself, not in the artifacts this command
 * validates, and a vault whose author has not written an index yet is not
 * broken. Raising them to errors would make `healthy` mean something it does
 * not mean, and every consumer of that flag would inherit the confusion.
 */
async function checkReachability(
  root: string,
  config: VaultConfig,
  records: CatalogRecord[],
): Promise<HealthCheck[]> {
  const routing = await loadRouting(root, config);
  const report = await auditReachability(root, config, records, routing);
  const checks: HealthCheck[] = [];

  checks.push(
    report.folders_without_index.length > 0
      ? {
        name: "reach:index",
        severity: "warning",
        detail: `${String(report.folders_without_index.length)} folder(s) hold documents with no _index.md: ${sample(report.folders_without_index)}.`,
      }
      : {
        name: "reach:index",
        severity: "ok",
        detail: `${String(report.folders_with_index)} folder(s) carry an index.`,
      },
  );

  checks.push(
    report.dead_index_links.length > 0
      ? {
        name: "reach:links",
        severity: "warning",
        detail: `${String(report.dead_index_links.length)} index link(s) resolve to nothing: ${sample(report.dead_index_links.map((link) => `${link.index} -> ${link.target}`))}.`,
      }
      : { name: "reach:links", severity: "ok", detail: "Every index link resolves." },
  );

  checks.push(
    report.orphan_folders.length > 0
      ? {
        name: "reach:orphans",
        severity: "warning",
        detail: `${String(report.orphan_folders.length)} indexed folder(s) their parent index never mentions: ${sample(report.orphan_folders)}.`,
      }
      : { name: "reach:orphans", severity: "ok", detail: "Every indexed folder is mentioned by its parent." },
  );

  const coverage = `default reaches ${String(report.default_route_layers.length)}/${String(report.layers.length)} layer(s)`;
  checks.push(
    report.unrouted_layers.length > 0
      ? {
        name: "reach:routes",
        severity: "warning",
        detail: `${String(report.unrouted_layers.length)} layer(s) no route reaches: ${sample(report.unrouted_layers)}. ${coverage}.`,
      }
      : {
        name: "reach:routes",
        severity: "ok",
        detail: `Every layer is reachable by a route; ${coverage}.`,
      },
  );

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

  const configResult = await loadConfigResult(root);
  if (configResult.issue) {
    checks.push({
      name: "config",
      severity: "error",
      detail: `${configResult.issue.message} Fix it, then run open-brain scan.`,
    });
  }

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

  checks.push(await checkPreferenceKernel(root));

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
        severity: shardIndexPresent ? "error" : "ok",
        detail: shardIndexPresent
          ? "Shard index is present while sharding is disabled. Run open-brain scan to repair the index."
          : "Sharding is disabled.",
      });
    }
  }

  if (options.reachability && catalog) {
    checks.push(...await checkReachability(root, config, catalog.records));
  }

  return {
    healthy: checks.every((check) => check.severity !== "error"),
    stale,
    index_available: indexAvailable,
    checked_at: now.toISOString(),
    checks,
  };
}
