import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_LOADER_FILENAMES } from "../src/loaders/index.js";
import {
  createPreferenceLedger,
  derivePreferenceStatus,
  listPreferences,
  logPreference,
  PREFERENCE_MIRROR_BEGIN_MARKER,
  PREFERENCE_MIRROR_END_MARKER,
  renderPreferenceCore,
  syncPreferenceMirrorContent,
  syncPreferenceMirrors,
  validatePreferenceLedger,
  type Preference,
} from "../src/prefs/index.js";

function preference(
  id: string,
  overrides: Partial<Preference> = {},
): Preference {
  return {
    id,
    weight: 3,
    status: "active",
    domains: ["workflow"],
    statement: `Use ${id}.`,
    why: "Synthetic test preference.",
    apply: `Apply ${id}.`,
    origin: "2026-07-01",
    last_seen: "2026-07-01",
    evidence: [],
    core: false,
    ...overrides,
  };
}

function occurrences(content: string, text: string): number {
  return content.split(text).length - 1;
}

test("Hermes validates the public v3 ledger and surfaces coherent warnings", () => {
  const valid = createPreferenceLedger([
    preference("clear-output", { core: true, weight: 5, status: "law" }),
  ]);
  const validPreference = valid.preferences[0];
  assert.ok(validPreference);
  assert.deepEqual(validatePreferenceLedger(valid), {
    valid: true,
    errors: [],
    warnings: [],
  });

  const invalid = {
    schema_version: 2,
    preferences: [
      {
        ...validPreference,
        id: "Not a valid id",
        evidence: [{ date: "not-a-date", weight_set: 8, signal: "" }],
      },
    ],
  };
  const invalidResult = validatePreferenceLedger(invalid);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.errors.length >= 3, true);

  const warningResult = validatePreferenceLedger(
    createPreferenceLedger([
      preference("weak-core", {
        core: true,
        weight: 1,
        status: "proposed",
      }),
    ]),
  );
  assert.equal(warningResult.valid, true);
  assert.equal(warningResult.warnings.some((warning) => warning.includes("low weight")), true);
});

test("Hermes lists deterministically and appends evidence without mutating history", () => {
  const ledger = createPreferenceLedger([
    preference("zeta", { weight: 3, last_seen: "2026-01-01" }),
    preference("alpha", { weight: 5, status: "law", last_seen: "2026-07-01" }),
    preference("retired", { weight: 4, status: "retired" }),
  ]);

  assert.deepEqual(
    listPreferences(ledger).map((item) => item.id),
    ["alpha", "retired", "zeta"],
  );
  assert.deepEqual(
    listPreferences(ledger, {
      staleDays: 90,
      today: new Date("2026-07-09T00:00:00.000Z"),
    }).map((item) => item.id),
    ["zeta"],
  );

  const logged = logPreference(
    ledger,
    "zeta",
    {
      signal: "explicit confirmation",
      date: "2026-07-09",
      weight: 5,
    },
  );
  const originalZeta = ledger.preferences.find((item) => item.id === "zeta");
  const loggedZeta = logged.preferences.find((item) => item.id === "zeta");
  assert.ok(originalZeta);
  assert.ok(loggedZeta);
  assert.equal(originalZeta.evidence.length, 0);
  assert.equal(loggedZeta.evidence.length, 1);
  assert.equal(loggedZeta.status, "law");
  assert.equal(loggedZeta.last_seen, "2026-07-09");
  assert.equal(derivePreferenceStatus(5), "law");
  assert.equal(derivePreferenceStatus(4), "active");
  assert.equal(derivePreferenceStatus(2), "proposed");
  assert.equal(derivePreferenceStatus(5, "retired"), "retired");
});

test("core rendering is deterministic and excludes retired or non-core preferences", () => {
  const first = createPreferenceLedger([
    preference("zeta-core", { core: true, weight: 4 }),
    preference("alpha-core", { core: true, weight: 5, status: "law" }),
    preference("retired-core", { core: true, status: "retired", weight: 5 }),
    preference("scoped-only", { core: false, weight: 5, status: "law" }),
  ]);
  const second = createPreferenceLedger([...first.preferences].reverse());
  const rendered = renderPreferenceCore(first);

  assert.equal(rendered, renderPreferenceCore(second));
  assert.equal(rendered.includes("alpha-core"), true);
  assert.equal(rendered.includes("zeta-core"), true);
  assert.equal(rendered.includes("retired-core"), false);
  assert.equal(rendered.includes("scoped-only"), false);
  assert.equal(rendered.indexOf("alpha-core") < rendered.indexOf("zeta-core"), true);
});

test("preference mirror is marker-safe, idempotent, and preserves other loader sections", () => {
  const ledger = createPreferenceLedger([
    preference("clear-output", { core: true, weight: 5, status: "law" }),
  ]);
  const original = [
    "# User loader text",
    "<!-- openbrain:begin -->",
    "Free Mode content stays untouched.",
    "<!-- openbrain:end -->",
    PREFERENCE_MIRROR_BEGIN_MARKER,
    "Stale preference mirror.",
    PREFERENCE_MIRROR_END_MARKER,
    "# User footer",
  ].join("\n");

  const once = syncPreferenceMirrorContent(original, ledger);
  const twice = syncPreferenceMirrorContent(once, ledger);

  assert.equal(once, twice);
  assert.equal(once.includes("# User loader text"), true);
  assert.equal(once.includes("Free Mode content stays untouched."), true);
  assert.equal(once.includes("# User footer"), true);
  assert.equal(once.includes("Stale preference mirror."), false);
  assert.equal(occurrences(once, PREFERENCE_MIRROR_BEGIN_MARKER), 1);
  assert.equal(occurrences(once, PREFERENCE_MIRROR_END_MARKER), 1);
});

test("preference mirror synchronises all portable loader files without repeat writes", async (t) => {
  const vaultRoot = await mkdtemp(join(tmpdir(), "open-brain-prefs-"));
  t.after(async () => rm(vaultRoot, { recursive: true, force: true }));

  const ledger = createPreferenceLedger([
    preference("clear-output", { core: true, weight: 5, status: "law" }),
  ]);
  await Promise.all(
    DEFAULT_LOADER_FILENAMES.map((filename) =>
      writeFile(join(vaultRoot, filename), "User-authored loader text.\n", "utf8"),
    ),
  );

  const first = await syncPreferenceMirrors(vaultRoot, ledger);
  assert.equal(first.every((result) => result.changed), true);
  const second = await syncPreferenceMirrors(vaultRoot, ledger);
  assert.equal(second.every((result) => !result.changed), true);

  for (const filename of DEFAULT_LOADER_FILENAMES) {
    const content = await readFile(join(vaultRoot, filename), "utf8");
    assert.equal(content.includes("User-authored loader text."), true);
    assert.equal(content.includes("clear-output"), true);
  }
});
