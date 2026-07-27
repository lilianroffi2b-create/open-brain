/**
 * Redaction, applied to every byte that leaves a transcript before it can be
 * written into the vault.
 *
 * The reference system stores the user's raw text verbatim. Open Brain does
 * not reproduce that: a transcript is the densest concentration of secrets a
 * developer machine produces, and a vault is very often a git repository, which
 * makes anything written there permanent.
 *
 * What this covers is a short, explicit list of shapes that are mechanically
 * recognisable. What it does not cover is everything that only a human can
 * recognise. Both lists are exported and printed by the CLI, because a
 * redaction promise that is not spelled out is read as "safe", and this one is
 * "safer, and here is exactly how much".
 *
 * It is a filter, not a guarantee. Nothing here inspects meaning.
 */

export type RedactionKind =
  | "private-key"
  | "jwt"
  | "api-key"
  | "assigned-secret"
  | "email"
  | "home-path";

export const REDACTION_KINDS: readonly RedactionKind[] = [
  "private-key",
  "jwt",
  "api-key",
  "assigned-secret",
  "email",
  "home-path",
];

/** Exactly what the filter recognises. Printed verbatim by the CLI. */
export const REDACTION_COVERED: readonly string[] = [
  "PEM private key blocks, from the BEGIN line to the END line.",
  "JSON web tokens, recognised by their three dot-separated segments after eyJ.",
  "Vendor API keys with a fixed prefix: sk- and pk- keys, GitHub gh*_ tokens, AWS AKIA identifiers, Slack xox*- tokens, Google AIza keys, npm_ tokens, and Bearer values in an authorization header.",
  "Assignments whose left side names a secret: key, api_key, access_key, secret, client_secret, token, auth_token, password, passwd, pwd, authorization.",
  "Email addresses.",
  "The user name segment of a home directory path, on Unix and on Windows. The rest of the path is kept, because a path without its owner is still useful and no longer identifies anyone.",
];

/** Exactly what the filter does NOT recognise. Printed verbatim by the CLI. */
export const REDACTION_NOT_COVERED: readonly string[] = [
  "Secrets with no recognisable shape: a password typed as a sentence, an internal hostname, a database connection string with an unusual scheme.",
  "Names of people, companies, clients, and projects. A transcript is full of them and no pattern can tell them from any other word.",
  "Source code, file contents, and command output quoted inside a message.",
  "Internal URLs, IP addresses, phone numbers, postal addresses, and account numbers.",
  "Anything that is only sensitive in context, which is most of what makes a transcript private.",
];

/** One-line summary for a hook or a listing that has no room for the lists. */
export const REDACTION_NOTICE =
  "Redaction removes recognisable secrets (keys, tokens, credentials, email addresses, home directory user names). It does not remove names, client information, quoted code, or anything that is only sensitive in context. Run `open-brain transcripts show` to read what was kept before you trust it.";

export type RedactionCounts = Partial<Record<RedactionKind, number>>;

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
  redacted: boolean;
}

interface RedactionRule {
  kind: RedactionKind;
  apply: (text: string, hit: () => void) => string;
}

function placeholder(kind: RedactionKind): string {
  return `[redacted:${kind}]`;
}

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu;
const BEARER = /\b([Bb]earer\s+)[A-Za-z0-9._~+/=-]{12,}/gu;
const VENDOR_KEY = /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36})\b/gu;
// The trailing lookahead leaves an authorization scheme alone when the value
// behind it has already been replaced by an earlier rule, so a redacted bearer
// token stays readable as "Bearer [redacted:api-key]".
const ASSIGNED_SECRET = /\b((?:api[_-]?|access[_-]?|secret[_-]?|client[_-]?|auth[_-]?)?(?:key|secret|token|password|passwd|pwd|authorization))(["']?\s*[:=]\s*)(["']?)[^\s"',;)]{6,}\3(?!\s*\[redacted:)/giu;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu;
const UNIX_HOME = /(\/(?:Users|home)\/)([A-Za-z0-9._-]+)/gu;
const WINDOWS_HOME = /([A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/gu;

/**
 * Order matters. Structured secrets go first so that a key inside an
 * assignment is replaced as a key, and the broad shapes go last so they can
 * only ever match what the earlier rules left behind.
 */
const RULES: readonly RedactionRule[] = [
  {
    kind: "private-key",
    apply: (text, hit) => text.replace(PRIVATE_KEY, () => {
      hit();
      return placeholder("private-key");
    }),
  },
  {
    kind: "jwt",
    apply: (text, hit) => text.replace(JWT, () => {
      hit();
      return placeholder("jwt");
    }),
  },
  {
    kind: "api-key",
    apply: (text, hit) => text
      .replace(VENDOR_KEY, () => {
        hit();
        return placeholder("api-key");
      })
      .replace(BEARER, (_match: string, prefix: string) => {
        hit();
        return `${prefix}${placeholder("api-key")}`;
      }),
  },
  {
    kind: "assigned-secret",
    apply: (text, hit) => text.replace(
      ASSIGNED_SECRET,
      (_match: string, name: string, separator: string, quote: string) => {
        hit();
        return `${name}${separator}${quote}${placeholder("assigned-secret")}${quote}`;
      },
    ),
  },
  {
    kind: "email",
    apply: (text, hit) => text.replace(EMAIL, () => {
      hit();
      return placeholder("email");
    }),
  },
  {
    kind: "home-path",
    apply: (text, hit) => text
      .replace(UNIX_HOME, (_match: string, prefix: string) => {
        hit();
        return `${prefix}${placeholder("home-path")}`;
      })
      .replace(WINDOWS_HOME, (_match: string, prefix: string) => {
        hit();
        return `${prefix}${placeholder("home-path")}`;
      }),
  },
];

/**
 * Runs every rule over a block of text and reports what it replaced. The count
 * is per kind rather than a single total, so a caller can say "three keys and
 * one address" instead of the useless "four things".
 */
export function redactText(text: string): RedactionResult {
  const counts: RedactionCounts = {};
  let current = text;
  for (const rule of RULES) {
    current = rule.apply(current, () => {
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
    });
  }
  return {
    text: current,
    counts,
    redacted: Object.keys(counts).length > 0,
  };
}

export function mergeRedactionCounts(
  into: RedactionCounts,
  from: RedactionCounts,
): RedactionCounts {
  const merged: RedactionCounts = { ...into };
  for (const kind of REDACTION_KINDS) {
    const value = from[kind];
    if (value !== undefined) {
      merged[kind] = (merged[kind] ?? 0) + value;
    }
  }
  return merged;
}

export function totalRedactions(counts: RedactionCounts): number {
  return REDACTION_KINDS.reduce((total, kind) => total + (counts[kind] ?? 0), 0);
}
