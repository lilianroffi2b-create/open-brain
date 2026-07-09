import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import {
  SkinError,
  applySkin,
  planSkin,
  resolveSkinPreset,
} from "../src/core/skin.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function renderConfig(): string {
  return [
    "version: 1",
    "root_label: ExampleVault",
    "paths:",
    "  index: 00_index",
    "  deltas: 00_index/deltas",
    "  catalog: 00_index/catalog.json",
    "  catalog_shards: 00_index/catalog",
    "  catalog_index: 00_index/catalog/catalog_index.json",
    "  graph: 00_index/graph.json",
    "  freshness: 00_index/freshness.json",
    "  routing: 00_index/routing.yml",
    "  archive: 90_archive",
    "  inbox: 01_inbox",
    "  memory: 10_memory",
    "  contexts: 20_contexts",
    "  skills: 30_skills",
    "  sources: 40_sources",
    "  outputs: 50_outputs",
    "  engine: 70_engine",
    "canonical_dirs:",
    "  - 00_index",
    "  - 01_inbox",
    "  - 10_memory",
    "  - 20_contexts",
    "  - 30_skills",
    "  - 40_sources",
    "  - 50_outputs",
    "  - 70_engine",
    "  - 90_archive",
    "activity:",
    "  active_paths:",
    "    - 20_contexts/current.md",
    "  active_dir_prefixes:",
    "    - 40_sources/",
    "",
  ].join("\n");
}

async function createSyntheticVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-skin-"));
  for (const directory of DEFAULT_CONFIG.canonical_dirs) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    renderConfig(),
    "utf8",
  );
  await writeFile(
    join(root, "AGENTS.md"),
    [
      "User prose: 00_index/routing.yml must remain unchanged here.",
      "<!-- openbrain:begin -->",
      "Managed path: 00_index/routing.yml",
      "<!-- openbrain:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

test("brain skin safely renames configured directories and only managed references", async (t) => {
  const root = await createSyntheticVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await applySkin(root, structuredClone(DEFAULT_CONFIG), "brain");
  const configPath = join(root, "00_map", "vault.config.yml");
  const configText = await readFile(configPath, "utf8");
  const agentsText = await readFile(join(root, "AGENTS.md"), "utf8");
  const reloadedConfig = await loadConfig(root);

  assert.equal(result.mode, "filesystem");
  assert.equal(result.rescan_required, true);
  assert.equal(await exists(join(root, "00_index")), false);
  assert.equal(await exists(join(root, "00_map")), true);
  assert.equal(await exists(join(root, "01_signals")), true);
  assert.equal(await exists(join(root, "20_associations")), true);
  assert.equal(await exists(join(root, "30_patterns")), true);
  assert.equal(await exists(join(root, "40_inputs")), true);
  assert.equal(await exists(join(root, "50_synthesis")), true);
  assert.equal(reloadedConfig.paths.index, "00_map");
  assert.equal(reloadedConfig.paths.contexts, "20_associations");
  assert.match(configText, /^  index: 00_map$/mu);
  assert.match(configText, /^  catalog: 00_map\/catalog\.json$/mu);
  assert.match(configText, /^  - 20_associations$/mu);
  assert.match(configText, /^    - 20_associations\/current\.md$/mu);
  assert.match(configText, /^    - 40_inputs\/$/mu);
  assert.match(agentsText, /User prose: 00_index\/routing\.yml must remain unchanged here\./u);
  assert.match(agentsText, /Managed path: 00_map\/routing\.yml/u);
});

test("skin planning rejects collisions before any move", async (t) => {
  const root = await createSyntheticVault();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "00_map"));

  await assert.rejects(
    planSkin(root, structuredClone(DEFAULT_CONFIG), "brain"),
    SkinError,
  );
  assert.equal(await exists(join(root, "00_index")), true);
});

test("skin refuses a dirty Git worktree and accepts config-level preset overrides", async (t) => {
  const root = await createSyntheticVault();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const configured = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & {
    skins: {
      brain: {
        directories: {
          index: string;
        };
      };
    };
  };
  configured.skins = {
    brain: {
      directories: {
        index: "00_library",
      },
    },
  };
  assert.equal(resolveSkinPreset(configured, "brain").directories.index, "00_library");

  await assert.rejects(
    applySkin(root, structuredClone(DEFAULT_CONFIG), "brain", {
      dryRun: true,
      runGit: async (_root, args) => {
        if (args[0] === "rev-parse") {
          return {
            ok: true,
            stdout: "true\n",
            stderr: "",
            unavailable: false,
          };
        }
        return {
          ok: true,
          stdout: " M tracked-file\n",
          stderr: "",
          unavailable: false,
        };
      },
    }),
    SkinError,
  );
});
