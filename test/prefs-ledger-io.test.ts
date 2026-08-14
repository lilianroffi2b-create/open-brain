import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExpectedError } from "../src/core/errors.js";
import {
  createPreferenceLedger,
  loadPreferenceLedger,
  PreferenceLedgerMissingError,
  PreferenceLedgerUnreadableError,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  savePreferenceLedger,
  type Preference,
} from "../src/prefs/index.js";

/**
 * Reading the kernel, and saying what is wrong with it when it cannot be read.
 *
 * Every case here used to arrive at the caller as the same thing: a raw crash
 * with no filename, or an absence that was not one. The distinction the tests
 * insist on is the one a person needs, present and unusable versus not there,
 * because the repair is the opposite in each case.
 */

function preference(id: string): Preference {
  return {
    id,
    weight: 4,
    status: "active",
    domains: ["workflow"],
    statement: `Use ${id}.`,
    why: "Synthetic test preference.",
    apply: `Apply ${id}.`,
    origin: "2026-07-01",
    last_seen: "2026-07-01",
    evidence: [],
  };
}

async function seedVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-ledger-io-"));
  await mkdir(join(root, "10_memory", "preferences"), { recursive: true });
  await savePreferenceLedger(root, createPreferenceLedger([preference("first-rule")]), {
    command: "test seed",
  });
  return root;
}

function ledgerPath(root: string): string {
  return join(root, PREFERENCE_LEDGER_RELATIVE_PATH);
}

test("a byte order mark is read, not fatal: it is what Windows editors write", async (t) => {
  const root = await seedVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const text = await readFile(ledgerPath(root), "utf8");
  await writeFile(ledgerPath(root), `﻿${text}`, "utf8");

  const ledger = await loadPreferenceLedger(root);
  assert.equal(ledger.preferences[0]?.id, "first-rule");
});

test("a kernel that is there and unusable is never reported as one that is absent", async (t) => {
  const cases: [string, (root: string) => Promise<void>, RegExp][] = [
    ["an empty file", async (root) => writeFile(ledgerPath(root), "", "utf8"), /is empty/u],
    [
      "a truncated write",
      async (root) => {
        const text = await readFile(ledgerPath(root), "utf8");
        await writeFile(ledgerPath(root), text.slice(0, Math.floor(text.length / 2)), "utf8");
      },
      /is not valid JSON/u,
    ],
    [
      "bytes that are not text at all",
      async (root) => writeFile(ledgerPath(root), Buffer.from([0x7b, 0x00, 0x7d])),
      /is not text/u,
    ],
    [
      "a directory where the file belongs",
      async (root) => {
        await rm(ledgerPath(root));
        await mkdir(ledgerPath(root));
      },
      /is a directory/u,
    ],
    [
      "content that is not a ledger",
      async (root) => writeFile(ledgerPath(root), JSON.stringify({ schema_version: 3 }), "utf8"),
      /Invalid preference ledger/u,
    ],
  ];

  for (const [label, breakIt, expected] of cases) {
    const root = await seedVault();
    t.after(async () => rm(root, { recursive: true, force: true }));
    await breakIt(root);

    await assert.rejects(
      () => loadPreferenceLedger(root),
      (error: unknown) => {
        assert.ok(error instanceof PreferenceLedgerUnreadableError, `${label}: ${String(error)}`);
        assert.ok(error instanceof ExpectedError, `${label} must print as one clean line`);
        assert.match(error.message, expected, label);
        // The two things a stack trace never said: which file, and what to do.
        assert.match(error.message, /_ledger\.json/u, `${label} must name the file`);
        assert.match(error.message, /Repair or restore that file/u, `${label} must say what to do`);
        return true;
      },
    );
  }
});

test("a ledger that is not there says so, and says how to make one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-ledger-io-absent-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => loadPreferenceLedger(root),
    (error: unknown) => error instanceof PreferenceLedgerMissingError
      && error instanceof ExpectedError
      && /No preference ledger at/u.test(error.message)
      && /prefs add/u.test(error.message),
  );
});
