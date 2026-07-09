import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { buildGraph, stripRootLabel } from "./graph.js";
import {
  activePathsFromConfig,
  gcGuardReason,
  isActive,
  isExpired,
} from "./lifecycle.js";
import { loadRouting } from "./route.js";
import { toPosixPath } from "./text.js";
import type {
  CatalogRecord,
  GraphEnvelope,
  RoutingDocument,
  VaultConfig,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const GC_PROPOSAL_SCHEMA_VERSION = 1;

export type GcCandidateReason = "expired_ephemeral" | "cold_unreferenced";
export type GcReviewDecision = "approved" | "rejected";
export type GcApplyOutcome = "archived" | "refused";

export interface GcCandidate {
  path: string;
  sha256: string;
  lifecycle: CatalogRecord["lifecycle"];
  tier: CatalogRecord["tier"];
  reason: GcCandidateReason;
}

export interface GcReview {
  decision: GcReviewDecision;
  reviewer: string;
  reviewed_at: string;
}

export interface GcProposal {
  schema_version: typeof GC_PROPOSAL_SCHEMA_VERSION;
  id: string;
  created_at: string;
  candidates: GcCandidate[];
  review?: GcReview;
}

export interface GcAppliedCandidate extends GcCandidate {
  current: "unchanged" | "changed" | "missing";
  outcome: GcApplyOutcome;
  detail: string;
  archived_to?: string;
}

export interface GcApplyResult {
  schema_version: typeof GC_PROPOSAL_SCHEMA_VERSION;
  proposal_id: string;
  applied_at: string;
  review: GcReview;
  candidates: GcAppliedCandidate[];
  archive_root: string;
  archived_count: number;
  refused_guard_count: number;
  sha_mismatch_count: number;
  missing_count: number;
  move_failed_count: number;
  report_path: string;
}

export interface GcProposalOptions {
  graph?: GraphEnvelope;
  routing?: RoutingDocument;
  now?: Date;
}

function proposalId(now: Date): string {
  return `gc-${now.toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function assertReviewableId(id: string): void {
  if (!/^gc-[a-z0-9-]+$/u.test(id)) {
    throw new TypeError("GC proposal id is invalid.");
  }
}

function writeAtomic(path: string, content: string): Promise<void> {
  return (async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  })();
}

function routingRefsFromDocument(routing: RoutingDocument | undefined): Set<string> {
  const refs = new Set<string>();
  if (!routing) {
    return refs;
  }
  for (const entry of routing.always_read) {
    refs.add(entry);
  }
  for (const route of Object.values(routing.routes)) {
    for (const target of route.read_order ?? []) {
      refs.add(target);
    }
  }
  return refs;
}

/**
 * Selection contract: an ephemeral whose `expires` date has passed, or a cold
 * document. Recency is the candidacy itself; the structural guardrails
 * (gcGuardReason) decide whether a candidate may actually be archived.
 */
function candidateReason(record: CatalogRecord, now: Date): GcCandidateReason | undefined {
  if (record.lifecycle === "ephemeral" && isExpired(record.expires, now)) {
    return "expired_ephemeral";
  }
  if (record.tier === "cold") {
    return "cold_unreferenced";
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const result = await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function updateArchiveIndex(
  archiveYearDirectory: string,
  year: string,
  rootLabel: string,
  stamp: string,
  moved: ReadonlyArray<{ rel: string; reason: GcCandidateReason }>,
): Promise<void> {
  const indexPath = join(archiveYearDirectory, "_index.md");
  const header = [
    "---",
    "lifecycle: master",
    "---",
    `# Archive ${year} (${rootLabel})`,
    "",
    "Files moved here by open-brain gc. Reversible with git or your version control.",
    "",
  ].join("\n") + "\n";
  let existing: string;
  try {
    existing = await readFile(indexPath, "utf8");
  } catch {
    existing = header;
  }
  const additions = [...moved]
    .sort((left, right) => left.rel.localeCompare(right.rel))
    .map((entry) => `- [${stamp}] ${entry.rel}  (${entry.reason})`);
  await writeAtomic(indexPath, existing.replace(/\n+$/u, "") + "\n" + additions.join("\n") + "\n");
}

/**
 * Produces a reviewable proposal only. It never writes, moves, or deletes vault
 * content. Candidacy (expired ephemeral or cold) is filtered through the full
 * structural guardrails, so masters, index pages and zones, the preferences and
 * archive zones, routing-referenced files, active-chantier docs, and any doc
 * with an incoming link are excluded from both candidate reasons.
 */
export function proposeGc(
  records: readonly CatalogRecord[],
  config: VaultConfig,
  options: GcProposalOptions = {},
): GcProposal {
  const now = options.now ?? new Date();
  const incoming = new Set(options.graph?.edges.map((edge) => edge.target) ?? []);
  const routingRefs = routingRefsFromDocument(options.routing);
  const active = activePathsFromConfig(config);

  const candidates = records
    .flatMap((record): GcCandidate[] => {
      const reason = candidateReason(record, now);
      if (!reason) {
        return [];
      }
      const rel = stripRootLabel(record.path, config.root_label);
      const guard = gcGuardReason({
        relativePath: rel,
        lifecycle: record.lifecycle,
        kind: record.kind,
        hasIncoming: incoming.has(record.path),
        active: isActive(rel, active.files, active.directories),
        routingRefs,
        config,
      });
      if (guard) {
        return [];
      }
      return [{
        path: record.path,
        sha256: record.sha256,
        lifecycle: record.lifecycle,
        tier: record.tier,
        reason,
      }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    schema_version: GC_PROPOSAL_SCHEMA_VERSION,
    id: proposalId(now),
    created_at: now.toISOString(),
    candidates,
  };
}

export function reviewGcProposal(
  proposal: GcProposal,
  decision: GcReviewDecision,
  reviewer: string,
  now: Date = new Date(),
): GcProposal {
  assertReviewableId(proposal.id);
  if (decision !== "approved" && decision !== "rejected") {
    throw new TypeError("GC review decision is invalid.");
  }
  if (!reviewer.trim()) {
    throw new TypeError("GC review requires a non-empty reviewer.");
  }

  return {
    ...proposal,
    candidates: proposal.candidates.map((candidate) => ({ ...candidate })),
    review: {
      decision,
      reviewer: reviewer.trim(),
      reviewed_at: now.toISOString(),
    },
  };
}

/**
 * Applies an explicitly approved proposal by archiving each survivor under
 * <archive>/<year>/<original path>, reversibly (git mv when the vault is a Git
 * repository, otherwise a filesystem move) and never deleting anything. Every
 * candidate is RE-VERIFIED at apply time (sha unchanged, still a candidate, all
 * guardrails still clear), the archive folder index is updated, and a durable
 * report with real counts is written. Parity with brain_gc apply.
 */
export async function applyReviewedGcProposal(
  root: string,
  config: VaultConfig,
  proposal: GcProposal,
  currentRecords: readonly CatalogRecord[],
  now: Date = new Date(),
): Promise<GcApplyResult> {
  assertReviewableId(proposal.id);
  if (!proposal.review || proposal.review.decision !== "approved") {
    throw new Error("GC proposal must be explicitly reviewed and approved before apply.");
  }

  const currentByPath = new Map(currentRecords.map((record) => [record.path, record]));
  const routing = await loadRouting(root, config);
  const routingRefs = routingRefsFromDocument(routing);
  const active = activePathsFromConfig(config);
  const incoming = new Set(
    buildGraph([...currentRecords], config.root_label).edges.map((edge) => edge.target),
  );
  const year = String(now.getUTCFullYear());
  const archiveYearRel = toPosixPath(join(config.paths.archive, year));
  const stamp = now.toISOString().slice(0, 10);
  const usesGit = await isGitRepo(root);

  const candidates: GcAppliedCandidate[] = [];
  const moved: Array<{ rel: string; reason: GcCandidateReason }> = [];
  let archivedCount = 0;
  let refusedGuardCount = 0;
  let shaMismatchCount = 0;
  let missingCount = 0;
  let moveFailedCount = 0;

  for (const candidate of proposal.candidates) {
    const currentRecord = currentByPath.get(candidate.path);
    const current: GcAppliedCandidate["current"] = currentRecord === undefined
      ? "missing"
      : currentRecord.sha256 === candidate.sha256
        ? "unchanged"
        : "changed";

    if (!currentRecord) {
      missingCount += 1;
      candidates.push({ ...candidate, current, outcome: "refused", detail: "missing_from_catalog" });
      continue;
    }
    if (current === "changed") {
      shaMismatchCount += 1;
      candidates.push({ ...candidate, current, outcome: "refused", detail: "sha_mismatch" });
      continue;
    }

    const rel = stripRootLabel(candidate.path, config.root_label);
    const reason = candidateReason(currentRecord, now);
    if (!reason) {
      refusedGuardCount += 1;
      candidates.push({ ...candidate, current, outcome: "refused", detail: "guard:not_a_candidate" });
      continue;
    }
    const guard = gcGuardReason({
      relativePath: rel,
      lifecycle: currentRecord.lifecycle,
      kind: currentRecord.kind,
      hasIncoming: incoming.has(candidate.path),
      active: isActive(rel, active.files, active.directories),
      routingRefs,
      config,
    });
    if (guard) {
      refusedGuardCount += 1;
      candidates.push({ ...candidate, current, outcome: "refused", detail: `guard:${guard}` });
      continue;
    }

    const sourceAbsolute = join(root, rel);
    if (!(await isFile(sourceAbsolute))) {
      missingCount += 1;
      candidates.push({ ...candidate, current, outcome: "refused", detail: "missing_on_disk" });
      continue;
    }

    const destinationRel = toPosixPath(join(config.paths.archive, year, rel));
    const destinationAbsolute = join(root, destinationRel);
    try {
      await mkdir(dirname(destinationAbsolute), { recursive: true });
      if (usesGit) {
        await execFileAsync("git", ["-C", root, "mv", rel, destinationRel]);
      } else {
        await rename(sourceAbsolute, destinationAbsolute);
      }
    } catch (error) {
      moveFailedCount += 1;
      const message = error instanceof Error ? error.message.slice(0, 120) : "unknown";
      candidates.push({ ...candidate, current, outcome: "refused", detail: `move_failed:${message}` });
      continue;
    }
    archivedCount += 1;
    moved.push({ rel, reason });
    candidates.push({
      ...candidate,
      current,
      outcome: "archived",
      detail: reason,
      archived_to: `${config.root_label}/${destinationRel}`,
    });
  }

  if (moved.length > 0) {
    await updateArchiveIndex(join(root, archiveYearRel), year, config.root_label, stamp, moved);
  }

  const reportRelativePath = join(config.paths.index, "gc-proposals", `${proposal.id}.applied.json`);
  const result: GcApplyResult = {
    schema_version: GC_PROPOSAL_SCHEMA_VERSION,
    proposal_id: proposal.id,
    applied_at: now.toISOString(),
    review: { ...proposal.review },
    candidates,
    archive_root: `${config.root_label}/${archiveYearRel}/`,
    archived_count: archivedCount,
    refused_guard_count: refusedGuardCount,
    sha_mismatch_count: shaMismatchCount,
    missing_count: missingCount,
    move_failed_count: moveFailedCount,
    report_path: toPosixPath(reportRelativePath),
  };

  await writeAtomic(join(root, reportRelativePath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
