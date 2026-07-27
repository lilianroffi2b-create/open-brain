import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capItems, emptyBudget, type ContextBudget } from "../core/budget.js";
import { requireCapability } from "../core/capabilities.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { atomicWriteJson, atomicWriteText } from "../core/fs-atomic.js";
import { renderFrontmatter, splitFrontmatter } from "../core/frontmatter.js";
import { lockPathFor, withLock, type LockOptions } from "../core/lock.js";
import { countCodePoints, sha256, toPosixPath } from "../core/text.js";
import type { VaultConfig } from "../core/types.js";
import { buildDecision, newDecisionId, writeEntryTolerant } from "./journal.js";
import { isLearningDisabled } from "./population.js";
import { learningDirectory } from "./store.js";
import {
  InvariantError,
  LEARNING_SCHEMA_VERSION,
  SchemaError,
  nowTs,
  validateConsolidation,
  validateLoadContract,
  type ConsolidationBlock,
  type ConsolidationEntry,
  type LoadContract,
} from "./types.js";

/**
 * The single subtractive operation of Open Brain, and the only organ that can
 * lose bytes. It moves the overflow of a bounded document into a verified
 * archive and leaves a pointer index behind; it never deletes anything.
 *
 * It is allowed to run on its own for exactly as long as its inverse is proven
 * byte for byte. That link is not a rule of conduct written in a document, it is
 * the call to verifyReversibility() at the top of applyCap(): the day the proof
 * stops being green, the autonomous path stops running, before anyone argues
 * about it.
 *
 * The window in which a concurrent writer could still overwrite the rewrite is
 * closed by the inter-process lock of core/lock.ts, not by a rename: reread and
 * write happen inside one withLock, so any writer that takes the same lock reads
 * the consolidated document rather than the one from before. A writer that takes
 * no lock is still caught by the digest reread, and then the layer aborts and
 * gives the archive back instead of overwriting the concurrent work.
 */

export const CONSOLIDATION_SUBDIRECTORY = "consolidation";
export const INDEX_START_MARKER = "<!-- load:index start -->";
export const INDEX_END_MARKER = "<!-- load:index end -->";
export const FOLDED_POINTER_LABEL = "blocks consolidated";
export const NO_SUBJECT = "(no subject)";
export const SUBJECT_MAX = 80;

/** Pointers that keep a line of their own. Older ones fold, one line per archive. */
export const DETAILED_POINTERS = 12;

export const LOAD_TRANSACTION_FILENAME = "load-transaction.flag";
export const LOAD_REFERENCES_FILENAME = "load-references.json";
export const CONSOLIDATION_LOCK_NAME = "consolidation";
export const ARCHIVE_LIFECYCLE = "data";

const POINTER_PATTERN =
  /^- (\d{4}-\d{2}-\d{2}) : (?:\+(\d+) blocks consolidated|(.*)) -> (\S+)$/u;
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/u;
const SECTION_PATTERN = /^##\s/u;

export interface Block {
  /** Position in the document, in file order. The cut never sorts. */
  index: number;
  date: string | undefined;
  subject: string;
  text: string;
}

export interface Pointer {
  date: string;
  subject: string | undefined;
  /** Number of blocks this line stands for. Absent means one. */
  count: number | undefined;
  archive: string;
}

export interface Split {
  head: string;
  blocks: Block[];
  pointers: Pointer[];
  tail: string;
  has_index: boolean;
}

export type ReferenceMode = "strict" | "bootstrap" | "resume";

export interface SystemReference {
  sha256: string;
  size: number;
  ts: string;
}

export interface LoadTransaction {
  schema_version: number;
  opened_at: string;
  document: string;
  decision: string;
  sha256_before: string;
  sha256_after: string;
  archives: string[];
}

export type ConsolidationStage =
  | "before_archive"
  | "after_archive"
  | "before_document_write"
  | "after_document_write";

export interface ConsolidationOptions {
  mode?: ReferenceMode;
  now?: string;
  /** Runs even when the OFF sentinel is set. The bypass is journaled. */
  force?: boolean;
  decisionId?: string;
  /**
   * Test seam. Each stage is one of the interruption points the source lost
   * bytes at, so a test can replay a power cut or a concurrent write exactly
   * where it hurt.
   */
  injectAt?: Partial<Record<ConsolidationStage, () => void | Promise<void>>>;
}

export interface ConsolidationReport {
  status: "consolidated" | "nothing_to_do" | "refused";
  document: string;
  mode: ReferenceMode;
  reason?: string;
  before: { size: number; sha256: string };
  after: { size: number; sha256: string };
  blocks: ConsolidationBlock[];
  deconsolidation_verified: boolean;
  /** The document as it now stands on disk. */
  text: string;
  entry?: ConsolidationEntry;
  budget: ContextBudget;
}

export interface DeconsolidationReport {
  document: string;
  /** The origin, restored from the living document and its archives. */
  text: string;
  sha256: string;
  size: number;
  blocks_restored: number;
  written: boolean;
  budget: ContextBudget;
}

export interface ReversibilityCase {
  name: string;
  ok: boolean;
  bytes: number;
  blocks_archived: number;
  sha256_before: string;
  sha256_after: string;
  detail?: string;
}

export interface ReversibilityProof {
  ok: boolean;
  checked_at: string;
  cases: ReversibilityCase[];
}

function fail(invariant: string, message: string): never {
  throw new InvariantError(invariant, message);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function archiveZone(config: VaultConfig): string {
  return `${toPosixPath(config.paths.archive)}/${CONSOLIDATION_SUBDIRECTORY}/`;
}

/**
 * Reads and validates the load contract of a bounded document. The shape and
 * the validation itself live in ./types.js with the other frozen shapes of
 * this layer; this wrapper only supplies the one thing types.ts cannot know on
 * its own, the archive zone of the vault this document belongs to.
 */
export function readLoadContract(text: string, config: VaultConfig): LoadContract {
  return validateLoadContract(text, { archiveZone: archiveZone(config) });
}

/**
 * The boundary is written by the owner of the document, so it is compiled
 * without the unicode flag on purpose: the stricter flag would refuse patterns
 * that are perfectly legal in every other tool the owner uses.
 */
function compileBoundary(pattern: string): RegExp {
  return new RegExp(pattern);
}

function boundaryOf(contract: LoadContract): RegExp {
  try {
    return compileBoundary(contract.load_boundary);
  } catch {
    return fail("load.load_boundary.regex", "load_boundary is not a valid expression.");
  }
}

/** Keeps the line terminators, so every slice can be concatenated back verbatim. */
function toLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/u);
}

function lineText(line: string): string {
  return line.replace(/\r?\n$/u, "");
}

export function blockSubject(line: string): string {
  const compact = lineText(line).replace(/\s+/gu, " ").trim();
  const withoutDate = compact.replace(/^\d{4}-\d{2}-\d{2}\s*/u, "");
  // The arrow separates a pointer line, so it cannot live inside a subject
  // without making the index ambiguous on the way back.
  const cleaned = withoutDate.replace(/->/gu, "-").trim();
  if (cleaned.length === 0) {
    return NO_SUBJECT;
  }
  const characters = Array.from(cleaned);
  return characters.length <= SUBJECT_MAX ? cleaned : characters.slice(0, SUBJECT_MAX).join("");
}

function blockDate(line: string): string | undefined {
  return DATE_PATTERN.exec(lineText(line))?.[0];
}

function parsePointer(line: string): Pointer | undefined {
  const match = POINTER_PATTERN.exec(lineText(line));
  if (!match) {
    return undefined;
  }
  const date = match[1];
  const archive = match[4];
  if (date === undefined || archive === undefined) {
    return undefined;
  }
  const folded = match[2];
  return {
    date,
    subject: folded === undefined ? match[3] ?? NO_SUBJECT : undefined,
    count: folded === undefined ? undefined : Number.parseInt(folded, 10),
    archive,
  };
}

export function pointerLine(pointer: Pointer): string {
  const body = pointer.count === undefined
    ? pointer.subject ?? NO_SUBJECT
    : `+${String(pointer.count)} ${FOLDED_POINTER_LABEL}`;
  return `- ${pointer.date} : ${body} -> ${pointer.archive}`;
}

function tileBlocks(lines: string[], boundary: RegExp, offset: number): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let currentLine = "";
  for (const line of lines) {
    if (boundary.test(lineText(line))) {
      if (current.length > 0) {
        blocks.push({
          index: blocks.length + offset,
          date: blockDate(currentLine),
          subject: blockSubject(currentLine),
          text: current.join(""),
        });
      }
      current = [line];
      currentLine = line;
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push({
      index: blocks.length + offset,
      date: blockDate(currentLine),
      subject: blockSubject(currentLine),
      text: current.join(""),
    });
  }
  return blocks;
}

/**
 * Cuts a bounded document into its head, its blocks, its pointer index, and its
 * tail. The cut keeps the order of the file and never sorts: several blocks can
 * carry the same date, and the order of the file is not always the strict
 * chronological order, so sorting would shuffle real entries.
 */
export function splitDocument(text: string, contract: LoadContract): Split {
  const boundary = boundaryOf(contract);
  const lines = toLines(text);

  const starts: number[] = [];
  const ends: number[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = lineText(line).trim();
    if (trimmed === INDEX_START_MARKER) {
      starts.push(index);
    }
    if (trimmed === INDEX_END_MARKER) {
      ends.push(index);
    }
  }
  if (starts.length > 1 || ends.length > 1) {
    fail(
      "load.index.multiple_markers",
      "This document carries more than one pointer index, which makes restoration ambiguous.",
    );
  }
  const markerStart = starts[0];
  const markerEnd = ends[0];
  if ((markerStart === undefined) !== (markerEnd === undefined)) {
    fail("load.index.corrupt", "The pointer index is missing one of its two markers.");
  }
  if (markerStart !== undefined && markerEnd !== undefined && markerEnd <= markerStart) {
    fail("load.index.corrupt", "The pointer index closes before it opens.");
  }

  let zoneStart = lines.length;
  for (const [index, line] of lines.entries()) {
    if (markerStart !== undefined && index >= markerStart) {
      break;
    }
    if (boundary.test(lineText(line))) {
      zoneStart = index;
      break;
    }
  }
  if (zoneStart === lines.length && markerStart !== undefined) {
    zoneStart = markerStart;
  }

  let zoneEnd = lines.length;
  let closedOnSection = false;
  for (let index = zoneStart; index < lines.length; index += 1) {
    if (index === markerStart) {
      zoneEnd = index;
      break;
    }
    if (index > zoneStart && SECTION_PATTERN.test(lineText(lines[index] ?? ""))) {
      zoneEnd = index;
      closedOnSection = true;
      break;
    }
  }

  // Cut 5. A zone that closes on a section heading while an index sits further
  // down would restore an empty index, therefore an origin stripped of every
  // pointer, and then a second index engraved under the first one.
  if (markerStart !== undefined && (closedOnSection || markerStart < zoneStart)) {
    fail(
      "load.index.out_of_zone",
      "The pointer index sits outside the block zone, so this document is refused rather than consolidated.",
    );
  }
  if (markerEnd !== undefined) {
    for (let index = markerEnd + 1; index < lines.length; index += 1) {
      if (boundary.test(lineText(lines[index] ?? ""))) {
        fail(
          "load.index.out_of_zone",
          "Blocks live below the pointer index, so the block zone is not where the index says it is.",
        );
      }
    }
  }

  const pointers: Pointer[] = [];
  if (markerStart !== undefined && markerEnd !== undefined) {
    for (let index = markerStart + 1; index < markerEnd; index += 1) {
      const line = lines[index] ?? "";
      if (lineText(line).trim().length === 0) {
        continue;
      }
      const pointer = parsePointer(line);
      if (!pointer) {
        fail("load.index.corrupt", `The pointer line ${JSON.stringify(lineText(line))} is unreadable.`);
      }
      pointers.push(pointer);
    }
  }

  return {
    head: lines.slice(0, zoneStart).join(""),
    blocks: tileBlocks(lines.slice(zoneStart, zoneEnd), boundary, 0),
    pointers,
    tail: markerEnd === undefined
      ? lines.slice(zoneEnd).join("")
      : lines.slice(markerEnd + 1).join(""),
    has_index: markerStart !== undefined,
  };
}

interface ParsedArchive {
  path: string;
  payload: string;
  blocks: Block[];
}

function parseArchive(
  path: string,
  text: string,
  contract: LoadContract,
  document: string,
): ParsedArchive {
  const { frontmatter, body } = splitFrontmatter(text);
  const source = frontmatter?.source;
  if (source !== undefined && unquote(source) !== document) {
    // Two bounded documents pointing at one archive directory would prepend
    // into each other and shift every pointer. The archive names its own source,
    // so that collision is a refusal rather than a silent loss.
    fail(
      "load.archive.source",
      `The archive ${path} was written for ${unquote(source)}, not for ${document}. Give each bounded document an archive directory of its own.`,
    );
  }
  const declared = frontmatter?.sha256_block;
  if (declared === undefined || declared.trim().length === 0) {
    fail(
      "load.archive.digest_missing",
      `The archive ${path} declares no block digest, so nothing can vouch for what it holds.`,
    );
  }
  const digest = sha256(body);
  if (unquote(declared) !== digest) {
    fail(
      "load.archive.digest",
      `The archive ${path} does not match the digest it declares, so restoration is refused.`,
    );
  }
  const boundary = boundaryOf(contract);
  const blocks = tileBlocks(toLines(body), boundary, 0);
  if (body.length > 0 && blocks.map((block) => block.text).join("") !== body) {
    fail(
      "load.index.block_incoherent",
      `The archive ${path} holds text outside any block, so its blocks cannot be counted.`,
    );
  }
  return { path, payload: body, blocks };
}

async function readArchives(
  root: string,
  split: Split,
  contract: LoadContract,
  document: string,
): Promise<Map<string, ParsedArchive>> {
  const archives = new Map<string, ParsedArchive>();
  for (const pointer of split.pointers) {
    if (archives.has(pointer.archive)) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(join(root, pointer.archive), "utf8");
    } catch {
      fail(
        "load.archive.missing",
        `The pointer index names ${pointer.archive}, and that archive is not there.`,
      );
    }
    archives.set(pointer.archive, parseArchive(pointer.archive, text, contract, document));
  }
  return archives;
}

/**
 * Rebuilds the origin from the living document and its archives. Two nets, both
 * independent of any state file: the digest of every archive is checked, and the
 * index must claim every block the archive holds. A block that no pointer claims
 * is the signature of an interruption between the archive and the rewrite, and
 * it is refused loudly rather than restored shifted by one.
 */
export function restoreOrigin(split: Split, archives: Map<string, ParsedArchive>): string {
  const cursors = new Map<string, number>();
  const pieces: string[] = [];
  for (const pointer of split.pointers) {
    const archive = archives.get(pointer.archive);
    if (!archive) {
      fail("load.archive.missing", `The archive ${pointer.archive} is not loaded.`);
    }
    const cursor = cursors.get(pointer.archive) ?? 0;
    const count = pointer.count ?? 1;
    const taken = archive.blocks.slice(cursor, cursor + count);
    if (taken.length !== count) {
      fail(
        "load.index.block_not_found",
        `The pointer index claims ${String(count)} block(s) that ${pointer.archive} does not hold.`,
      );
    }
    for (const block of taken) {
      pieces.push(block.text);
    }
    cursors.set(pointer.archive, cursor + count);
  }
  for (const [path, archive] of archives) {
    const consumed = cursors.get(path) ?? 0;
    if (consumed !== archive.blocks.length) {
      fail(
        "load.archive.orphan_blocks",
        `The archive ${path} holds ${String(archive.blocks.length - consumed)} block(s) that no pointer claims, so the index no longer covers it.`,
      );
    }
  }
  return split.head + split.blocks.map((block) => block.text).join("") + pieces.join("") + split.tail;
}

function renderIndex(pointers: Pointer[]): string {
  if (pointers.length === 0) {
    return "";
  }
  return [INDEX_START_MARKER, ...pointers.map(pointerLine), INDEX_END_MARKER].join("\n") + "\n";
}

function renderDocument(split: Split, keep: number, pointers: Pointer[]): string {
  const living = split.blocks.slice(0, keep).map((block) => block.text).join("");
  const index = renderIndex(pointers);
  const separator = index.length > 0 && living.length > 0 && !living.endsWith("\n") ? "\n" : "";
  return split.head + living + separator + index + split.tail;
}

/**
 * Folds the pointers past the detailed window into one line per run of
 * consecutive pointers sharing an archive. Only runs are folded, never scattered
 * pointers, because collapsing non adjacent ones would reorder the blocks they
 * stand for and break the byte exact way back.
 */
export function foldPointers(pointers: Pointer[]): Pointer[] {
  if (pointers.length <= DETAILED_POINTERS) {
    return pointers;
  }
  const detailed = pointers.slice(0, DETAILED_POINTERS);
  const rest = pointers.slice(DETAILED_POINTERS);
  const folded: Pointer[] = [];
  for (const pointer of rest) {
    const previous = folded[folded.length - 1];
    if (previous && previous.archive === pointer.archive) {
      previous.count = (previous.count ?? 1) + (pointer.count ?? 1);
      continue;
    }
    folded.push({
      date: pointer.date,
      subject: undefined,
      count: pointer.count ?? 1,
      archive: pointer.archive,
    });
  }
  return [...detailed, ...folded];
}

export function pointerWeight(pointers: readonly Pointer[]): number {
  return pointers.reduce((sum, pointer) => sum + (pointer.count ?? 1), 0);
}

interface ArchiveLot {
  archive: string;
  blocks: Block[];
  dates: string[];
}

function lotsOf(blocks: Block[], contract: LoadContract): ArchiveLot[] {
  const lots: ArchiveLot[] = [];
  for (const block of blocks) {
    if (block.date === undefined) {
      fail(
        "load.block.date.not_found",
        "A block without a readable date is never archived: what cannot be dated is not moved.",
      );
    }
    const month = block.date.slice(0, 7);
    const archive = `${contract.load_archive}/${month}.md`;
    const previous = lots[lots.length - 1];
    if (previous && previous.archive === archive) {
      previous.blocks.push(block);
      previous.dates.push(block.date);
      continue;
    }
    lots.push({ archive, blocks: [block], dates: [block.date] });
  }
  return lots;
}

function periodOf(dates: readonly string[]): string {
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    return "0000-00-00/0000-00-00";
  }
  return `${first}/${last}`;
}

export function learningFilePath(config: VaultConfig, root: string, filename: string): string {
  return join(learningDirectory(config, root), filename);
}

export function loadTransactionPath(config: VaultConfig, root: string): string {
  return learningFilePath(config, root, LOAD_TRANSACTION_FILENAME);
}

export function loadReferencesPath(config: VaultConfig, root: string): string {
  return learningFilePath(config, root, LOAD_REFERENCES_FILENAME);
}

export function consolidationLockPath(root: string): string {
  return lockPathFor(root, CONSOLIDATION_LOCK_NAME);
}

/**
 * The lock every writer of a bounded document must take. It is exported because
 * the guarantee is only worth what its other users make it worth: a writer that
 * takes this lock can never land between the reread and the rewrite.
 */
export async function withDocumentLock<T>(
  root: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return withLock(consolidationLockPath(root), fn, options);
}

export async function pendingTransaction(
  config: VaultConfig,
  root: string,
): Promise<LoadTransaction | undefined> {
  try {
    const parsed = JSON.parse(await readFile(loadTransactionPath(config, root), "utf8")) as unknown;
    return parsed as LoadTransaction;
  } catch {
    return undefined;
  }
}

interface ReferenceFile {
  schema_version: number;
  updated_at: string;
  references: Record<string, SystemReference>;
}

async function readReferenceFile(config: VaultConfig, root: string): Promise<ReferenceFile> {
  try {
    const parsed = JSON.parse(await readFile(loadReferencesPath(config, root), "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && "references" in parsed) {
      return parsed as ReferenceFile;
    }
  } catch {
    // A missing or unreadable reference file is the bootstrap case, and the
    // caller decides whether that is acceptable for the mode it was given.
  }
  return { schema_version: LEARNING_SCHEMA_VERSION, updated_at: nowTs(), references: {} };
}

export async function readSystemReference(
  config: VaultConfig,
  root: string,
  document: string,
): Promise<SystemReference | undefined> {
  return (await readReferenceFile(config, root)).references[document];
}

export async function recordSystemReference(
  config: VaultConfig,
  root: string,
  document: string,
  reference: SystemReference,
): Promise<void> {
  const file = await readReferenceFile(config, root);
  file.references[document] = reference;
  file.updated_at = reference.ts;
  file.schema_version = LEARNING_SCHEMA_VERSION;
  await atomicWriteJson(loadReferencesPath(config, root), file);
}

function decodeStrict(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("load.document.utf8", `The document ${path} is not valid UTF-8.`);
  }
}

async function readDocument(root: string, document: string): Promise<string> {
  const bytes = await readFile(join(root, document));
  return decodeStrict(bytes, document);
}

function digestPair(text: string): { size: number; sha256: string } {
  return { size: Buffer.byteLength(text, "utf8"), sha256: sha256(text) };
}

async function runStage(
  options: ConsolidationOptions,
  stage: ConsolidationStage,
): Promise<void> {
  const hook = options.injectAt?.[stage];
  if (hook) {
    await hook();
  }
}

async function journalMode(
  config: VaultConfig,
  root: string,
  document: string,
  ts: string,
  mode: ReferenceMode,
  outcome: string,
): Promise<void> {
  await writeEntryTolerant(
    config,
    root,
    buildDecision({
      session: "learning.consolidation",
      type: "load",
      input: { text: `${document}:${mode}:${outcome}`, summary: `${mode} reference: ${outcome}` },
      options: ["consolidated", "refused"],
      choice: outcome === "consolidated" ? "consolidated" : "refused",
      documents: [document],
      ts,
    }),
    "learning.consolidation",
  );
}

function refusal(
  document: string,
  mode: ReferenceMode,
  reason: string,
  text: string,
): ConsolidationReport {
  const pair = digestPair(text);
  return {
    status: "refused",
    document,
    mode,
    reason,
    before: pair,
    after: pair,
    blocks: [],
    deconsolidation_verified: false,
    text,
    budget: emptyBudget(),
  };
}

function reportBudget(blocks: ConsolidationBlock[]): ContextBudget {
  return capItems(
    blocks,
    (block) => `${block.archive} ${block.period} ${String(block.entries)} block(s)`,
    2_000,
  ).budget;
}

/**
 * Moves the overflow of one bounded document into its archive.
 *
 * Order of the guards is the order of the losses they close: the pending
 * transaction, then the write reference, then the shape of the index, then the
 * count of pointers, and only then the critical section where the two rereads
 * frame every write.
 */
export async function consolidate(
  config: VaultConfig,
  root: string,
  document: string,
  options: ConsolidationOptions = {},
): Promise<ConsolidationReport> {
  requireCapability(config, "learning.consolidate");
  const relative = toPosixPath(document);
  const now = options.now ?? nowTs();
  const mode: ReferenceMode = options.mode ?? "strict";

  const raw = await readDocument(root, relative);
  const before = digestPair(raw);

  if (!options.force && (await isLearningDisabled(config, root))) {
    // It reports, it does not raise: its automatic caller lives inside a hook
    // and an exception there would climb out into the session.
    return refusal(relative, mode, "disabled", raw);
  }

  const contract = readLoadContract(raw, config);
  if (contract.load_policy !== "dated_rotation") {
    fail(
      "load.policy.unsupported",
      `The load policy "${contract.load_policy}" is declared by the contract and not implemented, so nothing is moved.`,
    );
  }

  const pending = await pendingTransaction(config, root);
  if (pending) {
    if (pending.document === relative && pending.sha256_after === before.sha256) {
      // A run that succeeded and only failed to close its marker: finish it.
      await rm(loadTransactionPath(config, root), { force: true });
    } else {
      fail(
        "load.transaction.pending",
        "A consolidation was interrupted and its transaction is still open. Both consolidation and deconsolidation are refused until it is settled.",
      );
    }
  }

  // The shape of the document is judged before the write reference is, because a
  // document whose index sits outside its zone is refused whatever the mode: the
  // loss it carries is structural, it is not a property of how we got here.
  const split = splitDocument(raw, contract);

  const stored = await readSystemReference(config, root, relative);
  if (mode === "strict") {
    if (!stored) {
      fail(
        "load.reference.missing",
        "Strict mode needs a reference of the last write Open Brain made to this document, and there is none.",
      );
    }
    if (stored.sha256 !== before.sha256) {
      fail(
        "load.reference.diverged",
        "This document changed since Open Brain last wrote it, so strict mode refuses to consolidate it.",
      );
    }
  }
  if (mode === "bootstrap" && stored) {
    fail(
      "load.reference.mode",
      "Bootstrap mode is for a document Open Brain has never written, and this one already has a reference.",
    );
  }

  const archives = await readArchives(root, split, contract, relative);
  const origin = restoreOrigin(split, archives);

  if (countCodePoints(raw) <= contract.load_max) {
    return {
      status: "nothing_to_do",
      document: relative,
      mode,
      before,
      after: before,
      blocks: [],
      deconsolidation_verified: true,
      text: raw,
      budget: emptyBudget(),
    };
  }
  if (split.blocks.length === 0) {
    fail(
      "load.boundary.not_found",
      "This document is over its cap and carries no block matching its boundary, so there is nothing to move.",
    );
  }

  // Keep as many blocks as the cap allows, never fewer than one.
  let keep = 1;
  for (let candidate = split.blocks.length - 1; candidate >= 1; candidate -= 1) {
    const projected = renderDocument(
      split,
      candidate,
      foldPointers([
        ...pointersFor(split.blocks.slice(candidate), contract),
        ...split.pointers,
      ]),
    );
    if (countCodePoints(projected) < contract.load_max) {
      keep = candidate;
      break;
    }
  }

  const toArchive = split.blocks.slice(keep);
  if (toArchive.length === 0) {
    return {
      status: "nothing_to_do",
      document: relative,
      mode,
      before,
      after: before,
      blocks: [],
      deconsolidation_verified: true,
      text: raw,
      budget: emptyBudget(),
    };
  }
  const lots = lotsOf(toArchive, contract);
  const nextPointers = foldPointers([...pointersFor(toArchive, contract), ...split.pointers]);
  const nextText = renderDocument(split, keep, nextPointers);

  // A pointer line costs bytes too. When the blocks that would move are smaller
  // than the pointers they leave behind, moving them makes the document grow,
  // and a consolidation that grows a document is refused before it is written
  // rather than caught by its own contract after the fact.
  if (Buffer.byteLength(nextText, "utf8") > before.size) {
    return {
      status: "nothing_to_do",
      document: relative,
      mode,
      reason: "no_gain",
      before,
      after: before,
      blocks: [],
      deconsolidation_verified: true,
      text: raw,
      budget: emptyBudget(),
    };
  }

  // Cut 4, counted before a single byte is written: the index keeps standing for
  // every block that ever left, and it never shrinks.
  const weightBefore = pointerWeight(split.pointers);
  const weightAfter = pointerWeight(nextPointers);
  if (weightAfter !== weightBefore + toArchive.length) {
    fail(
      "load.index.pointers_lost",
      `The index would stand for ${String(weightAfter)} blocks where it must stand for ${String(weightBefore + toArchive.length)}.`,
    );
  }

  const decision = options.decisionId ?? newDecisionId(now);
  const after = digestPair(nextText);
  const documentPath = join(root, relative);

  const written = await withDocumentLock(root, async (): Promise<ConsolidationReport> => {
    await runStage(options, "before_archive");

    // First reread, at the door of the critical section. If the document moved
    // since we read it, nothing is archived at all.
    const current = await readDocument(root, relative);
    if (sha256(current) !== before.sha256) {
      fail(
        "load.document.concurrent",
        "The document changed while Open Brain was preparing its consolidation, so nothing was archived.",
      );
    }

    const previousArchives = new Map<string, string | undefined>();
    for (const lot of lots) {
      previousArchives.set(
        lot.archive,
        await readFile(join(root, lot.archive), "utf8").catch(() => undefined),
      );
    }

    const transaction: LoadTransaction = {
      schema_version: LEARNING_SCHEMA_VERSION,
      opened_at: now,
      document: relative,
      decision,
      sha256_before: before.sha256,
      sha256_after: after.sha256,
      archives: lots.map((lot) => lot.archive),
    };
    await atomicWriteJson(loadTransactionPath(config, root), transaction);

    const giveArchivesBack = async (): Promise<void> => {
      for (const [archive, content] of previousArchives) {
        if (content === undefined) {
          await rm(join(root, archive), { force: true });
          continue;
        }
        await atomicWriteText(join(root, archive), content);
      }
      await rm(loadTransactionPath(config, root), { force: true });
    };

    const blocks: ConsolidationBlock[] = [];
    try {
      for (const lot of lots) {
        const previous = previousArchives.get(lot.archive);
        const addition = lot.blocks.map((block) => block.text).join("");
        const existingPayload = previous === undefined
          ? ""
          : parseArchive(lot.archive, previous, contract, relative).payload;
        // Resuming an interrupted run must not prepend the same lot twice.
        const payload = existingPayload.startsWith(addition)
          ? existingPayload
          : addition + existingPayload;
        const dates = [
          ...lot.dates,
          ...tileBlocks(toLines(existingPayload), boundaryOf(contract), 0)
            .map((block) => block.date)
            .filter((date): date is string => date !== undefined),
        ];
        const digest = sha256(payload);
        const header = renderFrontmatter({
          lifecycle: ARCHIVE_LIFECYCLE,
          source: relative,
          period: periodOf(dates),
          sha256_block: digest,
          consolidated_at: now,
          decision_source: decision,
        });
        await atomicWriteText(join(root, lot.archive), header + payload);

        const rereadText = await readFile(join(root, lot.archive), "utf8");
        const reread = splitFrontmatter(rereadText);
        const rereadOk = reread.body === payload
          && reread.frontmatter?.sha256_block === digest
          && sha256(reread.body) === digest;
        blocks.push({
          archive: lot.archive,
          period: periodOf(lot.dates),
          entries: lot.blocks.length,
          size: Math.max(1, Buffer.byteLength(payload, "utf8")),
          sha256_block: digest,
          reread_ok: rereadOk,
        });
        if (!rereadOk) {
          fail(
            "load.archive.reread",
            `The archive ${lot.archive} did not read back as it was written, so the move is abandoned.`,
          );
        }
      }

      await runStage(options, "after_archive");

      // The proof is not that the last lot is reversible, it is that the
      // consolidated document restores exactly the same origin as the one we
      // measured before writing anything. That is what holds on a chain.
      const nextSplit = splitDocument(nextText, contract);
      const nextArchives = new Map<string, ParsedArchive>();
      for (const pointer of nextSplit.pointers) {
        if (nextArchives.has(pointer.archive)) {
          continue;
        }
        const text = await readFile(join(root, pointer.archive), "utf8").catch(() => undefined);
        if (text === undefined) {
          fail("load.archive.missing", `The archive ${pointer.archive} vanished mid flight.`);
        }
        nextArchives.set(pointer.archive, parseArchive(pointer.archive, text, contract, relative));
      }
      const restored = restoreOrigin(nextSplit, nextArchives);
      if (restored !== origin) {
        fail(
          "load.deconsolidation.unverified",
          "The consolidated document does not restore the origin byte for byte, so it is not written.",
        );
      }

      await runStage(options, "before_document_write");

      // Second reread, immediately before the write and inside the same lock:
      // this is the pair that closes the window a rename alone leaves open.
      const stillCurrent = await readDocument(root, relative);
      if (sha256(stillCurrent) !== before.sha256) {
        fail(
          "load.document.concurrent",
          "The document changed while Open Brain was archiving, so the archive was given back and nothing was overwritten.",
        );
      }
      await atomicWriteText(documentPath, nextText);
      await runStage(options, "after_document_write");
    } catch (error) {
      if (error instanceof SchemaError) {
        await giveArchivesBack();
      }
      // Anything else is an interruption, and an interruption is exactly what
      // the transaction marker exists to record. It is deliberately not cleaned
      // up here: a process that dies must leave its trace behind.
      throw error;
    }

    await rm(loadTransactionPath(config, root), { force: true });
    await recordSystemReference(config, root, relative, {
      sha256: after.sha256,
      size: after.size,
      ts: now,
    });

    const entry = validateConsolidation({
      schema_version: LEARNING_SCHEMA_VERSION,
      id: decision,
      ts: now,
      type: "consolidated",
      document: relative,
      before,
      after,
      blocks,
      deconsolidation_verified: true,
    });

    return {
      status: "consolidated",
      document: relative,
      mode,
      before,
      after,
      blocks,
      deconsolidation_verified: true,
      text: nextText,
      entry,
      budget: reportBudget(blocks),
    };
  });

  // The journal is written after the rewrite, never before: a decision that
  // claims a move that did not happen is worse than a move nobody logged.
  if (written.entry) {
    await writeEntryTolerant(config, root, written.entry, "learning.consolidation");
  }
  if (mode !== "strict") {
    await journalMode(config, root, relative, now, mode, "consolidated");
  }
  return written;
}

function pointersFor(blocks: readonly Block[], contract: LoadContract): Pointer[] {
  const pointers: Pointer[] = [];
  for (const block of blocks) {
    if (block.date === undefined) {
      fail(
        "load.block.date.not_found",
        "A block without a readable date is never archived: what cannot be dated is not moved.",
      );
    }
    pointers.push({
      date: block.date,
      subject: block.subject,
      count: undefined,
      archive: `${contract.load_archive}/${block.date.slice(0, 7)}.md`,
    });
  }
  return pointers;
}

export interface DeconsolidationOptions {
  write?: boolean;
  now?: string;
}

/**
 * The way back. It never consults the OFF sentinel: a way back that refuses to
 * work once the layer is switched off is the opposite of the service expected
 * from it.
 */
export async function deconsolidate(
  config: VaultConfig,
  root: string,
  document: string,
  options: DeconsolidationOptions = {},
): Promise<DeconsolidationReport> {
  requireCapability(config, "learning");
  const relative = toPosixPath(document);
  const now = options.now ?? nowTs();
  const raw = await readDocument(root, relative);
  const contract = readLoadContract(raw, config);

  const pending = await pendingTransaction(config, root);
  if (pending && pending.document === relative && pending.sha256_after !== sha256(raw)) {
    fail(
      "load.transaction.pending",
      "A consolidation was interrupted on this document and its transaction is still open, so restoration is refused until it is settled.",
    );
  }

  const split = splitDocument(raw, contract);
  const archives = await readArchives(root, split, contract, relative);
  const text = restoreOrigin(split, archives);
  const pair = digestPair(text);
  const restored = pointerWeight(split.pointers);

  let written = false;
  if (options.write === true) {
    await withDocumentLock(root, async () => {
      const current = await readDocument(root, relative);
      if (sha256(current) !== sha256(raw)) {
        fail(
          "load.document.concurrent",
          "The document changed while Open Brain was restoring it, so it was not overwritten.",
        );
      }
      await atomicWriteText(join(root, relative), text);
      await recordSystemReference(config, root, relative, {
        sha256: pair.sha256,
        size: pair.size,
        ts: now,
      });
    });
    written = true;
  }

  return {
    document: relative,
    text,
    sha256: pair.sha256,
    size: pair.size,
    blocks_restored: restored,
    written,
    budget: emptyBudget(),
  };
}

export interface ApplyCapOptions extends ConsolidationOptions {
  /** Seam of the safety catch. The default is the real proof. */
  reversibilityProof?: () => Promise<ReversibilityProof>;
}

/**
 * The autonomous path, the one an end of turn hook calls. It never raises: it
 * reports. And it never runs before the byte exact way back has been proven on
 * this very process, which is the safety catch of amendment 10.6 expressed as
 * code rather than as a rule of conduct.
 */
export async function applyCap(
  config: VaultConfig,
  root: string,
  document: string,
  options: ApplyCapOptions = {},
): Promise<ConsolidationReport> {
  const relative = toPosixPath(document);
  try {
    requireCapability(config, "learning.consolidate");
    const proof = await (options.reversibilityProof ?? verifyReversibility)();
    if (!proof.ok) {
      // The catch of amendment 10.6. The organ does not merely warn: it stops,
      // before reading the document and before taking a lock.
      await journalMode(
        config,
        root,
        relative,
        options.now ?? nowTs(),
        options.mode ?? "resume",
        "reversibility_unproven",
      );
      return refusal(relative, options.mode ?? "resume", "reversibility_unproven", "");
    }

    const raw = await readDocument(root, relative);
    const stored = await readSystemReference(config, root, relative);
    const mode: ReferenceMode = options.mode
      ?? (stored === undefined
        ? "bootstrap"
        : stored.sha256 === sha256(raw) ? "strict" : "resume");

    const forwarded: ConsolidationOptions = { ...options, mode };
    return await consolidate(config, root, relative, forwarded);
  } catch (error) {
    const reason = error instanceof InvariantError
      ? error.invariant
      : error instanceof Error ? error.message : String(error);
    return refusal(relative, options.mode ?? "resume", reason, "");
  }
}

// ---------------------------------------------------------------------------
// The proof.
// ---------------------------------------------------------------------------

interface ReversibilityFixture {
  name: string;
  document: string;
  rounds: number;
}

function filler(lines: number, text: string): string {
  return Array.from({ length: lines }, (_unused, index) => `${text} line ${String(index + 1)}`)
    .join("\n");
}

function fixtureBlock(date: string, subject: string, body: string): string {
  return `${date} (${subject})\n${body}\n\n`;
}

function fixtureDocument(name: string, blocks: readonly string[], loadMax: number): string {
  const frontmatter = [
    "---",
    "lifecycle: master",
    `load_max: ${String(loadMax)}`,
    "load_policy: dated_rotation",
    // One archive directory per document: two bounded documents sharing one
    // would prepend into each other.
    `load_archive: ${DEFAULT_CONFIG.paths.archive}/consolidation/proof/${name}/`,
    "load_boundary: '^20\\d\\d-\\d\\d-\\d\\d \\('",
    "---",
    "",
    "# Bounded document",
    "",
  ].join("\n");
  return `${frontmatter}${blocks.join("")}## Standing section\n\nThis section never moves.\n`;
}

function proofFixtures(): ReversibilityFixture[] {
  const plain = [
    fixtureBlock("2026-07-25", "sixth", filler(6, "plain six")),
    fixtureBlock("2026-07-24", "fifth", filler(6, "plain five")),
    fixtureBlock("2026-07-23", "fourth", filler(6, "plain four")),
    fixtureBlock("2026-07-22", "third", filler(6, "plain three")),
    fixtureBlock("2026-07-21", "second", filler(6, "plain two")),
    fixtureBlock("2026-07-20", "first", filler(6, "plain one")),
  ];
  const sameDates = Array.from({ length: 6 }, (_unused, index) =>
    fixtureBlock("2026-07-25", `entry ${String(index)}`, filler(6, `same date ${String(index)}`)));
  const accents = [
    fixtureBlock("2026-07-25", "accents", `eleve, etude, naivete, coeur \u{1F9E0}\n${filler(5, "accentue")}`),
    fixtureBlock("2026-07-24", "accents", `deja vu, tres tot \u{1F9E0}\n${filler(5, "accentue")}`),
    fixtureBlock("2026-07-23", "accents", `ou est-ce\n${filler(5, "accentue")}`),
    fixtureBlock("2026-07-22", "accents", `encore\n${filler(5, "accentue")}`),
  ];
  const crlf = Array.from({ length: 6 }, (_unused, index) =>
    fixtureBlock(
      `2026-07-2${String(index)}`,
      "crlf",
      index % 2 === 0
        ? filler(6, "windows").replace(/\n/gu, "\r\n")
        : filler(6, "mixed"),
    ));
  const jsonl = Array.from({ length: 5 }, (_unused, index) =>
    fixtureBlock(
      `2026-07-2${String(index)}`,
      "jsonl",
      Array.from(
        { length: 6 },
        (_ignored, line) => JSON.stringify({ id: `${String(index)}-${String(line)}`, value: line }),
      ).join("\n"),
    ));
  const months = [
    ...Array.from({ length: 8 }, (_unused, index) =>
      fixtureBlock(`2026-07-${String(10 + index)}`, `july ${String(index)}`, filler(8, "july"))),
    ...Array.from({ length: 8 }, (_unused, index) =>
      fixtureBlock(`2026-06-${String(10 + index)}`, `june ${String(index)}`, filler(8, "june"))),
  ];

  return [
    { name: "plain", document: fixtureDocument("plain", plain, 700), rounds: 1 },
    { name: "same_dates", document: fixtureDocument("same_dates", sameDates, 700), rounds: 1 },
    { name: "accents_emoji", document: fixtureDocument("accents_emoji", accents, 700), rounds: 1 },
    { name: "crlf", document: fixtureDocument("crlf", crlf, 700), rounds: 1 },
    { name: "jsonl", document: fixtureDocument("jsonl", jsonl, 700), rounds: 1 },
    { name: "chain", document: fixtureDocument("chain", plain, 700), rounds: 3 },
    { name: "folded_index", document: fixtureDocument("folded_index", months, 700), rounds: 4 },
  ];
}

function proofConfig(): VaultConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: {
      ...DEFAULT_CONFIG.capabilities,
      learning: { enabled: true, evaluate: false, consolidate: true },
    },
  };
}

let provenProof: ReversibilityProof | undefined;

export interface VerifyReversibilityOptions {
  /** False re-runs the proof even if this process already proved it green. */
  cache?: boolean;
}

/**
 * Runs consolidate then deconsolidate on the hard fixtures and demands the
 * origin back byte for byte, digest included. This is both the closing test of
 * the lot and the runtime catch: applyCap calls it and refuses to run when it is
 * not green.
 */
export async function verifyReversibility(
  options: VerifyReversibilityOptions = {},
): Promise<ReversibilityProof> {
  if (options.cache !== false && provenProof?.ok === true) {
    return provenProof;
  }
  const config = proofConfig();
  const root = await mkdtemp(join(tmpdir(), "open-brain-reversibility-"));
  const cases: ReversibilityCase[] = [];
  try {
    for (const fixture of proofFixtures()) {
      const relative = `10_memory/${fixture.name}.md`;
      const path = join(root, relative);
      await atomicWriteText(path, fixture.document);
      // The expected origin is grown exactly the way the living document is
      // grown between rounds, so a chain proves the whole origin and not only
      // the last lot that moved.
      let expected = fixture.document;
      let archived = 0;
      try {
        for (let round = 0; round < fixture.rounds; round += 1) {
          const day = String(20 + round).padStart(2, "0");
          const report = await consolidate(config, root, relative, {
            mode: round === 0 ? "bootstrap" : "resume",
            now: `2026-08-${day}T08:00:00Z`,
          });
          archived += report.blocks.reduce((sum, block) => sum + block.entries, 0);
          if (round + 1 < fixture.rounds) {
            const addition = `\n${fixtureBlock(`2026-08-${day}`, `round ${String(round)}`, filler(6, "fresh"))}`;
            const anchor = "# Bounded document\n";
            await atomicWriteText(
              path,
              (await readFile(path, "utf8")).replace(anchor, anchor + addition),
            );
            expected = expected.replace(anchor, anchor + addition);
          }
        }
        const back = await deconsolidate(config, root, relative);
        const restored = back.text === expected && back.sha256 === sha256(expected);
        // A case that moved nothing is a case that proves nothing, so it counts
        // as a failure rather than as a free pass.
        const ok = restored && archived >= 1;
        cases.push({
          name: fixture.name,
          ok,
          bytes: Buffer.byteLength(back.text, "utf8"),
          blocks_archived: archived,
          sha256_before: sha256(expected),
          sha256_after: back.sha256,
          ...(ok ? {} : {
            detail: restored
              ? "nothing was archived, so this case proves nothing"
              : "the origin did not come back byte for byte",
          }),
        });
      } catch (error) {
        cases.push({
          name: fixture.name,
          ok: false,
          bytes: 0,
          blocks_archived: archived,
          sha256_before: sha256(expected),
          sha256_after: "",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const proof: ReversibilityProof = {
    ok: cases.every((round) => round.ok),
    checked_at: nowTs(),
    cases,
  };
  if (proof.ok) {
    provenProof = proof;
  }
  return proof;
}

/** The loud form of the catch, for a caller that wants a refusal it cannot ignore. */
export async function assertReversibilityProven(proof?: ReversibilityProof): Promise<void> {
  const resolved = proof ?? await verifyReversibility();
  if (!resolved.ok) {
    fail(
      "load.safety.unproven",
      "The byte exact way back is not proven, so the subtractive organ stays disarmed.",
    );
  }
}
