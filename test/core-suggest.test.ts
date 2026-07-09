import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import { computeSuggestions } from "../src/core/route.js";
import type { CatalogRecord, RoutingDocument, VaultConfig } from "../src/core/types.js";

function config(): VaultConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.root_label = "SuggestVault";
  return value;
}

function record(path: string, domain: string, summary: string): CatalogRecord {
  return {
    path: `SuggestVault/${path}`,
    layer: "context",
    domain,
    kind: "note",
    lifecycle: "working",
    tags: [],
    summary,
    headings: [],
    links: [],
    sha256: "a".repeat(64),
    size: 1,
    token_estimate: 1,
    read_priority: 10,
    source_state: "working",
    tier: "warm",
  };
}

const routing: RoutingDocument = {
  always_read: [],
  routes: {
    prospection: { triggers: ["prospection", "outbound", "leads"], read_order: [] },
    fiscal: { triggers: ["fiscal", "impots"], read_order: [] },
    prospection_bis: { triggers: ["prospection", "outbound", "leads"], read_order: [] },
  },
};

test("route suggest clusters the catalog into new, covered, and mergeable routes", () => {
  const catalog: CatalogRecord[] = [
    // Directory cluster 20_contexts/prospection: lexical overlap with the prospection route.
    record("20_contexts/prospection/a.md", "general", "prospection outbound leads campaign"),
    record("20_contexts/prospection/b.md", "general", "prospection outbound leads campaign"),
    // Domain cluster domain:fiscal: covered by a direct domain-to-route-name match.
    record("20_contexts/fiscal-a.md", "fiscal", "declaration fiscal impots"),
    record("20_contexts/fiscal-b.md", "fiscal", "declaration fiscal impots"),
    // Domain cluster domain:roadmap: no route covers it lexically or by name.
    record("50_outputs/roadmap-a.md", "roadmap", "kubernetes deployment pipeline"),
    record("50_outputs/roadmap-b.md", "roadmap", "kubernetes deployment pipeline"),
  ];

  const result = computeSuggestions(routing, catalog, config(), 2);

  assert.equal(result.existing_routes, 3);
  assert.equal(result.clusters_examined, 3);

  const newRoute = result.new_route_suggestions.find((s) => s.cluster === "domain:roadmap");
  assert.ok(newRoute);
  assert.equal(newRoute.status, "new_route");
  assert.equal(newRoute.nearest_route, "");

  const domainCovered = result.covered_clusters.find((s) => s.cluster === "domain:fiscal");
  assert.ok(domainCovered);
  assert.equal(domainCovered.nearest_route, "fiscal");
  assert.equal(domainCovered.overlap, 1);

  const lexicalCovered = result.covered_clusters.find((s) => s.cluster === "20_contexts/prospection");
  assert.ok(lexicalCovered);
  assert.equal(lexicalCovered.nearest_route, "prospection");
  assert.ok(lexicalCovered.overlap >= 0.2);

  const merge = result.merge_suggestions.find(
    (m) => m.routes.includes("prospection") && m.routes.includes("prospection_bis"),
  );
  assert.ok(merge);
  assert.ok(merge.overlap >= 0.5);
});
