import { loadCatalog } from "./catalog.js";
import { checkVaultHealth, type HealthOptions, type VaultHealthReport } from "./health.js";
import { writeIndexArtifacts } from "./index-writer.js";
import { scanVault } from "./scan.js";
import type { FreshnessEnvelope, VaultConfig } from "./types.js";

export interface VaultStatusOptions extends HealthOptions {
  /** Rescan regardless of current health. */
  rescan?: boolean;
  /** Rescan only when health reports a stale or unavailable index. */
  auto?: boolean;
}

export interface VaultStatusReport {
  checked_at: string;
  rescanned: boolean;
  freshness?: FreshnessEnvelope;
  health: VaultHealthReport;
}

/**
 * Reports health without mutating the vault by default. With rescan or auto it
 * delegates deterministic index generation to the existing scan writer.
 */
export async function getVaultStatus(
  root: string,
  config: VaultConfig,
  options: VaultStatusOptions = {},
): Promise<VaultStatusReport> {
  const now = options.now ?? new Date();
  let health = await checkVaultHealth(root, config, { ...options, now });
  const shouldRescan = options.rescan === true
    || (options.auto === true && (health.stale || !health.index_available || !health.healthy));
  let freshness: FreshnessEnvelope | undefined;
  let rescanned = false;

  if (shouldRescan) {
    const previousRecords = await loadCatalog(root, config);
    const scan = await scanVault(root, config, { now, previousRecords });
    const write = await writeIndexArtifacts(root, config, scan, { now });
    freshness = write.freshness;
    rescanned = true;
    health = await checkVaultHealth(root, config, { ...options, now });
  }

  return {
    checked_at: now.toISOString(),
    rescanned,
    ...(freshness ? { freshness } : {}),
    health,
  };
}
