import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ExpectedError } from "./errors.js";
import { sha256 } from "./text.js";

/**
 * The one secret of a vault, and the only reason any seal in this project
 * proves anything at all.
 *
 * Everything the gate writes to prove something happened, the frozen decision,
 * the batch, the apply state, the undo record, the redline journal, is a file
 * sitting in the vault next to the files it vouches for. As long as those files
 * were sealed with a plain sha256, the seal proved nothing: sha256 is a public
 * function, so whoever could write the file could write its seal too, and the
 * check was a spell check rather than a lock. A hash anybody can recompute is
 * not evidence.
 *
 * So the seals are keyed, and the key lives OUTSIDE the vault, under the user
 * configuration directory. Writing into the vault, which is what a wandering
 * agent, a bad merge or a hostile note can do, is then no longer enough to
 * forge a seal: forging one also requires reading a file the vault does not
 * contain and no vault command ever prints.
 *
 * What this does NOT claim: it is not a defence against something running as
 * the user with full read access to their home directory. Nothing a local CLI
 * can do defends against that. It is the difference between "anyone who can
 * write a file in this directory" and "anyone who can read this user's private
 * configuration", which is exactly the gap every exploit replayed against this
 * gate went through.
 */

/** Overrides where keys live. Set by the test suite, documented for operators. */
export const VAULT_SECRET_DIRECTORY_ENV = "OPEN_BRAIN_SECRET_DIR";

/** 256 bits, the block size of the hash the seals use. */
const KEY_BYTES = 32;

const KEY_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * A vault key, in memory. The key material is never rendered, never logged and
 * never written anywhere but its own file: a secret that reaches a log line is
 * a secret that reaches whoever reads the log.
 */
export interface VaultSecret {
  /** Stable identifier of the vault this key belongs to. */
  readonly id: string;
  /** Where the key is stored, for diagnostics. Never the key itself. */
  readonly path: string;
  readonly key: Buffer;
}

/** A key file that exists and cannot be used. Never silently regenerated. */
export class VaultSecretError extends ExpectedError {
  public constructor(message: string) {
    super(message);
    this.name = "VaultSecretError";
  }
}

/**
 * Where keys live: honours the documented override first, then the XDG
 * convention, then the plain home directory. The override exists so a test run,
 * a container or a second isolated profile never touches the real key of a real
 * vault.
 */
export function vaultSecretDirectory(): string {
  const override = process.env[VAULT_SECRET_DIRECTORY_ENV];
  if (override !== undefined && override.trim().length > 0) {
    return resolve(override);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim().length > 0) {
    return join(resolve(xdg), "open-brain");
  }
  return join(homedir(), ".config", "open-brain");
}

/**
 * The identifier of a vault, derived from where it really is on disk.
 *
 * The real path is what makes it stable: two shells reaching the same vault
 * through a symlink and through its true path must land on the same key, or the
 * second one would read seals it cannot verify and call a legitimate vault
 * forged. A vault that has been moved gets a new identifier, and therefore a new
 * key, which is the honest answer: nothing here can vouch for seals written at
 * a path it has never seen.
 */
export async function vaultSecretId(root: string): Promise<string> {
  const absolute = resolve(root);
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    // A vault that is not on disk yet still needs a stable identifier, and the
    // absolute path is the best answer available before the directory exists.
    canonical = absolute;
  }
  return sha256(canonical);
}

/** Cached per key file, so a command that seals twenty times reads once. */
const cache = new Map<string, VaultSecret>();

function parseKeyMaterial(raw: string, path: string): Buffer {
  const material = raw.trim();
  if (!KEY_PATTERN.test(material)) {
    throw new VaultSecretError(
      `${path} is not an Open Brain vault key: a key is 64 hexadecimal characters and this file is not. Nothing was read from the vault. Move that file aside if it is not a key, or restore the real one from your backups: without it, every seal this vault carries reads as unverifiable rather than as forged.`,
    );
  }
  return Buffer.from(material, "hex");
}

/**
 * Creates the key file, once, without ever clobbering one that already exists.
 *
 * The material is written to a private temporary file, flushed, and only then
 * linked into place: link refuses to replace an existing entry, so two commands
 * racing on a fresh vault cannot end up with two different keys, one of which
 * would already have sealed something. Whoever loses the race simply reads what
 * the winner wrote, which is what the read-back below is for.
 */
async function createKeyFile(directory: string, path: string): Promise<void> {
  // 0o700: the directory itself is part of the secret, and a world readable
  // parent makes the mode of the file inside it beside the point.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.key.${randomUUID()}.tmp`);
  // "wx" plus mode 0o600 so the bytes are never, not even for an instant,
  // readable by another account. A umask can only remove bits, never add them.
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${randomBytes(KEY_BYTES).toString("hex")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporary, path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") {
      // Another process created the key first. Its key is the key.
      return;
    }
    if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV") {
      // Filesystems without hard links, which includes some Windows shares.
      // Rename can clobber, so it is only attempted when nothing is there.
      await rename(temporary, path);
      return;
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Reads the key of this vault, creating it on first use.
 *
 * On Windows the permission bits are advisory at best: the mode is passed all
 * the same, and the real protection there is the per-user profile directory the
 * key sits in. That limitation is documented rather than hidden, because a
 * guarantee that silently does not hold on a platform is worse than one that
 * says where it stops.
 */
export async function loadVaultSecret(root: string): Promise<VaultSecret> {
  const directory = vaultSecretDirectory();
  const id = await vaultSecretId(root);
  const path = join(directory, `vault-${id}.key`);

  const cached = cache.get(path);
  if (cached) {
    return cached;
  }

  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw new VaultSecretError(
        `The key of this vault is at ${path} and cannot be read (${error instanceof Error ? error.message : String(error)}). Nothing was written. Every seal in this vault is verified with it, so a command that cannot read it refuses rather than falls back to an unkeyed hash that proves nothing.`,
      );
    }
    await createKeyFile(directory, path);
    raw = await readFile(path, "utf8");
  }

  const secret: VaultSecret = { id, path, key: parseKeyMaterial(raw, path) };
  cache.set(path, secret);
  return secret;
}

/**
 * The seal itself: an HMAC over a domain tag and a message.
 *
 * The domain tag is not decoration. Without it, a seal legitimately produced for
 * one kind of record could be pasted into another kind that happens to hash the
 * same bytes, and the second record would verify with a signature nobody ever
 * produced for it. One tag per kind of claim keeps every seal answerable for
 * exactly the sentence it was written under.
 */
export function vaultMac(secret: VaultSecret, domain: string, message: string): string {
  return createHmac("sha256", secret.key)
    .update(domain, "utf8")
    .update(" ", "utf8")
    .update(message, "utf8")
    .digest("hex");
}

/**
 * Constant time comparison of two seals. A plain === leaks, through timing, how
 * many leading characters of a guess were right, which is how a forgery gets
 * built one character at a time.
 */
export function sealsMatch(left: string | undefined | null, right: string): boolean {
  if (typeof left !== "string" || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
