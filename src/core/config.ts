import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type {
  CapabilitiesConfig,
  CaptureMarkerPackConfig,
  CaptureTuningConfig,
  ClassifierProvider,
  LearningTuningConfig,
  PalierConfig,
  StagingTuningConfig,
  VaultConfig,
} from "./types.js";

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
    staging: "10_memory/staging",
    notes: "10_memory/notes",
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
    // Lock files live under <index>/.locks. The scan already skips the
    // literal path 00_index/.locks, but that check does not follow a skin
    // that renames the index directory; this segment-based exclusion does.
    ".locks",
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
  capabilities: {
    hooks: {
      enabled: false,
      targets: [],
      // Mirrors DEFAULT_HOOK_BUDGET_MS in src/hooks/runtime.ts. Duplicated
      // rather than imported: core must not depend on the hooks layer.
      budget_ms: 2_000,
    },
    capture: {
      enabled: false,
    },
    transcripts: {
      enabled: false,
      roots: [],
      redact: true,
    },
    classifier: {
      enabled: false,
      provider: "none",
      daily_call_budget: 25,
    },
    learning: {
      enabled: false,
      evaluate: false,
      consolidate: false,
    },
  },
  // staging.max_chars, capture.*, and learning.* below are configuration
  // surface only: they read tolerantly like every other section, but their
  // current readers (src/staging/markers.ts, src/learning/sensors/index.ts)
  // still re-parse vault.config.yml directly rather than reading VaultConfig.
  // The defaults here mirror those readers' own defaults so the two never
  // silently disagree.
  staging: {
    max_chars: 4_000,
  },
  capture: {
    markers: {
      packs: ["en"],
      custom: [],
      limits: {
        max_correction_chars: 1_200,
        negation_window_chars: 12,
        meta_window_chars: 24,
        max_markers_per_message: 8,
      },
    },
    limits: {
      max_messages_per_scan: 40,
      max_candidates_per_scan: 10,
      transcript_max_bytes: 512_000,
      transcript_max_lines: 4_000,
    },
  },
  learning: {
    // Mirrors DEFAULT_HISTORY_POLICY in src/learning/types.ts.
    history: {
      max_entries: 200,
    },
    // Mirrors DEFAULT_LEARNING_TUNING in src/learning/sensors/index.ts.
    sensors: {
      circulation: {
        read_tools: ["Read", "NotebookRead"],
        write_tools: ["Write", "Edit", "NotebookEdit"],
        max_partitions: 2,
        max_entries: 2_000,
      },
    },
    evaluator: {
      correction_window_turns: 2,
      confirmation_window_turns: 3,
      dead_output_days: 7,
      rapid_followup_seconds: 120,
      session_closed_hours: 12,
    },
    injection: {
      max_chars: 1_500,
      max_law: 1,
      max_active: 1,
      statement_clip: 160,
      drift_alert_tokens: 350,
    },
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

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asTier(value: unknown, fallback: PalierConfig["shard_from"]): PalierConfig["shard_from"] {
  return value === "P1" || value === "P2" || value === "P3" || value === "P4"
    ? value
    : fallback;
}

function asClassifierProvider(
  value: unknown,
  fallback: ClassifierProvider,
): ClassifierProvider {
  return value === "none" || value === "claude-code-subagent" ? value : fallback;
}

function asSection(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

/**
 * Capabilities are read against the disarmed defaults rather than merged over
 * them: a missing section, a wrong type, or a truthy string all read as
 * disarmed. Arming a capability therefore always requires an explicit boolean
 * true in the config file.
 */
function normalizeCapabilities(value: unknown): CapabilitiesConfig {
  const defaults = DEFAULT_CONFIG.capabilities;
  const source = asSection(value);
  const hooks = asSection(source.hooks);
  const capture = asSection(source.capture);
  const transcripts = asSection(source.transcripts);
  const classifier = asSection(source.classifier);
  const learning = asSection(source.learning);

  return {
    hooks: {
      enabled: asBoolean(hooks.enabled, defaults.hooks.enabled),
      targets: asStringArray(hooks.targets, defaults.hooks.targets),
      budget_ms: asPositiveInteger(hooks.budget_ms, defaults.hooks.budget_ms),
    },
    capture: {
      enabled: asBoolean(capture.enabled, defaults.capture.enabled),
    },
    transcripts: {
      enabled: asBoolean(transcripts.enabled, defaults.transcripts.enabled),
      roots: asStringArray(transcripts.roots, defaults.transcripts.roots),
      redact: asBoolean(transcripts.redact, defaults.transcripts.redact),
    },
    classifier: {
      enabled: asBoolean(classifier.enabled, defaults.classifier.enabled),
      provider: asClassifierProvider(classifier.provider, defaults.classifier.provider),
      // A value of 0 is not a way to stop the classifier: asPositiveInteger
      // treats it as absent and falls back to the default budget. The actual
      // switch is capabilities.classifier.enabled.
      daily_call_budget: asPositiveInteger(
        classifier.daily_call_budget,
        defaults.classifier.daily_call_budget,
      ),
    },
    learning: {
      enabled: asBoolean(learning.enabled, defaults.learning.enabled),
      evaluate: asBoolean(learning.evaluate, defaults.learning.evaluate),
      consolidate: asBoolean(learning.consolidate, defaults.learning.consolidate),
    },
  };
}

function normalizeStagingTuning(value: unknown): StagingTuningConfig {
  const defaults = DEFAULT_CONFIG.staging;
  const source = asSection(value);
  return {
    max_chars: asPositiveInteger(source.max_chars, defaults.max_chars),
  };
}

function asMarkerPackConfig(value: unknown): CaptureMarkerPackConfig | undefined {
  const source = asSection(value);
  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (id.length === 0) {
    return undefined;
  }
  return {
    id,
    explicit_request: asStringArray(source.explicit_request, []),
    correction: asStringArray(source.correction, []),
    correction_lead: asStringArray(source.correction_lead, []),
    praise: asStringArray(source.praise, []),
    praise_negations: asStringArray(source.praise_negations, []),
    praise_meta_words: asStringArray(source.praise_meta_words, []),
  };
}

function asMarkerPackList(
  value: unknown,
  fallback: readonly CaptureMarkerPackConfig[],
): CaptureMarkerPackConfig[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value
    .map(asMarkerPackConfig)
    .filter((pack): pack is CaptureMarkerPackConfig => pack !== undefined);
}

/**
 * The typed configuration for capture is documentation, not yet a live source:
 * src/staging/markers.ts re-reads vault.config.yml directly and keeps working
 * unchanged either way. Every value here is read tolerantly, same as
 * capabilities, so a typo degrades to the default instead of failing to load.
 */
function normalizeCaptureTuning(value: unknown): CaptureTuningConfig {
  const defaults = DEFAULT_CONFIG.capture;
  const source = asSection(value);
  const markers = asSection(source.markers);
  const markerLimits = asSection(markers.limits);
  const limits = asSection(source.limits);

  return {
    markers: {
      packs: asStringArray(markers.packs, defaults.markers.packs),
      custom: asMarkerPackList(markers.custom, defaults.markers.custom),
      limits: {
        max_correction_chars: asPositiveInteger(
          markerLimits.max_correction_chars,
          defaults.markers.limits.max_correction_chars,
        ),
        negation_window_chars: asPositiveInteger(
          markerLimits.negation_window_chars,
          defaults.markers.limits.negation_window_chars,
        ),
        meta_window_chars: asPositiveInteger(
          markerLimits.meta_window_chars,
          defaults.markers.limits.meta_window_chars,
        ),
        max_markers_per_message: asPositiveInteger(
          markerLimits.max_markers_per_message,
          defaults.markers.limits.max_markers_per_message,
        ),
      },
    },
    limits: {
      max_messages_per_scan: asPositiveInteger(
        limits.max_messages_per_scan,
        defaults.limits.max_messages_per_scan,
      ),
      max_candidates_per_scan: asPositiveInteger(
        limits.max_candidates_per_scan,
        defaults.limits.max_candidates_per_scan,
      ),
      transcript_max_bytes: asPositiveInteger(
        limits.transcript_max_bytes,
        defaults.limits.transcript_max_bytes,
      ),
      transcript_max_lines: asPositiveInteger(
        limits.transcript_max_lines,
        defaults.limits.transcript_max_lines,
      ),
    },
  };
}

/**
 * Same status as normalizeCaptureTuning: src/learning/sensors/index.ts still
 * re-reads vault.config.yml directly for these values. This is the typed
 * surface, not yet the live source.
 */
function normalizeLearningTuning(value: unknown): LearningTuningConfig {
  const defaults = DEFAULT_CONFIG.learning;
  const source = asSection(value);
  const history = asSection(source.history);
  const sensors = asSection(source.sensors);
  const circulation = asSection(sensors.circulation);
  const evaluator = asSection(source.evaluator);
  const injection = asSection(source.injection);

  return {
    history: {
      max_entries: asPositiveInteger(history.max_entries, defaults.history.max_entries),
    },
    sensors: {
      circulation: {
        read_tools: asStringArray(
          circulation.read_tools,
          defaults.sensors.circulation.read_tools,
        ),
        write_tools: asStringArray(
          circulation.write_tools,
          defaults.sensors.circulation.write_tools,
        ),
        max_partitions: asPositiveInteger(
          circulation.max_partitions,
          defaults.sensors.circulation.max_partitions,
        ),
        max_entries: asPositiveInteger(
          circulation.max_entries,
          defaults.sensors.circulation.max_entries,
        ),
      },
    },
    evaluator: {
      correction_window_turns: asPositiveInteger(
        evaluator.correction_window_turns,
        defaults.evaluator.correction_window_turns,
      ),
      confirmation_window_turns: asPositiveInteger(
        evaluator.confirmation_window_turns,
        defaults.evaluator.confirmation_window_turns,
      ),
      dead_output_days: asPositiveInteger(
        evaluator.dead_output_days,
        defaults.evaluator.dead_output_days,
      ),
      rapid_followup_seconds: asPositiveInteger(
        evaluator.rapid_followup_seconds,
        defaults.evaluator.rapid_followup_seconds,
      ),
      session_closed_hours: asPositiveInteger(
        evaluator.session_closed_hours,
        defaults.evaluator.session_closed_hours,
      ),
    },
    injection: {
      max_chars: asPositiveInteger(injection.max_chars, defaults.injection.max_chars),
      max_law: asPositiveInteger(injection.max_law, defaults.injection.max_law),
      max_active: asPositiveInteger(injection.max_active, defaults.injection.max_active),
      statement_clip: asPositiveInteger(
        injection.statement_clip,
        defaults.injection.statement_clip,
      ),
      drift_alert_tokens: asPositiveInteger(
        injection.drift_alert_tokens,
        defaults.injection.drift_alert_tokens,
      ),
    },
  };
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
  config.capabilities = normalizeCapabilities(config.capabilities);
  config.staging = normalizeStagingTuning(config.staging);
  config.capture = normalizeCaptureTuning(config.capture);
  config.learning = normalizeLearningTuning(config.learning);
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
