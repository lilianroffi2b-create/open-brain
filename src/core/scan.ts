import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { excludedParts, palier, shardsEnabled } from "./config.js";
import { buildGraph } from "./graph.js";
import { canonicalJson } from "./index-writer.js";
import {
  activePathsFromConfig,
  contentAgeDays,
  gitContentTimes,
  isActive,
  repoFloorTimestamp,
  thermalTier,
} from "./lifecycle.js";
import { readExpiresFromText, readLifecycleFromText } from "./frontmatter.js";
import {
  UnicodeError,
  countCodePoints,
  decodeText,
  extractHeadings,
  extractLinks,
  extractSummary,
  normalize,
  sha256,
  toPosixPath,
} from "./text.js";
import {
  SCHEMA_VERSION,
  type CatalogRecord,
  type DeltaSummary,
  type ScanResult,
  type VaultConfig,
  type VaultLayer,
} from "./types.js";

export interface ScanOptions {
  now?: Date;
  previousRecords?: CatalogRecord[];
  gitTimes?: ReadonlyMap<string, number>;
  maxFileBytes?: number;
}

const LOADER_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const TOOL_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".sh"]);

function relativePath(root: string, path: string): string {
  return toPosixPath(relative(root, path));
}

function projectPath(rootLabel: string, relativeFilePath: string): string {
  return rootLabel + "/" + relativeFilePath;
}

function topSegment(path: string): string {
  return path.split("/", 1)[0] ?? "";
}

function configTopSegment(path: string): string {
  return topSegment(toPosixPath(path));
}

function inferLayer(relativeFilePath: string, config: VaultConfig): VaultLayer {
  const top = topSegment(relativeFilePath);
  if (top === configTopSegment(config.paths.index)) {
    return "index";
  }
  if (top === configTopSegment(config.paths.inbox)) {
    return "inbox";
  }
  if (top === configTopSegment(config.paths.memory)) {
    return "memory";
  }
  if (top === configTopSegment(config.paths.contexts)) {
    return "context";
  }
  if (top === configTopSegment(config.paths.skills)) {
    return "skill";
  }
  if (top === configTopSegment(config.paths.sources)) {
    return "source";
  }
  if (top === configTopSegment(config.paths.outputs)) {
    return "output";
  }
  if (top === configTopSegment(config.paths.engine)) {
    return "engine";
  }
  if (top === configTopSegment(config.paths.archive)) {
    return "archive";
  }
  return "root";
}

function inferDomain(relativeFilePath: string, layer: VaultLayer, config: VaultConfig): string {
  const memoryPreferences = toPosixPath(config.paths.memory).replace(/\/$/u, "") + "/preferences/";
  if (relativeFilePath.startsWith(toPosixPath(config.paths.index).replace(/\/$/u, "") + "/")) {
    return "brain";
  }
  if (relativeFilePath.startsWith(memoryPreferences)) {
    return "user_preferences";
  }
  if (layer === "source") {
    return "source";
  }
  return "general";
}

function inferKind(relativeFilePath: string, suffix: string, layer: VaultLayer): string {
  const name = relativeFilePath.split("/").at(-1) ?? relativeFilePath;
  if (LOADER_NAMES.has(name)) {
    return "loader";
  }
  if (name === "_index.md") {
    return "index";
  }
  if (name.endsWith(".brief.md")) {
    return "brief";
  }
  if (layer === "source") {
    return "raw_source";
  }
  if (TOOL_EXTENSIONS.has(suffix)) {
    return "tool";
  }
  if ([".json", ".yaml", ".yml", ".toml"].includes(suffix)) {
    return "config";
  }
  if (suffix === ".md") {
    return "note";
  }
  return "text";
}

function inferTags(text: string, domain: string, layer: VaultLayer): string[] {
  const tags = new Set<string>();
  if (domain !== "general") {
    tags.add(domain);
  }
  if (layer !== "root") {
    tags.add(layer);
  }
  for (const match of text.matchAll(/(?<!\w)#([A-Za-z0-9_-]+)/gu)) {
    const tag = match[1];
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return [...tags].sort();
}

function inferPriority(
  relativeFilePath: string,
  kind: string,
  layer: VaultLayer,
  config: VaultConfig,
): number {
  const name = relativeFilePath.split("/").at(-1) ?? relativeFilePath;
  if (LOADER_NAMES.has(name)) {
    return 100;
  }
  if (relativeFilePath === toPosixPath(config.paths.routing)) {
    return 92;
  }
  if (kind === "index") {
    return 82;
  }
  if (kind === "brief") {
    return 74;
  }
  if (kind === "tool") {
    return 56;
  }
  if (layer === "memory" || layer === "context" || layer === "skill") {
    return 55;
  }
  if (layer === "source") {
    return 18;
  }
  return 35;
}

function inferSourceState(kind: string, layer: VaultLayer): string {
  if (kind === "index" || kind === "brief" || kind === "loader") {
    return "curated";
  }
  if (layer === "source") {
    return "raw";
  }
  if (layer === "index") {
    return "brain";
  }
  if (kind === "tool") {
    return "tool";
  }
  return "working";
}

function inferLifecycle(text: string, suffix: string): {
  lifecycle: CatalogRecord["lifecycle"];
  expires?: string;
} {
  if (suffix !== ".md") {
    return { lifecycle: "data" };
  }
  const lifecycle = readLifecycleFromText(text) ?? "working";
  const expires = readExpiresFromText(text);
  return expires ? { lifecycle, expires } : { lifecycle };
}

function generatedPaths(config: VaultConfig): Set<string> {
  return new Set([
    toPosixPath(config.paths.catalog),
    toPosixPath(config.paths.graph),
    toPosixPath(config.paths.freshness),
    toPosixPath(config.paths.catalog_index),
  ]);
}

function isGeneratedPath(relativeFilePath: string, config: VaultConfig): boolean {
  const normalized = toPosixPath(relativeFilePath);
  if (generatedPaths(config).has(normalized)) {
    return true;
  }
  const shardPrefix = toPosixPath(config.paths.catalog_shards).replace(/\/$/u, "") + "/";
  const deltaPrefix = toPosixPath(config.paths.deltas).replace(/\/$/u, "") + "/";
  return normalized.startsWith(shardPrefix) || normalized.startsWith(deltaPrefix);
}

function hasExcludedPart(relativeFilePath: string, excluded: ReadonlySet<string>): boolean {
  return relativeFilePath
    .split("/")
    .map((part) => normalize(part))
    .some((part) => excluded.has(part));
}

async function walkFiles(
  root: string,
  current: string,
  excluded: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(current, entry.name);
    const relativeFilePath = relativePath(root, absolutePath);
    if (hasExcludedPart(relativeFilePath, excluded)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, absolutePath, excluded));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function shouldSkip(
  root: string,
  absolutePath: string,
  config: VaultConfig,
  maxFileBytes: number,
  excluded: ReadonlySet<string>,
): Promise<string | undefined> {
  const relativeFilePath = relativePath(root, absolutePath);
  if (isGeneratedPath(relativeFilePath, config)) {
    return "generated_index";
  }
  if (hasExcludedPart(relativeFilePath, excluded)) {
    return "excluded";
  }
  try {
    const metadata = await stat(absolutePath);
    if (metadata.size > maxFileBytes) {
      return "oversize";
    }
  } catch {
    return "stat_error";
  }
  const suffix = extname(relativeFilePath).toLowerCase();
  if (suffix && !config.text_extensions.includes(suffix)) {
    return "unrecognized_suffix";
  }
  return undefined;
}

async function buildRecord(
  root: string,
  absolutePath: string,
  config: VaultConfig,
): Promise<CatalogRecord> {
  const bytes = await readFile(absolutePath);
  const decoded = decodeText(bytes);
  const relativeFilePath = relativePath(root, absolutePath);
  const suffix = extname(relativeFilePath).toLowerCase();
  const layer = inferLayer(relativeFilePath, config);
  const domain = inferDomain(relativeFilePath, layer, config);
  const kind = inferKind(relativeFilePath, suffix, layer);
  const headings = extractHeadings(decoded.text);
  const lifecycle = inferLifecycle(decoded.text, suffix);
  const record: CatalogRecord = {
    path: projectPath(config.root_label, relativeFilePath),
    layer,
    domain,
    kind,
    lifecycle: lifecycle.lifecycle,
    tags: inferTags(decoded.text, domain, layer),
    summary: extractSummary(decoded.text, headings) || "(" + kind + ") " + relativeFilePath,
    headings,
    links: extractLinks(decoded.text),
    sha256: sha256(bytes),
    size: bytes.length,
    token_estimate: Math.max(1, Math.floor(countCodePoints(decoded.text) / 4)),
    read_priority: inferPriority(relativeFilePath, kind, layer, config),
    source_state: inferSourceState(kind, layer),
    tier: "warm",
  };
  if (lifecycle.expires) {
    record.expires = lifecycle.expires;
  }
  return record;
}

export function computeDelta(
  previousRecords: CatalogRecord[],
  records: CatalogRecord[],
): DeltaSummary {
  const previous = new Map(previousRecords.map((record) => [record.path, record.sha256]));
  const current = new Map(records.map((record) => [record.path, record.sha256]));
  const added = [...current.keys()].filter((path) => !previous.has(path)).sort();
  const removed = [...previous.keys()].filter((path) => !current.has(path)).sort();
  const modified = [...current.keys()]
    .filter((path) => previous.has(path) && previous.get(path) !== current.get(path))
    .sort();
  return {
    added_count: added.length,
    removed_count: removed.length,
    modified_count: modified.length,
    added,
    removed,
    modified,
  };
}

function countBy(records: CatalogRecord[], field: "lifecycle" | "tier"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const value = record[field];
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export async function scanVault(
  root: string,
  config: VaultConfig,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const excluded = excludedParts(config);
  const maxFileBytes = options.maxFileBytes ?? config.max_file_bytes;
  const skipped: Record<string, number> = {};
  const records: CatalogRecord[] = [];

  for (const absolutePath of await walkFiles(root, root, excluded)) {
    const reason = await shouldSkip(root, absolutePath, config, maxFileBytes, excluded);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    try {
      records.push(await buildRecord(root, absolutePath, config));
    } catch (error) {
      const name = error instanceof UnicodeError ? error.name : "read_error";
      skipped[name] = (skipped[name] ?? 0) + 1;
    }
  }

  records.sort(
    (left, right) => right.read_priority - left.read_priority || left.path.localeCompare(right.path),
  );
  const graph = buildGraph(records, config.root_label, now);
  const incoming = new Set(graph.edges.map((edge) => edge.target));
  const gitTimes = options.gitTimes ?? await gitContentTimes(root);
  const floorTimestamp = repoFloorTimestamp(gitTimes);
  const active = activePathsFromConfig(config);

  for (const record of records) {
    const relativeFilePath = record.path.slice((config.root_label + "/").length);
    const ageDays = await contentAgeDays({
      relativePath: relativeFilePath,
      absolutePath: join(root, relativeFilePath),
      gitTimes,
      now,
      ...(floorTimestamp === undefined ? {} : { floorTimestamp }),
    });
    record.tier = thermalTier(
      ageDays,
      incoming.has(record.path),
      record.lifecycle,
      isActive(relativeFilePath, active.files, active.directories),
      config,
    );
    record.age_days = Math.round(ageDays * 10) / 10;
  }

  const delta = computeDelta(options.previousRecords ?? [], records);
  const sourceCount = records.length;
  const catalog: ScanResult["catalog"] = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root_label: config.root_label,
    records,
  };
  const freshness: ScanResult["freshness"] = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root: config.root_label + "/",
    source_count: sourceCount,
    palier: palier(sourceCount, config),
    sharded: shardsEnabled(sourceCount, config),
    total_token_estimate: records.reduce((total, record) => total + record.token_estimate, 0),
    catalog_sha256: sha256(canonicalJson(records)),
    delta: {
      added_count: delta.added_count,
      modified_count: delta.modified_count,
      removed_count: delta.removed_count,
    },
    scan_stats: {
      accepted: sourceCount,
      skipped,
    },
    lifecycle_counts: countBy(records, "lifecycle"),
    tier_counts: countBy(records, "tier"),
  };

  return { catalog, graph, freshness, delta };
}
