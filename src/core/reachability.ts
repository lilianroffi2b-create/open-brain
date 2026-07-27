import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { extractLinks } from "./text.js";
import type { CatalogRecord, RoutingDocument, VaultConfig } from "./types.js";

/**
 * Whether a reader can actually arrive at a document.
 *
 * An index and a route are the only two ways in. A folder no route names and no
 * parent index mentions is not private, it is unreachable: it will be scanned,
 * counted, and reported as healthy while never being opened. Worse, an index
 * that lists a folder which does not exist reads as authoritative and sends the
 * reader nowhere. Neither failure shows up in catalog integrity, because both
 * artifacts are perfectly well formed; they are just not true.
 *
 * Everything here is derived from the catalog and from the index files
 * themselves. Nothing is written, and nothing is repaired.
 */

/** A local link in an index that resolves to no file and no folder. */
export interface DeadIndexLink {
  index: string;
  target: string;
}

export interface ReachabilityReport {
  /** Folders holding at least one catalogued document, archive excluded. */
  folders: number;
  folders_with_index: number;
  folders_without_index: string[];
  dead_index_links: DeadIndexLink[];
  /** Indexed folders their parent index never mentions. */
  orphan_folders: string[];
  /** Top-level layers no route can reach. */
  unrouted_layers: string[];
  /** Layers the default route reaches, out of every layer in the vault. */
  default_route_layers: string[];
  layers: string[];
}

const INDEX_FILE_NAME = "_index.md";
const LINK_LIMIT = 500;
const PATH_EXTENSIONS = new Set([
  "md", "txt", "json", "yml", "yaml", "toml", "csv", "tsv", "html", "pdf",
]);

function relative(record: CatalogRecord): string {
  const separator = record.path.indexOf("/");
  return separator === -1 ? record.path : record.path.slice(separator + 1);
}

function parentOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function layerOf(path: string): string {
  const separator = path.indexOf("/");
  return separator === -1 ? path : path.slice(0, separator);
}

/**
 * Resolves a link the way a reader would: relative to the index it was written
 * in first, then from the vault root, because a root index that lists
 * `10_memory/notes/` is writing a path, not a neighbour.
 */
function normalizePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Keeps only targets that claim to be a path inside the vault. A bare wiki link
 * with no separator and no extension names a note by title, which this audit
 * cannot resolve without guessing, and a guess would report a defect that is
 * not there.
 */
function pathShapedTarget(rawTarget: string): string | undefined {
  const trimmed = rawTarget.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return undefined;
  }
  // `[label](path "Title")` hands the whole parenthesis over; the title is not
  // part of the path.
  const withoutTitle = trimmed.split(/\s+/u)[0] ?? "";
  const withoutFragment = withoutTitle.split("#")[0]?.split("?")[0] ?? "";
  let target = withoutFragment;
  try {
    target = decodeURIComponent(withoutFragment);
  } catch {
    // A malformed escape is not a broken link; read it literally.
  }
  if (target === "") {
    return undefined;
  }
  const name = target.split("/").at(-1) ?? target;
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
  if (!target.includes("/") && !PATH_EXTENSIONS.has(extension)) {
    return undefined;
  }
  return target;
}

function resolveTarget(target: string, indexFolder: string): string[] {
  const cleaned = target.replace(/\/+$/u, "");
  if (target.startsWith("/")) {
    const rooted = normalizePath(cleaned);
    return rooted === undefined || rooted === "" ? [] : [rooted];
  }
  const candidates: string[] = [];
  const local = normalizePath(indexFolder === "" ? cleaned : `${indexFolder}/${cleaned}`);
  if (local !== undefined && local !== "") {
    candidates.push(local);
  }
  const rooted = normalizePath(cleaned);
  if (rooted !== undefined && rooted !== "" && !candidates.includes(rooted)) {
    candidates.push(rooted);
  }
  return candidates;
}

/**
 * Audits the reading path. Reads every `_index.md` the catalog knows about, and
 * nothing else.
 *
 * The archive is exempt from needing an index: an archive is where documents go
 * to stop being read, so an index there would be a promise nobody makes.
 */
export async function auditReachability(
  root: string,
  config: VaultConfig,
  catalog: CatalogRecord[],
  routing: RoutingDocument,
): Promise<ReachabilityReport> {
  const indexDirectory = config.paths.index.replace(/\/+$/u, "");
  const archiveDirectory = config.paths.archive.replace(/\/+$/u, "");

  const files = new Set<string>();
  const folders = new Set<string>();
  const indexes: string[] = [];
  const layers = new Set<string>();

  for (const record of catalog) {
    const path = relative(record);
    files.add(path);
    for (
      let folder = parentOf(path);
      folder !== "";
      folder = parentOf(folder)
    ) {
      folders.add(folder);
    }
    // A file sitting at the vault root belongs to no layer; counting its own
    // name as one would report every loader as an unreachable layer.
    if (path.includes("/")) {
      layers.add(layerOf(path));
    }
    if ((path.split("/").at(-1) ?? "") === INDEX_FILE_NAME) {
      indexes.push(path);
    }
  }

  const exempt = (folder: string): boolean =>
    folder === indexDirectory
    || folder.startsWith(`${indexDirectory}/`)
    || folder === archiveDirectory
    || folder.startsWith(`${archiveDirectory}/`);

  const indexed = new Set(indexes.map(parentOf));
  const auditedFolders = [...folders].filter((folder) => !exempt(folder)).sort();
  const foldersWithoutIndex = auditedFolders.filter((folder) => !indexed.has(folder));

  const deadIndexLinks: DeadIndexLink[] = [];
  const indexText = new Map<string, string>();
  for (const indexPath of indexes.sort()) {
    let text = "";
    try {
      text = await readFile(join(root, indexPath), "utf8");
    } catch {
      // The catalog can be one scan behind the disk. A file that is gone is a
      // stale index, not a broken link, and `scan` is what fixes it.
      continue;
    }
    indexText.set(indexPath, text);
    const indexFolder = parentOf(indexPath);
    for (const rawTarget of extractLinks(text, LINK_LIMIT)) {
      const target = pathShapedTarget(rawTarget);
      if (target === undefined) {
        continue;
      }
      const candidates = resolveTarget(target, indexFolder);
      const alive = candidates.some(
        (candidate) => files.has(candidate) || folders.has(candidate),
      );
      if (!alive && candidates.length > 0) {
        deadIndexLinks.push({ index: indexPath, target });
      }
    }
  }

  const orphanFolders: string[] = [];
  for (const folder of auditedFolders) {
    if (!indexed.has(folder)) {
      continue;
    }
    const parent = parentOf(folder);
    const parentIndex = parent === "" ? INDEX_FILE_NAME : `${parent}/${INDEX_FILE_NAME}`;
    const text = indexText.get(parentIndex);
    if (text === undefined) {
      // No parent index means no claim was made about this folder, and a
      // missing parent index is already reported as a missing index.
      continue;
    }
    const name = folder.split("/").at(-1) ?? folder;
    if (!text.includes(folder) && !text.includes(name)) {
      orphanFolders.push(folder);
    }
  }

  const routedLayers = new Set<string>();
  const defaultLayers = new Set<string>();
  const collect = (targets: readonly string[], into: Set<string>): void => {
    for (const target of targets) {
      const normalized = normalizePath(target.replace(/\/+$/u, ""));
      if (normalized !== undefined && normalized !== "") {
        into.add(layerOf(normalized));
      }
    }
  };
  collect(routing.always_read, routedLayers);
  collect(routing.always_read, defaultLayers);
  for (const [name, route] of Object.entries(routing.routes)) {
    collect(route.read_order ?? [], routedLayers);
    if (name === "default") {
      collect(route.read_order ?? [], defaultLayers);
    }
  }

  const auditedLayers = [...layers]
    .filter((layer) => layer !== indexDirectory && layer !== archiveDirectory)
    .sort();

  return {
    folders: auditedFolders.length,
    folders_with_index: auditedFolders.filter((folder) => indexed.has(folder)).length,
    folders_without_index: foldersWithoutIndex,
    dead_index_links: deadIndexLinks,
    orphan_folders: orphanFolders,
    unrouted_layers: auditedLayers.filter((layer) => !routedLayers.has(layer)),
    default_route_layers: auditedLayers.filter((layer) => defaultLayers.has(layer)),
    layers: auditedLayers,
  };
}
