import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { VaultConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const DIRECTORY_KEYS = [
  "index",
  "inbox",
  "memory",
  "contexts",
  "skills",
  "sources",
  "outputs",
  "engine",
  "archive",
] as const;

type DirectoryKey = typeof DIRECTORY_KEYS[number];
type DirectoryMap = Record<DirectoryKey, string>;

const PATH_KEYS_BY_DIRECTORY: Record<
  DirectoryKey,
  Array<keyof VaultConfig["paths"]>
> = {
  index: [
    "index",
    "deltas",
    "catalog",
    "catalog_shards",
    "catalog_index",
    "graph",
    "freshness",
    "routing",
  ],
  inbox: ["inbox"],
  memory: ["memory"],
  contexts: ["contexts"],
  skills: ["skills"],
  sources: ["sources"],
  outputs: ["outputs"],
  engine: ["engine"],
  archive: ["archive"],
};

export type SkinName = "universal" | "brain";
export type SkinMode = "git" | "filesystem";

export interface SkinPreset {
  name: SkinName;
  directories: DirectoryMap;
}

export interface SkinMove {
  key: DirectoryKey;
  from: string;
  to: string;
}

export interface SkinPlan {
  skin: SkinName;
  preset: SkinPreset;
  moves: SkinMove[];
  updated_config: VaultConfig;
  config_path_before: string;
  config_path_after: string;
}

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  unavailable: boolean;
}

export type GitRunner = (
  root: string,
  args: string[],
) => Promise<GitRunResult>;

export interface ApplySkinOptions {
  dryRun?: boolean;
  runGit?: GitRunner;
}

export interface SkinApplyResult {
  plan: SkinPlan;
  mode: SkinMode;
  changed_files: string[];
  rescan_required: boolean;
}

export class SkinError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SkinError";
  }
}

const BUILTIN_PRESETS: Record<SkinName, SkinPreset> = {
  universal: {
    name: "universal",
    directories: {
      index: "00_index",
      inbox: "01_inbox",
      memory: "10_memory",
      contexts: "20_contexts",
      skills: "30_skills",
      sources: "40_sources",
      outputs: "50_outputs",
      engine: "70_engine",
      archive: "90_archive",
    },
  },
  brain: {
    name: "brain",
    directories: {
      index: "00_map",
      inbox: "01_signals",
      memory: "10_memory",
      contexts: "20_associations",
      skills: "30_patterns",
      sources: "40_inputs",
      outputs: "50_synthesis",
      engine: "70_engine",
      archive: "90_archive",
    },
  },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, "/");
}

function firstSegment(value: string): string {
  const segment = toPosix(value).split("/")[0];
  if (!segment || segment === "." || segment === "..") {
    throw new SkinError("Configured vault paths must begin with a directory name.");
  }
  return segment;
}

function validateDirectoryName(value: string): string {
  if (!/^\d{2}_[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new SkinError("Skin directory names must be a single numbered directory name.");
  }
  return value;
}

function currentDirectories(config: VaultConfig): DirectoryMap {
  return {
    index: firstSegment(config.paths.index),
    inbox: firstSegment(config.paths.inbox),
    memory: firstSegment(config.paths.memory),
    contexts: firstSegment(config.paths.contexts),
    skills: firstSegment(config.paths.skills),
    sources: firstSegment(config.paths.sources),
    outputs: firstSegment(config.paths.outputs),
    engine: firstSegment(config.paths.engine),
    archive: firstSegment(config.paths.archive),
  };
}

function customSkinDirectories(
  config: VaultConfig,
  skin: SkinName,
): Partial<DirectoryMap> {
  const carrier = config as VaultConfig & {
    skins?: Record<string, unknown>;
  };
  const entry = carrier.skins?.[skin];
  if (!isRecord(entry)) {
    return {};
  }
  const candidate = isRecord(entry.directories) ? entry.directories : entry;
  const directories: Partial<DirectoryMap> = {};
  for (const key of DIRECTORY_KEYS) {
    const value = candidate[key];
    if (typeof value === "string") {
      directories[key] = validateDirectoryName(value);
    }
  }
  return directories;
}

export function resolveSkinPreset(config: VaultConfig, skin: SkinName): SkinPreset {
  const builtin = BUILTIN_PRESETS[skin];
  const directories: DirectoryMap = {
    ...builtin.directories,
    ...customSkinDirectories(config, skin),
  };
  const names = Object.values(directories);
  if (new Set(names).size !== names.length) {
    throw new SkinError("A skin cannot map multiple vault areas to the same directory.");
  }
  return { name: skin, directories };
}

function replacePathPrefix(value: string, from: string, to: string): string {
  const normalized = toPosix(value);
  if (normalized === from) {
    return to;
  }
  if (normalized.startsWith(from + "/")) {
    return to + normalized.slice(from.length);
  }
  return normalized;
}

export function configForSkin(
  config: VaultConfig,
  preset: SkinPreset,
): VaultConfig {
  const updated = structuredClone(config);
  const current = currentDirectories(config);
  for (const key of DIRECTORY_KEYS) {
    const from = current[key];
    const to = preset.directories[key];
    for (const pathKey of PATH_KEYS_BY_DIRECTORY[key]) {
      updated.paths[pathKey] = replacePathPrefix(updated.paths[pathKey], from, to);
    }
    updated.canonical_dirs = updated.canonical_dirs.map(
      (value) => replacePathPrefix(value, from, to),
    );
    updated.activity.active_paths = updated.activity.active_paths.map(
      (value) => replacePathPrefix(value, from, to),
    );
    updated.activity.active_dir_prefixes = updated.activity.active_dir_prefixes.map(
      (value) => replacePathPrefix(value, from, to),
    );
  }
  return updated;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function planSkin(
  root: string,
  config: VaultConfig,
  skin: SkinName,
): Promise<SkinPlan> {
  const vaultRoot = resolve(root);
  const preset = resolveSkinPreset(config, skin);
  const current = currentDirectories(config);
  const moves = DIRECTORY_KEYS
    .filter((key) => current[key] !== preset.directories[key])
    .map((key) => ({
      key,
      from: current[key],
      to: preset.directories[key],
    }));
  const configPathBefore = join(vaultRoot, config.paths.index, "vault.config.yml");
  const updatedConfig = configForSkin(config, preset);
  const configPathAfter = join(vaultRoot, updatedConfig.paths.index, "vault.config.yml");

  if (!await pathExists(configPathBefore)) {
    throw new SkinError("The vault configuration file is required before applying a skin.");
  }

  for (const move of moves) {
    const source = join(vaultRoot, move.from);
    const destination = join(vaultRoot, move.to);
    if (!await isDirectory(source)) {
      throw new SkinError("Configured source directory is missing: " + move.from);
    }
    if (await pathExists(destination)) {
      throw new SkinError("Skin destination already exists: " + move.to);
    }
  }

  return {
    skin,
    preset,
    moves,
    updated_config: updatedConfig,
    config_path_before: configPathBefore,
    config_path_after: configPathAfter,
  };
}

async function defaultGitRunner(root: string, args: string[]): Promise<GitRunResult> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args]);
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      unavailable: false,
    };
  } catch (error) {
    const failure = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: false,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      unavailable: failure.code === "ENOENT",
    };
  }
}

export async function ensureCleanWorktree(
  root: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<SkinMode> {
  const probe = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ok) {
    if (probe.unavailable || /not a git repository/iu.test(probe.stderr)) {
      return "filesystem";
    }
    throw new SkinError("Git could not determine whether the vault is a worktree.");
  }
  if (probe.stdout.trim() !== "true") {
    return "filesystem";
  }
  const status = await runGit(root, ["status", "--porcelain"]);
  if (!status.ok) {
    throw new SkinError("Git could not verify the worktree state.");
  }
  if (status.stdout.trim()) {
    throw new SkinError("Skin changes require a clean Git worktree.");
  }
  return "git";
}

async function moveDirectory(
  root: string,
  move: SkinMove,
  mode: SkinMode,
  runGit: GitRunner,
): Promise<void> {
  if (mode === "git") {
    const result = await runGit(root, ["mv", move.from, move.to]);
    if (!result.ok) {
      throw new SkinError("Git could not move " + move.from + " to " + move.to + ".");
    }
    return;
  }
  await rename(join(root, move.from), join(root, move.to));
}

const ESCAPEABLE_PATTERN_CHARACTERS = new Set([
  "\\",
  "^",
  "$",
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
]);

function escapePattern(value: string): string {
  return Array.from(value, (character) => (
    ESCAPEABLE_PATTERN_CHARACTERS.has(character) ? "\\" + character : character
  )).join("");
}

function replaceManagedPathTokens(text: string, moves: SkinMove[]): string {
  let updated = text;
  for (const move of moves) {
    const pattern = new RegExp(
      "(^|[\\s\"'(/])" + escapePattern(move.from) + "(?=$|[\\s/\"')])",
      "gmu",
    );
    updated = updated.replace(pattern, (_match, prefix: string) => prefix + move.to);
  }
  return updated;
}

function rewriteScalarLine(line: string, moves: SkinMove[]): string {
  const match = /^(\s*(?:-\s+|[A-Za-z_][A-Za-z0-9_-]*:\s+))(["']?)([^#\s"']+)(.*)$/u.exec(line);
  if (!match) {
    return line;
  }
  const prefix = match[1] ?? "";
  const quote = match[2] ?? "";
  const value = match[3] ?? "";
  const suffix = match[4] ?? "";
  const updated = moves.reduce(
    (current, move) => replacePathPrefix(current, move.from, move.to),
    value,
  );
  return prefix + quote + updated + suffix;
}

export function rewriteManagedConfigReferences(text: string, moves: SkinMove[]): string {
  let section = "";
  let activityList = "";
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const top = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(?:#.*)?)?$/u.exec(line);
      if (top) {
        section = top[1] ?? "";
        activityList = "";
        return line;
      }
      if (section === "activity") {
        const nested = /^\s+([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(?:#.*)?)?$/u.exec(line);
        if (nested) {
          activityList = nested[1] ?? "";
          return line;
        }
      }
      const isManaged = section === "paths"
        || section === "canonical_dirs"
        || (
          section === "activity"
          && (activityList === "active_paths" || activityList === "active_dir_prefixes")
        );
      return isManaged ? rewriteScalarLine(line, moves) : line;
    })
    .join("\n");
}

function rewriteManagedLoaderBlock(text: string, moves: SkinMove[]): string {
  const begin = "<!-- openbrain:begin -->";
  const end = "<!-- openbrain:end -->";
  const start = text.indexOf(begin);
  if (start === -1) {
    return text;
  }
  const finish = text.indexOf(end, start + begin.length);
  if (finish === -1) {
    return text;
  }
  const blockEnd = finish + end.length;
  return text.slice(0, start)
    + replaceManagedPathTokens(text.slice(start, blockEnd), moves)
    + text.slice(blockEnd);
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

async function updateManagedReferences(
  root: string,
  plan: SkinPlan,
): Promise<string[]> {
  const changed: string[] = [];
  const configText = await readFile(plan.config_path_after, "utf8");
  const updatedConfigText = rewriteManagedConfigReferences(configText, plan.moves);
  if (updatedConfigText !== configText) {
    await writeAtomically(plan.config_path_after, updatedConfigText);
    changed.push(plan.config_path_after);
  }

  for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const path = join(root, filename);
    if (!await pathExists(path)) {
      continue;
    }
    const text = await readFile(path, "utf8");
    const updated = rewriteManagedLoaderBlock(text, plan.moves);
    if (updated !== text) {
      await writeAtomically(path, updated);
      changed.push(path);
    }
  }
  return changed;
}

export async function applySkin(
  root: string,
  config: VaultConfig,
  skin: SkinName,
  options: ApplySkinOptions = {},
): Promise<SkinApplyResult> {
  const vaultRoot = resolve(root);
  const plan = await planSkin(vaultRoot, config, skin);
  const runGit = options.runGit ?? defaultGitRunner;
  const mode = await ensureCleanWorktree(vaultRoot, runGit);
  if (options.dryRun) {
    return {
      plan,
      mode,
      changed_files: [],
      rescan_required: plan.moves.length > 0,
    };
  }

  for (const move of plan.moves) {
    await moveDirectory(vaultRoot, move, mode, runGit);
  }
  const changedFiles = await updateManagedReferences(vaultRoot, plan);
  return {
    plan,
    mode,
    changed_files: changedFiles,
    rescan_required: plan.moves.length > 0,
  };
}
