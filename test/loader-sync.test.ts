import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_LOADER_FILENAMES,
  OPENBRAIN_LOADER_BEGIN_MARKER,
  OPENBRAIN_LOADER_END_MARKER,
  renderFreeModeLoaderBlock,
  syncLoaderContent,
  syncLoadersFromConfig,
} from "../src/loaders/index.js";

function occurrences(content: string, text: string): number {
  return content.split(text).length - 1;
}

test("loader sync preserves outside text, replaces generated content once, and is idempotent", () => {
  const original = [
    "# User-authored heading",
    "Keep this introduction.",
    OPENBRAIN_LOADER_BEGIN_MARKER,
    "Old generated content.",
    OPENBRAIN_LOADER_END_MARKER,
    "Keep this footer.",
  ].join("\n");

  const once = syncLoaderContent(original, "calibrated");
  const twice = syncLoaderContent(once, "calibrated");

  assert.equal(once, twice);
  assert.equal(once.includes("# User-authored heading"), true);
  assert.equal(once.includes("Keep this introduction."), true);
  assert.equal(once.includes("Keep this footer."), true);
  assert.equal(once.includes("Old generated content."), false);
  assert.equal(occurrences(once, OPENBRAIN_LOADER_BEGIN_MARKER), 1);
  assert.equal(occurrences(once, OPENBRAIN_LOADER_END_MARKER), 1);
  assert.equal(once.includes("Free Mode check: A leads to [consequence]."), true);
  assert.equal(once.includes("One optional idea: [idea]."), true);
  assert.equal(once.includes("open-brain free-mode check"), true);
  assert.equal(once.includes("open-brain free-mode dismiss"), true);
  assert.equal(once.includes("open-brain free-mode reset"), true);
  assert.equal(once.includes("at most one material checkpoint per turn"), true);

  const offBlock = syncLoaderContent("", "off");
  assert.equal(offBlock.includes("Free Mode is off."), true);
  assert.equal(offBlock.includes("open-brain free-mode check"), false);

  const inserted = syncLoaderContent("User text without markers.", "off");
  assert.equal(inserted.includes("User text without markers."), true);
  assert.equal(occurrences(inserted, OPENBRAIN_LOADER_BEGIN_MARKER), 1);
  assert.equal(syncLoaderContent(inserted, "off"), inserted);
});

test("loader sync rejects malformed markers instead of overwriting user text", () => {
  assert.throws(
    () => syncLoaderContent(`${OPENBRAIN_LOADER_BEGIN_MARKER}\nUser text`, "off"),
    /malformed/,
  );
  assert.throws(
    () => syncLoaderContent(`${OPENBRAIN_LOADER_END_MARKER}\n${OPENBRAIN_LOADER_BEGIN_MARKER}`, "off"),
    /malformed/,
  );
});

test("loader sync renders all three loaders and reports no changes on a second run", async (t) => {
  const vaultRoot = await mkdtemp(join(tmpdir(), "open-brain-loaders-"));
  t.after(async () => rm(vaultRoot, { recursive: true, force: true }));

  await Promise.all(
    DEFAULT_LOADER_FILENAMES.map((filename) =>
      writeFile(
        join(vaultRoot, filename),
        [
          "Before marker text.",
          OPENBRAIN_LOADER_BEGIN_MARKER,
          "Stale generated block.",
          OPENBRAIN_LOADER_END_MARKER,
          "After marker text.",
        ].join("\n"),
        "utf8",
      ),
    ),
  );

  const first = await syncLoadersFromConfig(vaultRoot, {
    interaction: { free_mode: "calibrated" },
  });
  assert.equal(first.every((result) => result.changed), true);

  for (const filename of DEFAULT_LOADER_FILENAMES) {
    const content = await readFile(join(vaultRoot, filename), "utf8");
    assert.equal(content.includes("Before marker text."), true);
    assert.equal(content.includes("After marker text."), true);
    assert.equal(content.includes("Stale generated block."), false);
    assert.equal(content.includes(renderFreeModeLoaderBlock("calibrated")), true);
  }

  const second = await syncLoadersFromConfig(vaultRoot, {
    interaction: { free_mode: "calibrated" },
  });
  assert.equal(second.every((result) => !result.changed), true);
});
