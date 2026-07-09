import { createHash } from "node:crypto";

const CASE_FOLD_REPLACEMENTS: Readonly<Record<string, string>> = {
  "ß": "ss",
  "ς": "σ",
};

export function normalize(text: string): string {
  const decomposed = text.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase();
  return Array.from(decomposed, (character) => CASE_FOLD_REPLACEMENTS[character] ?? character).join("");
}

export function tokenize(text: string): string[] {
  return normalize(text).match(/[a-z0-9_.-]+/g)?.filter((token) => token.length > 1) ?? [];
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface DecodedText {
  bytes: Buffer;
  text: string;
  encoding: "utf-8" | "latin-1";
}

export function decodeText(bytes: Buffer): DecodedText {
  if (bytes.subarray(0, 4096).includes(0)) {
    throw new UnicodeError("binary_null_byte");
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
    return { bytes, text, encoding: "utf-8" };
  } catch {
    const text = new TextDecoder("iso-8859-1").decode(bytes);
    return { bytes, text, encoding: "latin-1" };
  }
}

export class UnicodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnicodeError";
  }
}

export function extractHeadings(text: string, limit = 6): string[] {
  const headings: string[] = [];
  const matcher = /^(#{1,6})\s+(.+?)\s*$/gmu;
  for (const match of text.matchAll(matcher)) {
    const heading = match[2];
    if (heading) {
      headings.push(heading.trim());
    }
    if (headings.length >= limit) {
      break;
    }
  }
  return headings;
}

export function extractLinks(text: string, limit = 50): string[] {
  const links: string[] = [];
  const patterns = [/\[\[([^\]]+)\]\]/gmu, /\[[^\]]+\]\(([^)]+)\)/gmu];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim() ?? "";
      if (value && !links.includes(value)) {
        links.push(value);
      }
      if (links.length >= limit) {
        return links;
      }
    }
  }
  return links;
}

export function extractSummary(text: string, headings: string[], limit = 220): string {
  const firstHeading = headings[0];
  if (firstHeading) {
    return firstHeading.slice(0, limit);
  }
  for (const line of text.split(/\r?\n/u)) {
    const compact = line.replace(/\s+/gu, " ").trim();
    if (compact) {
      return compact.slice(0, limit);
    }
  }
  return text.replace(/\s+/gu, " ").trim().slice(0, limit);
}
