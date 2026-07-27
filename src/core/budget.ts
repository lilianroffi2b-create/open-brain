import { countCodePoints } from "./text.js";

/**
 * The single vocabulary for invariant I11: every organ that produces text for a
 * model is capped, reports its cost, and announces its truncation. Callers read
 * the same five fields whatever the organ produced them, so a budget can be
 * aggregated, printed, or asserted on without knowing where it came from.
 *
 * An "item" is whatever unit the caller considers atomic: a line of a state
 * file, a routed file, a staged candidate. Truncation always drops whole items,
 * never half of one, and it always leaves a notice in the text saying how much
 * was dropped.
 */

export interface ContextBudget {
  chars: number;
  token_estimate: number;
  items_shown: number;
  items_total: number;
  truncated: boolean;
}

export interface CapResult {
  text: string;
  budget: ContextBudget;
}

/**
 * The same estimator the scanner writes into every catalog record: four code
 * points per token. Deliberately crude and deliberately identical everywhere,
 * so two organs never disagree about what a block of text costs.
 */
export function estimateTokens(text: string): number {
  const points = countCodePoints(text);
  return points === 0 ? 0 : Math.max(1, Math.floor(points / 4));
}

export function emptyBudget(): ContextBudget {
  return {
    chars: 0,
    token_estimate: 0,
    items_shown: 0,
    items_total: 0,
    truncated: false,
  };
}

function budgetFor(
  text: string,
  itemsShown: number,
  itemsTotal: number,
  truncated: boolean,
): ContextBudget {
  return {
    chars: text.length,
    token_estimate: estimateTokens(text),
    items_shown: itemsShown,
    items_total: itemsTotal,
    truncated,
  };
}

function truncationNotice(shown: number, total: number, maxChars: number): string {
  return `[open-brain] TRUNCATED: showing ${String(shown)} of ${String(total)} item(s), capped at ${String(maxChars)} characters. Open the source to read the rest.`;
}

/**
 * Keeps as many whole chunks as fit, then appends the notice. Room for the
 * notice is reserved up front using the longest form it can take, so the final
 * text never exceeds maxChars even though the notice mentions the final count.
 */
function capChunks(chunks: string[], itemsTotal: number, maxChars: number): CapResult {
  const reserve = truncationNotice(chunks.length, itemsTotal, maxChars).length + 1;
  const room = maxChars - reserve;
  const kept: string[] = [];
  let used = 0;

  for (const chunk of chunks) {
    const cost = kept.length === 0 ? chunk.length : chunk.length + 1;
    if (used + cost > room) {
      break;
    }
    kept.push(chunk);
    used += cost;
  }

  const notice = truncationNotice(kept.length, itemsTotal, maxChars);
  if (kept.length === 0) {
    const text = notice.length <= maxChars ? notice : "";
    return { text, budget: budgetFor(text, 0, itemsTotal, true) };
  }
  const text = [...kept, notice].join("\n");
  return { text, budget: budgetFor(text, kept.length, itemsTotal, true) };
}

/**
 * Caps a block of text at maxChars, dropping whole lines from the end.
 *
 * itemsTotal lets a caller that already dropped items upstream declare the real
 * total: when it is larger than the number of lines present, the result is
 * reported as truncated even if the text itself fits.
 */
export function capText(text: string, maxChars: number, itemsTotal?: number): CapResult {
  const lines = text.length === 0 ? [] : text.split("\n");
  const total = itemsTotal ?? lines.length;
  if (text.length <= maxChars && total <= lines.length) {
    return { text, budget: budgetFor(text, lines.length, total, false) };
  }
  return capChunks(lines, total, maxChars);
}

/**
 * Renders items one by one and keeps the longest prefix that fits. A rendered
 * item is atomic even when it spans several lines, which is what separates this
 * from capText.
 */
export function capItems<T>(
  items: T[],
  render: (item: T) => string,
  maxChars: number,
): CapResult {
  const rendered = items.map((item) => render(item));
  if (rendered.length === 0) {
    return { text: "", budget: emptyBudget() };
  }
  const text = rendered.join("\n");
  if (text.length <= maxChars) {
    return { text, budget: budgetFor(text, rendered.length, rendered.length, false) };
  }
  return capChunks(rendered, rendered.length, maxChars);
}
