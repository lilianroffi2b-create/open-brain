import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_NAMES,
  capabilityIssues,
  capabilityParent,
  describeCapability,
  isCapabilityName,
  isEnabled,
  requireCapability,
  type CapabilityName,
} from "../src/core/capabilities.js";
import { DEFAULT_CONFIG, loadConfig, loadConfigResult } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import type { VaultConfig } from "../src/core/types.js";

const templateConfigPath = fileURLToPath(
  new URL("../templates/vault/00_index/vault.config.yml", import.meta.url),
);
const EM_DASH = String.fromCodePoint(0x2014);

async function vaultWithConfig(prefix: string, yaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), yaml, "utf8");
  return root;
}

function assertEverythingDisarmed(config: VaultConfig, context: string): void {
  for (const name of CAPABILITY_NAMES) {
    assert.equal(isEnabled(config, name), false, `${name} should be disarmed ${context}`);
  }
}

test("invariants I2 and I3: a default vault has every capability disarmed", async (t) => {
  // I2, a default vault never triggers a model call and therefore never costs
  // anything. I3, a default vault never reads a byte outside its own directory.
  // Both hold only if every capability that could do either ships disarmed.
  assertEverythingDisarmed(DEFAULT_CONFIG, "in DEFAULT_CONFIG");
  assert.equal(DEFAULT_CONFIG.capabilities.classifier.provider, "none");
  assert.deepEqual(DEFAULT_CONFIG.capabilities.transcripts.roots, []);
  assert.equal(DEFAULT_CONFIG.capabilities.transcripts.redact, true);

  const empty = await mkdtemp(join(tmpdir(), "open-brain-capabilities-empty-"));
  t.after(async () => rm(empty, { recursive: true, force: true }));
  assertEverythingDisarmed(await loadConfig(empty), "in a vault with no config file");

  // The file a new vault actually receives, not just the in-memory default.
  const fresh = await vaultWithConfig(
    "open-brain-capabilities-template-",
    await readFile(templateConfigPath, "utf8"),
  );
  t.after(async () => rm(fresh, { recursive: true, force: true }));
  const shipped = await loadConfig(fresh);
  assertEverythingDisarmed(shipped, "in a freshly created vault");
  assert.equal(shipped.capabilities.classifier.provider, "none");
  assert.deepEqual(shipped.capabilities.transcripts.roots, []);
  assert.deepEqual(shipped.capabilities.hooks.targets, []);
});

test("a config written before capabilities existed loads without error", async (t) => {
  const legacy = await vaultWithConfig(
    "open-brain-capabilities-legacy-",
    "version: 1\nroot_label: Legacy\npaths:\n  memory: 10_memory\n",
  );
  t.after(async () => rm(legacy, { recursive: true, force: true }));

  const result = await loadConfigResult(legacy);
  assert.equal(result.issue, undefined);
  assert.equal(result.config.root_label, "Legacy");
  assertEverythingDisarmed(result.config, "in a config that predates capabilities");
});

test("absent, empty, or malformed capability values read as disarmed", async (t) => {
  const cases: Array<[string, string]> = [
    ["null section", "capabilities:\n"],
    ["scalar section", "capabilities: everything\n"],
    ["string flags", "capabilities:\n  classifier:\n    enabled: \"true\"\n  hooks:\n    enabled: yes-please\n"],
    ["numeric flags", "capabilities:\n  capture:\n    enabled: 1\n  learning:\n    enabled: 1\n"],
    ["unknown capability", "capabilities:\n  telepathy:\n    enabled: true\n"],
  ];

  for (const [label, yaml] of cases) {
    const root = await vaultWithConfig("open-brain-capabilities-malformed-", yaml);
    t.after(async () => rm(root, { recursive: true, force: true }));
    const result = await loadConfigResult(root);
    assert.equal(result.issue, undefined, `${label} should not be a load issue`);
    assertEverythingDisarmed(result.config, `for ${label}`);
  }

  const partial = await vaultWithConfig(
    "open-brain-capabilities-partial-",
    "capabilities:\n  transcripts:\n    enabled: true\n    roots:\n      - /somewhere/transcripts\n",
  );
  t.after(async () => rm(partial, { recursive: true, force: true }));
  const config = await loadConfig(partial);
  // Arming one capability arms exactly one capability.
  assert.equal(isEnabled(config, "transcripts"), true);
  assert.equal(config.capabilities.transcripts.redact, true);
  for (const name of CAPABILITY_NAMES.filter((item) => item !== "transcripts")) {
    assert.equal(isEnabled(config, name), false, `${name} should stay disarmed`);
  }
});

test("a child armed without its parent is disarmed at runtime and reported", async (t) => {
  const orphan = await vaultWithConfig(
    "open-brain-capabilities-orphan-",
    "capabilities:\n  learning:\n    enabled: false\n    evaluate: true\n    consolidate: true\n",
  );
  t.after(async () => rm(orphan, { recursive: true, force: true }));
  const config = await loadConfig(orphan);

  assert.equal(isEnabled(config, "learning"), false);
  assert.equal(isEnabled(config, "learning.evaluate"), false);
  assert.equal(isEnabled(config, "learning.consolidate"), false);

  const issues = capabilityIssues(config);
  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.startsWith("learning.evaluate is enabled")));
  assert.ok(issues.some((issue) => issue.startsWith("learning.consolidate is enabled")));
  for (const issue of issues) {
    assert.match(issue, /parent capability learning is disabled/u);
  }

  const armed = await vaultWithConfig(
    "open-brain-capabilities-armed-",
    "capabilities:\n  learning:\n    enabled: true\n    evaluate: true\n",
  );
  t.after(async () => rm(armed, { recursive: true, force: true }));
  const armedConfig = await loadConfig(armed);
  assert.equal(isEnabled(armedConfig, "learning.evaluate"), true);
  assert.equal(isEnabled(armedConfig, "learning.consolidate"), false);
  assert.deepEqual(capabilityIssues(armedConfig), []);
});

test("capabilityIssues reports a capability that is armed but cannot do anything", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.capabilities.hooks.enabled = true;
  config.capabilities.transcripts.enabled = true;
  config.capabilities.classifier.enabled = true;

  const issues = capabilityIssues(config);
  assert.equal(issues.length, 3);
  assert.ok(issues.some((issue) => issue.includes("capabilities.hooks.targets is empty")));
  assert.ok(issues.some((issue) => issue.includes("capabilities.transcripts.roots is empty")));
  assert.ok(issues.some((issue) => issue.includes("capabilities.classifier.provider is none")));
});

test("requireCapability explains the refusal and gives the exact command", () => {
  for (const name of CAPABILITY_NAMES) {
    assert.throws(
      () => {
        requireCapability(DEFAULT_CONFIG, name);
      },
      (error: unknown) => {
        assert.ok(error instanceof ExpectedError, `${name} should raise ExpectedError`);
        assert.ok(
          error.message.includes(`open-brain capabilities enable ${name}`),
          `${name} should name its own enable command, got: ${error.message}`,
        );
        assert.ok(
          error.message.includes(`Capability ${name} is disabled`),
          `${name} should name itself, got: ${error.message}`,
        );
        return true;
      },
    );
  }

  const orphan = structuredClone(DEFAULT_CONFIG);
  orphan.capabilities.learning.consolidate = true;
  assert.throws(
    () => {
      requireCapability(orphan, "learning.consolidate");
    },
    (error: unknown) => {
      assert.ok(error instanceof ExpectedError);
      assert.match(error.message, /parent capability learning/u);
      assert.ok(error.message.includes("open-brain capabilities enable learning"));
      return true;
    },
  );

  const armed = structuredClone(DEFAULT_CONFIG);
  armed.capabilities.learning.enabled = true;
  requireCapability(armed, "learning");
});

test("describeCapability returns real content for every capability", () => {
  assert.deepEqual([...CAPABILITY_NAMES], [
    "hooks",
    "capture",
    "transcripts",
    "classifier",
    "learning",
    "learning.evaluate",
    "learning.consolidate",
  ]);
  assert.equal(isCapabilityName("learning.evaluate"), true);
  assert.equal(isCapabilityName("learning.enabled"), false);

  for (const name of CAPABILITY_NAMES) {
    const description = describeCapability(name);
    assert.equal(description.name, name);
    assert.equal(description.parent, capabilityParent(name));
    const fields: Array<[string, string]> = [
      ["title", description.title],
      ["whatItDoes", description.whatItDoes],
      ["whatItReads", description.whatItReads],
      ["whatItWrites", description.whatItWrites],
      ["whatItCosts", description.whatItCosts],
      ["howToDisable", description.howToDisable],
      ["riskIfEnabled", description.riskIfEnabled],
    ];
    for (const [field, text] of fields) {
      assert.ok(text.trim().length > 20, `${name}.${field} should say something real`);
      assert.ok(!text.includes(EM_DASH), `${name}.${field} must not contain an em dash`);
    }
    assert.ok(
      description.howToDisable.includes(`open-brain capabilities disable ${name}`),
      `${name} should say exactly how to turn it off`,
    );
  }

  const parents: Array<[CapabilityName, CapabilityName | undefined]> = [
    ["learning.evaluate", "learning"],
    ["learning.consolidate", "learning"],
    ["learning", undefined],
    ["hooks", undefined],
  ];
  for (const [name, parent] of parents) {
    assert.equal(capabilityParent(name), parent);
  }

  // The costly one says so, and the free ones do not pretend otherwise.
  assert.match(describeCapability("classifier").whatItCosts, /Money/u);
  assert.match(describeCapability("hooks").whatItCosts, /^Nothing\./u);
  assert.match(describeCapability("learning").whatItCosts, /^Nothing\./u);
  assert.match(describeCapability("transcripts").whatItReads, /OUTSIDE this vault/u);
  assert.match(describeCapability("learning.consolidate").riskIfEnabled, /git/u);
});
