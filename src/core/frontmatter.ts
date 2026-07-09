import type { Lifecycle } from "./types.js";

const LIFECYCLES = new Set<Lifecycle>([
  "master",
  "working",
  "ephemeral",
  "data",
]);

export interface FrontmatterSplit {
  frontmatter: Record<string, string> | undefined;
  body: string;
}

export function splitFrontmatter(text: string): FrontmatterSplit {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) {
    return { frontmatter: undefined, body: text };
  }

  const frontmatter: Record<string, string> = {};
  const block = match[1] ?? "";
  for (const line of block.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key) {
      frontmatter[key] = line.slice(separator + 1).trim();
    }
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

export function renderFrontmatter(frontmatter: Record<string, string>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(key + ": " + value);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function readLifecycleFromText(text: string): Lifecycle | undefined {
  const lifecycle = splitFrontmatter(text).frontmatter?.lifecycle;
  return lifecycle && LIFECYCLES.has(lifecycle as Lifecycle)
    ? lifecycle as Lifecycle
    : undefined;
}

export function readExpiresFromText(text: string): string | undefined {
  return splitFrontmatter(text).frontmatter?.expires;
}
