import { capText, estimateTokens, type ContextBudget } from "../core/budget.js";
import type { BatchItem, Proof, WritePayload } from "../staging/types.js";
import {
  DEFAULT_REVIEW_CHARS,
  DIFF_LINE_LIMIT,
  type StagedCandidateView,
} from "./types.js";

/**
 * The presentation layer of the gate.
 *
 * A batch can hold two hundred items. Dumping two hundred items into the
 * context of a model is exactly the failure Open Brain exists to avoid, so
 * every rendering here is capped, reports what it cost, and says out loud how
 * much it left out and how to see it. A reviewer who cannot see that something
 * was hidden cannot ask for it.
 */

/** Per-field cap inside one item, so a single huge note cannot eat the batch. */
const FIELD_CHARS = 2_000;

export interface Presentation {
  text: string;
  budget: ContextBudget;
  from: number;
  shown: number;
  total: number;
  next: string | undefined;
}

function budgetOf(
  text: string,
  shown: number,
  total: number,
  truncated: boolean,
): ContextBudget {
  return {
    chars: text.length,
    token_estimate: estimateTokens(text),
    items_shown: shown,
    items_total: total,
    truncated,
  };
}

/**
 * Keeps whole rendered items until the cap is reached, then states the exact
 * remainder and the exact command that shows it. Room for that final line is
 * reserved before the first item is kept, so the result never exceeds the cap
 * even though the line quotes the numbers it ends up with.
 */
function capRendered(
  rendered: readonly string[],
  from: number,
  total: number,
  maxChars: number,
  moreCommand: string,
): Presentation {
  const reserve = 240;
  const room = Math.max(0, maxChars - reserve);
  const kept: string[] = [];
  let used = 0;

  for (const chunk of rendered) {
    const cost = kept.length === 0 ? chunk.length : chunk.length + 2;
    if (used + cost > room && kept.length > 0) {
      break;
    }
    if (used + cost > room && kept.length === 0) {
      kept.push(chunk.slice(0, room));
      used = room;
      break;
    }
    kept.push(chunk);
    used += cost;
  }

  const shown = kept.length;
  const remaining = total - from - shown;
  const truncated = remaining > 0 || from > 0;
  const lines = [...kept];
  if (remaining > 0) {
    lines.push(
      `[open-brain] TRUNCATED: showing item(s) ${String(from + 1)} to ${String(from + shown)} of ${String(total)}, capped at ${String(maxChars)} characters. ${String(remaining)} item(s) are not shown. See them with \`${moreCommand} --from ${String(from + shown + 1)}\`, or raise --max-chars.`,
    );
  } else if (from > 0) {
    lines.push(
      `[open-brain] Showing item(s) ${String(from + 1)} to ${String(from + shown)} of ${String(total)}. Nothing is left after this one.`,
    );
  }

  const text = lines.join("\n\n");
  const next = remaining > 0
    ? `${String(remaining)} item(s) were not shown. Read them with \`${moreCommand} --from ${String(from + shown + 1)}\` before you decide: an item you never read is still an item you are rejecting.`
    : undefined;

  const presentation: Presentation = {
    text,
    budget: budgetOf(text, shown, total, truncated),
    from,
    shown,
    total,
    next: undefined,
  };
  return next === undefined ? presentation : { ...presentation, next };
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function renderProofs(proofs: readonly Proof[]): string[] {
  return proofs.map((proof) => `    ${proof.date}: ${oneLine(proof.quote)}`);
}

function renderPrecondition(write: WritePayload): string {
  switch (write.kind) {
    case "preference":
      return `no preference with this id exists yet (${write.args.id})`;
    case "weight":
      return `the preference still weighs ${String(write.precondition.expected_current_weight)}`;
    case "memory":
      return write.precondition.expected_sha256 === "absent"
        ? "the note does not exist yet"
        : `the note still hashes to ${write.precondition.expected_sha256.slice(0, 12)}`;
    case "reject_only":
      return "none, nothing is written";
  }
}

function renderWriteBody(write: WritePayload): string[] {
  switch (write.kind) {
    case "preference":
      return [
        `  statement: ${oneLine(write.args.statement)}`,
        `  weight:    ${String(write.args.weight)}`,
        `  domains:   ${write.args.domains.join(", ")}`,
        `  why:       ${oneLine(write.args.why)}`,
        `  apply:     ${oneLine(write.args.apply)}`,
      ];
    case "weight":
      return [
        `  mode:      ${write.mode === "bump" ? "raise the weight" : "record evidence, weight already at its ceiling"}`,
        `  weight:    ${String(write.precondition.expected_current_weight)} to ${String(write.args.weight)}`,
        `  signal:    ${write.args.signal}`,
        `  quote:     ${oneLine(write.args.quote)}`,
      ];
    case "memory": {
      const diff = capText(write.diff, FIELD_CHARS);
      return [
        `  file:      ${write.target}`,
        `  sha256:    ${write.content_sha256.slice(0, 12)}`,
        "  diff:",
        ...diff.text.split("\n").map((line) => `    ${line}`),
      ];
    }
    case "reject_only":
      return [
        `  reason:    ${write.reason}`,
        `  content:   ${oneLine(capText(write.content, FIELD_CHARS).text)}`,
      ];
  }
}

/**
 * One item, in the exact form a human decides on. A reject_only item is shown
 * with its refusal spelled out rather than hidden: the reviewer has to see what
 * was captured and why it did not qualify, otherwise the same weak signal comes
 * back every week and nobody knows why it never lands.
 */
export function renderReviewItem(item: BatchItem): string {
  const header = item.recommendation === "reject_only"
    ? `[${String(item.index)}] ${item.type} -> ${item.target}   REJECT ONLY, cannot be approved`
    : `[${String(item.index)}] ${item.type} -> ${item.target}`;

  const lines: string[] = [header];
  lines.push(...renderWriteBody(item.write));
  lines.push(`  reason:    ${oneLine(item.reason)}`);
  lines.push(`  evidence:  ${item.evidence_basis ?? "none declared"}`);
  lines.push(`  proofs (${String(item.proofs.length)}):`);
  lines.push(...renderProofs(item.proofs));
  lines.push(`  requires:  ${renderPrecondition(item.write)}`);
  lines.push(`  candidates: ${item.merged_ids.join(", ")}`);
  if (item.recommendation === "reject_only") {
    lines.push(
      "  This item is recorded and rejected. Approving it is refused by the gate, so leaving it unchecked is the only outcome available.",
    );
  }
  return lines.join("\n");
}

export interface RenderReviewOptions {
  maxChars?: number;
  from?: number;
  command?: string;
}

export function renderReview(
  items: readonly BatchItem[],
  options: RenderReviewOptions = {},
): Presentation {
  const maxChars = options.maxChars ?? DEFAULT_REVIEW_CHARS;
  const from = Math.max(0, options.from ?? 0);
  const command = options.command ?? "open-brain sync show --batch <batch-id>";
  const slice = items.slice(from);
  const rendered = slice.map((item) => renderReviewItem(item));
  return capRendered(rendered, from, items.length, maxChars, command);
}

export function renderStagedCandidate(view: StagedCandidateView): string {
  const lines = [
    `${view.id}  ${view.source}/${view.signal}  ${view.ts}`,
    `  ${oneLine(capText(view.raw_quote, FIELD_CHARS).text)}`,
  ];
  if (view.raw_markers.length > 0) {
    lines.push(`  markers: ${view.raw_markers.join(", ")}`);
  }
  if (view.context !== null) {
    lines.push(`  context: ${oneLine(view.context)}`);
  }
  return lines.join("\n");
}

export function renderStagedSlice(
  views: readonly StagedCandidateView[],
  maxChars: number,
): Presentation {
  const rendered = views.map((view) => renderStagedCandidate(view));
  return capRendered(rendered, 0, views.length, maxChars, "open-brain staging list");
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

/**
 * A unified diff of the whole file, computed from a plain longest common
 * subsequence. It exists so a human sees what changes before approving it, and
 * it is bounded on purpose: past DIFF_LINE_LIMIT lines the quadratic table
 * would cost more than the review is worth, so the diff degrades to a stated
 * whole-file replacement rather than getting slow in silence.
 */
export function unifiedDiff(before: string, after: string, path: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const header = [`--- a/${path}`, `+++ b/${path}`];

  if (beforeLines.length > DIFF_LINE_LIMIT || afterLines.length > DIFF_LINE_LIMIT) {
    return [
      ...header,
      `@@ whole file @@ ${String(beforeLines.length)} line(s) replaced by ${String(afterLines.length)}, too large to diff line by line`,
    ].join("\n");
  }

  const rows = beforeLines.length;
  const columns = afterLines.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0));

  for (let i = rows - 1; i >= 0; i -= 1) {
    const currentRow = table[i];
    const nextRow = table[i + 1];
    if (!currentRow || !nextRow) {
      continue;
    }
    for (let j = columns - 1; j >= 0; j -= 1) {
      const same = beforeLines[i] === afterLines[j];
      const diagonal = nextRow[j + 1] ?? 0;
      const down = nextRow[j] ?? 0;
      const right = currentRow[j + 1] ?? 0;
      currentRow[j] = same ? diagonal + 1 : Math.max(down, right);
    }
  }

  const body: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (beforeLines[i] === afterLines[j]) {
      body.push(` ${beforeLines[i] ?? ""}`);
      i += 1;
      j += 1;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const right = table[i]?.[j + 1] ?? 0;
    if (down >= right) {
      body.push(`-${beforeLines[i] ?? ""}`);
      i += 1;
    } else {
      body.push(`+${afterLines[j] ?? ""}`);
      j += 1;
    }
  }
  while (i < rows) {
    body.push(`-${beforeLines[i] ?? ""}`);
    i += 1;
  }
  while (j < columns) {
    body.push(`+${afterLines[j] ?? ""}`);
    j += 1;
  }

  return [
    ...header,
    `@@ -1,${String(beforeLines.length)} +1,${String(afterLines.length)} @@`,
    ...body,
  ].join("\n");
}
