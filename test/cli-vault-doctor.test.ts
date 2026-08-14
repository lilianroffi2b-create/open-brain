import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PREFERENCE_LEDGER_RELATIVE_PATH } from "../src/prefs/index.js";
import { doctorVault, initVault } from "../src/cli/vault.js";

/**
 * doctor is the second of the three layers that make "detected, not
 * impossible" true for the preference kernel: the guard stops what it can
 * see, doctor detects what already exists, redline detects the write. These
 * tests cover the three checks the CLI wiring lot added to doctor's report:
 * the redline verdict, capability configuration issues, and symlink aliases
 * into the kernel.
 */

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-doctor-"));
  await initVault(root, { noGit: true });
  return root;
}

test("doctor reports a clean, untampered, alias-free vault", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await doctorVault(root);
  assert.equal(result.redline.tampered, false);
  assert.deepEqual(result.capabilityIssues, []);
  assert.deepEqual(result.preferenceKernelAliases, []);
});

test("doctor detects a symlink elsewhere in the vault that resolves to the ledger", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "20_contexts"), { recursive: true });
  const aliasPath = join(root, "20_contexts", "alias.json");
  await symlink(join(root, PREFERENCE_LEDGER_RELATIVE_PATH), aliasPath);

  const result = await doctorVault(root);
  assert.deepEqual(result.preferenceKernelAliases, ["20_contexts/alias.json"]);
});

test("doctor never flags a symlink that points somewhere ordinary", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "20_contexts"), { recursive: true });
  const ordinary = join(root, "20_contexts", "note.md");
  await writeFile(ordinary, "# Not the kernel\n", "utf8");
  await symlink(ordinary, join(root, "20_contexts", "alias.md"));

  const result = await doctorVault(root);
  assert.deepEqual(result.preferenceKernelAliases, []);
});

test("doctor surfaces a capability configuration issue without blocking anything", async (t) => {
  const root = await newVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    [
      "version: 1",
      "capabilities:",
      "  hooks:",
      "    enabled: true",
      "    targets: []",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await doctorVault(root);
  assert.equal(result.capabilityIssues.length, 1);
  assert.match(result.capabilityIssues[0] ?? "", /hooks is enabled but capabilities\.hooks\.targets is empty/u);
});
