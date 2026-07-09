import assert from "node:assert/strict";
import test from "node:test";

import {
  UnicodeError,
  countCodePoints,
  decodeText,
  extractHeadings,
  extractLinks,
  normalize,
  tokenize,
} from "../src/core/text.js";
import {
  readExpiresFromText,
  readLifecycleFromText,
  renderFrontmatter,
  splitFrontmatter,
} from "../src/core/frontmatter.js";

test("text extraction is Unicode-safe and preserves useful markdown signals", () => {
  assert.equal(normalize("Café ß"), "cafe ss");
  assert.deepEqual(tokenize("Café plan_v2"), ["cafe", "plan_v2"]);
  assert.equal(countCodePoints("A😀"), 2);
  assert.equal(decodeText(Buffer.from("\uFEFF# Title", "utf8")).text, "# Title");
  assert.equal(
    decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])).text,
    "café",
  );
  assert.throws(() => decodeText(Buffer.from([0x41, 0x00, 0x42])), UnicodeError);
  assert.deepEqual(
    extractHeadings("# One\n## Two\nplain"),
    ["One", "Two"],
  );
  assert.deepEqual(
    extractLinks("[Guide](docs/guide.md) and [[memory/note]]"),
    ["memory/note", "docs/guide.md"],
  );
});

test("frontmatter stays minimal and does not rewrite document prose", () => {
  const text = "---\nlifecycle: ephemeral\nexpires: 2026-02-01\n---\n# Body\n";
  const split = splitFrontmatter(text);

  assert.equal(split.frontmatter?.lifecycle, "ephemeral");
  assert.equal(split.body, "# Body\n");
  assert.equal(readLifecycleFromText(text), "ephemeral");
  assert.equal(readExpiresFromText(text), "2026-02-01");
  assert.equal(
    renderFrontmatter({ lifecycle: "working", owner: "example" }),
    "---\nlifecycle: working\nowner: example\n---\n",
  );
});
