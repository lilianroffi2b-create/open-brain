import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isExpired } from "./lifecycle.js";
import { toPosixPath } from "./text.js";
import type { CatalogRecord, GraphEnvelope, VaultConfig } from "./types.js";

export const GC_PROPOSAL_SCHEMA_VERSION = 1;

export type GcCandidateReason = "expired_ephemeral" | "cold_unreferenced";
export type GcReviewDecision = "approved" | "rejected";

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

export interface GcApplyResult {
  schema_version: typeof GC_PROPOSAL_SCHEMA_VERSION;
  proposal_id: string;
  applied_at: string;
  review: GcReview;
  candidates: Array<GcCandidate & { current: "unchanged" | "changed" | "missing" }>;
  deleted_count: 0;
  report_path: string;
}

export interface GcProposalOptions {
  graph?: GraphEnvelope;
  now?: Date;
}

function pathPrefix(rootLabel: string, relativePath: string): string {
  return `${rootLabel}/${toPosixPath(relativePath).replace(/^\/+|\/+$/gu, "")}/`;
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

/**
 * Produces a reviewable proposal only. It never writes, moves, or deletes
 * vault content. Master, index, and already archived records are excluded.
 */
export function proposeGc(
  records: readonly CatalogRecord[],
  config: VaultConfig,
  options: GcProposalOptions = {},
): GcProposal {
  const now = options.now ?? new Date();
  const incoming = new Set(options.graph?.edges.map((edge) => edge.target) ?? []);
  const indexPrefix = pathPrefix(config.root_label, config.paths.index);
  const archivePrefix = pathPrefix(config.root_label, config.paths.archive);

  const candidates = records
    .flatMap((record): GcCandidate[] => {
      if (
        record.lifecycle === "master" ||
        record.path.startsWith(indexPrefix) ||
        record.path.startsWith(archivePrefix)
      ) {
        return [];
      }

      if (record.lifecycle === "ephemeral" && isExpired(record.expires, now)) {
        return [{
          path: record.path,
          sha256: record.sha256,
          lifecycle: record.lifecycle,
          tier: record.tier,
          reason: "expired_ephemeral",
        }];
      }

      if (record.tier === "cold" && !incoming.has(record.path)) {
        return [{
          path: record.path,
          sha256: record.sha256,
          lifecycle: record.lifecycle,
          tier: record.tier,
          reason: "cold_unreferenced",
        }];
      }

      return [];
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
 * Applies only an explicitly approved proposal. Applying records a durable,
 * non-destructive review report. It never deletes, moves, or overwrites vault
 * content, including candidates that are still unchanged.
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

  const currentByPath = new Map(
    currentRecords.map((record) => [record.path, record.sha256]),
  );
  const candidates = proposal.candidates.map((candidate) => {
    const currentHash = currentByPath.get(candidate.path);
    const current: GcApplyResult["candidates"][number]["current"] = currentHash === undefined
      ? "missing"
      : currentHash === candidate.sha256
        ? "unchanged"
        : "changed";
    return { ...candidate, current };
  });
  const reportRelativePath = join(
    config.paths.index,
    "gc-proposals",
    `${proposal.id}.applied.json`,
  );
  const result: GcApplyResult = {
    schema_version: GC_PROPOSAL_SCHEMA_VERSION,
    proposal_id: proposal.id,
    applied_at: now.toISOString(),
    review: { ...proposal.review },
    candidates,
    deleted_count: 0,
    report_path: toPosixPath(reportRelativePath),
  };

  await writeAtomic(
    join(root, reportRelativePath),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}
