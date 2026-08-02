/**
 * The frozen parity reference. Open Brain is measured against one named commit
 * of the private Python engine, captured once, never against whatever that
 * engine happens to be today. A moving target cannot be reached, so the target
 * is pinned here and moves only through a deliberate recapture. See PARITY.md.
 */

export interface ParityReference {
  schema_version: number;
  engine: "lrpm-brain-python";
  // An opaque label for the captured snapshot. It deliberately carries no
  // revision identifier: the reference engine is a private repository, and a
  // real commit hash published here would correlate the two.
  snapshot: string;
  date: string;
  captured_by: string;
  modules: Array<{ name: string; area: string; note?: string }>;
}

export const PARITY_REFERENCE: ParityReference = {
  schema_version: 1,
  engine: "lrpm-brain-python",
  snapshot: "2026-08-a",
  date: "2026-08-02",
  // Package version at the moment of the capture. It records when the snapshot
  // was taken, so it does not follow later releases.
  captured_by: "0.1.0-alpha.2",
  modules: [
    {
      name: "index",
      area: "core",
      note: "Deterministic scan, catalog, graph, and shards.",
    },
    {
      name: "routing",
      area: "core",
      note: "Smallest useful reading route for a request, a named folder served by its index first.",
    },
    {
      name: "preferences",
      area: "prefs",
      note: "Weighted preference ledger, the always-on core it renders, and the cited door a stated preference enters by.",
    },
    {
      name: "lifecycle",
      area: "core",
      note: "Master, working, ephemeral, and data classification with expiry.",
    },
    {
      name: "freshness",
      area: "core",
      note: "Index freshness envelope and scan deltas.",
    },
    {
      name: "gc",
      area: "core",
      note: "Cleanup proposals, reviewed before anything is applied.",
    },
    {
      name: "health",
      area: "core",
      note: "Structure, wiring, and index integrity checks.",
    },
    {
      name: "ingest",
      area: "core",
      note: "Inbox import into the archive and generated briefs.",
    },
    {
      name: "staging",
      area: "staging",
      note: "Candidate area where nothing is authoritative yet.",
    },
    {
      name: "gate",
      area: "gate",
      note: "Human validation, item by item, before anything reaches the kernel, with the age of a batch stated so a stale one is never presented as new.",
    },
    {
      name: "hooks",
      area: "hooks",
      note: "Single hook entry point, idempotent host wiring, and the living state held to the load cap and the per-line budgets it declares for itself.",
    },
    {
      name: "learning",
      area: "learning",
      note: "Decision journal, sensors, evaluator, confidence, consolidation.",
    },
  ],
};

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Renders the parity reference for a terminal. */
export function renderParity(reference: ParityReference = PARITY_REFERENCE): string {
  const nameWidth = reference.modules.reduce(
    (width, module) => Math.max(width, module.name.length),
    0,
  );
  const areaWidth = reference.modules.reduce(
    (width, module) => Math.max(width, module.area.length),
    0,
  );

  const lines = [
    "Parity reference (frozen)",
    "",
    "engine:      " + reference.engine,
    "snapshot:    " + reference.snapshot,
    "date:        " + reference.date,
    "captured by: open-brain " + reference.captured_by,
    "schema:      " + String(reference.schema_version),
    "",
    "Modules (" + String(reference.modules.length) + ")",
  ];

  for (const module of reference.modules) {
    const prefix = "  " + padRight(module.name, nameWidth) + "  " + padRight(module.area, areaWidth);
    lines.push(module.note ? prefix + "  " + module.note : prefix.trimEnd());
  }

  lines.push("");
  lines.push("The reference is frozen on purpose. See PARITY.md to move it.");
  return lines.join("\n");
}
