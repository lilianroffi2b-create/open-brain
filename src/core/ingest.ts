import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import { extractHeadings, extractSummary, sha256, toPosixPath } from "./text.js";
import type { VaultConfig } from "./types.js";

export type IngestDocumentKind = "text" | "json" | "conversation";

export interface IngestDocument {
  title: string;
  body: string;
  kind: IngestDocumentKind;
}

export interface IngestedSource {
  source_path: string;
  archive_path: string;
  brief_paths: string[];
}

export interface IngestFailure {
  source_path: string;
  error: string;
}

export interface IngestReport {
  imported: IngestedSource[];
  failures: IngestFailure[];
  ignored: string[];
  inbox_cleared: number;
}

export interface IngestOptions {
  now?: Date;
  batchId?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeName(value: string): string {
  const compact = value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return compact || "import";
}

const UNICODE_REPLACEMENT = String.fromCharCode(0xfffd);

function decodeIngestContent(bytes: Buffer): string {
  const utf8 = bytes.toString("utf8");
  return utf8.includes(UNICODE_REPLACEMENT) ? bytes.toString("latin1") : utf8;
}

function batchIdentifier(now: Date, supplied?: string): string {
  if (supplied && /^[a-z0-9][a-z0-9_-]*$/u.test(supplied)) {
    return supplied;
  }
  return `${now.toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function stringParts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    : [];
}

function conversationNodeText(node: JsonRecord): string | undefined {
  const message = node.message;
  if (!isRecord(message)) {
    return undefined;
  }
  const role = isRecord(message.author) ? nonEmptyString(message.author.role) : undefined;
  const content = isRecord(message.content) ? message.content : undefined;
  const parts = content ? stringParts(content.parts) : [];
  if (parts.length === 0) {
    return undefined;
  }
  return `## ${role ?? "message"}\n\n${parts.join("\n")}`;
}

function childIds(node: JsonRecord): string[] {
  return Array.isArray(node.children)
    ? node.children.filter((child): child is string => typeof child === "string").sort()
    : [];
}

function transcriptFromMapping(mapping: JsonRecord): string {
  const referenced = new Set<string>();
  for (const node of Object.values(mapping)) {
    if (isRecord(node)) {
      for (const child of childIds(node)) {
        referenced.add(child);
      }
    }
  }

  const roots = Object.keys(mapping)
    .filter((id) => !referenced.has(id))
    .sort();
  const visited = new Set<string>();
  const parts: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const node = mapping[id];
    if (!isRecord(node)) {
      return;
    }
    const text = conversationNodeText(node);
    if (text) {
      parts.push(text);
    }
    for (const child of childIds(node)) {
      visit(child);
    }
  };

  for (const root of roots) {
    visit(root);
  }
  for (const id of Object.keys(mapping).sort()) {
    visit(id);
  }

  return parts.join("\n\n");
}

function conversationObjects(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  if (isRecord(value.mapping)) {
    return [value];
  }
  if (Array.isArray(value.conversations)) {
    return value.conversations.filter(isRecord);
  }
  return [];
}

/**
 * Traverses the public ChatGPT export mapping shape without retaining provider
 * metadata beyond the readable message sequence.
 */
export function extractChatGptConversations(value: unknown): IngestDocument[] {
  return conversationObjects(value)
    .flatMap((conversation, index): IngestDocument[] => {
      if (!isRecord(conversation.mapping)) {
        return [];
      }
      const body = transcriptFromMapping(conversation.mapping);
      if (!body) {
        return [];
      }
      return [{
        title: nonEmptyString(conversation.title) ?? `Conversation ${index + 1}`,
        body,
        kind: "conversation",
      }];
    });
}

export function extractIngestDocuments(
  fileName: string,
  content: string,
): IngestDocument[] {
  const extension = extname(fileName).toLowerCase();
  const title = basename(fileName, extension) || "Imported document";

  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    return content.trim()
      ? [{ title, body: content, kind: "text" }]
      : [];
  }

  if (extension !== ".json") {
    return [];
  }

  const value = JSON.parse(content) as unknown;
  const conversations = extractChatGptConversations(value);
  if (conversations.length > 0) {
    return conversations;
  }

  return [{
    title,
    body: JSON.stringify(value, null, 2),
    kind: "json",
  }];
}

function renderBrief(
  document: IngestDocument,
  archivePath: string,
  now: Date,
): string {
  const headings = extractHeadings(document.body);
  const summary = extractSummary(document.body, headings, 900) || "Imported content.";
  const extract = document.body.trim().slice(0, 4_000);
  return [
    "---",
    "lifecycle: working",
    `source: ${archivePath}`,
    `ingested_at: ${now.toISOString()}`,
    "---",
    `# ${document.title.replace(/[\r\n]+/gu, " ")}`,
    "",
    summary,
    "",
    "## Extract",
    "",
    extract,
    "",
  ].join("\n");
}

async function writeAtomically(path: string, content: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function inboxFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await inboxFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Imports supported inbox files. Raw bytes are archived and all brief writes
 * must succeed before the original inbox file is removed.
 */
export async function ingestInbox(
  root: string,
  config: VaultConfig,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const now = options.now ?? new Date();
  const batch = batchIdentifier(now, options.batchId);
  const inboxRoot = join(root, config.paths.inbox);
  const report: IngestReport = {
    imported: [],
    failures: [],
    ignored: [],
    inbox_cleared: 0,
  };

  for (const sourcePath of await inboxFiles(inboxRoot)) {
    const relativeSourcePath = toPosixPath(relative(inboxRoot, sourcePath));
    const extension = extname(sourcePath).toLowerCase();
    if (![".txt", ".md", ".markdown", ".json"].includes(extension)) {
      report.ignored.push(relativeSourcePath);
      continue;
    }

    try {
      const bytes = await readFile(sourcePath);
      const content = decodeIngestContent(bytes);
      const documents = extractIngestDocuments(sourcePath, content);
      if (documents.length === 0) {
        report.ignored.push(relativeSourcePath);
        continue;
      }

      const archiveRelativePath = toPosixPath(join(
        config.paths.archive,
        "imports",
        batch,
        relativeSourcePath,
      ));
      await writeAtomically(join(root, archiveRelativePath), bytes);

      const sourceStem = safeName(basename(sourcePath, extension));
      const sourceFingerprint = sha256(relativeSourcePath).slice(0, 12);
      const briefPaths: string[] = [];
      for (const [index, document] of documents.entries()) {
        const suffix = documents.length === 1 ? "" : `-${String(index + 1).padStart(3, "0")}`;
        const briefRelativePath = toPosixPath(join(
          config.paths.memory,
          "briefs",
          batch,
          `${sourceStem}-${sourceFingerprint}${suffix}.brief.md`,
        ));
        await writeAtomically(
          join(root, briefRelativePath),
          renderBrief(document, archiveRelativePath, now),
        );
        briefPaths.push(briefRelativePath);
      }

      await unlink(sourcePath);
      report.imported.push({
        source_path: relativeSourcePath,
        archive_path: archiveRelativePath,
        brief_paths: briefPaths,
      });
      report.inbox_cleared += 1;
    } catch (error) {
      report.failures.push({
        source_path: relativeSourcePath,
        error: error instanceof Error ? error.message : "Unknown ingest failure.",
      });
    }
  }

  return report;
}
