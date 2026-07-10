import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { PalierConfig, VaultConfig } from "./types.js";

export const VAULT_CONFIG_RELATIVE_PATH = "00_index/vault.config.yml";
const VAULT_CONFIG_FILENAME = "vault.config.yml";
const NUMBERED_DIRECTORY = /^\d{2}_[a-z][a-z0-9_-]*$/iu;

export const DEFAULT_CONFIG: VaultConfig = {
  version: 1,
  root_label: "OpenBrain",
  paths: {
    index: "00_index",
    deltas: "00_index/deltas",
    catalog: "00_index/catalog.json",
    catalog_shards: "00_index/catalog",
    catalog_index: "00_index/catalog/catalog_index.json",
    graph: "00_index/graph.json",
    freshness: "00_index/freshness.json",
    routing: "00_index/routing.yml",
    archive: "90_archive",
    inbox: "01_inbox",
    memory: "10_memory",
    contexts: "20_contexts",
    skills: "30_skills",
    sources: "40_sources",
    outputs: "50_outputs",
    engine: "70_engine",
  },
  exclusions: [
    ".git",
    ".DS_Store",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".open-brain",
    "70_engine",
  ],
  text_extensions: [
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".css",
    ".html",
    ".sh",
    ".csv",
    ".tsv",
    ".env",
    ".example",
  ],
  max_file_bytes: 768_000,
  paliers: {
    p1_max: 500,
    p2_max: 2_000,
    p3_max: 10_000,
    shard_from: "P2",
  },
  deltas: {
    retention: 30,
  },
  thermal: {
    hot_max_days: 14,
    warm_max_days: 90,
  },
  ephemeral: {
    ttl_days: 30,
  },
  canonical_dirs: [
    "00_index",
    "01_inbox",
    "10_memory",
    "20_contexts",
    "30_skills",
    "40_sources",
    "50_outputs",
    "70_engine",
    "90_archive",
  ],
  activity: {
    active_paths: [],
    active_dir_prefixes: [],
  },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as unknown as T;
  }
  return value;
}

export function deepMerge<T>(base: T, override: UnknownRecord): T {
  const merged = cloneValue(base) as unknown as UnknownRecord;
  for (const [key, value] of Object.entries(override)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMerge(merged[key] as UnknownRecord, value);
    } else if (value !== null && value !== undefined) {
      merged[key] = cloneValue(value);
    }
  }
  return merged as unknown as T;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return [...fallback];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function asTier(value: unknown, fallback: PalierConfig["shard_from"]): PalierConfig["shard_from"] {
  return value === "P1" || value === "P2" || value === "P3" || value === "P4"
    ? value
    : fallback;
}

function normalizeConfig(value: VaultConfig): VaultConfig {
  const config = cloneValue(value);
  config.version = asPositiveInteger(config.version, DEFAULT_CONFIG.version);
  config.root_label = asString(config.root_label, DEFAULT_CONFIG.root_label);

  for (const key of Object.keys(DEFAULT_CONFIG.paths) as Array<keyof VaultConfig["paths"]>) {
    config.paths[key] = asString(config.paths[key], DEFAULT_CONFIG.paths[key]);
  }

  config.exclusions = asStringArray(config.exclusions, DEFAULT_CONFIG.exclusions);
  config.text_extensions = asStringArray(
    config.text_extensions,
    DEFAULT_CONFIG.text_extensions,
  ).map((suffix) => (suffix.startsWith(".") ? suffix.toLowerCase() : "." + suffix.toLowerCase()));
  config.max_file_bytes = asPositiveInteger(
    config.max_file_bytes,
    DEFAULT_CONFIG.max_file_bytes,
  );
  config.paliers.p1_max = asPositiveInteger(
    config.paliers.p1_max,
    DEFAULT_CONFIG.paliers.p1_max,
  );
  config.paliers.p2_max = asPositiveInteger(
    config.paliers.p2_max,
    DEFAULT_CONFIG.paliers.p2_max,
  );
  config.paliers.p3_max = asPositiveInteger(
    config.paliers.p3_max,
    DEFAULT_CONFIG.paliers.p3_max,
  );
  config.paliers.shard_from = asTier(
    config.paliers.shard_from,
    DEFAULT_CONFIG.paliers.shard_from,
  );
  config.deltas.retention = asPositiveInteger(
    config.deltas.retention,
    DEFAULT_CONFIG.deltas.retention,
  );
  config.thermal.hot_max_days = asPositiveInteger(
    config.thermal.hot_max_days,
    DEFAULT_CONFIG.thermal.hot_max_days,
  );
  config.thermal.warm_max_days = asPositiveInteger(
    config.thermal.warm_max_days,
    DEFAULT_CONFIG.thermal.warm_max_days,
  );
  config.ephemeral.ttl_days = asPositiveInteger(
    config.ephemeral.ttl_days,
    DEFAULT_CONFIG.ephemeral.ttl_days,
  );
  config.canonical_dirs = asStringArray(
    config.canonical_dirs,
    DEFAULT_CONFIG.canonical_dirs,
  );
  config.activity.active_paths = asStringArray(
    config.activity.active_paths,
    DEFAULT_CONFIG.activity.active_paths,
  );
  config.activity.active_dir_prefixes = asStringArray(
    config.activity.active_dir_prefixes,
    DEFAULT_CONFIG.activity.active_dir_prefixes,
  );
  return config;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findConfigAtRoot(root: string): Promise<string | undefined> {
  const defaultPath = join(root, VAULT_CONFIG_RELATIVE_PATH);
  if (await exists(defaultPath)) {
    return defaultPath;
  }

  try {
    const candidates = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && NUMBERED_DIRECTORY.test(entry.name))
      .map((entry) => join(root, entry.name, VAULT_CONFIG_FILENAME));
    for (const candidate of candidates.sort()) {
      if (await exists(candidate)) {
        return candidate;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function findVaultConfigPath(
  start = process.cwd(),
): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    const configPath = await findConfigAtRoot(current);
    if (configPath) {
      return configPath;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function findVaultRoot(start = process.cwd()): Promise<string> {
  const configPath = await findVaultConfigPath(start);
  return configPath ? dirname(dirname(configPath)) : resolve(start);
}

export type ConfigIssueReason = "read-error" | "parse-error" | "not-a-mapping";

export interface ConfigLoadIssue {
  path: string;
  reason: ConfigIssueReason;
  message: string;
}

export interface ConfigLoadResult {
  config: VaultConfig;
  issue?: ConfigLoadIssue;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

/**
 * Loads the vault configuration and surfaces read or parse failures instead of
 * hiding them. A missing config file is legitimate (defaults are used silently),
 * but a config that exists yet cannot be read, parsed, or is not a YAML mapping
 * yields an issue so callers can warn without losing the caller's own I/O purity.
 */
export async function loadConfigResult(root?: string): Promise<ConfigLoadResult> {
  const vaultRoot = root ? resolve(root) : await findVaultRoot();
  const configPath = await findConfigAtRoot(vaultRoot)
    ?? join(vaultRoot, VAULT_CONFIG_RELATIVE_PATH);
  let parsed: UnknownRecord = {};
  let issue: ConfigLoadIssue | undefined;
  let text: string | undefined;

  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      issue = {
        path: configPath,
        reason: "read-error",
        message: `Vault config at ${configPath} could not be read; falling back to defaults.`,
      };
    }
  }

  if (text !== undefined) {
    try {
      const value = parseYaml(text) as unknown;
      if (value === null || value === undefined) {
        parsed = {};
      } else if (isRecord(value)) {
        parsed = value;
      } else {
        issue = {
          path: configPath,
          reason: "not-a-mapping",
          message: `Vault config at ${configPath} is not a YAML mapping; falling back to defaults.`,
        };
      }
    } catch {
      issue = {
        path: configPath,
        reason: "parse-error",
        message: `Vault config at ${configPath} is invalid YAML; falling back to defaults.`,
      };
    }
  }

  const config = normalizeConfig(deepMerge(DEFAULT_CONFIG, parsed));
  return issue ? { config, issue } : { config };
}

export async function loadConfig(root?: string): Promise<VaultConfig> {
  return (await loadConfigResult(root)).config;
}

export function excludedParts(config: VaultConfig): Set<string> {
  return new Set(config.exclusions.map((part) => part.normalize("NFKD").toLowerCase()));
}

export function palier(
  count: number,
  config: VaultConfig,
): "P1" | "P2" | "P3" | "P4" {
  if (count < config.paliers.p1_max) {
    return "P1";
  }
  if (count < config.paliers.p2_max) {
    return "P2";
  }
  if (count < config.paliers.p3_max) {
    return "P3";
  }
  return "P4";
}

export function shardsEnabled(count: number, config: VaultConfig): boolean {
  const order = ["P1", "P2", "P3", "P4"];
  return order.indexOf(palier(count, config)) >= order.indexOf(config.paliers.shard_from);
}

export function shardKey(recordPath: string, rootLabel: string): string {
  const prefix = rootLabel + "/";
  const relative = recordPath.startsWith(prefix)
    ? recordPath.slice(prefix.length)
    : recordPath;
  const separator = relative.indexOf("/");
  return separator === -1 ? "root" : relative.slice(0, separator);
}
