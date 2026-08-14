import assert from "node:assert/strict";
import test from "node:test";

import {
  capItems,
  capText,
  emptyBudget,
  estimateTokens,
  type ContextBudget,
} from "../src/core/budget.js";

function assertWithinCap(budget: ContextBudget, text: string, maxChars: number): void {
  assert.equal(budget.chars, text.length);
  assert.ok(
    text.length <= maxChars,
    `capped text is ${String(text.length)} chars, over the ${String(maxChars)} cap`,
  );
}

test("estimateTokens matches the scanner and reports nothing for nothing", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("emptyBudget is a real zero, not a partially filled shape", () => {
  assert.deepEqual(emptyBudget(), {
    chars: 0,
    token_estimate: 0,
    items_shown: 0,
    items_total: 0,
    truncated: false,
  });
});

test("capText under the cap is the identity and reports no truncation", () => {
  const text = "one\ntwo\nthree";
  const result = capText(text, 1_000);
  assert.equal(result.text, text);
  assert.equal(result.budget.truncated, false);
  assert.equal(result.budget.items_shown, 3);
  assert.equal(result.budget.items_total, 3);
  assert.equal(result.budget.chars, text.length);
  assert.equal(result.budget.token_estimate, estimateTokens(text));
});

test("invariant I11: capText stays under the cap, keeps whole lines, and says it cut", () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index)}`);
  const maxChars = 300;
  const result = capText(lines.join("\n"), maxChars);

  assertWithinCap(result.budget, result.text, maxChars);
  assert.equal(result.budget.truncated, true);
  assert.equal(result.budget.items_total, 200);
  assert.ok(result.budget.items_shown > 0, "at least one line survives");
  assert.ok(result.budget.items_shown < 200, "not everything survives");
  assert.match(result.text, /TRUNCATED/u);
  // Truncation is announced inside the injected text, not only in the budget:
  // a user who cannot see that something was hidden cannot correct it.
  assert.ok(result.text.includes(String(result.budget.items_total)));
  for (const line of result.text.split("\n").slice(0, result.budget.items_shown)) {
    assert.ok(lines.includes(line), `kept a partial line: ${line}`);
  }
});

test("capText reports truncation when the caller already dropped items upstream", () => {
  // The text fits, so nothing is cut here. It is still truncated, because the
  // caller declares more items than it handed over: an organ that dropped
  // something before calling must not be able to report a clean budget.
  const upstream = capText("kept\nalso", 1_000, 40);
  assert.equal(upstream.budget.truncated, true);
  assert.equal(upstream.budget.items_total, 40);
  assert.equal(upstream.budget.items_shown, 2);
  assert.match(upstream.text, /TRUNCATED/u);
  assert.ok(upstream.text.startsWith("kept\nalso"), "nothing was dropped here");

  const matching = capText("kept\nalso", 1_000, 2);
  assert.equal(matching.text, "kept\nalso");
  assert.equal(matching.budget.truncated, false);
});

test("capText with no room at all yields no text and still admits the truncation", () => {
  const result = capText("something long enough to matter", 5);
  assert.equal(result.text, "");
  assert.equal(result.budget.chars, 0);
  assert.equal(result.budget.truncated, true);
  assert.equal(result.budget.items_shown, 0);
});

test("capItems keeps whole items even when an item spans several lines", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ id: index }));
  const render = (item: { id: number }): string => `- item ${String(item.id)}\n  detail`;
  const maxChars = 200;
  const result = capItems(items, render, maxChars);

  assertWithinCap(result.budget, result.text, maxChars);
  assert.equal(result.budget.truncated, true);
  assert.equal(result.budget.items_total, 40);
  const rendered = result.text.split("\n");
  const shown = rendered.slice(0, result.budget.items_shown * 2);
  assert.equal(shown.length % 2, 0, "an item is never cut in half");
  for (let index = 0; index < shown.length; index += 2) {
    assert.match(shown[index] ?? "", /^- item \d+$/u);
    assert.equal(shown[index + 1], "  detail");
  }
});

test("capItems on an empty list is an empty budget, not a truncated one", () => {
  const result = capItems([], () => "", 100);
  assert.equal(result.text, "");
  assert.deepEqual(result.budget, emptyBudget());
});
