import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import { ExpectedError } from "./errors.js";
import { atomicWriteText, fsyncDirectory } from "./fs-atomic.js";
import { isInsideVault } from "./scan.js";
import { extractHeadings, extractSummary, sha256, toPosixPath } from "./text.js";
import type { VaultConfig } from "./types.js";

/**
 * Traversal bounds. An export file is arbitrary data from somewhere else, so
 * nothing about its shape can be trusted: a conversation graph deep enough to
 * exhaust the call stack used to raise a bare RangeError and lose the whole
 * file, and an inbox tree with a symlink loop used to walk forever.
 */
export const MAX_CONVERSATION_NODES = 200_000;
export const MAX_INGEST_DEPTH = 32;
export const MAX_INGEST_FILES = 50_000;

export type IngestDocumentKind = "text" | "json" | "conversation";

export interface IngestDocument {
  title: string;
  body: string;
  kind: IngestDocumentKind;
  /** Nodes dropped because the document hit MAX_CONVERSATION_NODES. */
  truncated?: number;
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
  /** Conversation nodes dropped because a document hit the traversal bound. */
  truncated: number;
  /** One line per bound that bit, so a partial import is never silent. */
  notices: string[];
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

/**
 * Walks the conversation graph with an explicit stack rather than recursion. A
 * chain of tens of thousands of nodes overflows the V8 call stack, and the
 * RangeError that follows used to discard the entire file. A stack has no such
 * ceiling, and the node bound turns an unbounded document into a partial import
 * that says how much it left behind.
 */
function transcriptFromMapping(
  mapping: JsonRecord,
  maxNodes: number,
): { text: string; truncated: number } {
  const referenced = new Set<string>();
  for (const node of Object.values(mapping)) {
    if (isRecord(node)) {
      for (const child of childIds(node)) {
        referenced.add(child);
      }
    }
  }

  const ids = Object.keys(mapping).sort();
  const roots = ids.filter((id) => !referenced.has(id));
  const visited = new Set<string>();
  const parts: string[] = [];
  let capped = false;

  for (const start of [...roots, ...ids]) {
    if (capped) {
      break;
    }
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || visited.has(id)) {
        continue;
      }
      if (visited.size >= maxNodes) {
        capped = true;
        break;
      }
      visited.add(id);
      const node = mapping[id];
      if (!isRecord(node)) {
        continue;
      }
      const text = conversationNodeText(node);
      if (text) {
        parts.push(text);
      }
      const children = childIds(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) {
          stack.push(child);
        }
      }
    }
  }

  return {
    text: parts.join("\n\n"),
    truncated: capped ? ids.filter((id) => !visited.has(id)).length : 0,
  };
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
export interface ConversationExtractOptions {
  /** Traversal bound. Defaults to MAX_CONVERSATION_NODES. */
  maxNodes?: number;
}

export function extractChatGptConversations(
  value: unknown,
  options: ConversationExtractOptions = {},
): IngestDocument[] {
  const maxNodes = options.maxNodes ?? MAX_CONVERSATION_NODES;
  return conversationObjects(value)
    .flatMap((conversation, index): IngestDocument[] => {
      if (!isRecord(conversation.mapping)) {
        return [];
      }
      const transcript = transcriptFromMapping(conversation.mapping, maxNodes);
      if (!transcript.text) {
        return [];
      }
      return [{
        title: nonEmptyString(conversation.title) ?? `Conversation ${index + 1}`,
        body: transcript.text,
        kind: "conversation",
        ...(transcript.truncated > 0 ? { truncated: transcript.truncated } : {}),
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

/**
 * Byte-mode twin of atomicWriteText, for the raw source archive. The shared
 * helper takes UTF-8 text, and an imported file must be archived byte for byte:
 * re-encoding it would corrupt anything that is not valid UTF-8. The publication
 * sequence is identical: same-directory temp file, flush, rename, flush parent.
 */
async function atomicWriteBytes(path: string, content: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(directory);
}

/**
 * Lists the inbox with a depth bound, a file bound, and a real-path guard.
 * The inbox is the one directory whose contents come from outside, so a symlink
 * loop, a link out of the vault, or a pathological tree must all be refused
 * loudly instead of walked.
 */
async function inboxFiles(
  inboxRoot: string,
  vaultRealPath: string,
  current: string = inboxRoot,
  depth = 0,
  visited: Set<string> = new Set(),
  files: string[] = [],
): Promise<string[]> {
  if (depth > MAX_INGEST_DEPTH) {
    throw new ExpectedError(
      `The inbox nests deeper than ${String(MAX_INGEST_DEPTH)} directories at ${relative(inboxRoot, current)}. Flatten it, then run ingest again.`,
    );
  }

  let currentReal: string;
  try {
    currentReal = await realpath(current);
  } catch {
    return files;
  }
  if (visited.has(currentReal) || !isInsideVault(vaultRealPath, currentReal)) {
    return files;
  }
  visited.add(currentReal);

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    let entryIsDirectory = entry.isDirectory();
    let entryIsFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Same policy as the scan: a link that resolves outside the vault is
      // refused, and a link inside it is followed like any other entry.
      const target = await realpath(path).catch(() => undefined);
      if (target === undefined || !isInsideVault(vaultRealPath, target)) {
        continue;
      }
      const resolved = await stat(path).catch(() => undefined);
      if (resolved === undefined) {
        continue;
      }
      entryIsDirectory = resolved.isDirectory();
      entryIsFile = resolved.isFile();
    }
    if (entryIsDirectory) {
      await inboxFiles(inboxRoot, vaultRealPath, path, depth + 1, visited, files);
    } else if (entryIsFile) {
      if (files.length >= MAX_INGEST_FILES) {
        throw new ExpectedError(
          `The inbox holds more than ${String(MAX_INGEST_FILES)} files. Import it in smaller batches.`,
        );
      }
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
    truncated: 0,
    notices: [],
  };
  const vaultRealPath = await realpath(root).catch(() => root);

  for (const sourcePath of await inboxFiles(inboxRoot, vaultRealPath)) {
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
      await atomicWriteBytes(join(root, archiveRelativePath), bytes);

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
        await atomicWriteText(
          join(root, briefRelativePath),
          renderBrief(document, archiveRelativePath, now),
        );
        briefPaths.push(briefRelativePath);
        if (document.truncated !== undefined && document.truncated > 0) {
          report.truncated += document.truncated;
          report.notices.push(
            `${relativeSourcePath}: conversation "${document.title}" exceeds the supported node limit (${String(MAX_CONVERSATION_NODES)}). The first ${String(MAX_CONVERSATION_NODES)} nodes were imported; ${String(document.truncated)} were skipped.`,
          );
        }
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
