import assert from "node:assert/strict";
import test from "node:test";

import { routeRequest } from "../src/core/route.js";
import type { CatalogRecord, RoutingDocument } from "../src/core/types.js";

/**
 * A folder named in read_order asks for that folder's index first. The index is
 * the only file that can say which of its neighbours answers the question, so
 * ranking it under them wastes the budget on documents chosen by lexical luck.
 */

function record(path: string): CatalogRecord {
  return {
    path: `RouteVault/${path}`,
    layer: "context",
    domain: "general",
    kind: path.endsWith("_index.md") ? "index" : "note",
    lifecycle: "working",
    tags: [],
    summary: path,
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

const catalog: CatalogRecord[] = [
  record("20_contexts/prospection/_index.md"),
  record("20_contexts/prospection/playbook.md"),
  record("20_contexts/prospection/voice.md"),
  record("20_contexts/fiscal/_index.md"),
  record("20_contexts/fiscal/rules.md"),
];

const routing: RoutingDocument = {
  always_read: [],
  routes: {
    prospection: {
      triggers: ["prospection"],
      // The folder AND one of its files, which is the case that used to invert:
      // the named file outranked the index of the folder it lives in.
      read_order: ["20_contexts/prospection", "20_contexts/prospection/playbook.md"],
      max_files: 3,
    },
    fiscal: {
      triggers: ["fiscal"],
      read_order: ["20_contexts/fiscal/rules.md"],
      max_files: 3,
    },
  },
};

test("a folder in read_order puts its index ahead of every file inside it", () => {
  const routed = routeRequest("prospection", routing, catalog);
  assert.equal(routed.route, "prospection");

  const paths = routed.files.map((file) => file.path);
  assert.equal(paths[0], "RouteVault/20_contexts/prospection/_index.md");
  assert.ok(
    paths.indexOf("RouteVault/20_contexts/prospection/_index.md")
      < paths.indexOf("RouteVault/20_contexts/prospection/playbook.md"),
    `the index should outrank a file the same route names: ${paths.join(", ")}`,
  );

  const index = routed.files.find((file) => file.path.endsWith("prospection/_index.md"));
  const playbook = routed.files.find((file) => file.path.endsWith("playbook.md"));
  assert.ok((index?.route_score ?? 0) > (playbook?.route_score ?? 0));
});

test("a route that names only files scores exactly as it did", () => {
  const routed = routeRequest("fiscal", routing, catalog);
  assert.equal(routed.route, "fiscal");

  const paths = routed.files.map((file) => file.path);
  assert.equal(paths[0], "RouteVault/20_contexts/fiscal/rules.md");
  // The folder's index gets no promotion here: nothing asked for the folder.
  assert.ok(
    !paths.includes("RouteVault/20_contexts/fiscal/_index.md")
      || paths.indexOf("RouteVault/20_contexts/fiscal/rules.md")
        < paths.indexOf("RouteVault/20_contexts/fiscal/_index.md"),
  );
});
