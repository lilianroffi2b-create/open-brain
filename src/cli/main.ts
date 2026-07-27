import pc from "picocolors";
import { defineCommand, runCommand, runMain } from "citty";
import { join, resolve } from "node:path";

import { loadCatalog } from "../core/catalog.js";
import { ExpectedError } from "../core/errors.js";
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
import { loadRouting, routeVault, suggestRoutes } from "../core/route.js";
import { runVaultScan } from "../core/scan.js";
import { applySkin, type SkinName } from "../core/skin.js";
import { getVaultStatus } from "../core/status.js";
import {
  assertHumanPresence,
  humanPresenceFromStdin,
  UNATTENDED_DESCRIPTION,
  UNATTENDED_FLAG,
  UNATTENDED_WARNING,
} from "../gate/presence.js";
import {
  isLedgerDate,
  isPreferenceStatus,
  isPreferenceWeight,
  listPreferences,
  loadPreferenceLedger,
  PREFERENCE_CORE_RELATIVE_PATH,
  PREFERENCE_LEDGER_RELATIVE_PATH,
  regeneratePreferenceOutputs,
  runPreferenceOperation,
  validatePreferenceLedger,
  withPreferenceLock,
  type PreferenceStatus,
  type PreferenceWeight,
} from "../prefs/index.js";
import { capabilitiesCommand } from "./commands/capabilities.js";
import { captureCommand } from "./commands/capture.js";
import { classifyCommand } from "./commands/classify.js";
import { guardCommand } from "./commands/guard.js";
import { hookCommand } from "./commands/hook.js";
import { hooksCommand } from "./commands/hooks.js";
import { learnCommand } from "./commands/learn.js";
import { onboardingCommand } from "./commands/onboarding.js";
import { parityCommand } from "./commands/parity.js";
import { stagingCommand } from "./commands/staging.js";
import { syncCommand } from "./commands/sync.js";
import { transcriptsCommand } from "./commands/transcripts.js";
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
import {
  booleanArgument,
  isRecord,
  loadConfigForCli,
  optionalBoolean,
  optionalNonNegativeInteger,
  optionalString,
  printJson,
  printNotice,
  requiredString,
  rootArgument,
} from "./shared.js";

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
    throw new ExpectedError(`--${name} must be an integer from 1 through 5.`);
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
    throw new ExpectedError(`--${name} must be a valid preference status.`);
  }
  return value;
}

function requiredPreferenceWeight(args: unknown, name: string): PreferenceWeight {
  const weight = optionalPreferenceWeight(args, name);
  if (weight === undefined) {
    throw new ExpectedError(`--${name} requires an integer from 1 through 5.`);
  }
  return weight;
}

function optionalLedgerDate(args: unknown, name: string): string | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!isLedgerDate(value)) {
    throw new ExpectedError(`--${name} must be an ISO date (YYYY-MM-DD).`);
  }
  return value;
}

/**
 * The second door into the preference kernel.
 *
 * `prefs add` and `prefs log` write it directly, on purpose: a preference the
 * user states by typing the whole statement themselves is a human decision, and
 * routing it through a staging batch would be ceremony, not safety. What is not
 * acceptable is that this door asks for less than `sync validate` does, because
 * the weaker door is the one that defines the real guarantee. Both now demand
 * the same thing: a terminal on standard input, or the documented flag that
 * says out loud it is writing with no human present.
 *
 * There is no confirmation token here and there does not need to be. The token
 * proves that somebody read a text the machine wrote; here the text is typed in
 * the same command by the person the presence check is about.
 */
function assertPreferenceWriteIsHuman(args: unknown, command: string): boolean {
  const unattended = booleanArgument(args, UNATTENDED_FLAG);
  assertHumanPresence(humanPresenceFromStdin(unattended), `\`open-brain ${command}\``);
  return unattended;
}

const unattendedArgument = {
  unattended: {
    type: "boolean",
    description: UNATTENDED_DESCRIPTION,
    default: false,
  },
} as const;

const operationIdArgument = {
  "operation-id": {
    type: "string",
    description:
      "Idempotency key. Replaying the same operation id with the same payload changes nothing and reports the replay.",
    required: false,
  },
} as const;

function requiredSkinName(args: unknown): SkinName {
  const skin = requiredString(args, "skin");
  if (skin !== "universal" && skin !== "brain") {
    throw new ExpectedError("skin must be either universal or brain.");
  }
  return skin;
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
    throw new ExpectedError("GC proposal does not match the expected OpenBrain format.");
  }
  return value;
}

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
    if (result.redline.tampered) {
      printNotice(
        "The preference kernel changed outside its recorded write paths. Review `redline` in this report before trusting it.",
      );
      process.exitCode = 2;
    }
    for (const issue of result.capabilityIssues) {
      printNotice(issue);
      process.exitCode = 2;
    }
    if (result.preferenceKernelAliases.length > 0) {
      printNotice(
        `${String(result.preferenceKernelAliases.length)} symlink(s) resolve to a protected preference kernel file: ${result.preferenceKernelAliases.join(", ")}. A write through one of them would not be seen as a kernel write.`,
      );
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
    const config = await loadConfigForCli(root);
    const written = await runVaultScan(root, config);
    printJson(written.scan);
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
    const config = await loadConfigForCli(root);
    if (booleanArgument(args, "suggest")) {
      const minDocs = optionalNonNegativeInteger(args, "min-docs") ?? 5;
      printJson(await suggestRoutes(root, config, minDocs));
      return;
    }
    const query = optionalString(args, "query");
    if (!query) {
      throw new ExpectedError("route requires a non-empty query unless --suggest is used.");
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
    const config = await loadConfigForCli(root);
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
      throw new ExpectedError("Use only one of --write, --approve, or --apply per gc command.");
    }
    if (reviewer !== undefined && approvalPath === undefined) {
      throw new ExpectedError("--reviewer can only be used with --approve.");
    }

    const root = await resolveVaultRoot(optionalString(args, "root"));
    const config = await loadConfigForCli(root);
    const records = await loadCatalog(root, config);

    if (approvalPath !== undefined) {
      if (!reviewer) {
        throw new ExpectedError("GC approval requires --reviewer with a non-empty value.");
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
    const config = await loadConfigForCli(root);
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
    const config = await loadConfigForCli(root);
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
    const config = await loadConfigForCli(root);
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
        ...operationIdArgument,
        ...unattendedArgument,
      },
      async run({ args }) {
        const unattended = assertPreferenceWriteIsHuman(args, "prefs add");
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const status = optionalPreferenceStatus(args, "status");
        const date = optionalLedgerDate(args, "date");
        const core = optionalBoolean(args, "core");
        const operationId = optionalString(args, "operation-id");
        const id = requiredString(args, "id");
        const result = await runPreferenceOperation(
          root,
          {
            kind: "add",
            id,
            text: requiredString(args, "text"),
            weight: requiredPreferenceWeight(args, "weight"),
            ...(status === undefined ? {} : { status }),
            ...(date === undefined ? {} : { date }),
            ...(core === undefined ? {} : { core }),
            ...(operationId === undefined ? {} : { operationId }),
          },
          { command: "prefs add" },
        );
        if (result.outcome.kind === "conflict") {
          throw new ExpectedError(result.outcome.detail);
        }
        printJson({
          preference: result.preference,
          regenerated: result.regenerated,
          replayed: result.outcome.kind === "replayed",
        });
        if (unattended) {
          process.stderr.write(`${UNATTENDED_WARNING}\n`);
        }
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
        const mirrors = await withPreferenceLock(root, async () => {
          const ledger = await loadPreferenceLedger(root);
          return regeneratePreferenceOutputs(root, ledger, { command: "prefs regen" });
        });
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
        ...operationIdArgument,
        ...unattendedArgument,
      },
      async run({ args }) {
        const unattended = assertPreferenceWriteIsHuman(args, "prefs log");
        const root = await resolveVaultRoot(optionalString(args, "root"));
        const id = requiredString(args, "id");
        const signal = requiredString(args, "signal");
        const weight = optionalPreferenceWeight(args, "weight");
        const status = optionalPreferenceStatus(args, "status");
        const date = optionalLedgerDate(args, "date");
        const quote = optionalString(args, "quote");
        const operationId = optionalString(args, "operation-id");
        const result = await runPreferenceOperation(
          root,
          {
            kind: "log",
            id,
            signal,
            ...(weight === undefined ? {} : { weight }),
            ...(status === undefined ? {} : { status }),
            ...(date === undefined ? {} : { date }),
            ...(quote === undefined ? {} : { quote }),
            ...(operationId === undefined ? {} : { operationId }),
          },
          { command: "prefs log" },
        );
        if (result.outcome.kind === "conflict") {
          throw new ExpectedError(result.outcome.detail);
        }
        printJson({
          preference: result.preference,
          regenerated: result.regenerated,
          replayed: result.outcome.kind === "replayed",
        });
        if (unattended) {
          process.stderr.write(`${UNATTENDED_WARNING}\n`);
        }
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
    const config = await loadConfigForCli(root);
    const dryRun = booleanArgument(args, "dry-run");
    const result = await applySkin(root, config, requiredSkinName(args), {
      ...(dryRun ? { dryRun: true } : {}),
    });

    let rescanned = false;
    if (!dryRun && result.rescan_required) {
      const updatedConfig = await loadConfigForCli(root);
      await runVaultScan(root, updatedConfig);
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
    hook: hookCommand,
    hooks: hooksCommand,
    staging: stagingCommand,
    guard: guardCommand,
    sync: syncCommand,
    classify: classifyCommand,
    transcripts: transcriptsCommand,
    capture: captureCommand,
    onboarding: onboardingCommand,
    capabilities: capabilitiesCommand,
    learn: learnCommand,
    parity: parityCommand,
  },
});

// citty raises a CLIError (name "CLIError") for user-facing usage problems
// such as a missing required flag or an unknown command.
function isCittyUsageError(error: unknown): boolean {
  return error instanceof Error && error.name === "CLIError";
}

// A user who typed no command or an unknown command needs the full usage
// block, not just an error line. Both failures are raised before any command
// logic runs, so replaying them through citty is side-effect free.
function needsUsageRendering(error: unknown): boolean {
  if (!isCittyUsageError(error) || !("code" in (error as Error))) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "E_NO_COMMAND" || code === "E_UNKNOWN_COMMAND";
}

function printExpectedError(message: string): void {
  process.stderr.write(`${pc.red("ERROR")} ${message}\n`);
}

// Drives citty directly so expected errors print a single clean stderr line
// with no stack frames and no duplicated message. Help, version, no-command,
// and unknown-command keep citty's full usage rendering (citty prints usage
// plus one message for its own CLIError, without a stack). Unexpected errors
// keep their stack.
async function runCli(rawArgs: string[]): Promise<void> {
  const wantsHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
  if (wantsHelp) {
    await runMain(main, { rawArgs });
    return;
  }
  // --version answers the same question wherever it appears, at the top level
  // or on any subcommand, so it is handled once here rather than left to
  // citty, which only recognizes it on the command actually being run.
  if (rawArgs.includes("--version")) {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return;
  }
  try {
    await runCommand(main, { rawArgs });
  } catch (error) {
    if (needsUsageRendering(error)) {
      // Deterministic replay: citty renders usage, prints the message once,
      // and exits with code 1.
      await runMain(main, { rawArgs });
      return;
    }
    if (error instanceof ExpectedError || isCittyUsageError(error)) {
      printExpectedError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await runCli(process.argv.slice(2));
