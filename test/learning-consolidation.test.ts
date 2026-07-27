import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { ExpectedError } from "../src/core/errors.js";
import { sha256 } from "../src/core/text.js";
import type { VaultConfig } from "../src/core/types.js";
import {
  applyCap,
  consolidate,
  deconsolidate,
  loadReferencesPath,
  loadTransactionPath,
  pointerWeight,
  readLoadContract,
  splitDocument,
  verifyReversibility,
} from "../src/learning/consolidation.js";
import { readJournal } from "../src/learning/journal.js";
import { offFlagPath } from "../src/learning/population.js";
import { InvariantError } from "../src/learning/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const consolidationModuleUrl = new URL("../src/learning/consolidation.ts", import.meta.url).href;

// Two promises in one process share the in-memory lock registry, so mutual
// exclusion is only proven by two operating system processes racing for it.
const CHILD_SCRIPT = `
import { access, readFile, writeFile } from "node:fs/promises";
import { withDocumentLock } from ${JSON.stringify(consolidationModuleUrl)};

const options = JSON.parse(process.argv[2]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await writeFile(options.readyPath, "ready", "utf8");
for (let attempt = 0; attempt < 4000; attempt += 1) {
  if (await exists(options.goPath)) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

try {
  await withDocumentLock(options.root, async () => {
    const current = await readFile(options.document, "utf8");
    await writeFile(options.document, current + options.append, "utf8");
  }, { timeoutMs: 20000 });
  process.exit(0);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(3);
}
`;

interface Vault {
  root: string;
  config: VaultConfig;
}

async function armedVault(prefix: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "capabilities:\n  learning:\n    enabled: true\n    evaluate: true\n    consolidate: true\n",
    "utf8",
  );
  return { root, config: await loadConfig(root) };
}

const LOAD_MAX = 900;
const ANCHOR = "# Living state\n";

const FRONTMATTER = [
  "---",
  "lifecycle: master",
  `load_max: ${String(LOAD_MAX)}`,
  "load_policy: dated_rotation",
  "load_archive: 90_archive/consolidation/state/",
  "load_boundary: '^20\\d\\d-\\d\\d-\\d\\d \\('",
  "---",
  "",
  "# Living state",
  "",
].join("\n");

const TAIL = "## Standing section\n\nThis section never moves.\n";

function filler(text: string, lines = 8): string {
  return Array.from(
    { length: lines },
    (_unused, index) => `${text} payload line ${String(index + 1)}`,
  ).join("\n");
}

function block(date: string, subject: string, body = filler(subject)): string {
  return `${date} (${subject})\n${body}\n\n`;
}

function documentOf(blocks: readonly string[], tail: string = TAIL): string {
  return FRONTMATTER + blocks.join("") + tail;
}

/** Newest first, which is the order a living state file grows in. */
const SIX_BLOCKS = [
  block("2026-07-25", "sixth"),
  block("2026-07-24", "fifth"),
  block("2026-07-23", "fourth"),
  block("2026-07-22", "third"),
  block("2026-07-21", "second"),
  block("2026-07-20", "first"),
];

function grow(text: string, date: string, subject: string): string {
  return text.replace(ANCHOR, `${ANCHOR}\n${block(date, subject)}`);
}

async function writeDocument(root: string, relative: string, text: string): Promise<string> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runChild(scriptPath: string, payload: unknown): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, JSON.stringify(payload)],
      { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// The closing test. It is written first and it is blocking: the subtractive
// organ is only allowed to run on its own for as long as this one is green.
// ---------------------------------------------------------------------------

test("closing test: consolidate then deconsolidate is byte exact on every hard fixture", async () => {
  const proof = await verifyReversibility({ cache: false });

  assert.equal(proof.ok, true, JSON.stringify(proof.cases, null, 2));
  assert.ok(proof.cases.length >= 6, "the proof must exercise more than one shape of document");
  for (const round of proof.cases) {
    assert.equal(round.ok, true, `${round.name}: ${String(round.detail)}`);
    assert.equal(
      round.sha256_after,
      round.sha256_before,
      `${round.name} came back with a different digest`,
    );
    assert.ok(round.bytes > 0, `${round.name} restored nothing`);
    assert.ok(round.blocks_archived >= 1, `${round.name} archived nothing, so it proves nothing`);
  }
  assert.ok(
    proof.cases.some((round) => round.name === "same_dates"),
    "the acute case of the first data loss must stay in the proof",
  );
});

test("a round trip is byte exact on accents, emoji, CRLF and JSONL payloads", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-roundtrip-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const fixtures: Record<string, string[]> = {
    accents: [
      block("2026-07-25", "accents", `eleve, etude, naivete, coeur \u{1F9E0}\n${filler("accentue")}`),
      block("2026-07-24", "accents", `deja vu, tres tot \u{1F9E0}\n${filler("accentue")}`),
      block("2026-07-23", "accents", filler("accentue")),
      block("2026-07-22", "accents", filler("accentue")),
      block("2026-07-21", "accents", filler("accentue")),
      block("2026-07-20", "accents", filler("accentue")),
    ],
    jsonl: Array.from({ length: 6 }, (_unused, index) =>
      block(
        `2026-07-2${String(index)}`,
        "jsonl",
        Array.from(
          { length: 8 },
          (_ignored, line) => JSON.stringify({ id: `${String(index)}-${String(line)}`, value: line }),
        ).join("\n"),
      )),
    crlf: Array.from({ length: 6 }, (_unused, index) =>
      block(`2026-07-2${String(index)}`, "crlf", filler("windows").replace(/\n/gu, "\r\n"))),
  };

  for (const [name, blocks] of Object.entries(fixtures)) {
    const relative = `10_memory/${name}.md`;
    // One archive directory per bounded document: sharing one is a refusal.
    const text = FRONTMATTER.replace("state/", `state/${name}/`) + blocks.join("") + TAIL;
    await writeDocument(root, relative, text);
    const report = await consolidate(config, root, relative, {
      mode: "bootstrap",
      now: "2026-07-26T08:00:00Z",
    });
    assert.equal(report.status, "consolidated", `${relative}: ${String(report.reason)}`);
    assert.ok(report.blocks.length >= 1);
    assert.equal(report.deconsolidation_verified, true);
    assert.ok(report.after.size < report.before.size, `${relative} did not shrink`);

    const back = await deconsolidate(config, root, relative);
    assert.equal(back.text, text, `${relative} did not come back byte for byte`);
    assert.equal(back.sha256, sha256(text));
    assert.equal(back.size, Buffer.byteLength(text, "utf8"));
  }
});

test("a chain of consolidations still restores the complete origin", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-chain-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/chain.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);

  const first = await consolidate(config, root, relative, {
    mode: "bootstrap",
    now: "2026-07-26T08:00:00Z",
  });
  assert.equal(first.status, "consolidated");

  // A later turn appends two newer entries at the top of the living zone.
  const grown = grow(
    grow(await readFile(path, "utf8"), "2026-07-26", "seventh"),
    "2026-07-27",
    "eighth",
  );
  const expected = grow(grow(original, "2026-07-26", "seventh"), "2026-07-27", "eighth");
  await writeDocument(root, relative, grown);

  const second = await consolidate(config, root, relative, {
    mode: "resume",
    now: "2026-07-27T08:00:00Z",
  });
  assert.equal(second.status, "consolidated", String(second.reason));

  const back = await deconsolidate(config, root, relative);
  assert.equal(back.text, expected, "the second consolidation lost part of the origin");
  assert.equal(back.sha256, sha256(expected));
});

test("the cut keeps the order of the file and never sorts, even on identical dates", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-order-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/same-dates.md";
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const original = documentOf(names.map((name) => block("2026-07-25", name)));
  await writeDocument(root, relative, original);

  const report = await consolidate(config, root, relative, {
    mode: "bootstrap",
    now: "2026-07-26T08:00:00Z",
  });
  assert.equal(report.status, "consolidated");

  const back = await deconsolidate(config, root, relative);
  assert.equal(back.text, original);

  const positions = names.map((name) => back.text.indexOf(`(${name})`));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

// ---------------------------------------------------------------------------
// The safety catch. The link between the proof and the organ lives in code.
// ---------------------------------------------------------------------------

test("the autonomous path refuses to run when the reversibility proof is not green", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-safety-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/guarded.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);

  const report = await applyCap(config, root, relative, {
    now: "2026-07-26T08:00:00Z",
    reversibilityProof: async () => ({
      ok: false,
      checked_at: "2026-07-26T08:00:00Z",
      cases: [{
        name: "same_dates",
        ok: false,
        bytes: 1,
        blocks_archived: 1,
        sha256_before: "a".repeat(64),
        sha256_after: "b".repeat(64),
      }],
    }),
  });

  assert.equal(report.status, "refused");
  assert.equal(report.reason, "reversibility_unproven");
  // Refusing means refusing to touch the document at all.
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await exists(join(root, "90_archive")), false);
  assert.equal(await exists(loadTransactionPath(config, root)), false);
  assert.equal(await exists(loadReferencesPath(config, root)), false);
});

test("the autonomous path consolidates once the proof is green and the cap is exceeded", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-autonomous-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/autonomous.md";
  const original = documentOf(SIX_BLOCKS);
  await writeDocument(root, relative, original);

  const report = await applyCap(config, root, relative, { now: "2026-07-26T08:00:00Z" });
  assert.equal(report.status, "consolidated", String(report.reason));
  assert.equal(report.mode, "bootstrap");
  assert.equal(report.deconsolidation_verified, true);

  // Under the cap now, so a second automatic pass has nothing to do.
  const again = await applyCap(config, root, relative, { now: "2026-07-26T09:00:00Z" });
  assert.equal(again.status, "nothing_to_do", String(again.reason));
  assert.equal(again.mode, "strict");

  const back = await deconsolidate(config, root, relative);
  assert.equal(back.text, original);
});

// ---------------------------------------------------------------------------
// The three data losses, replayed.
// ---------------------------------------------------------------------------

test("loss 1: an interruption after the archive is refused, marker or no marker", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-loss1-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/interrupted.md";
  // The acute case: every entry carries the same date, so a guard that compares
  // dates alone has nothing left to compare.
  const original = documentOf([
    block("2026-07-25", "alpha"),
    block("2026-07-25", "beta"),
    block("2026-07-25", "gamma"),
    block("2026-07-25", "delta"),
    block("2026-07-25", "epsilon"),
    block("2026-07-25", "zeta"),
  ]);
  const path = await writeDocument(root, relative, original);
  await consolidate(config, root, relative, { mode: "bootstrap", now: "2026-07-26T08:00:00Z" });

  let grown = await readFile(path, "utf8");
  for (const name of ["eta", "theta", "iota", "kappa"]) {
    grown = grow(grown, "2026-07-25", name);
  }
  await writeDocument(root, relative, grown);

  await assert.rejects(
    async () =>
      consolidate(config, root, relative, {
        mode: "resume",
        now: "2026-07-26T09:00:00Z",
        injectAt: {
          after_archive: () => {
            throw new Error("power cut between the archive and the document");
          },
        },
      }),
    /power cut/u,
  );

  // The document was never rewritten, and the transaction marker survived.
  assert.equal(await readFile(path, "utf8"), grown);
  assert.equal(await exists(loadTransactionPath(config, root)), true);

  // First net: the marker refuses both directions.
  await assert.rejects(
    async () => consolidate(config, root, relative, { mode: "resume", now: "2026-07-26T09:05:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.transaction.pending");
      return true;
    },
  );
  await assert.rejects(
    async () => deconsolidate(config, root, relative),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.transaction.pending");
      return true;
    },
  );

  // Second net, independent of every state file: the marker is removed by hand
  // and the archive still holds blocks that no pointer claims.
  await rm(loadTransactionPath(config, root), { force: true });
  await assert.rejects(
    async () => deconsolidate(config, root, relative),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.archive.orphan_blocks");
      return true;
    },
  );
});

test("loss 1: a tampered archive is refused at restoration", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-digest-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/digest.md";
  await writeDocument(root, relative, documentOf(SIX_BLOCKS));
  const report = await consolidate(config, root, relative, {
    mode: "bootstrap",
    now: "2026-07-26T08:00:00Z",
  });
  const archive = report.blocks[0]?.archive;
  assert.ok(archive);

  const archivePath = join(root, archive);
  const pristine = await readFile(archivePath, "utf8");

  await writeFile(archivePath, pristine.replace("payload line 1", "tampered line 1"), "utf8");
  await assert.rejects(
    async () => deconsolidate(config, root, relative),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.archive.digest");
      return true;
    },
  );

  await writeFile(archivePath, pristine.replace(/^sha256_block: .*$/mu, "kind: archive"), "utf8");
  await assert.rejects(
    async () => deconsolidate(config, root, relative),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.archive.digest_missing");
      return true;
    },
  );
});

test("loss 2: a write that lands before the lock aborts without archiving anything", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-loss2-early-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/concurrent-early.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);
  const intruder = grow(original, "2026-07-26", "another session");

  await assert.rejects(
    async () =>
      consolidate(config, root, relative, {
        mode: "bootstrap",
        now: "2026-07-26T08:00:00Z",
        injectAt: {
          before_archive: async () => {
            await writeFile(path, intruder, "utf8");
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.document.concurrent");
      return true;
    },
  );

  assert.equal(await readFile(path, "utf8"), intruder);
  assert.equal(await exists(join(root, "90_archive", "consolidation", "state")), false);
  assert.equal(await exists(loadTransactionPath(config, root)), false);
});

test("loss 2: a write that lands during the consolidation gives the archive back", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-loss2-late-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/concurrent-late.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);
  const intruder = grow(original, "2026-07-26", "another session");

  await assert.rejects(
    async () =>
      consolidate(config, root, relative, {
        mode: "bootstrap",
        now: "2026-07-26T08:00:00Z",
        injectAt: {
          after_archive: async () => {
            await writeFile(path, intruder, "utf8");
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.document.concurrent");
      return true;
    },
  );

  // The concurrent work is intact and the archive is back to what it was.
  assert.equal(await readFile(path, "utf8"), intruder);
  const remaining = await readdir(join(root, "90_archive", "consolidation", "state"))
    .catch(() => [] as string[]);
  assert.deepEqual(remaining, [], "the archive was not given back");
  assert.equal(await exists(loadTransactionPath(config, root)), false);
});

test("loss 3: an index pushed out of its zone is refused in all three modes", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-loss3-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/eaten.md";
  const eaten = FRONTMATTER
    + SIX_BLOCKS.join("")
    + TAIL
    + "\n"
    + "<!-- load:index start -->\n"
    + "- 2026-07-20 : first -> 90_archive/consolidation/state/2026-07.md\n"
    + "<!-- load:index end -->\n";
  const path = await writeDocument(root, relative, eaten);

  for (const mode of ["strict", "bootstrap", "resume"] as const) {
    await assert.rejects(
      async () => consolidate(config, root, relative, { mode, now: "2026-07-26T08:00:00Z" }),
      (error: unknown) => {
        assert.ok(error instanceof InvariantError, `mode ${mode}`);
        assert.equal(error.invariant, "load.index.out_of_zone", `mode ${mode}`);
        return true;
      },
    );
    assert.equal(await readFile(path, "utf8"), eaten);
  }
});

test("cut 4: the index never loses a pointer, and there is only ever one pair of markers", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-pointers-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/pointers.md";
  await writeDocument(root, relative, documentOf(SIX_BLOCKS));

  let archived = 0;
  for (let round = 0; round < 20; round += 1) {
    const day = String(10 + round).padStart(2, "0");
    const report = await consolidate(config, root, relative, {
      mode: round === 0 ? "bootstrap" : "resume",
      now: `2026-08-${day}T08:00:00Z`,
    });
    if (report.status === "consolidated") {
      archived += report.blocks.reduce((sum, entry) => sum + entry.entries, 0);
    }

    const current = await readFile(join(root, relative), "utf8");
    const contract = readLoadContract(current, config);
    const split = splitDocument(current, contract);
    assert.equal(pointerWeight(split.pointers), archived, `round ${String(round)} lost a pointer`);
    assert.equal((current.match(/<!-- load:index start -->/gu) ?? []).length, 1);
    assert.equal((current.match(/<!-- load:index end -->/gu) ?? []).length, 1);
    assert.ok(
      Array.from(current).length <= contract.load_max || split.blocks.length === 1,
      `round ${String(round)} stayed over its cap with ${String(split.blocks.length)} blocks`,
    );

    await writeDocument(root, relative, grow(current, `2026-08-${day}`, `round ${String(round)}`));
  }

  // Folding happened, and the way back is still deterministic and complete.
  const final = await readFile(join(root, relative), "utf8");
  const split = splitDocument(final, readLoadContract(final, config));
  assert.ok(split.pointers.length < archived, "the index was never folded, so it is not bounded");
  assert.ok(split.pointers.some((pointer) => pointer.count !== undefined));

  const first = await deconsolidate(config, root, relative);
  const second = await deconsolidate(config, root, relative);
  assert.equal(first.text, second.text);
  assert.equal(first.blocks_restored, archived);
  assert.ok(first.size > Buffer.byteLength(final, "utf8"));
});

// ---------------------------------------------------------------------------
// The concurrency sliver, closed with the inter-process lock.
// ---------------------------------------------------------------------------

test("the sliver is closed: a lock respecting writer never reads a stale document", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-sliver-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/sliver.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);

  const scriptPath = join(root, "child.mjs");
  await writeFile(scriptPath, CHILD_SCRIPT, "utf8");
  const readyPath = join(root, "child-ready");
  const goPath = join(root, "child-go");
  const append = "\n2026-07-26 (concurrent session) appended under the lock\n";

  const child = runChild(scriptPath, { root, document: path, readyPath, goPath, append });

  for (let attempt = 0; attempt < 4000 && !(await exists(readyPath)); attempt += 1) {
    await sleep(5);
  }
  assert.equal(await exists(readyPath), true, "the child never started");

  const report = await consolidate(config, root, relative, {
    mode: "bootstrap",
    now: "2026-07-26T08:00:00Z",
    injectAt: {
      // Inside the critical section: the competing writer is released here and
      // has to wait for the lock instead of landing between the reread and the
      // rewrite.
      after_archive: async () => {
        await writeFile(goPath, "go", "utf8");
        await sleep(700);
      },
    },
  });
  assert.equal(report.status, "consolidated", String(report.reason));

  const outcome = await child;
  assert.equal(outcome.code, 0, outcome.stderr);

  assert.equal(
    await readFile(path, "utf8"),
    report.text + append,
    "the competing writer read the document from before the consolidation",
  );
});

test("an unlocked writer is still caught, and the layer says so instead of overwriting", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-unlocked-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/unlocked.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);

  await assert.rejects(
    async () =>
      consolidate(config, root, relative, {
        mode: "bootstrap",
        now: "2026-07-26T08:00:00Z",
        injectAt: {
          before_document_write: async () => {
            await writeFile(path, `${original}extra byte\n`, "utf8");
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.document.concurrent");
      return true;
    },
  );
  assert.equal(await readFile(path, "utf8"), `${original}extra byte\n`);
});

// ---------------------------------------------------------------------------
// Contract, capability, sentinel.
// ---------------------------------------------------------------------------

test("a document without a load contract is never consolidated", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-contract-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/uncapped.md";
  await writeDocument(
    root,
    relative,
    "---\nlifecycle: master\n---\n\n2026-07-25 (entry) payload\n",
  );

  await assert.rejects(
    async () => consolidate(config, root, relative, { mode: "bootstrap" }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.load_max.missing");
      return true;
    },
  );

  const report = await applyCap(config, root, relative, {});
  assert.equal(report.status, "refused");
  assert.equal(report.reason, "load.load_max.missing");
});

test("the two unimplemented load policies are named, never silently rotated", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-policy-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const policy of ["fifo_rotation", "refuse"]) {
    const relative = `10_memory/policy-${policy}.md`;
    await writeDocument(
      root,
      relative,
      FRONTMATTER.replace("dated_rotation", policy) + SIX_BLOCKS.join("") + TAIL,
    );
    await assert.rejects(
      async () => consolidate(config, root, relative, { mode: "bootstrap" }),
      (error: unknown) => {
        assert.ok(error instanceof InvariantError, policy);
        assert.equal(error.invariant, "load.policy.unsupported", policy);
        return true;
      },
    );
  }
});

test("an archive outside the archive zone is refused", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-zone-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/escape.md";
  await writeDocument(
    root,
    relative,
    FRONTMATTER.replace("90_archive/consolidation/state/", "10_memory/../../elsewhere/")
      + SIX_BLOCKS.join("")
      + TAIL,
  );
  await assert.rejects(
    async () => consolidate(config, root, relative, { mode: "bootstrap" }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.load_archive.zone");
      return true;
    },
  );
});

test("consolidation refuses to run while its own capability is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-brain-consolidation-disarmed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const relative = "10_memory/disarmed.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);

  // A default vault, then a vault where the parent capability alone is armed.
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(
    join(root, "00_index", "vault.config.yml"),
    "capabilities:\n  learning:\n    enabled: true\n    evaluate: true\n",
    "utf8",
  );
  const parentOnly = await loadConfig(root);

  for (const config of [DEFAULT_CONFIG, parentOnly]) {
    await assert.rejects(
      async () => consolidate(config, root, relative, { mode: "bootstrap" }),
      (error: unknown) => {
        assert.ok(error instanceof ExpectedError);
        assert.match(error.message, /Capability learning\.consolidate is disabled/u);
        return true;
      },
    );
    const report = await applyCap(config, root, relative, {});
    assert.equal(report.status, "refused");
    assert.match(String(report.reason), /Capability learning\.consolidate is disabled/u);
  }

  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await exists(join(root, "90_archive")), false);
});

test("the OFF sentinel stops consolidation without stopping the way back", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-off-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/off.md";
  const original = documentOf(SIX_BLOCKS);
  await writeDocument(root, relative, original);
  await consolidate(config, root, relative, { mode: "bootstrap", now: "2026-07-26T08:00:00Z" });
  const consolidated = await readFile(join(root, relative), "utf8");

  await writeFile(offFlagPath(config, root), '{"disabled_at":"2026-07-26T09:00:00Z"}\n', "utf8");

  // It reports a refusal, it does not raise: its automatic caller lives inside a
  // hook, and an exception there would climb out into the session.
  const refused = await consolidate(config, root, relative, { now: "2026-07-26T09:05:00Z" });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "disabled");
  assert.equal(await readFile(join(root, relative), "utf8"), consolidated);

  // A way back that refuses to work once the layer is off is the opposite of
  // the service expected from it.
  const back = await deconsolidate(config, root, relative);
  assert.equal(back.text, original);
});

test("the reference guard is at the content, never at the clock", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-reference-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/reference.md";
  const original = documentOf(SIX_BLOCKS);
  const path = await writeDocument(root, relative, original);

  await assert.rejects(
    async () => consolidate(config, root, relative, { mode: "strict", now: "2026-07-26T08:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.reference.missing");
      return true;
    },
  );

  const first = await consolidate(config, root, relative, {
    mode: "bootstrap",
    now: "2026-07-26T08:00:00Z",
  });
  assert.equal(first.status, "consolidated");

  // Bootstrap is for a document Open Brain never wrote, and this one now has a
  // reference of its own write.
  await assert.rejects(
    async () =>
      consolidate(config, root, relative, { mode: "bootstrap", now: "2026-07-26T09:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.reference.mode");
      return true;
    },
  );

  // A hand edit is a divergence, whatever the clock says.
  await writeFile(path, grow(await readFile(path, "utf8"), "2026-07-26", "hand edit"), "utf8");
  await assert.rejects(
    async () => consolidate(config, root, relative, { mode: "strict", now: "2026-07-26T10:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.equal(error.invariant, "load.reference.diverged");
      return true;
    },
  );
});

test("the consolidation entry is journaled after the rewrite and shrinks the document", async (t) => {
  const { root, config } = await armedVault("open-brain-consolidation-journal-");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const relative = "10_memory/journaled.md";
  const original = documentOf(SIX_BLOCKS);
  await writeDocument(root, relative, original);

  const report = await consolidate(config, root, relative, {
    mode: "bootstrap",
    now: "2026-07-26T08:00:00Z",
  });
  assert.equal(report.status, "consolidated");

  const journal = await readJournal(config, root, { limit: 10 });
  const entry = journal.entries.find((candidate) => candidate.type === "consolidated");
  assert.ok(entry, "the consolidation was never journaled");
  assert.equal(entry.ts, "2026-07-26T08:00:00Z");
  assert.ok("blocks" in entry);
  assert.ok(entry.blocks.length >= 1);
  assert.equal(entry.deconsolidation_verified, true);
  assert.ok(entry.after.size < entry.before.size);
  assert.equal(entry.after.sha256, sha256(await readFile(join(root, relative), "utf8")));

  // The bootstrap mode is journaled too: a non nominal reference is never silent.
  const loads = journal.entries.filter((candidate) => candidate.type === "load");
  assert.equal(loads.length, 1);

  const living = await stat(join(root, relative));
  assert.ok(living.size < Buffer.byteLength(original, "utf8"));
});
