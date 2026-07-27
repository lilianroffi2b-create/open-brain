import { isAbsolute, join, resolve } from "node:path";

import type { VaultConfig } from "../core/types.js";

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
 * filesystem. The cost of that choice is that a symlink already pointing at a
 * protected file cannot be resolved here; that class is closed instead by
 * treating the whole preferences directory as protected and by counting both
 * operands of `ln` as write targets, so the alias can never be created either.
 *
 * When evidence is missing it refuses. An unparsable command, a payload that is
 * not an object, a nesting depth beyond four, a null byte, an unknown failure:
 * all of them deny.
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

const MUTATING_TOOLS: readonly string[] = [
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "bash",
  "exec",
  "exec_command",
  "shell",
];

const FILE_TOOLS: readonly string[] = ["write", "edit", "multiedit"];
const PATCH_TOOLS: readonly string[] = ["apply_patch"];

const WRAPPERS: readonly string[] = [
  "builtin",
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
  "xargs",
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

const SHELLS: readonly string[] = ["sh", "bash", "zsh", "dash", "ksh", "ash"];

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

const PREFERENCE_CLI_NAMES: readonly string[] = [
  "open-brain",
  "open-brain.js",
  "openbrain",
  "openbrain.js",
];

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

const WRITE_MARKERS =
  /\.write_text\s*\(|\.write_bytes\s*\(|\.unlink\s*\(|\.rename\s*\(|\.replace\s*\(|\.touch\s*\(|\.mkdir\s*\(|os\.replace\s*\(|os\.remove\s*\(|os\.rmdir\s*\(|os\.truncate\s*\(|shutil\.(?:move|copy|copy2|copyfile|copytree|rmtree)\s*\(|open\s*\(|fopen\s*\(|writeFileSync|appendFileSync|writeFile\s*\(|appendFile\s*\(|createWriteStream|unlinkSync|renameSync|copyFileSync|rmSync|truncateSync|Deno\.writeTextFile|Deno\.writeFile|Deno\.remove|File\.write|IO\.write|FileUtils\./u;

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
}

function emptySegment(): Segment {
  return { words: [], redirections: [], heredocs: [] };
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
  directory: string;
  files: string[];
}

function protectedPathsFor(input: GuardInput): ProtectedPaths {
  const memory = typeof input.config.paths.memory === "string" && input.config.paths.memory.length > 0
    ? input.config.paths.memory
    : "10_memory";
  const directory = resolve(join(input.vaultRoot, memory, PREFERENCES_DIRECTORY));
  return {
    directory: comparable(directory),
    files: PROTECTED_FILENAMES.map((name) => comparable(join(directory, name))),
  };
}

/** Case-insensitive, separator-normalized, trailing-slash-free form. */
function comparable(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
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

function classifyTarget(target: WriteTarget, guarded: ProtectedPaths): TargetVerdict {
  const raw = target.raw;
  if (raw.length === 0) {
    return "outside";
  }
  if (raw.startsWith("~")) {
    return PROTECTED_FILENAMES.includes(basename(raw)) || raw.includes(`/${PREFERENCES_DIRECTORY}/`)
      ? "protected"
      : "unresolved";
  }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(target.cwd, raw);
  const normalized = comparable(absolute);
  if (guarded.files.includes(normalized)) {
    return "protected";
  }
  if (normalized === guarded.directory || normalized.startsWith(`${guarded.directory}/`)) {
    return "protected";
  }
  if (guarded.directory.startsWith(`${normalized}/`)) {
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
  valueFlags?: readonly string[];
  recursiveFlags?: readonly string[];
  skipFirstOperand?: boolean;
}

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
  install: { operands: "destination", valueFlags: ["-m", "-o", "-g", "-t", "--mode", "--owner", "--group"] },
  ln: { operands: "all", valueFlags: ["-S", "--suffix", "-t", "--target-directory"] },
  mv: { operands: "all", valueFlags: ["-t", "--target-directory", "-S", "--suffix"] },
  patch: { operands: "all", valueFlags: ["-i", "--input", "-d", "--directory", "-p", "-o", "--output"] },
  rm: { operands: "all", recursiveFlags: ["r", "R"] },
  rmdir: { operands: "all" },
  rsync: {
    operands: "destination",
    valueFlags: ["-e", "--rsh", "--exclude", "--include", "--files-from", "--filter"],
    recursiveFlags: ["r", "a"],
  },
  shred: { operands: "all", valueFlags: ["-n", "-s"] },
  tee: { operands: "all" },
  touch: { operands: "all", valueFlags: ["-d", "-t", "-r", "--date", "--reference"] },
  truncate: { operands: "all", valueFlags: ["-s", "--size", "-r", "--reference"] },
  unlink: { operands: "all" },
  xattr: { operands: "all", skipFirstOperand: true, valueFlags: ["-w", "-d"] },
};

/** git subcommands that touch the working tree, and how they name their targets. */
const GIT_PATH_SUBCOMMANDS: readonly string[] = ["restore", "checkout", "switch", "rm", "mv"];
const GIT_TREE_SUBCOMMANDS: readonly string[] = ["clean", "apply", "am", "stash", "revert", "merge", "rebase", "pull"];

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Analysis {
  targets: WriteTarget[];
  preferenceCliMutation: boolean;
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

function shortFlagLetters(value: string): string {
  return value.startsWith("--") || !value.startsWith("-") ? "" : value.slice(1);
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

function collectOperands(words: readonly Word[], rule: MutatorRule): Word[] {
  const operands: Word[] = [];
  const valueFlags = rule.valueFlags ?? [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    if (isFlag(word.value) && !word.quoted) {
      if (valueFlags.includes(word.value) && !word.value.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (word.value === "--") {
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
    if (!isFlag(word.value) || word.quoted) {
      return false;
    }
    if (word.value === "--recursive" || word.value === "--archive") {
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

function analyzeMutator(context: Context, name: string, words: readonly Word[], cwd: string): void {
  const rule = MUTATORS[name];
  if (!rule) {
    return;
  }
  const operands = collectOperands(words, rule);
  const recursive = isRecursive(words, rule);
  const targetDirectoryFlag = words.findIndex(
    (word) => word.value === "-t" || word.value === "--target-directory",
  );
  if (rule.operands === "destination" && targetDirectoryFlag !== -1) {
    const target = words[targetDirectoryFlag + 1];
    if (target) {
      addTarget(context, cwd, target, true);
    }
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
    (word) => !word.quoted
      && (word.value === "-i" || word.value.startsWith("-i") || word.value.startsWith("--in-place")),
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

function analyzeTar(context: Context, words: readonly Word[], cwd: string): void {
  const extracting = words.some(
    (word) => word.value === "-x" || word.value === "--extract" || /^-[^-]*x/u.test(word.value),
  );
  if (!extracting) {
    return;
  }
  const directoryFlag = words.findIndex((word) => word.value === "-C" || word.value === "--directory");
  const destination = directoryFlag === -1 ? undefined : words[directoryFlag + 1];
  if (destination) {
    addTarget(context, cwd, destination, true);
    return;
  }
  addTarget(context, cwd, { value: cwd, expanded: cwd, quoted: false, substitutions: [] }, true);
}

function gitEffectiveCwd(words: readonly Word[], cwd: string): string {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    if ((word.value === "-C" || word.value === "--work-tree") && words[index + 1]?.expanded) {
      const directory = words[index + 1]?.expanded ?? "";
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
    if (isFlag(word.value)) {
      if (valueFlags.includes(word.value)) {
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

function analyzeCode(context: Context, code: string, cwd: string): void {
  if (!WRITE_MARKERS.test(code)) {
    return;
  }
  const literals = [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"/gu)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((value) => value.length > 0);
  for (const literal of literals) {
    addTarget(context, cwd, { value: literal, expanded: literal, quoted: true, substitutions: [] }, false);
  }
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
  const operands = words.slice(1).filter((word) => !isFlag(word.value));
  const prefsIndex = operands.findIndex((word) => word.value === "prefs" || word.value === "preferences");
  if (prefsIndex === -1) {
    return;
  }
  const subcommand = operands[prefsIndex + 1]?.value ?? "";
  if (READ_ONLY_PREFERENCE_SUBCOMMANDS.includes(subcommand)) {
    return;
  }
  context.analysis.preferenceCliMutation = true;
}

function isPreferenceCli(words: readonly Word[]): boolean {
  const first = words[0];
  if (!first) {
    return false;
  }
  const name = basename(first.expanded ?? first.value).toLowerCase();
  if (PREFERENCE_CLI_NAMES.includes(name)) {
    return true;
  }
  if (PACKAGE_RUNNERS.includes(name) || INTERPRETERS.includes(name)) {
    return words.slice(1).some((word) => {
      const candidate = basename(word.expanded ?? word.value).toLowerCase();
      return PREFERENCE_CLI_NAMES.includes(candidate)
        || (word.value.toLowerCase().includes("open-brain") && candidate.endsWith(".js"));
    });
  }
  return false;
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
      if (isFlag(word.value)) {
        index += valueFlags.includes(word.value) ? 2 : 1;
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

function analyzeSegment(context: Context, segment: Segment, cwd: string): string {
  const rawWords = toWords(segment, context.variables);
  analyzeRedirections(context, segment, cwd);

  for (const token of segment.words) {
    for (const substitution of token.substitutions ?? []) {
      analyzeCommandText(context, substitution, cwd, context.depth + 1);
    }
  }

  const words = resolveCommand(context, rawWords);
  const first = words[0];
  if (!first) {
    return cwd;
  }
  const name = basename(first.expanded ?? first.value).toLowerCase();

  // A command name that cannot be resolved cannot be checked against the
  // mutator tables. On its own that proves nothing, but next to a protected
  // path in the same command it is exactly the shape of a disguised writer.
  if (first.expanded === undefined && context.analysis.mentionsProtectedName) {
    throw new GuardRefusal(
      "dynamic-command",
      "The command name is built at runtime and the command names a protected file.",
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

  if (isPreferenceCli(words)) {
    analyzePreferenceCli(context, words);
  }

  if (SHELLS.includes(name)) {
    const commandFlag = words.findIndex((word) => word.value === "-c");
    const inline = commandFlag === -1 ? undefined : words[commandFlag + 1]?.expanded;
    if (inline !== undefined) {
      analyzeCommandText(context, inline, cwd, context.depth + 1);
    }
    for (const body of segment.heredocs) {
      analyzeCommandText(context, body, cwd, context.depth + 1);
    }
    return cwd;
  }

  if (INTERPRETERS.includes(name)) {
    const commandFlag = words.findIndex((word) => word.value === "-c" || word.value === "-e");
    const inline = commandFlag === -1 ? undefined : words[commandFlag + 1]?.expanded;
    if (inline !== undefined) {
      analyzeCode(context, inline, cwd);
    }
    for (const body of segment.heredocs) {
      analyzeCode(context, body, cwd);
    }
    return cwd;
  }

  if (name === "apply_patch") {
    const inline = words[1]?.expanded;
    for (const body of [...segment.heredocs, ...(inline === undefined ? [] : [inline])]) {
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

  if (name === "sed") {
    analyzeSed(context, words, cwd);
    return cwd;
  }

  if (name === "tar") {
    analyzeTar(context, words, cwd);
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
    analysis: { targets: [], preferenceCliMutation: false, mentionsProtectedName: false },
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
  return PROTECTED_FILENAMES.map((name) =>
    [memory, PREFERENCES_DIRECTORY, name].join("/"));
}
