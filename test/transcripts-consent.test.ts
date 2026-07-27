import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "citty";

import { captureCommand } from "../src/cli/commands/capture.js";
import { transcriptsCommand } from "../src/cli/commands/transcripts.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  preCompactCapture,
  promptSubmitCapture,
  scanTranscriptForCandidates,
  turnEndCapture,
} from "../src/staging/capture.js";
import { mineTranscripts } from "../src/staging/mine.js";
import { compactStaging, listCandidates, transitionCandidate } from "../src/staging/store.js";
import type { ProposalInput } from "../src/staging/types.js";
import {
  assertReadable,
  isWithin,
  listTranscriptFiles,
  TranscriptConsentError,
} from "../src/transcripts/consent.js";
import { readConsentedTranscript } from "../src/transcripts/reader.js";
import type { HookContext } from "../src/hooks/runtime.js";

/**
 * The consent contract. This file exists before the reader does any work,
 * because the first property of the transcripts capability is not what it can
 * read: it is what it refuses to touch.
 */

/** A string that must never appear anywhere in a vault after a disarmed run. */
const SECRET = "MARKER-9f2c-do-not-copy-into-the-vault";

function configWith(overrides: {
  transcripts?: boolean;
  roots?: string[];
  capture?: boolean;
  redact?: boolean;
}): VaultConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: {
      ...DEFAULT_CONFIG.capabilities,
      capture: { enabled: overrides.capture === true },
      transcripts: {
        enabled: overrides.transcripts === true,
        roots: overrides.roots ?? [],
        redact: overrides.redact !== false,
      },
    },
  };
}

async function newVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbrain-consent-"));
  await mkdir(join(root, "00_index"), { recursive: true });
  await mkdir(join(root, "10_memory"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), "version: 1\n", "utf8");
  return root;
}

function claudeLine(text: string, index: number): string {
  return JSON.stringify({
    type: "user",
    uuid: `uuid-${String(index)}`,
    sessionId: "session-consent",
    timestamp: "2026-07-26T10:00:00Z",
    promptSource: "typed",
    message: { role: "user", content: text },
  });
}

async function newTranscriptDirectory(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), "openbrain-sessions-"));
  const file = join(directory, "session.jsonl");
  await writeFile(
    file,
    [
      claudeLine(`Remember this: ${SECRET} is the passphrase.`, 1),
      claudeLine("From now on, keep answers short.", 2),
    ].join("\n") + "\n",
    "utf8",
  );
  return { directory, file };
}

async function vaultContents(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        parts.push(path);
        parts.push(await readFile(path, "utf8"));
      }
    }
  };
  await walk(root);
  return parts.join("\n");
}

function hookContext(
  root: string,
  config: VaultConfig,
  payload: Record<string, unknown>,
): HookContext {
  return {
    event: "stop",
    payload,
    vaultRoot: root,
    config,
    deadline: Date.now() + 5_000,
  };
}

test("a disarmed vault never touches a path outside itself", async () => {
  const root = await newVault();
  const sessions = await newTranscriptDirectory();
  const disarmed = configWith({ transcripts: false });

  try {
    // The path does not exist, and neither does its parent directory. A reader
    // that opened the file before checking consent would fail with ENOENT; a
    // reader that checks consent first cannot know the file is missing.
    await assert.rejects(
      () => readConsentedTranscript(
        root,
        disarmed,
        join(sessions.directory, "does-not-exist", "session.jsonl"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptConsentError, "consent decides before the disk does");
        assert.match(error.message, /does-not-exist/u, "the refusal names the path");
        assert.match(
          error.message,
          /capabilities enable transcripts --root/u,
          "the refusal names the command that would allow it",
        );
        return true;
      },
    );

    // A file that does exist is refused in exactly the same way.
    await assert.rejects(
      () => readConsentedTranscript(root, disarmed, sessions.file),
      TranscriptConsentError,
    );
    await assert.rejects(
      () => listTranscriptFiles(root, disarmed),
      /Capability transcripts is disabled/u,
    );
    await assert.rejects(
      () => mineTranscripts(root, disarmed),
      /Capability transcripts is disabled/u,
    );

    // Every capture organ, run against the same payload, on the same vault.
    const payload = {
      transcript_path: sessions.file,
      session_id: "session-consent",
      prompt: `Remember this: ${SECRET}`,
    };
    assert.equal(await turnEndCapture(hookContext(root, disarmed, payload)), undefined);
    assert.equal(await preCompactCapture(hookContext(root, disarmed, payload)), undefined);
    assert.equal(await promptSubmitCapture(hookContext(root, disarmed, payload)), undefined);
    await assert.rejects(
      () => scanTranscriptForCandidates(root, disarmed, sessions.file),
      /Capability capture is disabled/u,
    );

    const contents = await vaultContents(root);
    assert.equal(
      contents.includes(SECRET),
      false,
      "nothing read from outside the vault reached the vault",
    );
    assert.deepEqual(await listCandidates(root, disarmed), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sessions.directory, { recursive: true, force: true });
  }
});

test("consent is per directory: a stranger path is refused even when armed", async () => {
  const root = await newVault();
  const consented = await newTranscriptDirectory();
  const stranger = await newTranscriptDirectory();
  const armed = configWith({ transcripts: true, roots: [consented.directory] });

  try {
    const allowed = await assertReadable(root, armed, consented.file);
    assert.equal(allowed.scope, "consented-root");

    await assert.rejects(
      () => assertReadable(root, armed, stranger.file),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptConsentError);
        assert.match(error.message, /outside every consented directory/u);
        assert.ok(error.message.includes(stranger.file), "the refusal names the refused path");
        return true;
      },
    );

    // Climbing out with .. is normalized before anything is opened.
    await assert.rejects(
      () => assertReadable(root, armed, join(consented.directory, "..", "escaped.jsonl")),
      TranscriptConsentError,
    );

    // An empty root list is armed but consents to nothing.
    await assert.rejects(
      () => assertReadable(root, configWith({ transcripts: true }), consented.file),
      /no directory has been consented to/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(consented.directory, { recursive: true, force: true });
    await rm(stranger.directory, { recursive: true, force: true });
  }
});

test("a link out of a consented directory is not consent", async () => {
  const root = await newVault();
  const consented = await newTranscriptDirectory();
  const outside = await newTranscriptDirectory();
  const armed = configWith({ transcripts: true, roots: [consented.directory] });
  const link = join(consented.directory, "linked.jsonl");
  const linkedDirectory = join(consented.directory, "elsewhere");

  try {
    await symlink(outside.file, link);
    await symlink(outside.directory, linkedDirectory);

    await assert.rejects(
      () => assertReadable(root, armed, link),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptConsentError);
        assert.match(error.message, /A link is not consent/u);
        return true;
      },
    );
    await assert.rejects(
      () => assertReadable(root, armed, join(linkedDirectory, "session.jsonl")),
      TranscriptConsentError,
    );

    // The listing never walks through the link either.
    const listing = await listTranscriptFiles(root, armed);
    assert.equal(listing.files.length, 1, "only the real file inside the consented directory");
    assert.equal(listing.files[0]?.path.endsWith("session.jsonl"), true);
    assert.equal(
      listing.files.some((file) => file.path.includes("elsewhere")),
      false,
      "the linked directory was never entered",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(consented.directory, { recursive: true, force: true });
    await rm(outside.directory, { recursive: true, force: true });
  }
});

test("the vault itself stays readable with the capability disarmed", async () => {
  const root = await newVault();
  const inside = join(root, "40_sources", "session.jsonl");
  const disarmed = configWith({ transcripts: false });

  try {
    await mkdir(join(root, "40_sources"), { recursive: true });
    await writeFile(inside, claudeLine("From now on, prefer short answers.", 1) + "\n", "utf8");

    const target = await assertReadable(root, disarmed, inside);
    assert.equal(target.scope, "vault");

    const read = await readConsentedTranscript(root, disarmed, inside);
    assert.equal(read.messages.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a link out of the vault is judged like any other outside path", async () => {
  const root = await newVault();
  const outside = await newTranscriptDirectory();
  const link = join(root, "40_sources", "linked.jsonl");

  try {
    await mkdir(join(root, "40_sources"), { recursive: true });
    await symlink(outside.file, link);
    await assert.rejects(
      () => assertReadable(root, configWith({ transcripts: false }), link),
      TranscriptConsentError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside.directory, { recursive: true, force: true });
  }
});

test("containment is by path segment", () => {
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/b/c.jsonl"), true);
  assert.equal(isWithin("/a/b", "/a/bc/c.jsonl"), false);
  assert.equal(isWithin("/a/b", "/a"), false);
});

interface CapturedRun {
  output: unknown;
  raw: string;
}

async function capture(action: () => Promise<unknown>): Promise<CapturedRun> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  const first = captured.indexOf("{");
  const json = first === -1 ? "" : captured.slice(first, captured.lastIndexOf("}") + 1);
  return { output: json.length === 0 ? undefined : (JSON.parse(json) as unknown), raw: captured };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "the command prints a JSON object");
  return value as Record<string, unknown>;
}

async function writeVaultConfig(root: string, yaml: string): Promise<void> {
  await writeFile(join(root, "00_index", "vault.config.yml"), yaml, "utf8");
}

test("transcripts scan says nothing was read when the capability is disarmed", async () => {
  const root = await newVault();
  try {
    const run = await capture(() => runCommand(transcriptsCommand, {
      rawArgs: ["scan", "--root", root],
    }));
    const output = asRecord(run.output);
    assert.deepEqual(output.files, []);
    assert.match(String(output.next), /disarmed/u);
    assert.match(String(output.next), /capabilities enable transcripts --root/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcripts purge deletes what came from transcripts and names it", async () => {
  const root = await newVault();
  const sessions = await newTranscriptDirectory();
  try {
    await writeVaultConfig(root, [
      "version: 1",
      "capabilities:",
      "  capture:",
      "    enabled: true",
      "  transcripts:",
      "    enabled: true",
      "    redact: true",
      "    roots:",
      `      - ${JSON.stringify(sessions.directory)}`,
      "",
    ].join("\n"));

    const scan = await capture(() => runCommand(captureCommand, {
      rawArgs: ["scan", "--root", root, "--transcript", sessions.file],
    }));
    const scanned = asRecord(scan.output);
    assert.equal(scanned.filed, 2, "both explicit requests were staged");

    const manual = configWith({ capture: true, transcripts: true, roots: [sessions.directory] });
    const before = await listCandidates(root, manual);
    assert.equal(before.length, 2);

    const dry = await capture(() => runCommand(transcriptsCommand, {
      rawArgs: ["purge", "--root", root, "--dry-run"],
    }));
    const dryOutput = asRecord(dry.output);
    assert.equal(dryOutput.dry_run, true);
    assert.equal((dryOutput.deleted as string[]).length, 2);
    assert.equal((await listCandidates(root, manual)).length, 2, "a dry run deletes nothing");

    const purge = await capture(() => runCommand(transcriptsCommand, {
      rawArgs: ["purge", "--root", root, "--yes"],
    }));
    const purged = asRecord(purge.output);
    assert.equal((purged.deleted as string[]).length, 2);
    assert.deepEqual(purged.deleted_by_source, { pre_compact: 2 });
    assert.deepEqual(await listCandidates(root, manual), []);

    const contents = await vaultContents(root);
    assert.equal(contents.includes(SECRET), false, "the purge removed the quoted material");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sessions.directory, { recursive: true, force: true });
  }
});

function archivableProposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    type: "preference",
    target: "10_memory/preferences/_ledger.json",
    content: "Keep answers short.",
    proposed_weight: 2,
    reason: "The user asked for it in so many words.",
    proofs: [{ date: "2026-07-26", quote: "From now on, keep answers short." }],
    weak: false,
    recommendation: "approve",
    evidence_basis: null,
    gate_item_index: 1,
    gate_write_payload: { kind: "preference" },
    ...overrides,
  };
}

test("transcripts purge also erases what has already been archived", async () => {
  const root = await newVault();
  const sessions = await newTranscriptDirectory();
  try {
    await writeVaultConfig(root, [
      "version: 1",
      "capabilities:",
      "  capture:",
      "    enabled: true",
      "  transcripts:",
      "    enabled: true",
      "    redact: true",
      "    roots:",
      `      - ${JSON.stringify(sessions.directory)}`,
      "",
    ].join("\n"));

    const scan = await capture(() => runCommand(captureCommand, {
      rawArgs: ["scan", "--root", root, "--transcript", sessions.file],
    }));
    const scanned = asRecord(scan.output);
    assert.equal(scanned.filed, 2, "both explicit requests were staged");

    const manual = configWith({ capture: true, transcripts: true, roots: [sessions.directory] });
    const staged = await listCandidates(root, manual);
    assert.equal(staged.length, 2);
    const [first, second] = staged;
    if (!first || !second) {
      throw new Error("expected two staged candidates");
    }

    // Decide and archive one candidate, the way the gate would: proposed, then
    // a terminal status, then a compaction into the monthly archive file.
    await transitionCandidate(root, manual, {
      id: first.id,
      status: "proposed",
      proposal: archivableProposal(),
    });
    await transitionCandidate(root, manual, { id: first.id, status: "rejected" });
    const compacted = await compactStaging(root, manual);
    assert.equal(compacted.archived, 1);

    const beforeActive = await listCandidates(root, manual);
    const beforeAll = await listCandidates(root, manual, { includeArchived: true });
    assert.equal(beforeActive.length, 1, "one candidate is still active");
    assert.equal(beforeAll.length, 2, "the archived candidate is still readable");

    const purge = await capture(() => runCommand(transcriptsCommand, {
      rawArgs: ["purge", "--root", root, "--yes"],
    }));
    const purged = asRecord(purge.output);
    assert.equal((purged.deleted as string[]).length, 1, "the still-active candidate was deleted");
    assert.equal(
      (purged.deleted_archived as string[]).length,
      1,
      "the archived candidate was deleted too",
    );
    assert.ok(
      Array.isArray(purged.archive_files) && (purged.archive_files as unknown[]).length > 0,
      "the purge names the archive file(s) it erased from",
    );

    const afterActive = await listCandidates(root, manual);
    const afterAll = await listCandidates(root, manual, { includeArchived: true });
    assert.deepEqual(afterActive, [], "nothing derived from a transcript remains active");
    assert.deepEqual(afterAll, [], "nothing derived from a transcript remains, active or archived");

    const contents = await vaultContents(root);
    assert.equal(contents.includes(SECRET), false, "no quoted material survives, active or archived");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sessions.directory, { recursive: true, force: true });
  }
});

test("transcripts purge refuses to delete without a confirmation", async () => {
  const root = await newVault();
  try {
    await assert.rejects(
      () => runCommand(transcriptsCommand, { rawArgs: ["purge", "--root", root] }),
      /--yes/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
