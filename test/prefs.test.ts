import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_LOADER_FILENAMES } from "../src/loaders/index.js";
import {
  addPreference,
  createPreferenceLedger,
  derivePreferenceStatus,
  effectiveCore,
  getCorePreferences,
  listPreferences,
  logPreference,
  PREFERENCE_MIRROR_BEGIN_MARKER,
  PREFERENCE_MIRROR_END_MARKER,
  renderPreferenceCore,
  shouldAutoRegen,
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

test("effective core follows the explicit flag, then falls back to weight", () => {
  assert.equal(effectiveCore({ weight: 5 }), true);
  assert.equal(effectiveCore({ weight: 4 }), true);
  assert.equal(effectiveCore({ weight: 3 }), false);
  assert.equal(effectiveCore({ core: true, weight: 1 }), true);
  assert.equal(effectiveCore({ core: false, weight: 5 }), false);
});

test("shouldAutoRegen fires for core-effective or high-weight preferences", () => {
  assert.equal(shouldAutoRegen({ weight: 4 }), true);
  assert.equal(shouldAutoRegen({ weight: 3 }), false);
  assert.equal(shouldAutoRegen({ core: true, weight: 2 }), true);
  assert.equal(shouldAutoRegen({ core: false, weight: 5 }), true);
  assert.equal(shouldAutoRegen({ core: false, weight: 3 }), false);
});

test("addPreference builds a valid preference from minimal input and rejects duplicates", () => {
  const empty = createPreferenceLedger([]);
  const withOne = addPreference(
    empty,
    { id: "concise-answers", text: "Answer briefly.", weight: 4 },
    new Date("2026-07-09T00:00:00.000Z"),
  );

  assert.equal(validatePreferenceLedger(withOne).valid, true);
  const added = withOne.preferences[0];
  assert.ok(added);
  assert.equal(added.id, "concise-answers");
  assert.equal(added.statement, "Answer briefly.");
  assert.equal(added.apply, "Answer briefly.");
  assert.equal(added.status, "active");
  assert.equal(added.origin, "2026-07-09");
  assert.equal(added.last_seen, "2026-07-09");
  assert.equal(added.core, undefined);
  assert.equal(effectiveCore(added), true);
  assert.deepEqual(added.evidence, []);

  const withTwo = addPreference(withOne, {
    id: "ask-first",
    text: "Ask before destructive actions.",
    weight: 5,
    status: "law",
    date: "2026-01-02",
    core: true,
  });
  const second = withTwo.preferences[1];
  assert.ok(second);
  assert.equal(second.status, "law");
  assert.equal(second.last_seen, "2026-01-02");
  assert.equal(second.core, true);

  assert.throws(
    () => addPreference(withOne, { id: "concise-answers", text: "x", weight: 2 }),
    /already exists/,
  );
  assert.throws(
    () => addPreference(empty, { id: "Not Valid", text: "x", weight: 2 }),
    /kebab-case/,
  );
});

test("logging never overwrites an explicit core flag (parity F6)", () => {
  const ledger = createPreferenceLedger([
    preference("stays-false", { core: false, weight: 3 }),
    preference("stays-true", { core: true, weight: 3 }),
  ]);

  const bumped = logPreference(ledger, "stays-false", {
    signal: "reinforced",
    weight: 5,
  });
  const staysFalse = bumped.preferences.find((item) => item.id === "stays-false");
  assert.ok(staysFalse);
  assert.equal(staysFalse.weight, 5);
  assert.equal(staysFalse.status, "law");
  assert.equal(staysFalse.core, false);
  assert.equal(effectiveCore(staysFalse), false);
  assert.equal(shouldAutoRegen(staysFalse), true);

  const raised = logPreference(ledger, "stays-true", { signal: "reinforced", weight: 5 });
  const staysTrue = raised.preferences.find((item) => item.id === "stays-true");
  assert.ok(staysTrue);
  assert.equal(staysTrue.core, true);
});

test("core defaults to weight when the flag is absent", () => {
  const ledger = createPreferenceLedger([
    {
      id: "no-flag",
      weight: 5,
      status: "law",
      domains: ["workflow"],
      statement: "High weight, no explicit core.",
      why: "Test preference.",
      apply: "Apply it.",
      origin: "2026-07-01",
      last_seen: "2026-07-01",
      evidence: [],
    },
  ]);

  assert.equal(getCorePreferences(ledger).length, 1);
  assert.equal(renderPreferenceCore(ledger).includes("no-flag"), true);
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
