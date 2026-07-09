import pc from "picocolors";
import { defineCommand, runMain } from "citty";
import { join, resolve } from "node:path";

import { loadCatalog } from "../core/catalog.js";
import { loadConfig } from "../core/config.js";
import {
  applyReviewedGcProposal,
  GC_PROPOSAL_SCHEMA_VERSION,
  proposeGc,
  reviewGcProposal,
  type GcProposal,
} from "../core/gc.js";
import { buildGraph } from "../core/graph.js";
import { checkVaultHealth } from "../core/health.js";
import { ingestInbox } from "../core/ingest.js";
import { writeIndexArtifacts } from "../core/index-writer.js";
import { loadRouting, routeVault, suggestRoutes } from "../core/route.js";
import { scanVault } from "../core/scan.js";
import { applySkin, type SkinName } from "../core/skin.js";
import { getVaultStatus } from "../core/status.js";
import {
  addPreference,
  isLedgerDate,
  isPreferenceStatus,
  isPreferenceWeight,
  listPreferences,
  loadPreferenceLedger,
  logPreference,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  savePreferenceLedger,
  shouldAutoRegen,
  syncPreferenceMirrors,
  validatePreferenceLedger,
  writePreferenceCore,
  type PreferenceStatus,
  type PreferenceWeight,
} from "../prefs/index.js";
import {
  checkIdeaInVault,
  dismissIdeaInVault,
  doctorVault,
  ENGINE_VERSION,
  getVaultFreeModeStatus,
  initVault,
  readJsonFile,
  resetFreeModeState,
  resolveVaultRoot,
  setVaultFreeMode,
  updateVault,
  writeJsonFile,
} from "./vault.js";
import { syncLoadersFromConfig } from "../loaders/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argument(args: unknown, name: string): unknown {
  return isRecord(args) ? args[name] : undefined;
}

function optionalString(args: unknown, name: string): string | undefined {
  const value = argument(args, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanArgument(args: unknown, name: string): boolean {
  return argument(args, name) === true;
}

function requiredString(args: unknown, name: string): string {
  const value = optionalString(args, name);
  if (!value) {
    throw new Error(`--${name} requires a non-empty value.`);
  }
  return value;
}

function optionalNonNegativeInteger(
  args: unknown,
  name: string,
): number | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function optionalPreferenceWeight(
  args: unknown,
  name: string,
): PreferenceWeight | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  const weight = Number(value);
  if (!Number.isInteger(weight) || !isPreferenceWeight(weight)) {
    throw new Error(`--${name} must be an integer from 1 through 5.`);
  }
  return weight;
}

function optionalPreferenceStatus(
  args: unknown,
  name: string,
): PreferenceStatus | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!isPreferenceStatus(value)) {
    throw new Error(`--${name} must be a valid preference status.`);
  }
  return value;
}

function requiredPreferenceWeight(args: unknown, name: string): PreferenceWeight {
  const weight = optionalPreferenceWeight(args, name);
  if (weight === undefined) {
    throw new Error(`--${name} requires an integer from 1 through 5.`);
  }
  return weight;
}

function optionalLedgerDate(args: unknown, name: string): string | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!isLedgerDate(value)) {
    throw new Error(`--${name} must be an ISO date (YYYY-MM-DD).`);
  }
  return value;
}

// Tri-state boolean: --core => true, --no-core => false, absent => undefined.
function optionalBoolean(args: unknown, name: string): boolean | undefined {
  const value = argument(args, name);
  return typeof value === "boolean" ? value : undefined;
}

function requiredSkinName(args: unknown): SkinName {
  const skin = requiredString(args, "skin");
  if (skin !== "universal" && skin !== "brain") {
    throw new Error("skin must be either universal or brain.");
  }
  return skin;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printNotice(message: string): void {
  process.stdout.write(`${pc.cyan(message)}\n`);
}

function isGcCandidate(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.path === "string"
    && typeof value.sha256 === "string"
    && ["master", "working", "ephemeral", "data"].includes(
      value.lifecycle as string,
    )
    && ["hot", "warm", "cold"].includes(value.tier as string)
    && ["expired_ephemeral", "cold_unreferenced"].includes(
      value.reason as string,
    )
  );
}

function isGcProposal(value: unknown): value is GcProposal {
  if (
    !isRecord(value)
    || value.schema_version !== GC_PROPOSAL_SCHEMA_VERSION
    || typeof value.id !== "string"
    || typeof value.created_at !== "string"
    || !Array.isArray(value.candidates)
    || !value.candidates.every(isGcCandidate)
  ) {
    return false;
  }

  if (value.review === undefined) {
    return true;
  }
  return isRecord(value.review)
    && (value.review.decision === "approved" || value.review.decision === "rejected")
    && typeof value.review.reviewer === "string"
    && typeof value.review.reviewed_at === "string";
}

async function readGcProposal(path: string): Promise<GcProposal> {
  const value = await readJsonFile(path);
  if (!isGcProposal(value)) {
    throw new Error("GC proposal does not match the expected OpenBrain format.");
  }
  return value;
}

const rootArgument = {
  root: {
    type: "string",
    description: "Vault root or a path inside an existing vault.",
  },
} as const;

const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Create a new OpenBrain vault without overwriting existing files.",
  },
  args: {
    target: {
      type: "positional",
      description: "Empty destination directory. Defaults to the current directory.",
      required: false,
    },
    git: {
      type: "boolean",
      description: "Initialize a local Git repository by default. Use --no-git to skip it.",
      default: true,
    },
  },
  async run({ args }) {
    const target = optionalString(args, "target") ?? ".";
    const result = await initVault(target, {
      noGit: !booleanArgument(args, "git"),
    });
    printJson({
      ...result,
      message: "Open the vault in your AI CLI and ask it to start onboarding.",
    });
  },
});

const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Replace only the copied engine and managed integration blocks.",
  },
  args: rootArgument,
  async run({ args }) {
    printJson(await updateVault(optionalString(args, "root")));
  },
});

const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Inspect vault wiring and optionally repair only safe generated wiring.",
  },
  args: {
    ...rootArgument,
    repair: {
      type: "boolean",
      description: "Create missing canonical directories and resync managed loader blocks.",
      default: false,
    },
  },
  async run({ args }) {
    const result = await doctorVault(
      optionalString(args, "root"),
      booleanArgument(args, "repair"),
    );
    printJson(result);
    if (
      !result.repaired
      && (
        result.missingDirectories.length > 0
        || result.malformedLoaders.length > 0
        || result.missingLoaders.length > 0
      )
    ) {
      printNotice("Run `open-brain doctor --repair` to repair only safe generated wiring.");
      process.exitCode = 2;
    }
  },
});

const scanCommand = defineCommand({
  meta: {
    name: "scan",
    description: "Scan a vault and write deterministic local index artifacts.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const previousRecords = await loadCatalog(root, config);
    const scan = await scanVault(root, config, { previousRecords });
    await writeIndexArtifacts(root, config, scan);
    printJson(scan);
  },
});

const routeCommand = defineCommand({
  meta: {
    name: "route",
    description: "Return the smallest relevant reading route for a request.",
  },
  args: {
    query: {
      type: "positional",
      description: "Natural-language request to route. Optional with --suggest.",
      required: false,
    },
    ...rootArgument,
    suggest: {
      type: "boolean",
      description: "Propose new or mergeable routes from the catalog without editing routing.yml.",
      default: false,
    },
    "min-docs": {
      type: "string",
      description: "Minimum cluster size to suggest a new route (with --suggest).",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    if (booleanArgument(args, "suggest")) {
      const minDocs = optionalNonNegativeInteger(args, "min-docs") ?? 5;
      printJson(await suggestRoutes(root, config, minDocs));
      return;
    }
    const query = optionalString(args, "query");
    if (!query) {
      throw new Error("route requires a non-empty query unless --suggest is used.");
    }
    printJson(await routeVault(root, config, query));
  },
});

const loaderSyncCommand = defineCommand({
  meta: {
    name: "loader-sync",
    description: "Synchronize the generated Free Mode block in supported loaders.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    printJson(await syncLoadersFromConfig(root, config));
  },
});

const gcCommand = defineCommand({
  meta: {
    name: "gc",
    description: "Propose safe cleanup candidates without deleting vault content.",
  },
  args: {
    ...rootArgument,
    write: {
      type: "string",
      description: "Persist the generated proposal at this JSON path.",
      required: false,
    },
    approve: {
      type: "string",
      description: "Record explicit approval in an existing proposal JSON file.",
      required: false,
    },
    apply: {
      type: "string",
      description: "Apply an explicitly approved proposal by writing a non-destructive report.",
      required: false,
    },
    reviewer: {
      type: "string",
      description: "Name recorded with an explicit GC approval.",
      required: false,
    },
  },
  async run({ args }) {
    const writePath = optionalString(args, "write");
    const approvalPath = optionalString(args, "approve");
    const applyPath = optionalString(args, "apply");
    const reviewer = optionalString(args, "reviewer");
    const requestedActions = [writePath, approvalPath, applyPath]
      .filter((value): value is string => value !== undefined);
    if (requestedActions.length > 1) {
      throw new Error("Use only one of --write, --approve, or --apply per gc command.");
    }
    if (reviewer !== undefined && approvalPath === undefined) {
      throw new Error("--reviewer can only be used with --approve.");
    }

    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const records = await loadCatalog(root, config);

    if (approvalPath !== undefined) {
      if (!reviewer) {
        throw new Error("GC approval requires --reviewer with a non-empty value.");
      }
      const path = resolve(approvalPath);
      const proposal = await readGcProposal(path);
      const approved = reviewGcProposal(proposal, "approved", reviewer);
      await writeJsonFile(path, approved);
      printJson(approved);
      return;
    }

    if (applyPath !== undefined) {
      const proposal = await readGcProposal(resolve(applyPath));
      printJson(await applyReviewedGcProposal(root, config, proposal, records));
      return;
    }

    const proposal = proposeGc(records, config, {
      graph: buildGraph(records, config.root_label),
      routing: await loadRouting(root, config),
    });
    if (writePath !== undefined) {
      const path = resolve(writePath);
      await writeJsonFile(path, proposal);
      printJson({ proposal, proposal_path: path });
      return;
    }
    printJson(proposal);
  },
});

const healthCommand = defineCommand({
  meta: {
    name: "health",
    description: "Check vault structure, freshness, and index integrity.",
  },
  args: rootArgument,
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const report = await checkVaultHealth(root, config);
    printJson(report);
    if (!report.healthy) {
      process.exitCode = 2;
    }
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show vault health and optionally rebuild stale local indexes.",
  },
  args: {
    ...rootArgument,
    auto: {
      type: "boolean",
      description: "Rescan when indexes are stale, unavailable, or unhealthy.",
      default: false,
    },
    rescan: {
      type: "boolean",
      description: "Rescan local indexes before reporting status.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const report = await getVaultStatus(root, config, {
      auto: booleanArgument(args, "auto"),
      rescan: booleanArgument(args, "rescan"),
    });
    printJson(report);
    if (!report.health.healthy) {
      process.exitCode = 2;
    }
  },
});

const ingestCommand = defineCommand({
  meta: {
    name: "ingest",
    description: "Import supported files from the configured inbox into local archive and briefs.",
  },
  args: {
    ...rootArgument,
    "batch-id": {
      type: "string",
      description: "Optional stable identifier for this local import batch.",
      required: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const batchId = optionalString(args, "batch-id");
    const report = await ingestInbox(root, config, {
      ...(batchId === undefined ? {} : { batchId }),
    });
    printJson(report);
    if (report.failures.length > 0) {
      process.exitCode = 2;
    }
  },
});

const prefsCommand = defineCommand({
  meta: {
    name: "prefs",
    description: "Validate, inspect, regenerate, or log Hermes preferences.",
  },
  subCommands: {
    validate: defineCommand({
      meta: {
        name: "validate",
        description: "Validate the preference ledger without changing it.",
      },
      args: rootArgument,
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        let result;
        try {
          result = validatePreferenceLedger(
            await readJsonFile(join(root, PREFERENCE_LEDGER_RELATIVE_PATH)),
          );
        } catch {
          result = {
            valid: false,
            errors: ["Preference ledger is missing or is not valid JSON."],
            warnings: [],
          };
        }
        printJson(result);
        if (!result.valid) {
          process.exitCode = 2;
        }
      },
    }),
    add: defineCommand({
      meta: {
        name: "add",
        description: "Create a new preference and seed the always-on core when it qualifies.",
      },
      args: {
        ...rootArgument,
        id: { type: "string", description: "Kebab-case preference identifier.", required: true },
        text: { type: "string", description: "Preference statement text.", required: true },
        weight: { type: "string", description: "Importance from 1 through 5.", required: true },
        status: { type: "string", description: "Optional status (law, active, proposed, probation, retired).", required: false },
        date: { type: "string", description: "Optional ISO date (YYYY-MM-DD). Defaults to today.", required: false },
        core: { type: "boolean", description: "Force core membership regardless of weight.", required: false },
      },
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        const status = optionalPreferenceStatus(args, "status");
        const date = optionalLedgerDate(args, "date");
        const core = optionalBoolean(args, "core");
        const id = requiredString(args, "id");
        const next = addPreference(ledger, {
          id,
          text: requiredString(args, "text"),
          weight: requiredPreferenceWeight(args, "weight"),
          ...(status === undefined ? {} : { status }),
          ...(date === undefined ? {} : { date }),
          ...(core === undefined ? {} : { core }),
        });
        await savePreferenceLedger(root, next);
        const preference = next.preferences.find((item) => item.id === id);
        let regenerated = false;
        if (preference && shouldAutoRegen(preference)) {
          await writePreferenceCore(root, next);
          await syncPreferenceMirrors(root, next);
          regenerated = true;
        }
        printJson({ preference, regenerated });
      },
    }),
    list: defineCommand({
      meta: {
        name: "list",
        description: "List preferences with optional deterministic filters.",
      },
      args: {
        ...rootArgument,
        status: {
          type: "string",
          description: "Filter by preference status.",
          required: false,
        },
        domain: {
          type: "string",
          description: "Filter by preference domain.",
          required: false,
        },
        "min-weight": {
          type: "string",
          description: "Filter to weights from 1 through 5.",
          required: false,
        },
        "stale-days": {
          type: "string",
          description: "Filter to preferences older than this many days.",
          required: false,
        },
      },
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        const status = optionalPreferenceStatus(args, "status");
        const domain = optionalString(args, "domain");
        const minWeight = optionalPreferenceWeight(args, "min-weight");
        const staleDays = optionalNonNegativeInteger(args, "stale-days");
        printJson({
          preferences: listPreferences(ledger, {
            ...(status === undefined ? {} : { status }),
            ...(domain === undefined ? {} : { domain }),
            ...(minWeight === undefined ? {} : { minWeight }),
            ...(staleDays === undefined ? {} : { staleDays }),
          }),
        });
      },
    }),
    regen: defineCommand({
      meta: {
        name: "regen",
        description: "Regenerate the preference core and portable loader mirrors.",
      },
      args: rootArgument,
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        await writePreferenceCore(root, ledger);
        const mirrors = await syncPreferenceMirrors(root, ledger);
        printJson({
          core_path: PREFERENCE_CORE_RELATIVE_PATH,
          loader_mirrors: mirrors,
        });
      },
    }),
    log: defineCommand({
      meta: {
        name: "log",
        description: "Append evidence to an existing preference atomically.",
      },
      args: {
        ...rootArgument,
        id: {
          type: "string",
          description: "Existing preference identifier.",
          required: true,
        },
        signal: {
          type: "string",
          description: "Non-empty evidence signal to record.",
          required: true,
        },
        weight: {
          type: "string",
          description: "Optional replacement weight from 1 through 5.",
          required: false,
        },
        status: {
          type: "string",
          description: "Optional replacement status.",
          required: false,
        },
        date: {
          type: "string",
          description: "Optional ISO event date (YYYY-MM-DD).",
          required: false,
        },
        quote: {
          type: "string",
          description: "Optional supporting quote.",
          required: false,
        },
      },
      async run({ args }) {
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const ledger = await loadPreferenceLedger(root);
        const id = requiredString(args, "id");
        const signal = requiredString(args, "signal");
        const weight = optionalPreferenceWeight(args, "weight");
        const status = optionalPreferenceStatus(args, "status");
        const date = optionalLedgerDate(args, "date");
        const quote = optionalString(args, "quote");
        const next = logPreference(ledger, id, {
          signal,
          ...(weight === undefined ? {} : { weight }),
          ...(status === undefined ? {} : { status }),
          ...(date === undefined ? {} : { date }),
          ...(quote === undefined ? {} : { quote }),
        });
        await savePreferenceLedger(root, next);
        const preference = next.preferences.find((item) => item.id === id);
        let regenerated = false;
        if (preference && shouldAutoRegen(preference)) {
          await writePreferenceCore(root, next);
          await syncPreferenceMirrors(root, next);
          regenerated = true;
        }
        printJson({ preference, regenerated });
      },
    }),
  },
});

const skinCommand = defineCommand({
  meta: {
    name: "skin",
    description: "Apply a portable directory naming preset through the core skin API.",
  },
  args: {
    skin: {
      type: "positional",
      description: "Directory naming preset: universal or brain.",
      required: true,
    },
    ...rootArgument,
    "dry-run": {
      type: "boolean",
      description: "Show the skin plan without changing the vault.",
      default: false,
    },
  },
  async run({ args }) {
    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfig(root);
    const dryRun = booleanArgument(args, "dry-run");
    const result = await applySkin(root, config, requiredSkinName(args), {
      ...(dryRun ? { dryRun: true } : {}),
    });

    let rescanned = false;
    if (!dryRun && result.rescan_required) {
      const updatedConfig = await loadConfig(root);
      const previousRecords = await loadCatalog(root, updatedConfig);
      const scan = await scanVault(root, updatedConfig, { previousRecords });
      await writeIndexArtifacts(root, updatedConfig, scan);
      rescanned = true;
    }

    printJson({ ...result, rescanned });
  },
});

function freeModeSetCommand(action: "on" | "off") {
  const mode = action === "on" ? "calibrated" : "off";
  return defineCommand({
    meta: {
      name: action,
      description: action === "on"
        ? "Enable Calibrated Free Mode."
        : "Disable Free Mode prompts.",
    },
    args: rootArgument,
    async run({ args }) {
      printJson(await setVaultFreeMode(optionalString(args, "root"), mode));
    },
  });
}

const freeModeCommand = defineCommand({
  meta: {
    name: "free-mode",
    description: "Configure or inspect optional Calibrated Free Mode.",
  },
  subCommands: {
    on: freeModeSetCommand("on"),
    off: freeModeSetCommand("off"),
    status: defineCommand({
      meta: {
        name: "status",
        description: "Show safe Free Mode state without exposing fingerprints.",
      },
      args: rootArgument,
      async run({ args }) {
        printJson(await getVaultFreeModeStatus(optionalString(args, "root")));
      },
    }),
    dismiss: defineCommand({
      meta: {
        name: "dismiss",
        description: "Record an opaque fingerprint so an idea is never proposed again.",
      },
      args: {
        idea: { type: "positional", description: "Short phrase describing the idea to dismiss.", required: true },
        ...rootArgument,
      },
      async run({ args }) {
        printJson(await dismissIdeaInVault(optionalString(args, "root"), requiredString(args, "idea")));
      },
    }),
    check: defineCommand({
      meta: {
        name: "check",
        description: "Check whether an idea was already dismissed. Exit code 1 means dismissed.",
      },
      args: {
        idea: { type: "positional", description: "Short phrase describing the idea to check.", required: true },
        ...rootArgument,
      },
      async run({ args }) {
        const result = await checkIdeaInVault(optionalString(args, "root"), requiredString(args, "idea"));
        printJson(result);
        if (result.dismissed) {
          process.exitCode = 1;
        }
      },
    }),
    reset: defineCommand({
      meta: {
        name: "reset",
        description: "Erase every remembered dismissal by deleting local Free Mode state.",
      },
      args: rootArgument,
      async run({ args }) {
        printJson(await resetFreeModeState(optionalString(args, "root")));
      },
    }),
  },
});

const feedbackCommand = defineCommand({
  meta: {
    name: "feedback",
    description: "Print opt-in, safe environment details for a feedback report.",
  },
  async run() {
    printNotice("Feedback is opt-in. No data has been sent.");
    printJson({
      version: ENGINE_VERSION,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      next: "Open the project issue tracker and choose the appropriate feedback template. Do not include private vault content, prompts, or secrets.",
    });
  },
});

const main = defineCommand({
  meta: {
    name: "open-brain",
    version: ENGINE_VERSION,
    description: "A local, file-based continuity layer for AI CLI assistants.",
  },
  subCommands: {
    init: initCommand,
    update: updateCommand,
    doctor: doctorCommand,
    scan: scanCommand,
    route: routeCommand,
    "loader-sync": loaderSyncCommand,
    "free-mode": freeModeCommand,
    feedback: feedbackCommand,
    gc: gcCommand,
    health: healthCommand,
    status: statusCommand,
    ingest: ingestCommand,
    prefs: prefsCommand,
    skin: skinCommand,
  },
});

await runMain(main);
