import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { loadCatalog } from "./catalog.js";
import { normalize, tokenize } from "./text.js";
import type {
  CatalogRecord,
  RouteResult,
  RoutedRecord,
  RoutingDefinition,
  RoutingDocument,
  VaultConfig,
} from "./types.js";

const RAW_QUERY_TERMS = [
  "source",
  "transcript",
  "citation",
  "exact",
  "audit",
  "verify",
  "evidence",
  "verifie",
  "preuve",
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseRoute(value: unknown): RoutingDefinition {
  if (!isRecord(value)) {
    return {};
  }
  const route: RoutingDefinition = {
    triggers: asStringArray(value.triggers),
    read_order: asStringArray(value.read_order),
    deep_sources: value.deep_sources === true,
  };
  if (typeof value.intent === "string") {
    route.intent = value.intent;
  }
  if (typeof value.max_files === "number" && value.max_files > 0) {
    route.max_files = Math.floor(value.max_files);
  }
  return route;
}

export function parseRoutingDocument(value: unknown): RoutingDocument {
  if (!isRecord(value)) {
    return { always_read: [], routes: {} };
  }
  const alwaysReadValue = isRecord(value.always_read)
    ? value.always_read.files
    : value.always_read;
  const routes: Record<string, RoutingDefinition> = {};
  if (isRecord(value.routes)) {
    for (const [name, route] of Object.entries(value.routes)) {
      routes[name] = parseRoute(route);
    }
  }
  return {
    always_read: asStringArray(alwaysReadValue),
    routes,
  };
}

export async function loadRouting(
  root: string,
  config: VaultConfig,
): Promise<RoutingDocument> {
  try {
    return parseRoutingDocument(parseYaml(await readFile(join(root, config.paths.routing), "utf8")));
  } catch {
    return { always_read: [], routes: {} };
  }
}

export function candidateLayers(
  route: RoutingDefinition,
  alwaysRead: string[],
): string[] | undefined {
  const layers = new Set<string>();
  for (const entry of [...(route.read_order ?? []), ...alwaysRead]) {
    const separator = entry.indexOf("/");
    layers.add(separator === -1 ? "root" : entry.slice(0, separator));
  }
  return layers.size > 0 ? [...layers].sort() : undefined;
}

export function scoreRoute(query: string, route: RoutingDefinition): number {
  const normalizedQuery = normalize(query);
  const queryTokens = new Set(tokenize(query));
  let score = 0;
  for (const trigger of route.triggers ?? []) {
    const normalizedTrigger = normalize(trigger);
    const triggerTokens = new Set(tokenize(trigger));
    if (normalizedTrigger && normalizedQuery.includes(normalizedTrigger)) {
      score += 8 + triggerTokens.size;
    } else {
      let overlap = 0;
      for (const token of triggerTokens) {
        if (queryTokens.has(token)) {
          overlap += 1;
        }
      }
      score += overlap * 2;
    }
  }
  return score;
}

export function chooseRoute(
  query: string,
  routes: Record<string, RoutingDefinition>,
): { name: string; route: RoutingDefinition; score: number } {
  const choices = Object.entries(routes)
    .map(([name, route]) => ({ name, route, score: scoreRoute(query, route) }))
    .sort(
      (left, right) => right.score - left.score
        || Number(left.name === "default") - Number(right.name === "default")
        || left.name.localeCompare(right.name),
    );
  const best = choices[0] ?? { name: "default", route: {}, score: 0 };
  if (best.score <= 0 && routes.default) {
    return { name: "default", route: routes.default, score: 0 };
  }
  return best;
}

export function pathWithoutRoot(recordPath: string): string {
  const separator = recordPath.indexOf("/");
  return separator === -1 ? recordPath : recordPath.slice(separator + 1);
}

export function scoreRecord(
  query: string,
  route: RoutingDefinition,
  record: CatalogRecord,
): number {
  const normalizedQuery = normalize(query);
  const wantsRaw = RAW_QUERY_TERMS.some((term) => normalizedQuery.includes(term));
  if (record.kind === "raw_source" && !route.deep_sources && !wantsRaw) {
    return -999;
  }

  const relativePath = normalize(pathWithoutRoot(record.path));
  const queryTokens = new Set(tokenize(query));
  const summary = normalize(record.summary);
  const tags = record.tags.map(normalize);
  const headings = normalize(record.headings.join(" "));
  let score = Math.floor(record.read_priority / 10);

  for (const [index, target] of (route.read_order ?? []).entries()) {
    const normalizedTarget = normalize(target);
    if (relativePath === normalizedTarget) {
      score += 120 - index;
    } else if (relativePath.startsWith(normalizedTarget.replace(/\/$/u, "") + "/")) {
      score += 90 - index;
    } else if (relativePath.includes(normalizedTarget)) {
      score += 45 - index;
    }
  }

  const haystack = relativePath + " " + summary + " " + tags.join(" ") + " " + headings;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 4;
    }
  }
  if (record.kind === "raw_source" && !route.deep_sources) {
    score -= 30;
  }
  return score;
}

export function selectRecords(
  query: string,
  route: RoutingDefinition,
  catalog: CatalogRecord[],
): Array<CatalogRecord & { route_score: number }> {
  const maxFiles = route.max_files ?? 5;
  const scored = catalog
    .map((record) => ({ record, score: scoreRecord(query, route, record) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) => right.score - left.score
        || right.record.read_priority - left.record.read_priority
        || left.record.path.localeCompare(right.record.path),
    );
  const selected: Array<CatalogRecord & { route_score: number }> = [];
  const seen = new Set<string>();
  for (const item of scored) {
    if (seen.has(item.record.path)) {
      continue;
    }
    selected.push({ ...item.record, route_score: item.score });
    seen.add(item.record.path);
    if (selected.length >= maxFiles) {
      break;
    }
  }
  return selected;
}

function baselineRecords(
  paths: string[],
  catalog: CatalogRecord[],
): Array<CatalogRecord & { route_score: number; baseline: true }> {
  const byRelativePath = new Map(catalog.map((record) => [pathWithoutRoot(record.path), record]));
  return paths.map((path, index) => {
    const record = byRelativePath.get(path);
    if (record) {
      return { ...record, route_score: 1000 - index, baseline: true as const };
    }
    return {
      path,
      layer: "root",
      kind: "baseline",
      domain: "user_preferences",
      lifecycle: "working" as const,
      tags: [],
      summary: "Baseline file declared by routing configuration.",
      headings: [],
      links: [],
      sha256: "",
      size: 0,
      token_estimate: 0,
      read_priority: 0,
      source_state: "configured",
      tier: "warm" as const,
      route_score: 1000 - index,
      baseline: true as const,
    };
  });
}

function presentRecord(record: CatalogRecord & {
  route_score: number;
  baseline?: boolean;
}): RoutedRecord {
  return {
    path: record.path,
    kind: record.kind,
    domain: record.domain,
    size: record.size,
    read_priority: record.read_priority,
    route_score: record.route_score,
    baseline: record.baseline ?? false,
    summary: record.summary,
  };
}

export function routeRequest(
  query: string,
  routing: RoutingDocument,
  catalog: CatalogRecord[],
): RouteResult {
  const selectedRoute = chooseRoute(query, routing.routes);
  const baseline = baselineRecords(routing.always_read, catalog);
  const selected = selectRecords(query, selectedRoute.route, catalog);
  const seen = new Set(baseline.map((record) => record.path));
  const files = [
    ...baseline,
    ...selected.filter((record) => !seen.has(record.path)),
  ];
  const layers = candidateLayers(selectedRoute.route, routing.always_read);
  return {
    query,
    route: selectedRoute.name,
    route_score: selectedRoute.score,
    intent: selectedRoute.route.intent ?? "",
    always_read: routing.always_read,
    read_order: selectedRoute.route.read_order ?? [],
    max_files: selectedRoute.route.max_files ?? 5,
    deep_sources: selectedRoute.route.deep_sources ?? false,
    budget: {
      files: files.length,
      read_bytes: files.reduce((total, record) => total + record.size, 0),
      read_tokens: files.reduce((total, record) => total + record.token_estimate, 0),
      layers_loaded: layers ?? "aggregate",
      catalog_docs_scored: catalog.length,
    },
    files: files.map(presentRecord),
  };
}

export async function routeVault(
  root: string,
  config: VaultConfig,
  query: string,
): Promise<RouteResult> {
  const routing = await loadRouting(root, config);
  const selectedRoute = chooseRoute(query, routing.routes);
  const catalog = await loadCatalog(
    root,
    config,
    candidateLayers(selectedRoute.route, routing.always_read),
  );
  return routeRequest(query, routing, catalog);
}

// --------------------------------------------------------------------------- //
// --suggest : lexical clustering of the catalog into candidate routes          //
// --------------------------------------------------------------------------- //

export interface RouteSuggestion {
  cluster: string;
  docs: number;
  status: "covered" | "new_route";
  nearest_route: string;
  overlap: number;
  tokens: string[];
  examples: string[];
}

export interface RouteMergeSuggestion {
  routes: [string, string];
  overlap: number;
}

export interface SuggestResult {
  existing_routes: number;
  clusters_examined: number;
  new_route_suggestions: RouteSuggestion[];
  merge_suggestions: RouteMergeSuggestion[];
  covered_clusters: RouteSuggestion[];
  note: string;
}

const STOP_TOKENS = new Set([
  "md", "json", "index", "_index", "readme", "note", "notes", "2026", "the", "and",
  "de", "la", "le", "les", "des", "un", "une", "et", "pour", "avec", "sur",
]);
const EXTENSION_TOKENS = new Set([
  "md", "json", "html", "htm", "pptx", "docx", "pdf", "png", "jpg", "jpeg",
  "py", "csv", "txt", "yml", "yaml", "xlsx",
]);
const GENERIC_TOKENS = new Set(["index", "readme", "note", "notes", "file", "files", "doc", "docs"]);
const TOPIC_WORD_RE = /[a-z0-9]+/gu;
const COVERED_THRESHOLD = 0.2;
const MERGE_THRESHOLD = 0.5;

function topicWords(text: string): string[] {
  return normalize(text).match(TOPIC_WORD_RE) ?? [];
}

function structuralTokens(config: VaultConfig): Set<string> {
  const structural = new Set<string>();
  for (const directory of config.canonical_dirs) {
    for (const part of normalize(String(directory)).split("_")) {
      if (part && !/^\d+$/u.test(part)) {
        structural.add(part);
      }
    }
  }
  for (const token of EXTENSION_TOKENS) {
    structural.add(token);
  }
  for (const token of GENERIC_TOKENS) {
    structural.add(token);
  }
  for (const token of STOP_TOKENS) {
    structural.add(token);
  }
  return structural;
}

function isDateToken(token: string): boolean {
  return /^\d{4}(-\d{2}(-\d{2})?)?$/u.test(token) || /^\d+$/u.test(token);
}

function signatureTokens(text: string, structural: ReadonlySet<string>): Set<string> {
  const signature = new Set<string>();
  for (const token of topicWords(text)) {
    if (token.length > 2 && !structural.has(token) && !isDateToken(token)) {
      signature.add(token);
    }
  }
  return signature;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) {
      size += 1;
    }
  }
  return size;
}

function nameParts(name: string): Set<string> {
  return new Set(name.split("_").filter((part) => part.length > 0));
}

function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Clusters the catalog into candidate routes without ever editing routing.yml.
 * Ported from brain_route.run_suggest: token signatures per route (name +
 * triggers + read_order) and per doc (summary + tags + domain), structural
 * tokens stripped, jaccard 0.20 coverage, direct domain-to-route-name match,
 * and route-pair merge suggestions above 0.50 overlap.
 */
export function computeSuggestions(
  routing: RoutingDocument,
  catalog: CatalogRecord[],
  config: VaultConfig,
  minDocs: number,
): SuggestResult {
  const structural = structuralTokens(config);

  const routeSignatures = new Map<string, Set<string>>();
  const routeNameParts = new Map<string, Set<string>>();
  for (const [name, route] of Object.entries(routing.routes)) {
    const signature = signatureTokens(name, structural);
    for (const trigger of route.triggers ?? []) {
      for (const token of signatureTokens(String(trigger), structural)) {
        signature.add(token);
      }
    }
    for (const target of route.read_order ?? []) {
      for (const token of signatureTokens(String(target).replace(/\//gu, " "), structural)) {
        signature.add(token);
      }
    }
    routeSignatures.set(name, signature);
    routeNameParts.set(name, nameParts(name));
  }

  const clusters = new Map<string, CatalogRecord[]>();
  for (const record of catalog) {
    const relative = pathWithoutRoot(record.path);
    const parts = relative.split("/");
    if (parts.length >= 3) {
      const key = parts.slice(0, 2).join("/");
      clusters.set(key, [...(clusters.get(key) ?? []), record]);
    }
    const domain = record.domain || "general";
    if (domain && domain !== "general") {
      const key = `domain:${domain}`;
      clusters.set(key, [...(clusters.get(key) ?? []), record]);
    }
  }

  const documentSignature = (record: CatalogRecord): Set<string> => {
    const signature = signatureTokens(record.summary, structural);
    for (const tag of record.tags) {
      for (const token of signatureTokens(String(tag), structural)) {
        signature.add(token);
      }
    }
    for (const token of signatureTokens(record.domain, structural)) {
      signature.add(token);
    }
    return signature;
  };

  const suggestions: RouteSuggestion[] = [];
  for (const [key, docs] of clusters) {
    if (docs.length < minDocs) {
      continue;
    }
    const clusterSignature = new Set<string>();
    const documentSignatures: Array<[CatalogRecord, Set<string>]> = [];
    for (const record of docs) {
      const signature = documentSignature(record);
      documentSignatures.push([record, signature]);
      for (const token of signature) {
        clusterSignature.add(token);
      }
    }

    let bestRoute = "";
    let bestOverlap = 0;
    for (const [name, signature] of routeSignatures) {
      const overlap = jaccard(clusterSignature, signature);
      if (overlap > bestOverlap) {
        bestRoute = name;
        bestOverlap = overlap;
      }
    }

    let domainMatchedRoute = "";
    if (key.startsWith("domain:")) {
      const domainParts = nameParts(key.slice("domain:".length));
      if (domainParts.size > 0) {
        for (const [name, parts] of routeNameParts) {
          if (parts.size > 0 && (isSubset(domainParts, parts) || isSubset(parts, domainParts))) {
            domainMatchedRoute = name;
            break;
          }
        }
      }
    }
    if (domainMatchedRoute) {
      bestRoute = domainMatchedRoute;
      bestOverlap = Math.max(bestOverlap, 1);
    }

    const covered = Boolean(domainMatchedRoute) || bestOverlap >= COVERED_THRESHOLD;
    const ranked = [...documentSignatures].sort((left, right) => {
      const overlapDelta = intersectionSize(right[1], clusterSignature)
        - intersectionSize(left[1], clusterSignature);
      if (overlapDelta !== 0) {
        return overlapDelta;
      }
      return right[0].read_priority - left[0].read_priority;
    });
    const examples = ranked.slice(0, 3).map(([record]) => pathWithoutRoot(record.path));

    const tokenCounts = new Map<string, number>();
    for (const [, signature] of documentSignatures) {
      for (const token of signature) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }
    }
    const topTokens = [...tokenCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([token]) => token);

    suggestions.push({
      cluster: key,
      docs: docs.length,
      status: covered ? "covered" : "new_route",
      nearest_route: bestRoute,
      overlap: round2(bestOverlap),
      tokens: topTokens,
      examples,
    });
  }

  const merges: RouteMergeSuggestion[] = [];
  const names = [...routeSignatures.keys()];
  for (let i = 0; i < names.length; i += 1) {
    const left = names[i];
    const leftSignature = left === undefined ? undefined : routeSignatures.get(left);
    if (left === undefined || leftSignature === undefined) {
      continue;
    }
    for (let j = i + 1; j < names.length; j += 1) {
      const right = names[j];
      const rightSignature = right === undefined ? undefined : routeSignatures.get(right);
      if (right === undefined || rightSignature === undefined) {
        continue;
      }
      const overlap = jaccard(leftSignature, rightSignature);
      if (overlap >= MERGE_THRESHOLD) {
        merges.push({ routes: [left, right], overlap: round2(overlap) });
      }
    }
  }

  return {
    existing_routes: Object.keys(routing.routes).length,
    clusters_examined: suggestions.length,
    new_route_suggestions: suggestions
      .filter((suggestion) => suggestion.status === "new_route")
      .sort((left, right) => right.docs - left.docs),
    merge_suggestions: [...merges].sort((left, right) => right.overlap - left.overlap),
    covered_clusters: suggestions
      .filter((suggestion) => suggestion.status === "covered")
      .sort((left, right) => right.docs - left.docs),
    note: "routing.yml is never modified by this tool; validate and edit by hand.",
  };
}

export async function suggestRoutes(
  root: string,
  config: VaultConfig,
  minDocs = 5,
): Promise<SuggestResult> {
  const routing = await loadRouting(root, config);
  const catalog = await loadCatalog(root, config);
  return computeSuggestions(routing, catalog, config, minDocs);
}
