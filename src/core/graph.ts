import { basename, extname } from "node:path/posix";

import { SCHEMA_VERSION, type CatalogRecord, type GraphEnvelope } from "./types.js";
import { normalize } from "./text.js";

export function stripRootLabel(recordPath: string, rootLabel: string): string {
  const prefix = rootLabel + "/";
  return recordPath.startsWith(prefix) ? recordPath.slice(prefix.length) : recordPath;
}

export function cleanLinkTarget(link: string): string | undefined {
  let value = link.split("#", 1)[0]?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (
    lower.startsWith("http://")
    || lower.startsWith("https://")
    || lower.startsWith("mailto:")
    || lower.startsWith("file:")
    || value.startsWith("/")
    || /^[a-z]:[\\/]/iu.test(value)
  ) {
    return undefined;
  }
  if (!/[a-z0-9]/iu.test(value)) {
    return undefined;
  }
  value = value.replace(/^(\.\/|\.\.\/)+/u, "").replace(/^\/+/u, "");
  return value || undefined;
}

function withoutMarkdownExtension(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

function stem(value: string): string {
  const name = basename(value);
  const suffix = extname(name);
  return suffix ? name.slice(0, -suffix.length) : name;
}

export function buildGraph(
  records: CatalogRecord[],
  rootLabel: string,
  now = new Date(),
): GraphEnvelope {
  const byRelativePath = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  const domainByPath = new Map<string, string>();

  for (const record of records) {
    const relative = normalize(stripRootLabel(record.path, rootLabel));
    byRelativePath.set(relative, record.path);
    byRelativePath.set(withoutMarkdownExtension(relative), record.path);
    const key = normalize(stem(relative));
    byStem.set(key, [...(byStem.get(key) ?? []), record.path]);
    domainByPath.set(record.path, record.domain);
  }

  const edges: GraphEnvelope["edges"] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const link of record.links) {
      const cleaned = cleanLinkTarget(link);
      if (!cleaned) {
        continue;
      }
      const normalizedTarget = normalize(cleaned);
      let target = byRelativePath.get(normalizedTarget)
        ?? byRelativePath.get(withoutMarkdownExtension(normalizedTarget));

      if (!target) {
        const candidates = byStem.get(normalize(stem(cleaned))) ?? [];
        if (candidates.length === 1) {
          target = candidates[0];
        } else if (candidates.length > 1) {
          const sameDomain = candidates.filter(
            (candidate) => domainByPath.get(candidate) === record.domain,
          );
          if (sameDomain.length === 1) {
            target = sameDomain[0];
          }
        }
      }

      const key = record.path + "\u0000" + (target ?? "");
      if (target && target !== record.path && !seen.has(key)) {
        edges.push({ source: record.path, target, kind: "link" });
        seen.add(key);
      }
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    root_label: rootLabel,
    nodes: records.map((record) => ({
      path: record.path,
      domain: record.domain,
      tags: [...record.tags],
    })),
    edges,
  };
}
