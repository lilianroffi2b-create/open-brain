import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  DEFAULT_CONFIG,
  findVaultConfigPath,
  findVaultRoot,
  loadConfig,
} from "../core/config.js";
import { ExpectedError } from "../core/errors.js";
import {
  dismissIdea,
  getFreeModeStatePath,
  isIdeaDismissed,
  loadFreeModeLocalState,
  readFreeMode,
  saveFreeModeLocalState,
  setFreeModeLocalStateMode,
  type FreeMode,
} from "../free-mode/index.js";
import {
  OPENBRAIN_LOADER_BEGIN_MARKER,
  OPENBRAIN_LOADER_END_MARKER,
  syncLoadersFromConfig,
} from "../loaders/index.js";

export const ENGINE_VERSION = "0.1.0-alpha.2";
export const OPENBRAIN_MANIFEST_FILENAME = ".open-brain.json";

interface OpenBrainManifest extends Record<string, unknown> {
  engineVersion: string;
  installedAt: string;
  integrations: string[];
}

export interface InitVaultOptions {
  noGit?: boolean;
}

export interface InitVaultResult {
  root: string;
  copiedTemplateFiles: number;
  git: "initialized" | "already-present" | "unavailable" | "skipped";
}

export interface UpdateVaultResult {
  root: string;
  loadersChanged: number;
  migrationNotesAdded: number;
}

export interface DoctorResult {
  root: string;
  configFound: boolean;
  missingDirectories: string[];
  malformedLoaders: string[];
  missingLoaders: string[];
  localFreeModeStateFound: boolean;
  repaired: boolean;
}

export interface FreeModeStatus {
  mode: FreeMode;
  createdAt: string;
  updatedAt: string;
  dismissedIdeaCount: number;
}

export interface IdeaCheckResult {
  dismissed: boolean;
}

export interface FreeModeResetResult {
  root: string;
  removed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads a user-supplied JSON artifact without exposing its contents in errors. */
export async function readJsonFile(path: string): Promise<unknown> {
  const resolvedPath = resolve(path);
  let content: string;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch {
    throw new Error(`Unable to read JSON file: ${resolvedPath}.`);
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`JSON file is invalid: ${resolvedPath}.`);
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Writes an explicit CLI artifact atomically, preserving its review boundary. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const resolvedPath = resolve(path);
  await writeAtomically(resolvedPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyAtomically(source: string, target: string): Promise<void> {
  const directory = dirname(target);
  const temporaryPath = join(
    directory,
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, target);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function getPackageRoot(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (await pathExists(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate the OpenBrain package root.");
    }
    current = parent;
  }
}

async function copyMissingTree(
  source: string,
  target: string,
  isTemplateRoot = true,
): Promise<number> {
  const entries = await readdir(source, { withFileTypes: true });
  let copied = 0;

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetName = isTemplateRoot && entry.name === "gitignore.template"
      ? ".gitignore"
      : entry.name;
    const targetPath = join(target, targetName);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      copied += await copyMissingTree(sourcePath, targetPath, false);
    } else if (entry.isFile() && !await pathExists(targetPath)) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      copied += 1;
    }
  }

  return copied;
}

async function ensureFreeModeState(root: string, mode: FreeMode): Promise<void> {
  const statePath = getFreeModeStatePath(root);
  const existed = await pathExists(statePath);
  const current = await loadFreeModeLocalState(root, mode);
  if (!existed || current.mode !== mode) {
    await saveFreeModeLocalState(
      root,
      setFreeModeLocalStateMode(current, mode),
    );
  }
}

async function readManifest(root: string): Promise<Record<string, unknown>> {
  const path = join(root, OPENBRAIN_MANIFEST_FILENAME);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {};
    }
    throw new Error("OpenBrain manifest is not valid JSON.");
  }
}

async function writeManifest(root: string): Promise<void> {
  const previous = await readManifest(root);
  const installedAt = typeof previous.installedAt === "string"
    ? previous.installedAt
    : new Date().toISOString();
  const integrations = Array.isArray(previous.integrations)
    && previous.integrations.every((item) => typeof item === "string")
    ? [...previous.integrations]
    : ["loaders"];
  const next: OpenBrainManifest = {
    ...previous,
    engineVersion: ENGINE_VERSION,
    installedAt,
    integrations,
  };
  await writeAtomically(
    join(root, OPENBRAIN_MANIFEST_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
  );
}

async function ensureInitialState(root: string): Promise<void> {
  const statePath = join(root, "10_memory", "_state.md");
  if (await pathExists(statePath)) {
    return;
  }
  await writeAtomically(
    statePath,
    [
      "---",
      "lifecycle: master",
      "---",
      "# Living state",
      "",
      "## Last update",
      "Vault initialized.",
      "",
      "## Health",
      "Run `open-brain status` when that command is available in your installed version.",
      "",
      "## Current work",
      "No work has been recorded yet.",
      "",
      "## Handoff",
      "Read this file first and update it at the end of a substantive session.",
      "",
    ].join("\n"),
  );
}

async function initializeGit(root: string): Promise<InitVaultResult["git"]> {
  if (await pathExists(join(root, ".git"))) {
    return "already-present";
  }

  return new Promise((resolveGit) => {
    const child = spawn("git", ["init", "-b", "main", root], {
      stdio: "ignore",
    });
    child.once("error", () => resolveGit("unavailable"));
    child.once("exit", (code) => {
      resolveGit(code === 0 ? "initialized" : "unavailable");
    });
  });
}

async function readDirectoryEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function packageEnginePath(): Promise<string> {
  const path = join(await getPackageRoot(), "bin", "cli.js");
  if (!await pathExists(path)) {
    throw new Error("The packaged CLI bundle is missing. Run `npm run build` before init or update.");
  }
  return path;
}

async function copyEngineToVault(root: string, engineDirectory: string): Promise<void> {
  await copyAtomically(
    await packageEnginePath(),
    join(root, engineDirectory, "cli.js"),
  );
}

async function migrationNotes(root: string): Promise<number> {
  const packageRoot = await getPackageRoot();
  const migrationRoot = join(packageRoot, "MIGRATIONS");
  let entries;
  try {
    entries = await readdir(migrationRoot, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }

  const migrationFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  if (migrationFiles.length === 0) {
    return 0;
  }

  const destination = join(root, "MIGRATION_TODO.md");
  let existing = "";
  try {
    existing = await readFile(destination, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const additions: string[] = [];
  for (const filename of migrationFiles) {
    const marker = `<!-- openbrain:migration:${filename} -->`;
    if (existing.includes(marker)) {
      continue;
    }
    const contents = await readFile(join(migrationRoot, filename), "utf8");
    additions.push(marker, `## ${filename}`, "", contents.trim(), "");
  }

  if (additions.length > 0) {
    const prefix = existing
      ? existing.endsWith("\n") ? "\n" : "\n\n"
      : "# OpenBrain migration tasks\n\n";
    await writeAtomically(destination, `${existing}${prefix}${additions.join("\n")}\n`);
  }

  return additions.filter((line) => line.startsWith("<!-- openbrain:migration:")).length;
}

export async function resolveVaultRoot(start?: string): Promise<string> {
  const requested = resolve(start ?? process.cwd());
  const root = await findVaultRoot(requested);
  const configPath = await findVaultConfigPath(root);
  if (!configPath || dirname(dirname(configPath)) !== root) {
    throw new ExpectedError(
      `No OpenBrain vault was found from ${requested}. Run \`open-brain init\` first.`,
    );
  }
  return root;
}

export async function initVault(
  target: string,
  options: InitVaultOptions = {},
): Promise<InitVaultResult> {
  const root = resolve(target);
  if (await findVaultConfigPath(root)) {
    throw new ExpectedError(
      `An OpenBrain vault already exists at ${root}. Init never overwrites a vault; use update instead.`,
    );
  }

  const existingEntries = await readDirectoryEntries(root);
  if (existingEntries.length > 0) {
    throw new ExpectedError(
      `Refusing to initialize non-empty directory ${root}. Choose an empty directory to avoid overwriting files.`,
    );
  }

  const packageRoot = await getPackageRoot();
  const templateRoot = join(packageRoot, "templates", "vault");
  if (!await pathExists(templateRoot)) {
    throw new Error("OpenBrain vault templates are missing from this package.");
  }
  await packageEnginePath();

  await mkdir(root, { recursive: true });
  const copiedTemplateFiles = await copyMissingTree(templateRoot, root);
  const config = await loadConfig(root);
  for (const directory of config.canonical_dirs) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await ensureInitialState(root);
  await copyEngineToVault(root, config.paths.engine);
  await writeManifest(root);
  await ensureFreeModeState(root, readFreeMode(config));
  await syncLoadersFromConfig(root, config);

  const git = options.noGit ? "skipped" : await initializeGit(root);
  return { root, copiedTemplateFiles, git };
}

export async function updateVault(start?: string): Promise<UpdateVaultResult> {
  const root = await resolveVaultRoot(start);
  const config = await loadConfig(root);
  await copyEngineToVault(root, config.paths.engine);
  await writeManifest(root);
  await ensureFreeModeState(root, readFreeMode(config));
  const loaders = await syncLoadersFromConfig(root, config);
  const migrationNotesAdded = await migrationNotes(root);
  return {
    root,
    loadersChanged: loaders.filter((loader) => loader.changed).length,
    migrationNotesAdded,
  };
}

function markerCount(contents: string, marker: string): number {
  return contents.split(marker).length - 1;
}

export async function doctorVault(
  start?: string,
  repair = false,
): Promise<DoctorResult> {
  const root = await resolveVaultRoot(start);
  const config = await loadConfig(root);
  const missingDirectories: string[] = [];
  for (const directory of config.canonical_dirs) {
    if (!await pathExists(join(root, directory))) {
      missingDirectories.push(directory);
    }
  }

  const malformedLoaders: string[] = [];
  const missingLoaders: string[] = [];
  for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const path = join(root, filename);
    try {
      const contents = await readFile(path, "utf8");
      if (
        markerCount(contents, OPENBRAIN_LOADER_BEGIN_MARKER) !== 1
        || markerCount(contents, OPENBRAIN_LOADER_END_MARKER) !== 1
      ) {
        malformedLoaders.push(filename);
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        missingLoaders.push(filename);
      } else {
        throw error;
      }
    }
  }

  if (repair) {
    for (const directory of missingDirectories) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await syncLoadersFromConfig(root, config);
    await ensureFreeModeState(root, readFreeMode(config));
  }

  return {
    root,
    configFound: true,
    missingDirectories,
    malformedLoaders,
    missingLoaders,
    localFreeModeStateFound: await pathExists(getFreeModeStatePath(root)),
    repaired: repair,
  };
}

async function getVaultConfigPath(root: string): Promise<string> {
  const configPath = await findVaultConfigPath(root);
  if (!configPath || dirname(dirname(configPath)) !== resolve(root)) {
    throw new Error(`OpenBrain vault configuration is missing from ${root}.`);
  }
  return configPath;
}

async function readConfigText(root: string): Promise<{
  path: string;
  text: string;
}> {
  const path = await getVaultConfigPath(root);
  return { path, text: await readFile(path, "utf8") };
}

function patchFreeModeConfig(text: string, mode: FreeMode): string {
  const modeLine = /^(\s*)free_mode:\s*(?:off|calibrated)(\s*(?:#.*)?)$/mu;
  if (modeLine.test(text)) {
    return text.replace(modeLine, (_match, indent: string, suffix: string) => (
      `${indent}free_mode: ${mode}${suffix}`
    ));
  }

  const inlineEmpty = /^(\s*)interaction:\s*(?:\{\s*\}|null)(\s*(?:#.*)?)$/mu;
  if (inlineEmpty.test(text)) {
    return text.replace(inlineEmpty, (_match, indent: string, suffix: string) => (
      `${indent}interaction:${suffix}\n${indent}  free_mode: ${mode}`
    ));
  }

  const interactionHeader = /^(\s*)interaction:\s*(?:#.*)?\r?\n/mu.exec(text);
  if (interactionHeader) {
    const insertion = interactionHeader.index + interactionHeader[0].length;
    const indent = interactionHeader[1] ?? "";
    return `${text.slice(0, insertion)}${indent}  free_mode: ${mode}\n${text.slice(insertion)}`;
  }

  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}\ninteraction:\n  free_mode: ${mode}\n`;
}

export async function setVaultFreeMode(
  start: string | undefined,
  mode: FreeMode,
): Promise<FreeModeStatus> {
  const root = await resolveVaultRoot(start);
  const config = await readConfigText(root);
  const parsed = parseYaml(config.text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("vault.config.yml must contain a YAML mapping.");
  }
  readFreeMode(parsed);
  const nextText = patchFreeModeConfig(config.text, mode);
  const nextParsed = parseYaml(nextText) as unknown;
  if (!isRecord(nextParsed) || readFreeMode(nextParsed) !== mode) {
    throw new Error("Unable to update interaction.free_mode safely.");
  }
  await writeAtomically(config.path, nextText);
  await syncLoadersFromConfig(root, nextParsed);

  const state = await loadFreeModeLocalState(root, mode);
  const nextState = setFreeModeLocalStateMode(state, mode);
  await saveFreeModeLocalState(root, nextState);
  return {
    mode,
    createdAt: nextState.createdAt,
    updatedAt: nextState.updatedAt,
    dismissedIdeaCount: nextState.dismissedIdeaFingerprints.length,
  };
}

export async function getVaultFreeModeStatus(start?: string): Promise<FreeModeStatus> {
  const root = await resolveVaultRoot(start);
  const config = await readConfigText(root);
  const parsed = parseYaml(config.text) as unknown;
  const mode = readFreeMode(parsed);
  const state = await loadFreeModeLocalState(root, mode);
  return {
    mode,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    dismissedIdeaCount: state.dismissedIdeaFingerprints.length,
  };
}

/** Reads the configured Free Mode without loading full local state. */
async function readVaultMode(root: string): Promise<FreeMode> {
  const config = await readConfigText(root);
  return readFreeMode(parseYaml(config.text) as unknown);
}

/**
 * Fingerprints an idea and records the opaque hash in local state so it is
 * never proposed again. The raw idea text is never written to disk.
 */
export async function dismissIdeaInVault(
  start: string | undefined,
  idea: string,
): Promise<FreeModeStatus> {
  const root = await resolveVaultRoot(start);
  const mode = await readVaultMode(root);
  const state = await loadFreeModeLocalState(root, mode);
  const nextState = dismissIdea(state, idea);
  await saveFreeModeLocalState(root, nextState);
  return {
    mode: nextState.mode,
    createdAt: nextState.createdAt,
    updatedAt: nextState.updatedAt,
    dismissedIdeaCount: nextState.dismissedIdeaFingerprints.length,
  };
}

/** Reports whether an idea's fingerprint is already in the dismissed set. */
export async function checkIdeaInVault(
  start: string | undefined,
  idea: string,
): Promise<IdeaCheckResult> {
  const root = await resolveVaultRoot(start);
  const mode = await readVaultMode(root);
  const state = await loadFreeModeLocalState(root, mode);
  return { dismissed: isIdeaDismissed(state, idea) };
}

/**
 * Deletes the local Free Mode state file, erasing all remembered dismissals.
 * This is the only path that purges local state; toggling Free Mode never does.
 */
export async function resetFreeModeState(
  start?: string,
): Promise<FreeModeResetResult> {
  const root = await resolveVaultRoot(start);
  const statePath = getFreeModeStatePath(root);
  try {
    await unlink(statePath);
    return { root, removed: true };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { root, removed: false };
    }
    throw error;
  }
}

export const DEFAULT_CANONICAL_DIRECTORIES = [...DEFAULT_CONFIG.canonical_dirs];
