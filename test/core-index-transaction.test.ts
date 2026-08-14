import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalog } from "../src/core/catalog.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { atomicWriteSet } from "../src/core/fs-atomic.js";
import {
  canonicalJson,
  planIndexArtifacts,
  writeIndexArtifacts,
  SCAN_LOCK_NAME,
} from "../src/core/index-writer.js";
import { lockPathFor } from "../src/core/lock.js";
import { runVaultScan, scanVault } from "../src/core/scan.js";
import { sha256 } from "../src/core/text.js";
import type { CatalogRecord, VaultConfig } from "../src/core/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const scanModuleUrl = new URL("../src/core/scan.ts", import.meta.url).href;
const configModuleUrl = new URL("../src/core/config.ts", import.meta.url).href;

// Two scans in one process share the in-memory lock registry, so serialisation
// is only proven by separate operating system processes racing for the vault.
const CHILD_SCAN_SCRIPT = `
import { appendFile } from "node:fs/promises";
import { runVaultScan } from ${JSON.stringify(scanModuleUrl)};
import { DEFAULT_CONFIG } from ${JSON.stringify(configModuleUrl)};

const options = JSON.parse(process.argv[2]);
const config = { ...structuredClone(DEFAULT_CONFIG), root_label: "RaceVault" };

try {
  await runVaultScan(options.root, config, {
    now: new Date(options.now),
    gitTimes: new Map(),
    lock: { timeoutMs: 20000 },
  });
  process.exit(0);
} catch (error) {
  await appendFile(options.tracePath, "error " + String(error) + "\\n", "utf8");
  process.exit(3);
}
`;

function shardingConfig(): VaultConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.root_label = "TransactionVault";
  config.paliers.p1_max = 2;
  config.paliers.shard_from = "P2";
  return config;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function temporaryFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await temporaryFiles(path));
    } else if (entry.name.endsWith(".tmp")) {
      found.push(path);
    }
  }
  return found;
}

function runChild(scriptPath: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, JSON.stringify(payload)],
      { cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? -1);
    });
  });
}

async function seed(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

test("the freshness manifest is the last file of the published set", async (t) => {
  const config = shardingConfig();
  const root = await mkdtemp(join(tmpdir(), "open-brain-index-plan-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seed(root, {
    "10_memory/alpha.md": "# Alpha\n",
    "10_memory/beta.md": "# Beta\n",
    "20_contexts/gamma.md": "# Gamma\n",
  });

  const now = new Date("2026-04-01T00:00:00.000Z");
  const scan = await scanVault(root, config, { now, gitTimes: new Map() });
  const plan = await planIndexArtifacts(root, config, scan, { now });

  const last = plan.entries.at(-1);
  assert.ok(last);
  assert.equal(
    last.path,
    join(root, config.paths.freshness),
    "freshness.json is the commit point and must be renamed last",
  );
  const paths = plan.entries.map((entry) => entry.path);
  assert.ok(paths.includes(join(root, config.paths.catalog)));
  assert.ok(paths.includes(join(root, config.paths.graph)));
  assert.ok(paths.includes(join(root, config.paths.catalog_index)));
  assert.ok(paths.includes(join(root, config.paths.catalog_shards, "10_memory.json")));
});

test("a crash between publication and pruning leaves a complete index, never an amputated one", async (t) => {
  const config = shardingConfig();
  const root = await mkdtemp(join(tmpdir(), "open-brain-index-crash-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seed(root, {
    "10_memory/alpha.md": "# Alpha\n",
    "10_memory/beta.md": "# Beta\n",
    "20_contexts/gamma.md": "# Gamma\n",
  });

  const first = new Date("2026-04-01T00:00:00.000Z");
  await writeIndexArtifacts(
    root,
    config,
    await scanVault(root, config, { now: first, gitTimes: new Map() }),
    { now: first, writeDelta: false },
  );
  const memoryShard = join(root, config.paths.catalog_shards, "10_memory.json");
  const contextShard = join(root, config.paths.catalog_shards, "20_contexts.json");
  assert.equal(await fileExists(contextShard), true);

  // The context layer disappears, so its shard becomes obsolete.
  await unlink(join(root, "20_contexts", "gamma.md"));
  await writeFile(join(root, "10_memory", "delta.md"), "# Delta\n", "utf8");

  const second = new Date("2026-04-02T00:00:00.000Z");
  const scan = await scanVault(root, config, { now: second, gitTimes: new Map() });
  const plan = await planIndexArtifacts(root, config, scan, { now: second, writeDelta: false });
  assert.deepEqual(plan.removals, [contextShard], "the obsolete shard is planned for removal");

  // Simulate the crash: publish the set, then stop before anything is pruned.
  await atomicWriteSet(plan.entries);

  assert.equal(
    await fileExists(contextShard),
    true,
    "the obsolete shard is still there: publication happens before removal, never the reverse",
  );
  assert.equal(await fileExists(memoryShard), true);
  const catalog = JSON.parse(await readFile(join(root, config.paths.catalog), "utf8")) as {
    records: CatalogRecord[];
  };
  const freshness = JSON.parse(await readFile(join(root, config.paths.freshness), "utf8")) as {
    catalog_sha256: string;
  };
  JSON.parse(await readFile(join(root, config.paths.graph), "utf8"));
  const index = JSON.parse(await readFile(join(root, config.paths.catalog_index), "utf8")) as {
    shards: Record<string, unknown>;
  };

  assert.equal(freshness.catalog_sha256, sha256(canonicalJson(catalog.records)));
  assert.deepEqual(Object.keys(index.shards), ["10_memory"]);
  // The index is complete: everything the index references exists on disk.
  const scoped = await loadCatalog(root, config, ["10_memory"]);
  assert.deepEqual(
    scoped.map((record) => record.path).sort(),
    [
      "TransactionVault/10_memory/alpha.md",
      "TransactionVault/10_memory/beta.md",
      "TransactionVault/10_memory/delta.md",
    ],
  );
  assert.deepEqual(await temporaryFiles(root), []);

  // Completing the same write prunes what the publication made obsolete.
  await writeIndexArtifacts(root, config, scan, { now: second, writeDelta: false });
  assert.equal(await fileExists(contextShard), false);
  assert.deepEqual(await temporaryFiles(root), []);
});

test("delta rotation only removes older notes once the new one is published", async (t) => {
  const config = shardingConfig();
  config.deltas.retention = 2;
  const root = await mkdtemp(join(tmpdir(), "open-brain-delta-order-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seed(root, { "10_memory/alpha.md": "# Alpha\n" });

  const firstStamp = new Date("2026-03-01T00:00:01.001Z");
  const stamps = [
    firstStamp,
    new Date("2026-03-01T00:00:02.002Z"),
    new Date("2026-03-01T00:00:03.003Z"),
  ];
  const scan = await scanVault(root, config, {
    now: firstStamp,
    gitTimes: new Map(),
  });

  for (const now of stamps) {
    const plan = await planIndexArtifacts(root, config, scan, { now });
    const published = plan.entries.map((entry) => entry.path);
    for (const removal of plan.removals) {
      assert.ok(
        !published.includes(removal),
        "a path that is being republished is never scheduled for removal",
      );
    }
    await writeIndexArtifacts(root, config, scan, { now });
  }

  const notes = (await readdir(join(root, config.paths.deltas))).sort();
  assert.equal(notes.length, 2, `retention keeps two notes, found ${notes.join(", ")}`);
});

test("two real processes scanning the same vault never interleave and leave a coherent index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-scan-race-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seed(root, {
    "10_memory/alpha.md": "# Alpha\n",
    "10_memory/beta.md": "# Beta\n",
    "20_contexts/gamma.md": "# Gamma\n",
  });
  const config = { ...structuredClone(DEFAULT_CONFIG), root_label: "RaceVault" };
  const scriptPath = join(root, "scanner.mjs");
  const tracePath = join(root, "trace.log");
  await writeFile(scriptPath, CHILD_SCAN_SCRIPT, "utf8");

  const codes = await Promise.all([
    runChild(scriptPath, { root, tracePath, now: "2026-05-01T00:00:00.000Z" }),
    runChild(scriptPath, { root, tracePath, now: "2026-05-01T00:00:01.000Z" }),
  ]);
  assert.deepEqual(codes, [0, 0]);

  const catalog = JSON.parse(await readFile(join(root, config.paths.catalog), "utf8")) as {
    records: CatalogRecord[];
  };
  const freshness = JSON.parse(await readFile(join(root, config.paths.freshness), "utf8")) as {
    catalog_sha256: string;
    source_count: number;
  };
  JSON.parse(await readFile(join(root, config.paths.graph), "utf8"));

  assert.equal(
    freshness.catalog_sha256,
    sha256(canonicalJson(catalog.records)),
    "the manifest must describe the catalog that is actually on disk",
  );
  assert.equal(freshness.source_count, catalog.records.length);
  assert.deepEqual(await temporaryFiles(root), []);
  // Each scan published its own delta note: neither run was lost.
  const notes = await readdir(join(root, config.paths.deltas));
  assert.equal(notes.length, 2, `expected one note per scan, found ${notes.join(", ")}`);
  // The lock is released, so its file is gone once both processes are done.
  assert.equal(await fileExists(lockPathFor(root, SCAN_LOCK_NAME)), false);
});
