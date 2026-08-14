import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initVault } from "../src/cli/vault.js";
import { loadConfig } from "../src/core/config.js";
import { checkVaultHealth } from "../src/core/health.js";
import { runVaultScan } from "../src/core/scan.js";
import { PREFERENCE_LEDGER_RELATIVE_PATH } from "../src/prefs/io.js";

/**
 * `health` is the command whose name promises the vault is sound. It has to
 * look at the preference kernel, not just the catalog: a vault with a
 * corrupted ledger is not healthy, even though `doctor` and `prefs validate`
 * already catch the same corruption from a different command.
 */

async function newHealthyVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-health-"));
  await initVault(root, { noGit: true });
  const config = await loadConfig(root);
  await runVaultScan(root, config);
  return root;
}

test("health reports the preference kernel as ok on a freshly initialized vault", async (t) => {
  const root = await newHealthyVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const config = await loadConfig(root);
  const report = await checkVaultHealth(root, config);
  const preferencesCheck = report.checks.find((check) => check.name === "preferences");
  assert.equal(preferencesCheck?.severity, "ok");
  assert.equal(report.healthy, true);
});

test("health stops calling a vault healthy when the preference ledger is corrupted", async (t) => {
  const root = await newHealthyVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeFile(
    join(root, PREFERENCE_LEDGER_RELATIVE_PATH),
    JSON.stringify({ schema_version: 3, preferences: [{ id: "bad" }] }),
    "utf8",
  );

  const config = await loadConfig(root);
  const report = await checkVaultHealth(root, config);
  const preferencesCheck = report.checks.find((check) => check.name === "preferences");
  assert.equal(preferencesCheck?.severity, "error");
  assert.match(preferencesCheck?.detail ?? "", /Preference ledger is invalid/u);
  assert.equal(report.healthy, false);
});

test("health stops calling a vault healthy when the preference ledger is missing", async (t) => {
  const root = await newHealthyVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  await rm(join(root, PREFERENCE_LEDGER_RELATIVE_PATH));

  const config = await loadConfig(root);
  const report = await checkVaultHealth(root, config);
  const preferencesCheck = report.checks.find((check) => check.name === "preferences");
  assert.equal(preferencesCheck?.severity, "error");
  assert.equal(report.healthy, false);
});
