export const SCHEMA_VERSION = 1;

export type Lifecycle = "master" | "working" | "ephemeral" | "data";
export type ThermalTier = "hot" | "warm" | "cold";
export type VaultLayer =
  | "index"
  | "inbox"
  | "memory"
  | "context"
  | "skill"
  | "source"
  | "output"
  | "engine"
  | "archive"
  | "root";

export interface VaultPaths {
  index: string;
  deltas: string;
  catalog: string;
  catalog_shards: string;
  catalog_index: string;
  graph: string;
  freshness: string;
  routing: string;
  archive: string;
  inbox: string;
  memory: string;
  contexts: string;
  skills: string;
  sources: string;
  outputs: string;
  engine: string;
  /** Staging area for candidates awaiting human review. */
  staging: string;
  /** Manual memory notes the gate may write into. */
  notes: string;
}

export interface PalierConfig {
  p1_max: number;
  p2_max: number;
  p3_max: number;
  shard_from: "P1" | "P2" | "P3" | "P4";
}

export type ClassifierProvider = "none" | "claude-code-subagent";

export interface HooksCapabilityConfig {
  enabled: boolean;
  targets: string[];
  /** Per-hook time budget, in milliseconds. Overridden by OPEN_BRAIN_HOOK_BUDGET_MS. */
  budget_ms: number;
}

export interface CaptureCapabilityConfig {
  enabled: boolean;
}

export interface TranscriptsCapabilityConfig {
  enabled: boolean;
  roots: string[];
  redact: boolean;
}

export interface ClassifierCapabilityConfig {
  enabled: boolean;
  provider: ClassifierProvider;
  daily_call_budget: number;
}

export interface LearningCapabilityConfig {
  enabled: boolean;
  evaluate: boolean;
  consolidate: boolean;
}

/**
 * Every capability that costs money, reads outside the vault, or changes
 * behavior is declared here and ships disarmed. Absent or malformed values read
 * as disarmed, so a vault written before capabilities existed loads unchanged
 * and with nothing armed.
 */
export interface CapabilitiesConfig {
  hooks: HooksCapabilityConfig;
  capture: CaptureCapabilityConfig;
  transcripts: TranscriptsCapabilityConfig;
  classifier: ClassifierCapabilityConfig;
  learning: LearningCapabilityConfig;
}

/** Tuning for the staging area CLI, distinct from capabilities.capture. */
export interface StagingTuningConfig {
  /** Default character cap of `staging list` and `staging show`. */
  max_chars: number;
}

export interface CaptureMarkerPackConfig {
  id: string;
  explicit_request: string[];
  correction: string[];
  correction_lead: string[];
  praise: string[];
  praise_negations: string[];
  praise_meta_words: string[];
}

export interface CaptureMarkerLimitsConfig {
  max_correction_chars: number;
  negation_window_chars: number;
  meta_window_chars: number;
  max_markers_per_message: number;
}

export interface CaptureMarkersConfig {
  /** Ids of the built-in packs to load, for example ["en"]. */
  packs: string[];
  custom: CaptureMarkerPackConfig[];
  limits: CaptureMarkerLimitsConfig;
}

export interface CaptureScanLimitsConfig {
  max_messages_per_scan: number;
  max_candidates_per_scan: number;
  transcript_max_bytes: number;
  transcript_max_lines: number;
}

/** Tuning for the capture pre-filter, distinct from capabilities.capture. */
export interface CaptureTuningConfig {
  markers: CaptureMarkersConfig;
  limits: CaptureScanLimitsConfig;
}

export interface LearningHistoryConfig {
  /** Belief history entries kept before the overflow folds into one summary. */
  max_entries: number;
}

export interface LearningCirculationConfig {
  read_tools: string[];
  write_tools: string[];
  max_partitions: number;
  max_entries: number;
}

export interface LearningSensorsConfig {
  circulation: LearningCirculationConfig;
}

export interface LearningEvaluatorConfig {
  correction_window_turns: number;
  confirmation_window_turns: number;
  dead_output_days: number;
  rapid_followup_seconds: number;
  session_closed_hours: number;
}

export interface LearningInjectionConfig {
  max_chars: number;
  max_law: number;
  max_active: number;
  statement_clip: number;
  drift_alert_tokens: number;
}

/** Tuning for the learning layer, distinct from capabilities.learning. */
export interface LearningTuningConfig {
  history: LearningHistoryConfig;
  sensors: LearningSensorsConfig;
  evaluator: LearningEvaluatorConfig;
  injection: LearningInjectionConfig;
}

export interface VaultConfig {
  version: number;
  root_label: string;
  paths: VaultPaths;
  exclusions: string[];
  text_extensions: string[];
  max_file_bytes: number;
  paliers: PalierConfig;
  deltas: {
    retention: number;
  };
  thermal: {
    hot_max_days: number;
    warm_max_days: number;
  };
  ephemeral: {
    ttl_days: number;
  };
  canonical_dirs: string[];
  activity: {
    active_paths: string[];
    active_dir_prefixes: string[];
  };
  capabilities: CapabilitiesConfig;
  staging: StagingTuningConfig;
  capture: CaptureTuningConfig;
  learning: LearningTuningConfig;
}

export interface CatalogRecord {
  path: string;
  layer: VaultLayer | string;
  domain: string;
  kind: string;
  lifecycle: Lifecycle;
  tags: string[];
  summary: string;
  headings: string[];
  links: string[];
  sha256: string;
  size: number;
  token_estimate: number;
  read_priority: number;
  source_state: string;
  tier: ThermalTier;
  age_days?: number;
  expires?: string;
}

export interface CatalogEnvelope {
  schema_version: number;
  generated_at: string;
  root_label: string;
  records: CatalogRecord[];
}

export interface GraphNode {
  path: string;
  domain: string;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "link";
}

export interface GraphEnvelope {
  schema_version: number;
  generated_at: string;
  root_label: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface DeltaSummary {
  added_count: number;
  removed_count: number;
  modified_count: number;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface ShardMetadata {
  layer: string;
  docs: number;
  sha256: string;
  mtime?: number;
}

export interface CatalogIndexEnvelope {
  schema_version: number;
  generated_at: string;
  root_label: string;
  shard_count: number;
  total_docs: number;
  shards: Record<string, ShardMetadata>;
}

export interface FreshnessEnvelope {
  schema_version: number;
  generated_at: string;
  root: string;
  source_count: number;
  palier: "P1" | "P2" | "P3" | "P4";
  sharded: boolean;
  total_token_estimate: number;
  catalog_sha256: string;
  delta: Pick<DeltaSummary, "added_count" | "modified_count" | "removed_count">;
  scan_stats: {
    accepted: number;
    skipped: Record<string, number>;
  };
  lifecycle_counts: Record<string, number>;
  tier_counts: Record<string, number>;
  shards?: {
    shards_written: number;
    missing_recreated: string[];
  };
  delta_note?: string;
}

export interface RoutingDefinition {
  intent?: string;
  triggers?: string[];
  read_order?: string[];
  max_files?: number;
  deep_sources?: boolean;
}

export interface RoutingDocument {
  always_read: string[];
  routes: Record<string, RoutingDefinition>;
}

export interface RoutedRecord {
  path: string;
  kind: string;
  domain: string;
  size?: number;
  read_priority: number;
  route_score: number;
  baseline: boolean;
  summary: string;
}

export interface RouteResult {
  query: string;
  route: string;
  route_score: number;
  intent: string;
  always_read: string[];
  read_order: string[];
  max_files: number;
  deep_sources: boolean;
  budget: {
    files: number;
    read_bytes: number;
    read_tokens: number;
    layers_loaded: string[] | "aggregate";
    catalog_docs_scored: number;
  };
  files: RoutedRecord[];
}

export interface ScanResult {
  catalog: CatalogEnvelope;
  graph: GraphEnvelope;
  freshness: FreshnessEnvelope;
  delta: DeltaSummary;
}
