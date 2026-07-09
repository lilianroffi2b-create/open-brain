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
      domain: "general",
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
