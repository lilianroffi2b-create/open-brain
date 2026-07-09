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
}

export interface PalierConfig {
  p1_max: number;
  p2_max: number;
  p3_max: number;
  shard_from: "P1" | "P2" | "P3" | "P4";
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
