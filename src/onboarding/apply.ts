import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";

import {
  capabilityParent,
  isCapabilityName,
  type CapabilityName,
} from "../core/capabilities.js";
import { findVaultConfigPath, loadConfig } from "../core/config.js";
import { ExpectedError } from "../core/errors.js";
import { atomicWriteText } from "../core/fs-atomic.js";
import { lockPathFor, withLock } from "../core/lock.js";
import type { CapabilitiesConfig, ClassifierProvider, VaultConfig } from "../core/types.js";
import { CONSOLIDATE_CONFIRMATION_PHRASE } from "./questions.js";

/**
 * Writing the capabilities section, and nothing else.
 *
 * Three properties hold whatever the caller does. Only keys whose declared value
 * actually changes are written, so replaying the same answers produces the same
 * bytes and touches nothing. Comments and every unrelated line survive, because
 * the file is edited as a YAML document rather than re-serialised from a parsed
 * object. And a child is never armed under a disarmed parent, so a half-applied
 * batch cannot leave a configuration that says one thing and does another.
 *
 * learning.consolidate has its own rule, which is the reason this module exists
 * rather than a generic config setter: it is the only capability that deletes,
 * so it arms only against its own typed confirmation. No preset reaches it, no
 * global yes reaches it, and arming its parent does not reach it.
 */

const CONFIG_LOCK_NAME = "vault-config";

export interface CapabilityRequest {
  capability: CapabilityName;
  enable: boolean;
  roots?: readonly string[];
  targets?: readonly string[];
  provider?: ClassifierProvider;
  /** Only learning.consolidate reads this, and only the exact phrase arms it. */
  confirmation?: string;
}

export interface CapabilityWrite {
  key: string;
  before: string;
  after: string;
}

export interface PlannedCapability {
  capability: CapabilityName;
  requested: "enable" | "disable";
  before: boolean;
  after: boolean;
  changed: boolean;
  refused?: string;
  notes?: string[];
}

export interface CapabilityPlan {
  root: string;
  config_path: string;
  planned: PlannedCapability[];
  writes: CapabilityWrite[];
  refusals: string[];
  notes: string[];
  changes_anything: boolean;
}

export interface ApplyResult {
  plan: CapabilityPlan;
  applied: boolean;
  /** True when the plan asked for a change that the config already reflected. */
  already_current: boolean;
}

export interface ApplyOptions {
  dryRun?: boolean;
}

const HOST_TARGETS = ["claude-code", "codex"] as const;

function cloneCapabilities(config: VaultConfig): CapabilitiesConfig {
  return structuredClone(config.capabilities);
}

/**
 * Consent is recorded as an absolute path. A relative path means nothing once
 * it is written into a file that another process reads from another directory,
 * and a consent record that means nothing is not a consent record.
 */
export function normalizeConsentPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/")
      ? resolve(homedir(), trimmed.slice(2))
      : trimmed;
  return resolve(expanded);
}

function mergeUnique(existing: readonly string[], added: readonly string[]): string[] {
  const merged = [...existing];
  for (const item of added) {
    if (item.length > 0 && !merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
}

function declaredValue(capabilities: CapabilitiesConfig, name: CapabilityName): boolean {
  switch (name) {
    case "hooks":
      return capabilities.hooks.enabled;
    case "capture":
      return capabilities.capture.enabled;
    case "transcripts":
      return capabilities.transcripts.enabled;
    case "classifier":
      return capabilities.classifier.enabled;
    case "learning":
      return capabilities.learning.enabled;
    case "learning.evaluate":
      return capabilities.learning.evaluate;
    case "learning.consolidate":
      return capabilities.learning.consolidate;
  }
}

function setDeclaredValue(
  capabilities: CapabilitiesConfig,
  name: CapabilityName,
  value: boolean,
): void {
  switch (name) {
    case "hooks":
      capabilities.hooks.enabled = value;
      return;
    case "capture":
      capabilities.capture.enabled = value;
      return;
    case "transcripts":
      capabilities.transcripts.enabled = value;
      return;
    case "classifier":
      capabilities.classifier.enabled = value;
      return;
    case "learning":
      capabilities.learning.enabled = value;
      return;
    case "learning.evaluate":
      capabilities.learning.evaluate = value;
      return;
    case "learning.consolidate":
      capabilities.learning.consolidate = value;
  }
}

/** Children of a capability, so disarming a parent disarms what depends on it. */
export function capabilityChildren(name: CapabilityName): CapabilityName[] {
  const children: CapabilityName[] = [];
  for (const candidate of ["learning.evaluate", "learning.consolidate"] as const) {
    if (capabilityParent(candidate) === name) {
      children.push(candidate);
    }
  }
  return children;
}

function validateTargets(targets: readonly string[]): string[] {
  const cleaned = targets.map((item) => item.trim()).filter((item) => item.length > 0);
  const unknown = cleaned.filter(
    (item) => !HOST_TARGETS.some((target) => target === item),
  );
  if (unknown.length > 0) {
    throw new ExpectedError(
      `Unknown hook target(s): ${unknown.join(", ")}. Expected one or more of: ${HOST_TARGETS.join(", ")}.`,
    );
  }
  return cleaned;
}

interface Applied {
  planned: PlannedCapability;
}

function planOne(
  state: CapabilitiesConfig,
  request: CapabilityRequest,
): Applied {
  const name = request.capability;
  const before = declaredValue(state, name);
  const notes: string[] = [];

  const refuse = (reason: string): Applied => ({
    planned: {
      capability: name,
      requested: request.enable ? "enable" : "disable",
      before,
      after: before,
      changed: false,
      refused: reason,
      ...(notes.length === 0 ? {} : { notes }),
    },
  });

  if (!request.enable) {
    setDeclaredValue(state, name, false);
    for (const child of capabilityChildren(name)) {
      if (declaredValue(state, child)) {
        notes.push(`${child} was armed under ${name} and has been disarmed with it.`);
      }
      setDeclaredValue(state, child, false);
    }
    return {
      planned: {
        capability: name,
        requested: "disable",
        before,
        after: false,
        changed: before,
        ...(notes.length === 0 ? {} : { notes }),
      },
    };
  }

  if (name === "learning.consolidate" && request.confirmation !== CONSOLIDATE_CONFIRMATION_PHRASE) {
    return refuse(
      `learning.consolidate is the only capability that deletes, so it needs its own confirmation. A preset does not arm it, a global --yes does not arm it, and arming learning does not arm it. Confirm it by itself with: open-brain capabilities enable learning.consolidate --confirm "${CONSOLIDATE_CONFIRMATION_PHRASE}"`,
    );
  }

  const parent = capabilityParent(name);
  if (parent !== undefined && !declaredValue(state, parent)) {
    return refuse(
      `${name} cannot be armed while its parent capability ${parent} is disarmed: it would sit in the config saying yes and never run. Arm the parent first with \`open-brain capabilities enable ${parent}\`.`,
    );
  }

  if (name === "transcripts") {
    const roots = (request.roots ?? [])
      .map((item) => normalizeConsentPath(item))
      .filter((item) => item.length > 0);
    if (roots.length === 0) {
      return refuse(
        `transcripts is the only capability that reads outside the vault, so consent is given per directory and never in general. Nothing was armed. Name a directory: \`open-brain capabilities enable transcripts --path <path>\`.${state.transcripts.roots.length === 0 ? "" : ` Already consented: ${state.transcripts.roots.join(", ")}.`}`,
      );
    }
    state.transcripts.roots = mergeUnique(state.transcripts.roots, roots);
    notes.push(
      `Transcripts will be read from: ${state.transcripts.roots.join(", ")}. Nothing else on this disk is opened.`,
    );
    if (!state.transcripts.redact) {
      notes.push(
        "Redaction is off in this config, so secrets and identifiers are not stripped before anything is written into the vault.",
      );
    }
  }

  if (name === "hooks") {
    const targets = validateTargets(request.targets ?? []);
    state.hooks.targets = mergeUnique(state.hooks.targets, targets);
    if (state.hooks.targets.length === 0) {
      notes.push(
        "No host CLI is wired yet, so nothing calls the hooks. Wire one with `open-brain hooks install --target claude-code`.",
      );
    } else {
      notes.push(
        `Hosts declared: ${state.hooks.targets.join(", ")}. Run \`open-brain hooks install\` to write the wiring.`,
      );
    }
  }

  if (name === "classifier") {
    const provider = request.provider
      ?? (state.classifier.provider === "none" ? "claude-code-subagent" : state.classifier.provider);
    state.classifier.provider = provider;
    if (provider === "none") {
      notes.push(
        "The provider is none, so no candidate is ever classified and no call is ever made.",
      );
    } else {
      notes.push(
        `Provider set to ${provider}. Up to ${String(state.classifier.daily_call_budget)} model calls per day, then the run stops. This is the only capability that spends money.`,
      );
    }
  }

  if (name === "learning.consolidate" && !state.learning.evaluate) {
    notes.push(
      "The evaluator is disarmed, so nothing is concluding and consolidation has nothing to act on yet.",
    );
  }

  setDeclaredValue(state, name, true);
  return {
    planned: {
      capability: name,
      requested: "enable",
      before,
      after: true,
      changed: !before,
      ...(notes.length === 0 ? {} : { notes }),
    },
  };
}

export interface CapabilityMutation {
  path: readonly string[];
  value: boolean | string | string[];
}

function renderValue(value: boolean | string | string[]): string {
  return Array.isArray(value)
    ? value.length === 0 ? "[]" : value.join(", ")
    : String(value);
}

/**
 * Only the keys that actually differ. A capability that is already in the state
 * the caller asked for produces no mutation at all, which is what makes a rerun
 * of the same answers a no-op down to the bytes on disk.
 */
function diffCapabilities(
  before: CapabilitiesConfig,
  after: CapabilitiesConfig,
): { mutations: CapabilityMutation[]; writes: CapabilityWrite[] } {
  const mutations: CapabilityMutation[] = [];
  const writes: CapabilityWrite[] = [];

  const compare = (
    path: readonly string[],
    previous: boolean | string | string[],
    next: boolean | string | string[],
  ): void => {
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      return;
    }
    mutations.push({ path, value: next });
    writes.push({
      key: ["capabilities", ...path].join("."),
      before: renderValue(previous),
      after: renderValue(next),
    });
  };

  compare(["hooks", "enabled"], before.hooks.enabled, after.hooks.enabled);
  compare(["hooks", "targets"], before.hooks.targets, after.hooks.targets);
  compare(["capture", "enabled"], before.capture.enabled, after.capture.enabled);
  compare(["transcripts", "enabled"], before.transcripts.enabled, after.transcripts.enabled);
  compare(["transcripts", "roots"], before.transcripts.roots, after.transcripts.roots);
  compare(["classifier", "enabled"], before.classifier.enabled, after.classifier.enabled);
  compare(["classifier", "provider"], before.classifier.provider, after.classifier.provider);
  compare(["learning", "enabled"], before.learning.enabled, after.learning.enabled);
  compare(["learning", "evaluate"], before.learning.evaluate, after.learning.evaluate);
  compare(["learning", "consolidate"], before.learning.consolidate, after.learning.consolidate);

  return { mutations, writes };
}

async function vaultConfigPath(root: string): Promise<string> {
  const configPath = await findVaultConfigPath(root);
  if (configPath === undefined || dirname(dirname(configPath)) !== resolve(root)) {
    throw new ExpectedError(
      `No vault configuration was found at ${resolve(root)}. Run \`open-brain init\` first.`,
    );
  }
  return configPath;
}

/**
 * Rewrites the capabilities section of an existing config text. The document is
 * edited in place rather than rebuilt, so every comment, every blank line and
 * every unrelated section come back byte for byte.
 */
export function writeCapabilitiesInto(
  text: string,
  mutations: readonly CapabilityMutation[],
): string {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new ExpectedError(
      "The vault configuration is not valid YAML, so its capabilities section was left untouched. Fix the file first.",
    );
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new ExpectedError(
      "The vault configuration must be a YAML mapping, so its capabilities section was left untouched.",
    );
  }
  for (const mutation of mutations) {
    document.setIn(["capabilities", ...mutation.path], mutation.value);
  }
  return document.toString();
}

function refusalLines(planned: readonly PlannedCapability[]): string[] {
  return planned
    .map((item) => item.refused)
    .filter((item): item is string => item !== undefined);
}

function noteLines(planned: readonly PlannedCapability[]): string[] {
  return planned.flatMap((item) => item.notes ?? []);
}

/**
 * What would be written, without writing it. Requests are evaluated in order,
 * so a batch that arms a parent and then its child works, and a batch that does
 * the reverse refuses the child and says why.
 */
export async function planCapabilities(
  root: string,
  config: VaultConfig,
  requests: readonly CapabilityRequest[],
): Promise<CapabilityPlan> {
  const configPath = await vaultConfigPath(root);
  const before = cloneCapabilities(config);
  const state = cloneCapabilities(config);
  const planned = requests.map((request) => planOne(state, request).planned);
  const { writes } = diffCapabilities(before, state);
  return {
    root: resolve(root),
    config_path: configPath,
    planned,
    writes,
    refusals: refusalLines(planned),
    notes: noteLines(planned),
    changes_anything: writes.length > 0,
  };
}

/**
 * Plans and writes in one lock, re-reading the file inside the lock so a
 * concurrent writer cannot be clobbered by a plan computed before it ran.
 */
export async function applyCapabilities(
  root: string,
  config: VaultConfig,
  requests: readonly CapabilityRequest[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const plan = await planCapabilities(root, config, requests);
  if (!plan.changes_anything) {
    return {
      plan,
      applied: false,
      already_current: requests.length > 0 && plan.refusals.length === 0,
    };
  }
  if (options.dryRun === true) {
    return { plan, applied: false, already_current: false };
  }

  return withLock(lockPathFor(root, CONFIG_LOCK_NAME), async () => {
    const current = await loadConfig(root);
    const before = cloneCapabilities(current);
    const state = cloneCapabilities(current);
    for (const request of requests) {
      planOne(state, request);
    }
    const { mutations, writes } = diffCapabilities(before, state);
    if (mutations.length === 0) {
      return {
        plan: { ...plan, writes, changes_anything: false },
        applied: false,
        already_current: true,
      };
    }
    const text = await readFile(plan.config_path, "utf8");
    const next = writeCapabilitiesInto(text, mutations);
    if (next !== text) {
      await atomicWriteText(plan.config_path, next);
    }
    return {
      plan: { ...plan, writes, changes_anything: true },
      applied: next !== text,
      already_current: next === text,
    };
  });
}

/** Parses a capability name coming from a command line or a conversation. */
export function parseCapabilityName(value: string): CapabilityName {
  const trimmed = value.trim();
  if (!isCapabilityName(trimmed)) {
    throw new ExpectedError(
      `Unknown capability "${value}". Run \`open-brain capabilities list\` to see the seven names.`,
    );
  }
  return trimmed;
}
