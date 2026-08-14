import { isAbsolute, join, resolve } from "node:path";

import { VAULT_CONFIG_RELATIVE_PATH } from "../core/config.js";
import type { VaultConfig } from "../core/types.js";
import {
  REDLINE_JOURNAL_RELATIVE_PATH,
  REDLINE_STATE_RELATIVE_PATH,
  REDLINE_TARGET_PATHS,
} from "../prefs/redline.js";

/**
 * The pre-effect guard on the preference kernel.
 *
 * It answers exactly one question: does this tool call intend to WRITE to the
 * preference ledger or its generated mirror? Mentioning one of those paths is
 * never enough. `git blame .../\_core.md | tail` reads, so it is allowed;
 * `printf x > .../\_core.md` writes, so it is refused. The rule that fired on a
 * mention plus a bare mutating word is deliberately absent: it refused reads and
 * let real redirections through, which is wrong in both directions.
 *
 * The function is pure and synchronous. It performs no I/O at all, so it can run
 * inside a hook with a hard time budget and be exercised by tests without a
 * filesystem.
 *
 * That choice has a cost, and this comment used to hide it. A path that is
 * ALREADY a symbolic link to a protected file cannot be resolved here, so
 * `printf x > alias.md` is judged on the alias and allowed. What the guard does
 * close is the creation of the alias: both operands of `ln` count as write
 * targets, and so do the link calls of the interpreters it can read, including
 * the sync variants. What it cannot close is an alias that exists already, or
 * one created by a program it cannot read. That class is caught after the fact
 * rather than before: `doctor` reports every symlink resolving into the kernel,
 * and the redline sees the modification. Prevention here is partial, and a
 * comment claiming otherwise would be worse than the gap itself.
 *
 * When evidence is missing it refuses. An unparsable command, a payload that is
 * not an object, a nesting depth beyond four, a null byte, a command name built
 * at runtime, a pipe into a shell, an interpreter body whose write target is
 * hidden behind an encoding, an unknown failure: all of them deny.
 */

export interface GuardInput {
  tool: string;
  toolInput: Record<string, unknown>;
  vaultRoot: string;
  config: VaultConfig;
}

export interface GuardVerdict {
  decision: "allow" | "deny";
  reason?: string;
  rule?: string;
}

const BLOCK_MESSAGE =
  "Direct writes to the preference ledger and its generated mirror are blocked. Every semantic change must go through `open-brain sync`.";

const MAX_DEPTH = 4;
const PREFERENCES_DIRECTORY = "preferences";
const PROTECTED_FILENAMES: readonly string[] = ["_ledger.json", "_core.md"];

/**
 * Files this guard protects no matter what `config.paths.memory` says.
 *
 * `protectedPathsFor` used to derive the whole perimeter from the configured
 * memory root, and `00_index/vault.config.yml` is exactly what sets that
 * root: a caller free to edit the config was a caller free to walk the real
 * kernel, `10_memory/preferences/_ledger.json` and `_core.md`, out from under
 * `guarded.directory` before writing to it. `REDLINE_TARGET_PATHS` is that
 * real kernel, imported rather than re-derived so there is exactly one
 * definition of it in the codebase. The redline record itself is added for
 * the same reason: a write there is what would let a tamperer edit the
 * kernel and then erase the evidence that anything changed. None of this
 * depends on `config.paths.memory`, on purpose: it is the fixed floor under
 * a configurable directory, not a mirror of it.
 */
const HARDCODED_PROTECTED_FILES: readonly string[] = [
  ...Object.values(REDLINE_TARGET_PATHS),
  REDLINE_STATE_RELATIVE_PATH,
  REDLINE_JOURNAL_RELATIVE_PATH,
  VAULT_CONFIG_RELATIVE_PATH,
];

/**
 * Directories this guard protects no matter what `config.paths.memory` says.
 *
 * Staged batches are candidates the sync gate has not ruled on yet: writing
 * into them directly is a way to plant or alter what `sync validate` will
 * later treat as reviewed. The path is written out literally, not built from
 * `config.paths.memory`, for the same reason as the files above.
 */
const HARDCODED_PROTECTED_DIRECTORIES: readonly string[] = [
  join("10_memory", "staging", "batches"),
];

/**
 * `notebookedit` is on both lists because `filePathOf` already read
 * `notebook_path` and nothing ever reached it: the tool was in neither set, so
 * the branch was dead and a notebook write was never evaluated at all. It
 * writes a file like the others, and the vault template already counts it as a
 * write tool, so it is wired in rather than deleted.
 */
const MUTATING_TOOLS: readonly string[] = [
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "notebook_edit",
  "apply_patch",
  "bash",
  "exec",
  "exec_command",
  "shell",
];

const FILE_TOOLS: readonly string[] = ["write", "edit", "multiedit", "notebookedit", "notebook_edit"];
const PATCH_TOOLS: readonly string[] = ["apply_patch"];

/**
 * Names that run another command and add nothing of their own.
 *
 * `xargs` used to be on this list and it does not belong: it supplies operands
 * from somewhere the guard cannot see, so stripping it left a mutator with an
 * empty operand list and `echo <path> | xargs rm -f` was allowed. It has its
 * own analysis now. `busybox` is here for the opposite reason: it is a real
 * multiplexer, `busybox rm -f x` is `rm -f x`, and it was a spelling of every
 * mutator that the table did not know.
 */
const WRAPPERS: readonly string[] = [
  "builtin",
  "busybox",
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
];

const WRAPPER_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "-C", "--chdir"],
  nice: ["-n"],
  sudo: ["-u", "-g", "-p", "-C", "-h", "-U"],
  doas: ["-u", "-C"],
  timeout: ["-s", "--signal", "-k"],
  stdbuf: ["-i", "-o", "-e"],
  xargs: ["-n", "-I", "-i", "-P", "-d", "-a", "-s", "-E", "-e", "-L", "-l"],
};

/** Shell keywords that can open a segment without being the command itself. */
const KEYWORDS: readonly string[] = [
  "!",
  "[[",
  "]]",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
];

/** Wrappers that take a positional argument of their own before the command. */
const WRAPPER_POSITIONAL_ARGS: Readonly<Record<string, number>> = { timeout: 1 };

const SHELLS: readonly string[] = ["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"];

const INTERPRETERS: readonly string[] = [
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "tsx",
];

/**
 * The flags that make a shell or an interpreter run its next word instead of a
 * file, in every spelling the program itself accepts.
 *
 * The letters are read out of a cluster, because that is how these calls are
 * really written: `bash -lc`, `sh -cx`, `python3 -uc`, and the argv form a tool
 * emits, `["bash", "-lc", script]`. A guard that only knows the token `-c`
 * knows none of them, and it returned before analyzing anything, so the script
 * it was handed was never opened at all.
 *
 * The interpreter set is wider than the shell set on purpose: `-e` is eval for
 * node, perl and ruby, and errexit for a shell. Matching a letter that turns
 * out not to be eval costs nothing, since the word it points at is then read as
 * code and simply contains no write.
 */
const SHELL_COMMAND_LETTERS = "c";
const SHELL_COMMAND_FLAGS: readonly string[] = ["--command"];
const INTERPRETER_EVAL_LETTERS = "ceEpr";
const INTERPRETER_EVAL_FLAGS: readonly string[] = ["--eval", "--print", "--exec", "--command"];

/** Interpreters that spell eval as a subcommand rather than as a flag. */
const EVAL_SUBCOMMAND_RUNTIMES: readonly string[] = ["deno", "bun"];

/**
 * Names the preference CLI is known by. `cli.js` is on the list because it is
 * the name that actually ships: `bin/cli.js` in the package, `70_engine/cli.js`
 * in a vault. Recognizing only the pretty name recognized nothing.
 *
 * A name is never enough on its own, which is why recognizePreferenceCli also
 * reads the subcommand tree. A binary can be renamed; `prefs add` cannot.
 */
const PREFERENCE_CLI_NAMES: readonly string[] = [
  "open-brain",
  "open-brain.js",
  "openbrain",
  "openbrain.js",
  "cli.js",
];

/** Operands that are a script or a package specifier, never a subcommand. */
const SCRIPT_LIKE = /\.(?:js|mjs|cjs|ts|mts|cts)$/u;

const PACKAGE_RUNNERS: readonly string[] = ["npx", "bunx", "pnpx", "yarn", "pnpm", "npm"];

/** Preference subcommands that only read. Anything else mutates the kernel. */
const READ_ONLY_PREFERENCE_SUBCOMMANDS: readonly string[] = [
  "list",
  "validate",
  "show",
  "status",
  "explain",
  "diff",
];

/**
 * Subcommand trees used to recognize the CLI when its file has been renamed,
 * aliased, or wrapped in a shell function.
 *
 * These lists are deliberately closed, and they are used ONLY for recognition
 * by content. A call that names the CLI is judged by the read-only list above,
 * so an unknown `prefs` subcommand on the real binary still refuses. The cost
 * of that split is stated plainly: `frobnicate prefs whatever` is not
 * recognized. The alternative was to refuse `grep prefs README.md`, and a guard
 * that refuses reads is the failure this file was rewritten to end.
 */
const PREFERENCE_SUBCOMMANDS: readonly string[] = [
  ...READ_ONLY_PREFERENCE_SUBCOMMANDS,
  "add",
  "log",
  "regen",
];

const SYNC_SUBCOMMANDS: readonly string[] = [
  "pending",
  "staged",
  "prepare",
  "show",
  "resume",
  "validate",
  "apply",
  "undo",
];

/**
 * What counts as an intent to write inside an interpreter body.
 *
 * The link calls are on the list for the reason the header states: creating an
 * alias to a protected file is a write, and refusing `ln -s` while allowing
 * `os.symlink` refused the spelling rather than the act. `link\s*\(` covers
 * `os.symlink(`, `os.link(`, `fs.link(` and the bare forms at once; the sync
 * variants of Node do not contain it, so they are named.
 */
const WRITE_MARKERS =
  /\.write_text\s*\(|\.write_bytes\s*\(|\.unlink\s*\(|\.rename\s*\(|\.replace\s*\(|\.touch\s*\(|\.mkdir\s*\(|\.symlink_to\s*\(|\.hardlink_to\s*\(|os\.replace\s*\(|os\.remove\s*\(|os\.rmdir\s*\(|os\.truncate\s*\(|shutil\.(?:move|copy|copy2|copyfile|copytree|rmtree)\s*\(|open\s*\(|fopen\s*\(|link\s*\(|symlinkSync|linkSync|writeFileSync|appendFileSync|writeFile\s*\(|appendFile\s*\(|createWriteStream|unlinkSync|renameSync|copyFileSync|rmSync|truncateSync|Deno\.writeTextFile|Deno\.writeFile|Deno\.remove|Deno\.symlink|File\.write|IO\.write|FileUtils\./u;

/**
 * Ways of naming a path without writing it down. A body that writes and hides
 * its target behind one of these cannot be judged on its literals, so it is
 * refused, exactly as an unresolved redirection target is.
 */
const OPAQUE_MARKERS =
  /base64|b64decode|b64encode|atob\s*\(|btoa\s*\(|fromhex|unhexlify|fromCharCode|\.decode\s*\(\s*["']hex|codecs\.decode|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|chr\s*\(/u;

/**
 * Interpreter primitives that hand a whole line to a shell, the same act as
 * awk's `system()`. None of them appear in WRITE_MARKERS, whose vocabulary is
 * language-level file operations, so a body that only shells out through one
 * of these was invisible to `analyzeCode` even though a shell command is
 * exactly the write vector the rest of this file exists to read.
 *
 * The match is on the qualified name, `child_process.execSync(`, the same
 * literal shape `analyzeAwk` matches for `system(`. It is named rather than
 * hidden that `require('child_process').execSync(` does not match this: that
 * is the gap this table leaves, same as every other table in this file.
 */
const SHELL_EXEC_MARKERS =
  /\bos\.system\s*\(|\bos\.popen\s*\(|\bsubprocess\.run\s*\(|\bsubprocess\.call\s*\(|\bsubprocess\.Popen\s*\(|child_process\.execSync\s*\(|child_process\.exec\s*\(/gu;

const NULL_BYTE = "\u0000";
const VAR_OPEN = "\uE000";
const VAR_CLOSE = "\uE001";
const DYNAMIC_MARKER = "\uE002";

interface Token {
  kind: "word" | "op";
  value: string;
  quoted: boolean;
  fd?: string;
  delimiter?: string;
  heredoc?: string;
  substitutions?: string[];
}

class GuardRefusal extends Error {
  public readonly rule: string;

  public constructor(rule: string, message: string) {
    super(message);
    this.name = "GuardRefusal";
    this.rule = rule;
  }
}

function deny(rule: string, detail: string): GuardVerdict {
  return { decision: "deny", reason: `${BLOCK_MESSAGE} ${detail}`, rule };
}

function allow(): GuardVerdict {
  return { decision: "allow" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolName(tool: string): string {
  const trimmed = tool.trim().toLowerCase();
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("."));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
}

function basename(path: string): string {
  const cleaned = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const separator = cleaned.lastIndexOf("/");
  return separator === -1 ? cleaned : cleaned.slice(separator + 1);
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

function readSingleQuoted(input: string, start: number): { text: string; next: number } {
  const end = input.indexOf("'", start + 1);
  if (end === -1) {
    throw new GuardRefusal("tokenize-failed", "The command has an unterminated single quote.");
  }
  return { text: input.slice(start + 1, end), next: end + 1 };
}

function readBalanced(
  input: string,
  start: number,
  open: string,
  close: string,
): { text: string; next: number } {
  let depth = 0;
  let index = start;
  while (index < input.length) {
    const character = input.charAt(index);
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "'") {
      const quoted = readSingleQuoted(input, index);
      index = quoted.next;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return { text: input.slice(start + 1, index), next: index + 1 };
      }
    }
    index += 1;
  }
  throw new GuardRefusal("tokenize-failed", "The command has an unbalanced substitution.");
}

interface WordAccumulator {
  text: string;
  quoted: boolean;
  started: boolean;
  substitutions: string[];
}

function emptyWord(): WordAccumulator {
  return { text: "", quoted: false, started: false, substitutions: [] };
}

function readVariable(input: string, start: number, word: WordAccumulator): number {
  const next = input.charAt(start + 1);
  if (next === "{") {
    const closing = input.indexOf("}", start + 2);
    if (closing === -1) {
      throw new GuardRefusal("tokenize-failed", "The command has an unterminated expansion.");
    }
    const name = input.slice(start + 2, closing);
    word.text += /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      ? VAR_OPEN + name + VAR_CLOSE
      : DYNAMIC_MARKER;
    word.started = true;
    return closing + 1;
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(input.slice(start + 1));
  if (!match) {
    word.text += "$";
    word.started = true;
    return start + 1;
  }
  word.text += VAR_OPEN + match[0] + VAR_CLOSE;
  word.started = true;
  return start + 1 + match[0].length;
}

function readDoubleQuoted(input: string, start: number, word: WordAccumulator): number {
  let index = start + 1;
  word.quoted = true;
  word.started = true;
  while (index < input.length) {
    const character = input.charAt(index);
    if (character === '"') {
      return index + 1;
    }
    if (character === "\\") {
      const escaped = input.charAt(index + 1);
      if (escaped === "") {
        break;
      }
      word.text += escaped;
      index += 2;
      continue;
    }
    if (character === "`") {
      const closing = input.indexOf("`", index + 1);
      if (closing === -1) {
        throw new GuardRefusal("tokenize-failed", "The command has an unterminated backquote.");
      }
      word.substitutions.push(input.slice(index + 1, closing));
      word.text += DYNAMIC_MARKER;
      index = closing + 1;
      continue;
    }
    if (character === "$" && input.charAt(index + 1) === "(") {
      const inner = readBalanced(input, index + 1, "(", ")");
      word.substitutions.push(inner.text);
      word.text += DYNAMIC_MARKER;
      index = inner.next;
      continue;
    }
    if (character === "$") {
      index = readVariable(input, index, word);
      continue;
    }
    word.text += character;
    index += 1;
  }
  throw new GuardRefusal("tokenize-failed", "The command has an unterminated double quote.");
}

function consumeHeredocBodies(input: string, start: number, pending: Token[]): number {
  let index = start;
  while (pending.length > 0) {
    const token = pending.shift();
    if (!token) {
      break;
    }
    const delimiter = (token.delimiter ?? "").replace(/['"]/gu, "");
    const stripTabs = token.value === "<<-";
    const lines: string[] = [];
    let closed = false;
    while (index <= input.length) {
      const lineEnd = input.indexOf("\n", index);
      const line = lineEnd === -1 ? input.slice(index) : input.slice(index, lineEnd);
      const compared = stripTabs ? line.replace(/^\t+/u, "") : line;
      index = lineEnd === -1 ? input.length : lineEnd + 1;
      if (compared.trim() === delimiter) {
        closed = true;
        break;
      }
      lines.push(line);
      if (lineEnd === -1) {
        break;
      }
    }
    if (!closed) {
      throw new GuardRefusal("tokenize-failed", "The command has an unterminated heredoc.");
    }
    token.heredoc = lines.join("\n");
  }
  return index;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: Token[] = [];
  let awaitingDelimiter: Token | undefined;
  let word = emptyWord();
  let index = 0;

  const flush = (): void => {
    if (!word.started) {
      return;
    }
    const token: Token = {
      kind: "word",
      value: word.text,
      quoted: word.quoted,
      substitutions: word.substitutions,
    };
    if (awaitingDelimiter) {
      awaitingDelimiter.delimiter = word.text;
      pendingHeredocs.push(awaitingDelimiter);
      awaitingDelimiter = undefined;
    } else {
      tokens.push(token);
    }
    word = emptyWord();
  };

  const pushOperator = (value: string, fd?: string): Token => {
    flush();
    const token: Token = fd === undefined
      ? { kind: "op", value, quoted: false }
      : { kind: "op", value, quoted: false, fd };
    tokens.push(token);
    return token;
  };

  while (index < input.length) {
    const character = input.charAt(index);

    if (character === "\\") {
      const escaped = input.charAt(index + 1);
      if (escaped === "") {
        throw new GuardRefusal("tokenize-failed", "The command ends with a dangling escape.");
      }
      if (escaped !== "\n") {
        word.text += escaped;
        word.quoted = true;
        word.started = true;
      }
      index += 2;
      continue;
    }

    if (character === "'") {
      const quoted = readSingleQuoted(input, index);
      word.text += quoted.text;
      word.quoted = true;
      word.started = true;
      index = quoted.next;
      continue;
    }

    if (character === '"') {
      index = readDoubleQuoted(input, index, word);
      continue;
    }

    if (character === "`") {
      const closing = input.indexOf("`", index + 1);
      if (closing === -1) {
        throw new GuardRefusal("tokenize-failed", "The command has an unterminated backquote.");
      }
      word.substitutions.push(input.slice(index + 1, closing));
      word.text += DYNAMIC_MARKER;
      word.started = true;
      index = closing + 1;
      continue;
    }

    if (character === "$" && input.charAt(index + 1) === "(") {
      const inner = readBalanced(input, index + 1, "(", ")");
      word.substitutions.push(inner.text);
      word.text += DYNAMIC_MARKER;
      word.started = true;
      index = inner.next;
      continue;
    }

    if (character === "$" && input.charAt(index + 1) === "'") {
      const quoted = readSingleQuoted(input, index + 1);
      word.text += quoted.text.replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");
      word.quoted = true;
      word.started = true;
      index = quoted.next;
      continue;
    }

    if (character === "$") {
      index = readVariable(input, index, word);
      continue;
    }

    if (character === " " || character === "\t" || character === "\r") {
      flush();
      index += 1;
      continue;
    }

    if (character === "\n") {
      pushOperator("\n");
      index += 1;
      if (pendingHeredocs.length > 0) {
        index = consumeHeredocBodies(input, index, pendingHeredocs);
      }
      continue;
    }

    if (character === ";") {
      pushOperator(input.charAt(index + 1) === ";" ? ";;" : ";");
      index += input.charAt(index + 1) === ";" ? 2 : 1;
      continue;
    }

    if (character === "|") {
      pushOperator(input.charAt(index + 1) === "|" ? "||" : "|");
      index += input.charAt(index + 1) === "|" ? 2 : 1;
      continue;
    }

    if (character === "&") {
      if (input.charAt(index + 1) === "&") {
        pushOperator("&&");
        index += 2;
        continue;
      }
      if (input.charAt(index + 1) === ">") {
        const doubled = input.charAt(index + 2) === ">";
        pushOperator(doubled ? ">>" : ">");
        index += doubled ? 3 : 2;
        continue;
      }
      pushOperator("&");
      index += 1;
      continue;
    }

    if (character === "(" || character === ")") {
      pushOperator(character);
      index += 1;
      continue;
    }

    if (character === ">" || character === "<") {
      let fd: string | undefined;
      if (word.started && /^\d+$/u.test(word.text)) {
        fd = word.text;
        word = emptyWord();
      }
      let operator = character;
      let width = 1;
      if (character === ">") {
        const next = input.charAt(index + 1);
        if (next === ">") {
          operator = ">>";
          width = 2;
        } else if (next === "&") {
          operator = ">&";
          width = 2;
        } else if (next === "|") {
          operator = ">|";
          width = 2;
        }
      } else {
        const next = input.charAt(index + 1);
        if (next === "<") {
          const third = input.charAt(index + 2);
          if (third === "-") {
            operator = "<<-";
            width = 3;
          } else if (third === "<") {
            operator = "<<<";
            width = 3;
          } else {
            operator = "<<";
            width = 2;
          }
        } else if (next === ">") {
          operator = "<>";
          width = 2;
        }
      }
      const token = pushOperator(operator, fd);
      index += width;
      if (operator === "<<" || operator === "<<-") {
        awaitingDelimiter = token;
      }
      continue;
    }

    word.text += character;
    word.started = true;
    index += 1;
  }

  flush();
  if (awaitingDelimiter || pendingHeredocs.length > 0) {
    throw new GuardRefusal("tokenize-failed", "The command declares a heredoc it never closes.");
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const SEGMENT_SEPARATORS: readonly string[] = [";", ";;", "\n", "|", "||", "&&", "&", "(", ")"];

interface Redirection {
  operator: string;
  target: Token | undefined;
  fd: string | undefined;
}

interface Segment {
  words: Token[];
  redirections: Redirection[];
  heredocs: string[];
  /** This segment reads the standard output of the previous one. */
  pipedInto: boolean;
}

function emptySegment(): Segment {
  return { words: [], redirections: [], heredocs: [], pipedInto: false };
}

function splitSegments(tokens: readonly Token[]): Segment[] {
  const segments: Segment[] = [];
  let current = emptySegment();

  const close = (): void => {
    if (current.words.length > 0 || current.redirections.length > 0 || current.heredocs.length > 0) {
      segments.push(current);
    }
    current = emptySegment();
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.kind === "op") {
      if (SEGMENT_SEPARATORS.includes(token.value)) {
        close();
        // Only a real pipe carries the previous output into this command. A
        // logical or is a separator, not a channel.
        current.pipedInto = token.value === "|";
        continue;
      }
      if (token.value === "<<" || token.value === "<<-") {
        current.heredocs.push(token.heredoc ?? "");
        continue;
      }
      const next = tokens[index + 1];
      const target = next && next.kind === "word" ? next : undefined;
      if (target) {
        index += 1;
      }
      current.redirections.push({
        operator: token.value,
        target,
        fd: token.fd,
      });
      continue;
    }
    if (token.value === "{" || token.value === "}") {
      close();
      continue;
    }
    current.words.push(token);
  }

  close();
  return segments;
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

interface ProtectedPaths {
  /** Every directory a target inside counts as protected, configured plus hardcoded. */
  directories: string[];
  files: string[];
}

/**
 * The perimeter this guard enforces: the configured preferences directory
 * (`config.paths.memory`, editable, and legitimately so, since a vault is
 * free to rename its own memory root) UNIONED with the paths nothing in the
 * config can move, see `HARDCODED_PROTECTED_FILES` and
 * `HARDCODED_PROTECTED_DIRECTORIES` above. Changing `memory:` in
 * `vault.config.yml` can widen or narrow the first set; it can never touch
 * the second.
 */
function protectedPathsFor(input: GuardInput): ProtectedPaths {
  const memory = typeof input.config.paths.memory === "string" && input.config.paths.memory.length > 0
    ? input.config.paths.memory
    : "10_memory";
  const configuredDirectory = resolve(join(input.vaultRoot, memory, PREFERENCES_DIRECTORY));
  const directories = [
    configuredDirectory,
    ...HARDCODED_PROTECTED_DIRECTORIES.map((relative) => resolve(join(input.vaultRoot, relative))),
  ];
  const files = [
    ...PROTECTED_FILENAMES.map((name) => join(configuredDirectory, name)),
    ...HARDCODED_PROTECTED_FILES.map((relative) => resolve(join(input.vaultRoot, relative))),
  ];
  return {
    directories: directories.map((directory) => comparable(directory)),
    files: files.map((file) => comparable(file)),
  };
}

/**
 * Whether the filesystem this process runs on folds case in a file name.
 *
 * The guard performs no I/O, so it cannot ask the volume and reads the platform
 * instead. macOS and Windows fold by default and Linux does not, which is the
 * closest a pure function gets to the truth. A macOS volume formatted
 * case-sensitively is the one case it reads the wrong way, and it reads it in
 * the refusing direction.
 */
const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";

/**
 * Two spellings of the same path, reduced to one string.
 *
 * Separators and trailing slashes were already handled. Two things were not.
 *
 * Case was folded unconditionally, on every platform. On Linux a file named
 * `10_MEMORY/preferences/_core.md` is a different file from the kernel, and
 * writing to it was refused: safe, but a false positive inside the one function
 * whose stated job is to end them. Folding now follows the platform.
 *
 * Unicode was not normalized at all. A vault path holding a non-ASCII character
 * can be written composed or decomposed, macOS stores one form and accepts
 * both, and the two spellings reach the same inode while comparing unequal
 * here: the guard allowed a write to the file it protects. Canonical
 * composition is what collapses them. Compatibility folding, which this
 * codebase uses when it matches words rather than paths, would go further and
 * collapse names that really are different files, so it is not used here.
 */
function comparable(path: string): string {
  const cleaned = path.replace(/\\/gu, "/").replace(/\/+$/u, "").normalize("NFC");
  return FOLDS_CASE ? cleaned.toLowerCase() : cleaned;
}

interface WriteTarget {
  raw: string;
  cwd: string;
  destructive: boolean;
}

type TargetVerdict = "protected" | "ancestor" | "outside" | "unresolved";

function expandWord(value: string, variables: ReadonlyMap<string, string>): string | undefined {
  if (value.includes(DYNAMIC_MARKER)) {
    return undefined;
  }
  let expanded = value;
  const pattern = new RegExp(`${VAR_OPEN}([A-Za-z_][A-Za-z0-9_]*)${VAR_CLOSE}`, "u");
  for (let guard = 0; guard < 16; guard += 1) {
    const match = pattern.exec(expanded);
    if (!match) {
      return expanded;
    }
    const name = match[1] ?? "";
    const replacement = variables.get(name);
    if (replacement === undefined) {
      return undefined;
    }
    expanded = expanded.replace(match[0], replacement);
  }
  return undefined;
}

/** Basenames of the hardcoded protected files, for the unresolved `~` heuristic below. */
const HARDCODED_PROTECTED_BASENAMES: readonly string[] =
  HARDCODED_PROTECTED_FILES.map((path) => basename(path));

/** `/segment/` forms of the hardcoded protected directories, same purpose. */
const HARDCODED_PROTECTED_DIRECTORY_SEGMENTS: readonly string[] =
  HARDCODED_PROTECTED_DIRECTORIES.map((directory) => `/${directory.replace(/\\/gu, "/")}/`);

function classifyTarget(target: WriteTarget, guarded: ProtectedPaths): TargetVerdict {
  const raw = target.raw;
  if (raw.length === 0) {
    return "outside";
  }
  if (raw.startsWith("~")) {
    const name = basename(raw);
    return PROTECTED_FILENAMES.includes(name)
      || HARDCODED_PROTECTED_BASENAMES.includes(name)
      || raw.includes(`/${PREFERENCES_DIRECTORY}/`)
      || HARDCODED_PROTECTED_DIRECTORY_SEGMENTS.some((segment) => raw.includes(segment))
      ? "protected"
      : "unresolved";
  }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(target.cwd, raw);
  const normalized = comparable(absolute);
  if (guarded.files.includes(normalized)) {
    return "protected";
  }
  for (const directory of guarded.directories) {
    if (normalized === directory || normalized.startsWith(`${directory}/`)) {
      return "protected";
    }
  }
  if (guarded.directories.some((directory) => directory.startsWith(`${normalized}/`))) {
    return "ancestor";
  }
  return "outside";
}

// ---------------------------------------------------------------------------
// Command tables
// ---------------------------------------------------------------------------

type OperandRule = "all" | "destination" | "none";

interface MutatorRule {
  operands: OperandRule;
  /** Flags whose next word is their value, so it is not an operand. */
  valueFlags?: readonly string[];
  /** Short-flag letters with the same effect when they end a cluster. */
  valueLetters?: string;
  /** Flags whose value is itself a file the command would write. */
  targetFlags?: readonly string[];
  /** Short-flag letters with the same effect: `curl -so out` writes `out`. */
  targetLetters?: string;
  recursiveFlags?: readonly string[];
  skipFirstOperand?: boolean;
}

/**
 * The commands that write, and how each of them names what it writes.
 *
 * This table is a denylist, and that is a deliberate choice with a cost that
 * belongs in writing rather than in a comment claiming completeness. The
 * alternative was an allowlist of readers: refuse every command not proven to
 * be a reader when it names a protected path. That posture is stronger against
 * the unknown and it was rejected for one reason: it refuses reads. `bat`,
 * `less`, `md5`, `python3 -m json.tool`, any tool a user installs tomorrow,
 * all of them would refuse on a path they only open for reading, and refusing
 * reads is the exact failure this file was rewritten to end.
 *
 * So the gap is named instead of hidden. A writer that is not on this list and
 * is not a redirection, an interpreter body, a patch or the preference CLI is
 * not seen. The list grew from the measured ones: the download tools that took
 * a protected path as an output flag, the editors driven from a script, the
 * archive tools that unpack over a directory, the in-place interpreters. What
 * closes the rest is not this table but the layers after it: `doctor` reports
 * what resolves into the kernel, and the redline sees the modification.
 */
const MUTATORS: Readonly<Record<string, MutatorRule>> = {
  chflags: { operands: "all", skipFirstOperand: true, recursiveFlags: ["R"] },
  chgrp: { operands: "all", skipFirstOperand: true, recursiveFlags: ["R"] },
  chmod: { operands: "all", skipFirstOperand: true, recursiveFlags: ["R"] },
  chown: { operands: "all", skipFirstOperand: true, recursiveFlags: ["R"] },
  cp: {
    operands: "destination",
    valueFlags: ["-t", "--target-directory", "-S", "--suffix"],
    recursiveFlags: ["r", "R", "a"],
  },
  curl: {
    operands: "none",
    targetFlags: ["--output", "--output-dir", "--dump-header", "--trace", "--trace-ascii"],
    targetLetters: "oD",
  },
  ed: { operands: "all", valueLetters: "p" },
  ex: { operands: "all", valueLetters: "cs" },
  // Interactive editors, driven from a script exactly like ex: every operand
  // that is not a flag value is a file they can write back to.
  vim: { operands: "all", valueLetters: "cs" },
  vi: { operands: "all", valueLetters: "cs" },
  nvim: { operands: "all", valueLetters: "cs" },
  emacs: { operands: "all", valueLetters: "cs" },
  install: { operands: "destination", valueFlags: ["-m", "-o", "-g", "-t", "--mode", "--owner", "--group"] },
  ln: { operands: "all", valueFlags: ["-S", "--suffix", "-t", "--target-directory"] },
  mkdir: { operands: "all", valueFlags: ["-m", "--mode"] },
  mv: { operands: "all", valueFlags: ["-t", "--target-directory", "-S", "--suffix"] },
  openssl: { operands: "none", targetFlags: ["-out", "-keyout", "-signkey"] },
  patch: { operands: "all", valueFlags: ["-i", "--input", "-d", "--directory", "-p", "-o", "--output"] },
  rm: { operands: "all", recursiveFlags: ["r", "R"] },
  rmdir: { operands: "all" },
  rsync: {
    operands: "destination",
    valueFlags: ["-e", "--rsh", "--exclude", "--include", "--files-from", "--filter"],
    recursiveFlags: ["r", "a"],
  },
  shred: { operands: "all", valueFlags: ["-n", "-s"] },
  sponge: { operands: "all" },
  tee: { operands: "all" },
  touch: { operands: "all", valueFlags: ["-d", "-t", "-r", "--date", "--reference"] },
  truncate: { operands: "all", valueFlags: ["-s", "--size", "-r", "--reference"] },
  unlink: { operands: "all" },
  wget: {
    operands: "none",
    targetFlags: ["--output-document", "--directory-prefix", "--output-file"],
    targetLetters: "OPo",
  },
  xattr: { operands: "all", skipFirstOperand: true, valueFlags: ["-w", "-d"] },
};

/** The awk family, whose program hides its redirections from the shell lexer. */
const AWKS: readonly string[] = ["awk", "gawk", "mawk", "nawk"];

/** Interpreters that edit their operands in place when a cluster carries `i`. */
const IN_PLACE_INTERPRETERS: readonly string[] = ["perl", "ruby"];

/**
 * The in-place spelling of those interpreters, and only that one.
 *
 * `-i`, `-pi`, `-ni.bak` all edit the files that follow. Matching the letter
 * anywhere in the cluster would have matched `-MList::Util` too, and a module
 * name is not an edit, so the cluster is read as the short switches it really
 * is.
 */
const IN_PLACE_CLUSTER = /^-[0nplaswcFe]*i(?:\.[^\s]*)?$/u;

/** git subcommands that touch the working tree, and how they name their targets. */
const GIT_PATH_SUBCOMMANDS: readonly string[] = ["restore", "checkout", "switch", "rm", "mv"];
const GIT_TREE_SUBCOMMANDS: readonly string[] = ["clean", "apply", "am", "stash", "revert", "merge", "rebase", "pull"];

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Analysis {
  targets: WriteTarget[];
  preferenceCliMutation: boolean;
  unattendedKernelWrite: boolean;
  mentionsProtectedName: boolean;
}

interface Context {
  guarded: ProtectedPaths;
  variables: Map<string, string>;
  analysis: Analysis;
  depth: number;
}

function isFlag(value: string): boolean {
  return value.startsWith("-") && value !== "-" && value !== "--";
}

/**
 * A flag as the program reads it, not as one spelling of it happens to look.
 *
 * Every check in this file used to compare a whole token to a whole flag, and
 * two spellings that no program distinguishes went straight through. `-lc` is
 * how a shell is really called, and a shell splits it into `-l` and `-c`, so
 * comparing the token to `-c` recognized nothing and the inline script was
 * never read. `--unattended=true` is what citty accepts everywhere it accepts
 * `--unattended`, so comparing the token to `--unattended` recognized nothing
 * and the human gate was simply absent. Both are the same defect: a flag is a
 * name, an optional attached value, and, when it is short, a cluster of
 * letters. Everything that keys on a flag now asks this function.
 */
interface ParsedFlag {
  /** The flag without whatever was written after an equals sign. */
  name: string;
  /** The value written after an equals sign, if there was one. */
  attached: string | undefined;
  /** The letters a clustered short flag carries. Empty for a long flag. */
  letters: string;
}

function parseFlag(value: string): ParsedFlag | undefined {
  if (!isFlag(value)) {
    return undefined;
  }
  const equals = value.indexOf("=");
  const name = equals === -1 ? value : value.slice(0, equals);
  const attached = equals === -1 ? undefined : value.slice(equals + 1);
  return { name, attached, letters: name.startsWith("--") ? "" : name.slice(1) };
}

/** Whether this word is one of these flags, bare or in the `=value` spelling. */
function namesFlag(value: string, names: readonly string[]): boolean {
  const flag = parseFlag(value);
  return flag !== undefined && names.includes(flag.name);
}

/** Whether this word is a short cluster carrying one of these letters. */
function carriesLetter(value: string, letters: string): boolean {
  const flag = parseFlag(value);
  if (!flag) {
    return false;
  }
  return [...flag.letters].some((letter) => letters.includes(letter));
}

function shortFlagLetters(value: string): string {
  return parseFlag(value)?.letters ?? "";
}

function mentionsProtectedName(value: string): boolean {
  const lower = value.toLowerCase();
  return PROTECTED_FILENAMES.some((name) => lower.includes(name))
    || lower.includes(`/${PREFERENCES_DIRECTORY}/`);
}

interface Word {
  value: string;
  expanded: string | undefined;
  quoted: boolean;
  substitutions: readonly string[];
}

function toWords(segment: Segment, variables: ReadonlyMap<string, string>): Word[] {
  return segment.words.map((token) => ({
    value: token.value,
    expanded: expandWord(token.value, variables),
    quoted: token.quoted,
    substitutions: token.substitutions ?? [],
  }));
}

function addTarget(context: Context, cwd: string, word: Word, destructive: boolean): void {
  const raw = word.expanded;
  if (raw === undefined) {
    // The target cannot be resolved. That alone proves nothing, so it only
    // refuses when the command itself names a protected file: a writer aimed at
    // an opaque variable next to a mention of the ledger is not something this
    // guard is willing to let through.
    context.analysis.targets.push({ raw: "", cwd, destructive });
    if (context.analysis.mentionsProtectedName) {
      throw new GuardRefusal(
        "unresolved-write-target",
        "A write target could not be resolved and the command names a protected file.",
      );
    }
    return;
  }
  context.analysis.targets.push({ raw, cwd, destructive });
}

/**
 * The operands of a mutator, with its flags and their values removed.
 *
 * Quoting used to disqualify a word from being a flag, and that was never true
 * of anything: the shell strips the quotes and `sed` reads the same four bytes
 * whether they were written `-i` or `'-i'`. The rule cost more than a spelling.
 * `analyzeArgv` marks every token as quoted, because an argv array has no shell
 * to quote it, so the whole array tool API lost flag recognition at once: `-i`
 * was filed as a filename, `-r` as a path, and the in-place edit and the
 * recursive copy behind them were invisible.
 */
function collectOperands(words: readonly Word[], rule: MutatorRule): Word[] {
  const operands: Word[] = [];
  const valueFlags = rule.valueFlags ?? [];
  const valueLetters = rule.valueLetters ?? "";
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    if (word.value === "--") {
      continue;
    }
    const flag = parseFlag(word.value);
    if (flag) {
      const takesValue = valueFlags.includes(flag.name)
        || (flag.letters.length > 0 && valueLetters.includes(flag.letters.slice(-1)));
      if (takesValue && flag.attached === undefined) {
        index += 1;
      }
      continue;
    }
    operands.push(word);
  }
  return rule.skipFirstOperand === true ? operands.slice(1) : operands;
}

function isRecursive(words: readonly Word[], rule: MutatorRule): boolean {
  const letters = rule.recursiveFlags ?? [];
  if (letters.length === 0) {
    return false;
  }
  return words.some((word) => {
    if (!isFlag(word.value)) {
      return false;
    }
    if (namesFlag(word.value, ["--recursive", "--archive"])) {
      return true;
    }
    const short = shortFlagLetters(word.value);
    return letters.some((letter) => short.includes(letter));
  });
}

function analyzeRedirections(context: Context, segment: Segment, cwd: string): void {
  for (const redirection of segment.redirections) {
    const writes = [">", ">>", ">|", "<>", ">&"].includes(redirection.operator);
    if (!writes || !redirection.target) {
      continue;
    }
    const expanded = expandWord(redirection.target.value, context.variables);
    if (redirection.operator === ">&" && expanded !== undefined && /^\d+$|^-$/u.test(expanded)) {
      continue;
    }
    addTarget(
      context,
      cwd,
      {
        value: redirection.target.value,
        expanded,
        quoted: redirection.target.quoted,
        substitutions: redirection.target.substitutions ?? [],
      },
      false,
    );
  }
}

/**
 * The files a command names through a flag rather than through an operand.
 *
 * `curl -so <path>` is the shape that mattered: the output flag is the last
 * letter of a cluster, so the path is the next word, and a table that only
 * knew operands never looked at it.
 */
function flagTarget(words: readonly Word[], index: number, rule: MutatorRule): Word | undefined {
  const word = words[index];
  if (!word) {
    return undefined;
  }
  const flag = parseFlag(word.value);
  if (!flag) {
    return undefined;
  }
  const named = (rule.targetFlags ?? []).includes(flag.name);
  const lettered = flag.letters.length > 0
    && (rule.targetLetters ?? "").includes(flag.letters.slice(-1));
  if (!named && !lettered) {
    return undefined;
  }
  if (flag.attached !== undefined) {
    const expanded = word.expanded;
    return {
      value: flag.attached,
      expanded: expanded === undefined ? undefined : expanded.slice(expanded.indexOf("=") + 1),
      quoted: word.quoted,
      substitutions: word.substitutions,
    };
  }
  return words[index + 1];
}

/** `-t dir` and `--target-directory=dir` name the destination, not an operand. */
const TARGET_DIRECTORY_RULE: MutatorRule = {
  operands: "none",
  targetFlags: ["-t", "--target-directory"],
};

function analyzeMutator(context: Context, name: string, words: readonly Word[], cwd: string): void {
  const rule = MUTATORS[name];
  if (!rule) {
    return;
  }
  const operands = collectOperands(words, rule);
  const recursive = isRecursive(words, rule);
  let destinationFlag: Word | undefined;
  for (let index = 1; index < words.length; index += 1) {
    const flagged = flagTarget(words, index, rule);
    if (flagged) {
      addTarget(context, cwd, flagged, true);
    }
    destinationFlag = flagTarget(words, index, TARGET_DIRECTORY_RULE) ?? destinationFlag;
  }
  if (destinationFlag) {
    // `-t dir` is the destination whatever the rest of the line looks like.
    // Reading it only for the commands whose last operand is a destination
    // meant `mv -t <kernel> forged.md` named its target and was not seen.
    addTarget(context, cwd, destinationFlag, true);
  }
  if (rule.operands === "none") {
    // The command names what it writes through a flag. Its operands are a URL,
    // a subcommand or an input file, and calling any of them a write target
    // refused `openssl dgst <file>`, which only reads.
    return;
  }
  if (rule.operands === "destination" && destinationFlag) {
    return;
  }
  if (rule.operands === "destination") {
    const destination = operands[operands.length - 1];
    if (destination) {
      addTarget(context, cwd, destination, recursive);
    }
    return;
  }
  for (const operand of operands) {
    addTarget(context, cwd, operand, recursive || name === "rm" || name === "mv");
  }
}

function analyzeDd(context: Context, words: readonly Word[], cwd: string): void {
  for (const word of words.slice(1)) {
    if (word.value.startsWith("of=")) {
      addTarget(
        context,
        cwd,
        {
          value: word.value.slice(3),
          expanded: word.expanded === undefined ? undefined : word.expanded.slice(3),
          quoted: word.quoted,
          substitutions: word.substitutions,
        },
        false,
      );
    }
  }
}

function analyzeSed(context: Context, words: readonly Word[], cwd: string): void {
  const inPlace = words.some(
    (word) => word.value.startsWith("-i") || word.value.startsWith("--in-place"),
  );
  if (!inPlace) {
    return;
  }
  const scriptFlags = words.some(
    (word) => word.value === "-e" || word.value === "-f" || word.value === "--expression" || word.value === "--file",
  );
  const rule: MutatorRule = { operands: "all", valueFlags: ["-e", "-f", "--expression", "--file"] };
  const operands = collectOperands(words, rule);
  const files = scriptFlags ? operands : operands.slice(1);
  for (const file of files) {
    addTarget(context, cwd, file, false);
  }
}

/**
 * An interpreter that edits its operands in place, the way `sed -i` does.
 *
 * `perl -pi -e 's/a/b/' <file>` rewrites the file without ever naming it inside
 * the body, so reading the body proves nothing. What proves it is the cluster.
 */
function analyzeInPlaceInterpreter(
  context: Context,
  name: string,
  words: readonly Word[],
  cwd: string,
): void {
  if (!IN_PLACE_INTERPRETERS.includes(name)) {
    return;
  }
  if (!words.some((word) => IN_PLACE_CLUSTER.test(word.value))) {
    return;
  }
  const rule: MutatorRule = {
    operands: "all",
    valueFlags: ["-e", "-E", "-m", "-M", "-I", "-F", "-r", "--eval"],
    valueLetters: "eEmMIFr",
  };
  for (const file of collectOperands(words, rule)) {
    addTarget(context, cwd, file, false);
  }
}

/**
 * The redirections of an awk program, which the shell lexer never sees.
 *
 * `awk 'BEGIN{print "x" > "<path>"}'` is one quoted word to the shell, so the
 * `>` inside it is not an operator and no redirection was ever recorded. The
 * program is read here instead, and only a redirection into a literal counts:
 * matching a bare `>` would have called `$1 > 5` a write.
 */
function analyzeAwk(context: Context, words: readonly Word[], cwd: string): void {
  if (words.some((word) => namesFlag(word.value, ["-f", "--file"]))) {
    // The program lives in a file this function does not read, exactly as
    // `sed -f` does. Nothing here can say what it writes, and nothing here
    // pretends to.
    return;
  }
  const rule: MutatorRule = { operands: "all", valueFlags: ["-v", "--assign"], valueLetters: "v" };
  const program = collectOperands(words, rule)[0];
  const source = program?.expanded;
  if (source === undefined) {
    return;
  }
  for (const match of source.matchAll(/>>?\s*(["'])([^"'\n]*)\1/gu)) {
    const literal = match[2] ?? "";
    if (literal.length > 0) {
      addTarget(context, cwd, { value: literal, expanded: literal, quoted: true, substitutions: [] }, false);
    }
  }
  if (!/\bsystem\s*\(/u.test(source)) {
    return;
  }
  const inner = /\bsystem\s*\(\s*(["'])([^"'\n]*)\1\s*\)/u.exec(source);
  if (!inner) {
    throw new GuardRefusal(
      "opaque-interpreter-write",
      "This awk program shells out with a command it builds at runtime, so what it would run cannot be established.",
    );
  }
  analyzeCommandText(context, inner[2] ?? "", cwd, context.depth + 1);
}

/** The primaries that make `find` write rather than list. */
const FIND_DESTRUCTIVE: readonly string[] = ["-delete", "-fprint", "-fprintf", "-fls"];
const FIND_EXEC: readonly string[] = ["-exec", "-execdir", "-ok", "-okdir"];
/** Options `find` accepts before the paths it walks, none of which take a value. */
const FIND_PRE_PATH_FLAGS: readonly string[] = ["-H", "-L", "-P", "-E", "-d", "-s", "-x"];

/**
 * What a `find` expression would do to the directories it walks.
 *
 * The paths are operands, but the write is a primary buried in the expression,
 * so a table keyed on the command name saw a reader. `-delete` and an `-exec`
 * that runs a mutator both make every starting path a destructive target, and
 * the exec command is analyzed on its own so an explicit path inside it counts
 * too.
 */
function analyzeFind(context: Context, words: readonly Word[], cwd: string): void {
  const roots: Word[] = [];
  let expression = words.length;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    if (FIND_PRE_PATH_FLAGS.includes(word.value)) {
      continue;
    }
    if (isFlag(word.value) || word.value === "(" || word.value === "!") {
      expression = index;
      break;
    }
    roots.push(word);
  }

  let destructive = false;
  for (let index = expression; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    if (FIND_DESTRUCTIVE.includes(word.value)) {
      destructive = true;
      continue;
    }
    if (!FIND_EXEC.includes(word.value)) {
      continue;
    }
    const end = words.findIndex(
      (candidate, position) => position > index && (candidate.value === ";" || candidate.value === "+"),
    );
    const inner = words.slice(index + 1, end === -1 ? words.length : end);
    if (inner.length === 0) {
      continue;
    }
    const command = basename(inner[0]?.expanded ?? inner[0]?.value ?? "").toLowerCase();
    if (MUTATORS[command] || command === "sed" || command === "gsed" || command === "tar" || SHELLS.includes(command)) {
      destructive = true;
    }
    analyzeCommand(context, inner, cwd, [], false);
  }

  if (!destructive) {
    return;
  }
  for (const root of roots) {
    addTarget(context, cwd, root, true);
  }
  if (roots.length === 0) {
    addTarget(context, cwd, { value: cwd, expanded: cwd, quoted: false, substitutions: [] }, true);
  }
}

function analyzeTar(context: Context, words: readonly Word[], cwd: string): void {
  const extracting = words.some(
    (word) => word.value === "-x" || word.value === "--extract" || /^-[^-]*x/u.test(word.value),
  );
  if (!extracting) {
    return;
  }
  const rule: MutatorRule = { operands: "none", targetFlags: ["-C", "--directory"] };
  for (let index = 1; index < words.length; index += 1) {
    const destination = flagTarget(words, index, rule);
    if (destination) {
      addTarget(context, cwd, destination, true);
      return;
    }
  }
  addTarget(context, cwd, { value: cwd, expanded: cwd, quoted: false, substitutions: [] }, true);
}

/**
 * `unzip` unpacks over `-d` when it is given one, and over the cwd when it is
 * not. The listing letters only mean a listing when nothing on the line asks
 * for an extraction, since `-o` and `-d` put one back.
 */
function analyzeUnzip(context: Context, words: readonly Word[], cwd: string): void {
  const rule: MutatorRule = { operands: "none", targetFlags: ["-d"], targetLetters: "d" };
  const extracts = words.some((word) => carriesLetter(word.value, "od"));
  if (!extracts && words.some((word) => carriesLetter(word.value, "lptvz"))) {
    return;
  }
  for (let index = 1; index < words.length; index += 1) {
    const destination = flagTarget(words, index, rule);
    if (destination) {
      addTarget(context, cwd, destination, true);
      return;
    }
  }
  addTarget(context, cwd, { value: cwd, expanded: cwd, quoted: false, substitutions: [] }, true);
}

/**
 * `xargs` runs a command on operands it reads from somewhere else.
 *
 * It used to be a transparent wrapper, so the guard analyzed `rm -f` with no
 * operands at all and allowed it: `echo <path> | xargs rm -f` deleted a file
 * the guard had just read the name of. What is written on the line is still
 * analyzed, because `xargs rm <path>` puts the path there. What comes from the
 * pipe, `-a`/`--arg-file`, or an input redirection (`xargs rm < paths.txt`,
 * the same operand source as `-a` under a different spelling) is not readable
 * here, so a mutator fed by one is recorded as a target that could not be
 * resolved, which is the same answer this guard already gives to
 * `rm "$UNKNOWN"`: refuse when the command names a protected file, allow
 * when it does not.
 */
function analyzeXargs(context: Context, words: readonly Word[], cwd: string, fed: boolean): void {
  const valueFlags = WRAPPER_VALUE_FLAGS.xargs ?? [];
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    const flag = word === undefined ? undefined : parseFlag(word.value);
    if (!flag) {
      break;
    }
    const takesValue = valueFlags.includes(flag.name)
      || (flag.letters.length > 0 && XARGS_VALUE_LETTERS.includes(flag.letters.slice(-1)));
    index += takesValue && flag.attached === undefined ? 2 : 1;
  }
  const inner = words.slice(index);
  if (inner.length === 0) {
    return;
  }
  analyzeCommand(context, inner, cwd, [], false);
  const readsFromElsewhere = fed || words.some((word) => namesFlag(word.value, ["-a", "--arg-file"]));
  if (!readsFromElsewhere) {
    return;
  }
  const resolved = resolveCommand(context, inner);
  const name = basename(resolved[0]?.expanded ?? resolved[0]?.value ?? "").toLowerCase();
  if (isWriter(name)) {
    addTarget(context, cwd, { value: "", expanded: undefined, quoted: false, substitutions: [] }, true);
  }
}

/** The xargs options that consume the word after them rather than start a command. */
const XARGS_VALUE_LETTERS = "nIiPdasEeLl";

/** Whether this file knows the named command to be capable of a write. */
function isWriter(name: string): boolean {
  return MUTATORS[name] !== undefined
    || AWKS.includes(name)
    || SHELLS.includes(name)
    || INTERPRETERS.includes(name)
    || ["apply_patch", "dd", "find", "git", "sed", "gsed", "tar", "unzip"].includes(name);
}

function gitEffectiveCwd(words: readonly Word[], cwd: string): string {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    const flag = parseFlag(word.value);
    if (!flag || !["-C", "--work-tree"].includes(flag.name)) {
      continue;
    }
    const directory = flag.attached === undefined
      ? words[index + 1]?.expanded
      : word.expanded?.slice(word.expanded.indexOf("=") + 1);
    if (directory !== undefined && directory.length > 0) {
      return isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory);
    }
  }
  return cwd;
}

function analyzeGit(context: Context, words: readonly Word[], cwd: string): void {
  const effectiveCwd = gitEffectiveCwd(words, cwd);
  const valueFlags = ["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"];
  let subcommand: Word | undefined;
  const operands: Word[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    const flag = parseFlag(word.value);
    if (flag) {
      if (flag.attached === undefined && valueFlags.includes(flag.name)) {
        index += 1;
      }
      continue;
    }
    if (!subcommand) {
      subcommand = word;
      continue;
    }
    operands.push(word);
  }
  if (!subcommand) {
    return;
  }

  const name = subcommand.value;
  const hard = words.some((word) => word.value === "--hard" || word.value === "--merge");
  const wholeTree = {
    value: effectiveCwd,
    expanded: effectiveCwd,
    quoted: false,
    substitutions: [],
  };

  if (name === "reset") {
    if (hard) {
      addTarget(context, effectiveCwd, wholeTree, true);
    }
    return;
  }
  if (GIT_TREE_SUBCOMMANDS.includes(name)) {
    if (name === "stash") {
      const action = operands[0]?.value ?? "";
      if (action !== "pop" && action !== "apply" && action !== "" && action !== "drop") {
        return;
      }
      if (action === "drop") {
        return;
      }
    }
    addTarget(context, effectiveCwd, wholeTree, true);
    return;
  }
  if (GIT_PATH_SUBCOMMANDS.includes(name)) {
    const paths = operands.filter((operand) => operand.value !== "--");
    const separator = operands.findIndex((operand) => operand.value === "--");
    const selected = separator === -1 ? paths : operands.slice(separator + 1);
    if (selected.length === 0) {
      addTarget(context, effectiveCwd, wholeTree, true);
      return;
    }
    for (const path of selected) {
      addTarget(context, effectiveCwd, path, true);
    }
  }
}

/**
 * Shell-out calls inside an interpreter body, read the same way `analyzeAwk`
 * reads `system()`: only a plain string literal argument can be established,
 * so only that shape is walked into `analyzeCommandText`, where every table
 * in this file, redirections, sed, xargs, applies to what the call would
 * actually run. A variable, an f-string, a list built at runtime, or any
 * other shape hides the command and is refused rather than guessed.
 */
function analyzeShellExecCalls(context: Context, code: string, cwd: string): void {
  const calls = [...code.matchAll(SHELL_EXEC_MARKERS)];
  for (const call of calls) {
    const start = (call.index ?? 0) + call[0].length;
    const rest = code.slice(start).replace(/^\s+/u, "");
    const literal = /^(["'])([^"'\n]*)\1/u.exec(rest);
    if (!literal) {
      throw new GuardRefusal(
        "opaque-interpreter-write",
        "This interpreter body shells out through os.system, os.popen, subprocess, or child_process with a command that is not a plain string literal, so what it would run cannot be established.",
      );
    }
    analyzeCommandText(context, literal[2] ?? "", cwd, context.depth + 1);
  }
}

function analyzeCode(context: Context, code: string, cwd: string): void {
  analyzeShellExecCalls(context, code, cwd);
  if (!WRITE_MARKERS.test(code)) {
    return;
  }
  if (OPAQUE_MARKERS.test(code)) {
    throw new GuardRefusal(
      "opaque-interpreter-write",
      "This interpreter body writes, and it builds at least one of its strings from an encoding, so the file it would touch cannot be established from the command. It is refused rather than guessed.",
    );
  }
  for (const literal of codeLiterals(code)) {
    addTarget(context, cwd, { value: literal, expanded: literal, quoted: true, substitutions: [] }, false);
  }
}

/**
 * The strings an interpreter body could be naming a file with.
 *
 * Each literal counts on its own, and so does every run of literals the
 * language would join into one. `open('.../pref' 'erences/_core.md','w')` is a
 * single path to Python and it was two harmless fragments here, which is the
 * same trick as `chr(49)` and base64: split the name so no piece matches. Those
 * two are refused outright because their result cannot be computed. A
 * concatenation can be, so it is computed rather than refused, and the run is
 * added alongside its pieces instead of replacing them.
 */
function codeLiterals(code: string): string[] {
  const matches = [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"/gu)];
  const literals: string[] = [];
  let run = "";
  let runEnd = -1;
  for (const match of matches) {
    const value = match[1] ?? match[2] ?? "";
    const start = match.index ?? 0;
    const joined = runEnd !== -1 && /^\s*\+?\s*$/u.test(code.slice(runEnd, start));
    run = joined ? run + value : value;
    runEnd = start + match[0].length;
    if (value.length > 0) {
      literals.push(value);
    }
    if (joined && run.length > 0) {
      literals.push(run);
    }
  }
  return literals;
}

function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/gimu,
    /^\*\*\*\s+Move\s+to:\s*(.+)$/gimu,
    /^\+\+\+\s+(?:b\/)?(.+?)(?:\t.*)?$/gmu,
    /^---\s+(?:a\/)?(.+?)(?:\t.*)?$/gmu,
    /^diff --git a\/(.+?) b\/(.+)$/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      for (const group of match.slice(1)) {
        const value = (group ?? "").trim();
        if (value.length > 0 && value !== "/dev/null") {
          targets.push(value);
        }
      }
    }
  }
  return targets;
}

function analyzePreferenceCli(context: Context, words: readonly Word[]): void {
  // The escape hatch of the human gate is a kernel write with the proof of a
  // human switched off. A tool call is exactly the caller that must never have
  // it: on a vault where the hooks capability is armed, that proof is the whole
  // reason this guard runs at all.
  if (words.some((word) => namesFlag(word.expanded ?? word.value, ["--unattended"]))) {
    context.analysis.unattendedKernelWrite = true;
  }

  const operands = words.slice(1).filter((word) => !isFlag(word.value));
  const prefsIndex = operands.findIndex((word) => {
    const value = word.expanded ?? word.value;
    return value === "prefs" || value === "preferences";
  });
  if (prefsIndex === -1) {
    // A subcommand built at runtime could be any of them, including the ones
    // that rewrite the ledger. An unresolved operand next to a subcommand that
    // did resolve is just a flag value, so it proves nothing either way.
    const namesGate = operands.some((word) => word.expanded === "sync");
    if (!namesGate && operands.length > 0 && operands[0]?.expanded === undefined) {
      throw new GuardRefusal(
        "dynamic-preference-subcommand",
        "This call runs the preference CLI with a subcommand built at runtime, so what it would do to the kernel cannot be established.",
      );
    }
    return;
  }
  const next = operands[prefsIndex + 1];
  if (next === undefined) {
    // `prefs` with nothing after it prints its own help and writes nothing.
    return;
  }
  if (next.expanded !== undefined && READ_ONLY_PREFERENCE_SUBCOMMANDS.includes(next.expanded)) {
    return;
  }
  context.analysis.preferenceCliMutation = true;
}

/** How this segment was recognized as the preference CLI, if it was. */
type CliRecognition = "none" | "named" | "content";

/**
 * Recognizes the preference CLI by what it runs, not only by what it is called.
 *
 * The name check alone missed the binary that actually ships (`bin/cli.js`),
 * the copy `init` writes into a vault (`70_engine/cli.js`), and every shell
 * function or alias wrapping either of them. The subcommand tree is the part
 * that cannot be renamed: `prefs add` means one thing and one program.
 *
 * The two ways of recognizing it are kept apart because they deserve different
 * strictness. A call that names the CLI is this CLI, so anything but a read-only
 * subcommand refuses. A call recognized only by its shape has to match a known
 * tree, or every `grep prefs somefile` would refuse too.
 */
function recognizePreferenceCli(words: readonly Word[]): CliRecognition {
  const first = words[0];
  if (!first) {
    return "none";
  }
  const name = basename(first.expanded ?? first.value).toLowerCase();
  if (PREFERENCE_CLI_NAMES.includes(name)) {
    return "named";
  }
  if (PACKAGE_RUNNERS.includes(name) || INTERPRETERS.includes(name)) {
    const named = words.slice(1).some((word) => {
      const candidate = basename(word.expanded ?? word.value).toLowerCase();
      return PREFERENCE_CLI_NAMES.includes(candidate)
        || (word.value.toLowerCase().includes("open-brain") && candidate.endsWith(".js"));
    });
    if (named) {
      return "named";
    }
  }
  return looksLikePreferenceTree(words) ? "content" : "none";
}

/** `<anything> prefs add`, `<anything> sync validate`, and nothing looser. */
function looksLikePreferenceTree(words: readonly Word[]): boolean {
  const operands = subcommandOperands(words);
  const head = operands[0];
  const next = operands[1];
  if (head === undefined || next === undefined) {
    return false;
  }
  if (head === "prefs" || head === "preferences") {
    return PREFERENCE_SUBCOMMANDS.includes(next);
  }
  return head === "sync" && SYNC_SUBCOMMANDS.includes(next);
}

/**
 * The operands that can plausibly be subcommands: not flags, not script paths,
 * not package specifiers, not directories. Flag values slip through, which is
 * harmless: they only ever fail to match a known tree.
 */
function subcommandOperands(words: readonly Word[]): string[] {
  const operands: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || isFlag(word.value) || word.value === "--") {
      continue;
    }
    const value = (word.expanded ?? word.value).toLowerCase();
    if (
      value.length === 0
      || value === "."
      || value === ".."
      || value.includes("/")
      || SCRIPT_LIKE.test(value)
    ) {
      continue;
    }
    operands.push(value);
  }
  return operands;
}

/** Skips assignments and wrappers to find what the segment actually runs. */
function resolveCommand(context: Context, words: readonly Word[]): Word[] {
  let remaining = [...words];
  for (let round = 0; round < 8; round += 1) {
    while (remaining.length > 0) {
      const first = remaining[0];
      if (!first || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(first.value)) {
        break;
      }
      const separator = first.value.indexOf("=");
      const name = first.value.slice(0, separator);
      const value = first.expanded === undefined
        ? undefined
        : first.expanded.slice(first.expanded.indexOf("=") + 1);
      if (value !== undefined) {
        context.variables.set(name, value);
      }
      remaining = remaining.slice(1);
    }
    const first = remaining[0];
    if (!first) {
      return remaining;
    }
    if (KEYWORDS.includes(first.value)) {
      remaining = remaining.slice(1);
      continue;
    }
    const name = basename(first.expanded ?? first.value).toLowerCase();
    if (!WRAPPERS.includes(name)) {
      return remaining;
    }
    const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? [];
    let positionals = WRAPPER_POSITIONAL_ARGS[name] ?? 0;
    let index = 1;
    while (index < remaining.length) {
      const word = remaining[index];
      if (!word) {
        break;
      }
      const flag = parseFlag(word.value);
      if (flag) {
        index += flag.attached === undefined && valueFlags.includes(flag.name) ? 2 : 1;
        continue;
      }
      if (positionals > 0) {
        positionals -= 1;
        index += 1;
        continue;
      }
      break;
    }
    remaining = remaining.slice(index);
  }
  return remaining;
}

/**
 * Every word this call would run as a program rather than read as data.
 *
 * The flag can carry its program in the next word, `bash -lc script`, or in
 * itself, `node --eval=script`. Both are collected, and every matching flag is,
 * not only the first: `perl -pi -e script` names one flag that is not eval and
 * one that is, and stopping at the first match read the wrong word.
 */
function inlinePrograms(
  words: readonly Word[],
  letters: string,
  flags: readonly string[],
): string[] {
  const bodies: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    const raw = word.expanded ?? word.value;
    if (!namesFlag(raw, flags) && !carriesLetter(raw, letters)) {
      continue;
    }
    const attached = parseFlag(raw)?.attached;
    if (attached !== undefined) {
      bodies.push(attached);
      continue;
    }
    const body = words[index + 1]?.expanded;
    if (body !== undefined) {
      bodies.push(body);
    }
  }
  return bodies;
}

/** The program of a runtime that spells eval as a subcommand: `deno eval x`. */
function evalSubcommandProgram(words: readonly Word[]): string | undefined {
  const start = words.findIndex((word, index) => index > 0 && (word.expanded ?? word.value) === "eval");
  if (start === -1) {
    return undefined;
  }
  for (let index = start + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || isFlag(word.value)) {
      continue;
    }
    return word.expanded;
  }
  return undefined;
}

/**
 * Whether this command, fed by a pipe, would execute what the pipe carries.
 *
 * A shell or an interpreter with no program of its own runs standard input.
 * With an eval flag or a script operand it runs that instead, and the pipe is
 * just data: `cat notes | python3 report.py` stays readable, `cat program | sh`
 * does not.
 */
function readsProgramFromStdin(name: string, words: readonly Word[]): boolean {
  if (!SHELLS.includes(name) && !INTERPRETERS.includes(name)) {
    return false;
  }
  return !words.slice(1).some(
    (word) => carriesLetter(word.value, INTERPRETER_EVAL_LETTERS)
      || namesFlag(word.value, INTERPRETER_EVAL_FLAGS)
      || !isFlag(word.value),
  );
}

function analyzeSegment(context: Context, segment: Segment, cwd: string): string {
  const rawWords = toWords(segment, context.variables);
  analyzeRedirections(context, segment, cwd);

  for (const token of segment.words) {
    for (const substitution of token.substitutions ?? []) {
      analyzeCommandText(context, substitution, cwd, context.depth + 1);
    }
  }

  // `xargs < file` reads its operand list from that file exactly as
  // `xargs -a file` or a pipe would; the shell lexer has already recorded
  // the redirection here, so it is read off the segment rather than the words.
  const redirectedIn = segment.redirections.some((redirection) => redirection.operator === "<");
  return analyzeCommand(context, rawWords, cwd, segment.heredocs, segment.pipedInto, redirectedIn);
}

/**
 * What one command does, once its redirections have been read.
 *
 * It is separate from the segment so that a command carrying another one,
 * `xargs rm` or `find -exec rm`, can be judged by the same tables instead of
 * being waved through as a wrapper.
 */
function analyzeCommand(
  context: Context,
  rawWords: readonly Word[],
  cwd: string,
  heredocs: readonly string[],
  pipedInto: boolean,
  redirectedIn = false,
): string {
  const words = resolveCommand(context, rawWords);
  const first = words[0];
  if (!first) {
    return cwd;
  }
  const name = basename(first.expanded ?? first.value).toLowerCase();

  // A command name that cannot be resolved cannot be checked against the
  // mutator tables at all, so nothing here can tell a listing from a deletion.
  // This used to refuse only when a protected path was named in the same
  // command, which let `$TOOL prefs add` and every renamed binary through.
  if (first.expanded === undefined) {
    throw new GuardRefusal(
      "dynamic-command",
      "The command name is built at runtime, so what it runs cannot be established.",
    );
  }

  // A command that reads its program from a pipe is a program this guard never
  // sees. `printf "..." | bash` and `echo <base64> | base64 -d | sh` are the
  // same call as the text they carry, and the text is not here to be read.
  if (pipedInto && readsProgramFromStdin(name, words)) {
    throw new GuardRefusal(
      "pipe-into-interpreter",
      "This pipes into an interpreter, which runs a program this guard cannot read.",
    );
  }

  if (name === "eval") {
    const inline = words.slice(1)
      .map((word) => word.expanded)
      .filter((value): value is string => value !== undefined)
      .join(" ");
    if (inline.length > 0) {
      analyzeCommandText(context, inline, cwd, context.depth + 1);
    }
    return cwd;
  }

  if (name === "cd" || name === "pushd") {
    const destination = words[1]?.expanded;
    if (destination === undefined || destination === "-") {
      return cwd;
    }
    return isAbsolute(destination) ? resolve(destination) : resolve(cwd, destination);
  }

  if (recognizePreferenceCli(words) !== "none") {
    analyzePreferenceCli(context, words);
  }

  if (SHELLS.includes(name)) {
    for (const inline of inlinePrograms(words, SHELL_COMMAND_LETTERS, SHELL_COMMAND_FLAGS)) {
      analyzeCommandText(context, inline, cwd, context.depth + 1);
    }
    for (const body of heredocs) {
      analyzeCommandText(context, body, cwd, context.depth + 1);
    }
    return cwd;
  }

  if (INTERPRETERS.includes(name)) {
    for (const inline of inlinePrograms(words, INTERPRETER_EVAL_LETTERS, INTERPRETER_EVAL_FLAGS)) {
      analyzeCode(context, inline, cwd);
    }
    if (EVAL_SUBCOMMAND_RUNTIMES.includes(name)) {
      const inline = evalSubcommandProgram(words);
      if (inline !== undefined) {
        analyzeCode(context, inline, cwd);
      }
    }
    analyzeInPlaceInterpreter(context, name, words, cwd);
    for (const body of heredocs) {
      analyzeCode(context, body, cwd);
    }
    return cwd;
  }

  if (name === "apply_patch") {
    const inline = words[1]?.expanded;
    for (const body of [...heredocs, ...(inline === undefined ? [] : [inline])]) {
      for (const target of patchTargets(body)) {
        addTarget(context, cwd, { value: target, expanded: target, quoted: true, substitutions: [] }, true);
      }
    }
    return cwd;
  }

  if (name === "git") {
    analyzeGit(context, words, cwd);
    return cwd;
  }

  if (name === "dd") {
    analyzeDd(context, words, cwd);
    return cwd;
  }

  if (name === "sed" || name === "gsed") {
    analyzeSed(context, words, cwd);
    return cwd;
  }

  if (AWKS.includes(name)) {
    analyzeAwk(context, words, cwd);
    return cwd;
  }

  if (name === "find") {
    analyzeFind(context, words, cwd);
    return cwd;
  }

  if (name === "tar") {
    analyzeTar(context, words, cwd);
    return cwd;
  }

  if (name === "unzip") {
    analyzeUnzip(context, words, cwd);
    return cwd;
  }

  if (name === "xargs") {
    analyzeXargs(context, words, cwd, pipedInto || redirectedIn);
    return cwd;
  }

  if (MUTATORS[name]) {
    analyzeMutator(context, name, words, cwd);
  }

  return cwd;
}

function analyzeCommandText(
  context: Context,
  command: string,
  cwd: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new GuardRefusal(
      "nesting-depth-exceeded",
      `The command nests shells more than ${String(MAX_DEPTH)} levels deep, which cannot be analyzed with confidence.`,
    );
  }
  if (command.includes(NULL_BYTE)) {
    throw new GuardRefusal("null-byte", "The command contains a null byte.");
  }
  if (mentionsProtectedName(command)) {
    context.analysis.mentionsProtectedName = true;
  }
  const previousDepth = context.depth;
  context.depth = depth;
  let cursor = cwd;
  for (const segment of splitSegments(lex(command))) {
    cursor = analyzeSegment(context, segment, cursor);
  }
  context.depth = previousDepth;
}

function analyzeArgv(context: Context, argv: readonly string[], cwd: string): void {
  const tokens: Token[] = argv.map((value) => ({ kind: "word", value, quoted: true, substitutions: [] }));
  if (argv.some((value) => mentionsProtectedName(value))) {
    context.analysis.mentionsProtectedName = true;
  }
  let cursor = cwd;
  for (const segment of splitSegments(tokens)) {
    cursor = analyzeSegment(context, segment, cursor);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function commandOf(toolInput: Record<string, unknown>): string | string[] {
  const value = toolInput.command ?? toolInput.cmd ?? toolInput.script;
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  throw new GuardRefusal(
    "malformed-payload",
    "A shell tool call without a readable command cannot be judged.",
  );
}

function filePathOf(toolInput: Record<string, unknown>): string {
  const value = toolInput.file_path ?? toolInput.path ?? toolInput.filePath ?? toolInput.notebook_path;
  if (typeof value !== "string" || value.length === 0) {
    throw new GuardRefusal(
      "malformed-payload",
      "A file tool call without a readable path cannot be judged.",
    );
  }
  return value;
}

function effectiveCwd(input: GuardInput): string {
  const declared = input.toolInput.cwd;
  return typeof declared === "string" && declared.length > 0
    ? resolve(declared)
    : resolve(input.vaultRoot);
}

function verdictFor(context: Context): GuardVerdict {
  if (context.analysis.preferenceCliMutation) {
    return deny(
      "preference-cli-mutation",
      "It calls a preference subcommand that mutates the ledger.",
    );
  }
  if (context.analysis.unattendedKernelWrite) {
    return deny(
      "unattended-kernel-write",
      "It runs the kernel gate with --unattended, which writes without proving a human approved it. A tool call is never that human. Run the command yourself in a terminal.",
    );
  }
  for (const target of context.analysis.targets) {
    const classified = classifyTarget(target, context.guarded);
    if (classified === "protected") {
      return deny("protected-write-target", `It writes to ${target.raw}.`);
    }
    if (classified === "ancestor" && target.destructive) {
      return deny(
        "protected-parent-write",
        `It runs a recursive or destructive operation on ${target.raw}, which contains the preference kernel.`,
      );
    }
    if (classified === "unresolved" && context.analysis.mentionsProtectedName) {
      return deny(
        "unresolved-write-target",
        `The write target ${target.raw} cannot be resolved and the command names a protected file.`,
      );
    }
  }
  return allow();
}

function evaluate(input: GuardInput): GuardVerdict {
  if (typeof input.tool !== "string" || input.tool.length === 0) {
    return deny("malformed-payload", "The tool name is missing.");
  }
  const tool = normalizeToolName(input.tool);
  if (!MUTATING_TOOLS.includes(tool)) {
    return allow();
  }
  if (typeof input.vaultRoot !== "string" || input.vaultRoot.length === 0) {
    return deny("vault-root-unresolved", "The vault root could not be resolved.");
  }
  if (!isRecord(input.toolInput)) {
    return deny("malformed-payload", "The tool input is not an object.");
  }
  if (!isRecord(input.config) || !isRecord(input.config.paths)) {
    return deny("malformed-payload", "The vault configuration could not be read.");
  }

  const context: Context = {
    guarded: protectedPathsFor(input),
    variables: new Map<string, string>(),
    analysis: {
      targets: [],
      preferenceCliMutation: false,
      unattendedKernelWrite: false,
      mentionsProtectedName: false,
    },
    depth: 0,
  };
  const cwd = effectiveCwd(input);

  if (FILE_TOOLS.includes(tool)) {
    const path = filePathOf(input.toolInput);
    context.analysis.targets.push({ raw: path, cwd, destructive: false });
    return verdictFor(context);
  }

  if (PATCH_TOOLS.includes(tool)) {
    const patch = input.toolInput.patch ?? input.toolInput.input ?? input.toolInput.content;
    if (typeof patch === "string") {
      const targets = patchTargets(patch);
      if (targets.length === 0) {
        return deny(
          "malformed-payload",
          "The patch declares no file, so what it would change cannot be established.",
        );
      }
      for (const target of targets) {
        context.analysis.targets.push({ raw: target, cwd, destructive: true });
      }
      return verdictFor(context);
    }
    const command = commandOf(input.toolInput);
    if (typeof command === "string") {
      analyzeCommandText(context, command, cwd, 1);
    } else {
      analyzeArgv(context, command, cwd);
    }
    return verdictFor(context);
  }

  const command = commandOf(input.toolInput);
  if (typeof command === "string") {
    analyzeCommandText(context, command, cwd, 1);
  } else {
    analyzeArgv(context, command, cwd);
  }
  return verdictFor(context);
}

/**
 * Decides one tool call. Pure and synchronous: it reads only what it is given,
 * so a caller that needs a path resolved on disk must resolve it before calling.
 */
export function evaluateGuard(input: GuardInput): GuardVerdict {
  try {
    return evaluate(input);
  } catch (error) {
    if (error instanceof GuardRefusal) {
      return deny(error.rule, error.message);
    }
    return deny(
      "unexpected-failure",
      "The guard could not analyze this call, so it refuses rather than guess.",
    );
  }
}

/** The paths this guard protects, exposed so `guard` can explain itself. */
export function protectedRelativePaths(config: VaultConfig): string[] {
  const memory = config.paths.memory.length > 0 ? config.paths.memory : "10_memory";
  const configured = PROTECTED_FILENAMES.map((name) =>
    [memory, PREFERENCES_DIRECTORY, name].join("/"));
  const hardcodedFiles = HARDCODED_PROTECTED_FILES.map((path) => path.replace(/\\/gu, "/"));
  const hardcodedDirectories = HARDCODED_PROTECTED_DIRECTORIES.map(
    (directory) => directory.replace(/\\/gu, "/"),
  );
  // The configured kernel files and the hardcoded redline targets name the
  // same two paths whenever memory is still "10_memory": deduped so a caller
  // walking this list does not check the same path twice.
  return [...new Set([...configured, ...hardcodedFiles, ...hardcodedDirectories])];
}
