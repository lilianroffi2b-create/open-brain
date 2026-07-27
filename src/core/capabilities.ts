import { ExpectedError } from "./errors.js";
import type { VaultConfig } from "./types.js";

/**
 * The single gate for every capability that costs money, reads outside the
 * vault, or changes behavior. Nothing sensitive runs without passing through
 * isEnabled or requireCapability, which is what makes "shipped whole but
 * disarmed" a checkable property instead of a promise.
 */

export type CapabilityName =
  | "hooks"
  | "capture"
  | "transcripts"
  | "classifier"
  | "learning"
  | "learning.evaluate"
  | "learning.consolidate";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "hooks",
  "capture",
  "transcripts",
  "classifier",
  "learning",
  "learning.evaluate",
  "learning.consolidate",
];

const CAPABILITY_PARENTS: Partial<Record<CapabilityName, CapabilityName>> = {
  "learning.evaluate": "learning",
  "learning.consolidate": "learning",
};

export interface CapabilityDescription {
  name: CapabilityName;
  title: string;
  whatItDoes: string;
  whatItReads: string;
  whatItWrites: string;
  whatItCosts: string;
  howToDisable: string;
  riskIfEnabled: string;
  parent?: CapabilityName;
}

const DESCRIPTIONS: Record<CapabilityName, CapabilityDescription> = {
  hooks: {
    name: "hooks",
    title: "Wire Open Brain into the events of your AI CLI",
    whatItDoes:
      "Registers a single `open-brain hook <event>` entry point with the host CLI so that session start, prompt submission, tool use, stop, and pre-compaction can consult the vault. Each hook either stays silent or returns a short block of context, and it always has a time budget.",
    whatItReads:
      "This vault only: its index, its living state, its routing table, and its preference core. Nothing outside the vault root is read.",
    whatItWrites:
      "The managed hook entries in the host settings file, after backing up the original once, plus the vault's own hook artifacts. Entries you or another tool put in that file are preserved untouched.",
    whatItCosts:
      "Nothing. No model call, no network call. The only cost is local time, capped by a per-hook budget of 2000 ms after which the hook returns what it already has.",
    howToDisable:
      "Run `open-brain capabilities disable hooks` to stop every hook immediately, then `open-brain hooks uninstall` to remove the wiring from the host settings file.",
    riskIfEnabled:
      "Your AI CLI runs one extra local command per event, which costs a fraction of a second. A hook can never fail a session: it either says nothing or refuses a single action with an explanation.",
  },
  capture: {
    name: "capture",
    title: "Fill the staging area with preference and memory candidates",
    whatItDoes:
      "Extracts candidates from the material Open Brain already sees, such as preference statements, durable facts, and decisions worth keeping, and files them in the staging area for review. What it sees depends on what feeds it: with hooks armed it fills the staging area on its own, and without them it applies only to what you or a command you run put through it.",
    whatItReads:
      "The vault, plus any transcript directory you have separately consented to through the transcripts capability. On its own, capture reads nothing outside the vault root.",
    whatItWrites:
      "Candidate files and their manifest under 10_memory/staging/. It never writes to the preference core, to the belief store, or to any other part of the kernel.",
    whatItCosts:
      "Nothing. Extraction is deterministic and local. Money enters the picture only if you also arm the classifier.",
    howToDisable:
      "Run `open-brain capabilities disable capture`. Candidates already staged stay where they are and can be removed with `open-brain staging drop`.",
    riskIfEnabled:
      "The staging area accumulates material you have to review, so the real cost is noise. Nothing reaches the kernel without your explicit validation in `open-brain sync`.",
  },
  transcripts: {
    name: "transcripts",
    title: "Read session transcripts from directories you name",
    whatItDoes:
      "Reads the session transcripts your AI CLI writes to disk, so Open Brain can learn from what actually happened in a session instead of only from what you typed into it.",
    whatItReads:
      "Transcript files under the directories listed in capabilities.transcripts.roots, which normally sit OUTSIDE this vault. This is the only capability that reads outside the vault root, and it reads nothing at all until you name a directory: consent is per path, never global.",
    whatItWrites:
      "Derived candidates in the staging area. With redaction on, which is the default, secrets and obvious identifiers are stripped before anything is written into the vault.",
    whatItCosts:
      "No money and no network. It costs disk reads and it costs privacy surface, which is the real price of this one.",
    howToDisable:
      "Run `open-brain capabilities disable transcripts` to stop all reading immediately, and `open-brain transcripts purge` to delete what has already been derived from them.",
    riskIfEnabled:
      "This is the most privacy-sensitive capability in Open Brain. A transcript can contain secrets, client names, and file contents you never intended to keep. Review the directories you consent to, keep redaction on, and inspect what was derived with `open-brain transcripts show`.",
  },
  classifier: {
    name: "classifier",
    title: "Ask a model to classify staged candidates",
    whatItDoes:
      "Sends staged candidates to a model so they come back typed, scored, and deduplicated, instead of reaching your review as raw text.",
    whatItReads:
      "Staged candidates only. It never reads transcripts directly and never reads the preference kernel.",
    whatItWrites:
      "Classification results attached to the staged candidates, and a local counter of the calls spent today.",
    whatItCosts:
      "Money. This is the only capability in Open Brain that spends anything: every run makes model calls billed by whichever provider your CLI is configured against. Calls are capped by capabilities.classifier.daily_call_budget, 25 per day by default, and a run stops when the budget is spent. The cap in force is printed by `open-brain capabilities list`.",
    howToDisable:
      "Run `open-brain capabilities disable classifier`. While it is disarmed no model call is ever made, and Open Brain costs nothing at all.",
    riskIfEnabled:
      "Cost, and the fact that the text of staged candidates leaves your machine through your provider. Run `open-brain classify --dry-run` first to see exactly what would be sent before you spend a call.",
  },
  learning: {
    name: "learning",
    title: "Record what Open Brain did and what happened next",
    whatItDoes:
      "Keeps a decision journal and a set of sensors: which routes were taken, which preferences were applied, what the vault looked like at the time. It observes and records; it concludes nothing and changes no behavior.",
    whatItReads:
      "The vault's own artifacts: the index, the routing decisions, the preference ledger, and the living state.",
    whatItWrites:
      "Journal entries and sensor readings under 10_memory/learning/. It never writes a belief and never edits a preference.",
    whatItCosts:
      "Nothing. No model call, no network call. It costs a small and steadily growing amount of disk.",
    howToDisable:
      "Run `open-brain capabilities disable learning`. That also disarms learning.evaluate and learning.consolidate, neither of which can run without it.",
    riskIfEnabled:
      "The journal builds a detailed history of your sessions inside the vault. It never leaves your machine, but it does land in git if you version your vault, so it inherits whatever visibility that repository has.",
  },
  "learning.evaluate": {
    name: "learning.evaluate",
    title: "Score beliefs and move their confidence",
    whatItDoes:
      "Reads the decision journal and the sensors, judges whether each belief held up against what actually happened, and updates its confidence. This is where observation turns into conclusion.",
    whatItReads:
      "The decision journal, the sensor readings, and the belief store. All of it inside the vault.",
    whatItWrites:
      "Confidence values and evaluation records in the belief store. It adds and updates; it never removes anything.",
    whatItCosts:
      "Nothing. The evaluator is deterministic and runs locally.",
    howToDisable:
      "Run `open-brain capabilities disable learning.evaluate`. Confidence values already written stay as they are and keep applying until you revert them.",
    riskIfEnabled:
      "Behavior starts to move. A belief whose confidence rises is applied more readily, so an unrepresentative window of sessions can bias what Open Brain proposes. Inspect every change with `open-brain learn status` and undo one with `open-brain learn rollback`.",
    parent: "learning",
  },
  "learning.consolidate": {
    name: "learning.consolidate",
    title: "Delete beliefs that have lost their support",
    whatItDoes:
      "Removes beliefs whose confidence has collapsed, together with the journal entries that only existed to support them. This is the single subtractive operation in Open Brain.",
    whatItReads:
      "The belief store, the decision journal, and the confidence values written by the evaluator.",
    whatItWrites:
      "It deletes. Consolidated beliefs and their supporting entries are removed from the vault, and a consolidation record is written stating exactly what was removed and why.",
    whatItCosts:
      "No money. It costs data, and Open Brain cannot give that data back on its own.",
    howToDisable:
      "Run `open-brain capabilities disable learning.consolidate`. It never arms implicitly: not through a preset, not through --yes, not by enabling its parent.",
    riskIfEnabled:
      "The way back is `open-brain learn consolidate --restore`, which restores the document from its own archive; git plays no part in it, and Open Brain never shells out to git at all. The restore's byte-for-byte reversibility is proven on seven fixtures before a consolidation is ever allowed to run. What is not reversible is losing the archive files themselves, so treat 90_archive/consolidation with the same care as the rest of the vault.",
    parent: "learning",
  },
};

export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAMES.some((name) => name === value);
}

export function describeCapability(name: CapabilityName): CapabilityDescription {
  return DESCRIPTIONS[name];
}

export function capabilityParent(name: CapabilityName): CapabilityName | undefined {
  return CAPABILITY_PARENTS[name];
}

function isDeclared(config: VaultConfig, name: CapabilityName): boolean {
  const capabilities = config.capabilities;
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

/**
 * A capability counts as enabled only when it is declared enabled and its
 * parent is enabled too. A child armed under a disarmed parent is an invalid
 * configuration, reported by capabilityIssues and treated as disarmed here, so
 * a half-edited config can never arm an organ by accident.
 */
export function isEnabled(config: VaultConfig, name: CapabilityName): boolean {
  if (!isDeclared(config, name)) {
    return false;
  }
  const parent = CAPABILITY_PARENTS[name];
  return parent === undefined || isDeclared(config, parent);
}

export function requireCapability(config: VaultConfig, name: CapabilityName): void {
  if (isEnabled(config, name)) {
    return;
  }
  const parent = CAPABILITY_PARENTS[name];
  if (parent !== undefined && isDeclared(config, name) && !isDeclared(config, parent)) {
    throw new ExpectedError(
      `Capability ${name} is disabled: it is enabled in the vault config, but its parent capability ${parent} is not, so it never runs. Enable the parent with \`open-brain capabilities enable ${parent}\`, or turn ${name} off to make the config say what it does.`,
    );
  }
  throw new ExpectedError(
    `Capability ${name} is disabled: Open Brain ships every capability disarmed until you arm it yourself. Read what it does with \`open-brain capabilities explain ${name}\`, then arm it with \`open-brain capabilities enable ${name}\`.`,
  );
}

/**
 * Configuration inconsistencies worth reporting to a human, in a form doctor
 * can print as is. An issue never blocks anything: the runtime already treats
 * every case below as disarmed.
 */
export function capabilityIssues(config: VaultConfig): string[] {
  const issues: string[] = [];

  for (const name of CAPABILITY_NAMES) {
    const parent = CAPABILITY_PARENTS[name];
    if (parent !== undefined && isDeclared(config, name) && !isDeclared(config, parent)) {
      issues.push(
        `${name} is enabled but its parent capability ${parent} is disabled, so ${name} is treated as disabled. Enable ${parent} or disable ${name}.`,
      );
    }
  }

  if (config.capabilities.hooks.enabled && config.capabilities.hooks.targets.length === 0) {
    issues.push(
      "hooks is enabled but capabilities.hooks.targets is empty, so no host CLI is wired. Add a target or disable hooks.",
    );
  }

  if (
    config.capabilities.transcripts.enabled
    && config.capabilities.transcripts.roots.length === 0
  ) {
    issues.push(
      "transcripts is enabled but capabilities.transcripts.roots is empty, so nothing outside the vault is ever read. Consent to a directory or disable transcripts.",
    );
  }

  if (
    config.capabilities.classifier.enabled
    && config.capabilities.classifier.provider === "none"
  ) {
    issues.push(
      "classifier is enabled but capabilities.classifier.provider is none, so no candidate is ever classified. Set a provider or disable classifier.",
    );
  }

  return issues;
}
