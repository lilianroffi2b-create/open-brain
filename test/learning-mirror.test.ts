import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/core/config.js";
import { sha256 } from "../src/core/text.js";
import type { VaultConfig } from "../src/core/types.js";
import { computeMove } from "../src/learning/confidence.js";
import { appendVerdicts } from "../src/learning/evaluator.js";
import { buildDecision, noteError, writeEntry } from "../src/learning/journal.js";
import {
  buildMirror,
  buildOrganReport,
  CIRCULATION_FLOOR_NOTE,
  DEFAULT_SECTION_CAPS,
  formatMirror,
  LEARNING_ORGANS,
  MIRROR_SECTION_IDS,
  NO_PROPOSAL_PRODUCER_NOTE,
  renderMirror,
  type AutonomousSection,
  type BeliefsSection,
  type BlindSection,
  type Mirror,
  type MirrorSection,
  type MirrorSectionId,
  type UnbuiltSection,
  type UncertainSection,
  type WeekSection,
} from "../src/learning/mirror.js";
import { writePopulation } from "../src/learning/population.js";
import { appendObservations, observationId } from "../src/learning/sensors/index.js";
import { addBelief, applyBeliefApplications, beliefsPath } from "../src/learning/store.js";
import {
  createBelief,
  LEARNING_SCHEMA_VERSION,
  type ApplicationCause,
  type Belief,
} from "../src/learning/types.js";

/**
 * The mirror is the organ that shows and writes nothing, so its tests are
 * mostly about what it refuses to do: write, invent, hide a cut, or let a file
 * it cannot read take the whole render down with it.
 */

const NOW = "2026-07-26T09:00:00Z";
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

interface Vault {
  root: string;
  config: VaultConfig;
}

async function vaultWith(prefix: string, capabilities: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "00_index"), { recursive: true });
  await writeFile(join(root, "00_index", "vault.config.yml"), capabilities, "utf8");
  return { root, config: await loadConfig(root) };
}

async function armedVault(prefix: string): Promise<Vault> {
  return vaultWith(
    prefix,
    "capabilities:\n  learning:\n    enabled: true\n    evaluate: true\n",
  );
}

async function disarmedVault(prefix: string): Promise<Vault> {
  return vaultWith(prefix, "capabilities:\n  learning:\n    enabled: false\n");
}

/**
 * A digest of everything under a directory: names, sizes, modification times
 * and contents. Reading a file changes none of them, so a render that leaves
 * this digest untouched has written nothing at all.
 */
async function fingerprint(directory: string): Promise<string> {
  const lines: string[] = [];

  async function walk(current: string, prefix: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sorted) {
      const full = join(current, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`d ${relative}`);
        await walk(full, `${relative}/`);
        continue;
      }
      const info = await stat(full);
      lines.push(
        `f ${relative} ${String(info.size)} ${String(info.mtimeMs)} ${sha256(await readFile(full))}`,
      );
    }
  }

  await walk(directory, "");
  return sha256(lines.join("\n"));
}

function belief(statement: string, domain: string, created: string): Belief {
  return createBelief({
    statement,
    domain,
    evidence: { occurrences: 1, refs: ["test:fixture"], quote: statement },
    now: created,
  });
}

async function move(
  vault: Vault,
  id: string,
  cause: ApplicationCause,
  ref: string,
  at: string,
): Promise<void> {
  const document = await readDocument(vault);
  const target = document.find((candidate) => candidate.id === id);
  assert.ok(target, `fixture belief ${id} must exist`);
  const outcome = computeMove(target, cause, at);
  await applyBeliefApplications(
    vault.config,
    vault.root,
    [{ belief_id: id, cause, ref, confidence: outcome.to, at }],
    { now: at },
  );
}

async function readDocument(vault: Vault): Promise<Belief[]> {
  const raw = await readFile(beliefsPath(vault.config, vault.root), "utf8");
  const parsed = JSON.parse(raw) as { beliefs: Belief[] };
  return parsed.beliefs;
}

/**
 * A vault with real data of every shape the mirror reports on: a law engraved
 * by hand, an active belief the automatic ceiling holds back, a demoted one, a
 * mark written without a move, verdicts armed and disarmed, observations, a
 * population wider than what was measured, and a graft that failed.
 */
async function populatedVault(prefix: string): Promise<Vault> {
  const vault = await armedVault(prefix);
  const { config, root } = vault;

  await addBelief(config, root, belief(
    "Load a bounded context and report its token cost.",
    "agentic coding",
    "2026-07-01T09:00:00Z",
  ));
  await addBelief(config, root, belief(
    "Answer in short sentences and skip the preamble.",
    "writing",
    "2026-07-02T09:00:00Z",
  ));
  await addBelief(config, root, belief(
    "Open a long explanation before any code.",
    "writing",
    "2026-07-03T09:00:00Z",
  ));

  const law = "b_load_a_bounded_context_and_report_its_token";
  const short = "b_answer_in_short_sentences_and_skip_the";
  const demoted = "b_open_a_long_explanation_before_any_code";

  await move(vault, law, "human_engrave", "human:engrave", "2026-07-24T09:00:00Z");
  // Locked, so a confirmation writes its mark and moves nothing. That is the
  // exact signature of a replay, and it has to stay visible.
  await move(vault, law, "application_confirmed", "dec_20260725T0900_aaaa1111", "2026-07-25T09:00:00Z");
  await move(vault, short, "application_confirmed", "dec_20260722T0900_bbbb2222", "2026-07-22T09:00:00Z");
  await move(vault, short, "application_confirmed", "dec_20260723T0900_cccc3333", "2026-07-23T09:00:00Z");
  await move(vault, demoted, "application_corrected", "dec_20260723T1000_dddd4444", "2026-07-23T10:00:00Z");

  await writeEntry(config, root, buildDecision({
    id: "dec_20260722T0900_bbbb2222",
    ts: "2026-07-22T09:00:00Z",
    session: "s1",
    type: "route",
    input: { summary: "route a request about agentic coding" },
    choice: "agentic coding",
    score: 0.8,
    beliefs_applied: [short],
  }));
  await writeEntry(config, root, buildDecision({
    id: "dec_20260723T1000_dddd4444",
    ts: "2026-07-23T10:00:00Z",
    session: "s2",
    type: "route",
    input: { summary: "route a request about writing" },
    choice: "writing",
    score: 0.4,
  }));
  await writeEntry(config, root, buildDecision({
    id: "dec_20260701T0900_eeee5555",
    ts: "2026-07-01T09:00:00Z",
    session: "s0",
    type: "route",
    input: { summary: "an old decision, outside the window" },
    choice: "writing",
  }));

  await appendVerdicts(config, root, [
    {
      schema_version: LEARNING_SCHEMA_VERSION,
      decision_id: "dec_20260722T0900_bbbb2222",
      rule: "sterile_route",
      verdict: "good",
      weight: 1,
      armed: true,
      evidence: { documents: 2 },
      evaluated_at: "2026-07-24T09:00:00Z",
    },
    {
      schema_version: LEARNING_SCHEMA_VERSION,
      decision_id: "dec_20260723T1000_dddd4444",
      rule: "sterile_route",
      verdict: "bad",
      weight: 1,
      armed: true,
      evidence: { documents: 0 },
      evaluated_at: "2026-07-24T09:00:00Z",
    },
    {
      schema_version: LEARNING_SCHEMA_VERSION,
      decision_id: "dec_20260723T1000_dddd4444",
      rule: "rapid_followup",
      verdict: "undetermined",
      weight: 1,
      armed: false,
      evidence: { window: "not calibrated" },
      evaluated_at: "2026-07-24T09:00:00Z",
    },
  ]);

  await appendObservations(config, root, [
    {
      schema_version: LEARNING_SCHEMA_VERSION,
      id: observationId("2026-07-24T09:00:00Z", 1),
      sensor: "circulation",
      ts: "2026-07-24T09:00:00Z",
      subject: "10_memory/_state.md@2026-07",
      population: "10_memory/_state.md",
      measure: { reads: 4, reads_transcript: 0, reads_graft: 4 },
      derived: {},
    },
  ]);

  await writePopulation(config, root, {
    schema_version: LEARNING_SCHEMA_VERSION,
    updated_at: "2026-07-24T09:00:00Z",
    total: 3,
    documents: [
      "10_memory/_state.md",
      "20_contexts/brief.md",
      "20_contexts/style.md",
    ],
  });

  await noteError(config, root, "learning.confidence", new Error("disk full"), { at: "hook" });

  return vault;
}

function sectionOf(mirror: Mirror, id: MirrorSectionId): MirrorSection {
  const found = mirror.sections.find((section) => section.id === id);
  assert.ok(found, `section ${id} must be present`);
  return found;
}

function beliefsSection(mirror: Mirror): BeliefsSection {
  const section = sectionOf(mirror, "beliefs");
  assert.equal(section.id, "beliefs");
  return section;
}

function weekSection(mirror: Mirror): WeekSection {
  const section = sectionOf(mirror, "week");
  assert.equal(section.id, "week");
  return section;
}

function uncertainSection(mirror: Mirror): UncertainSection {
  const section = sectionOf(mirror, "uncertain");
  assert.equal(section.id, "uncertain");
  return section;
}

function blindSection(mirror: Mirror): BlindSection {
  const section = sectionOf(mirror, "blind");
  assert.equal(section.id, "blind");
  return section;
}

function autonomousSection(mirror: Mirror): AutonomousSection {
  const section = sectionOf(mirror, "autonomous");
  assert.equal(section.id, "autonomous");
  return section;
}

function unbuiltSection(mirror: Mirror): UnbuiltSection {
  const section = sectionOf(mirror, "unbuilt");
  assert.equal(section.id, "unbuilt");
  return section;
}

test("the mirror writes nothing: the vault is byte identical before and after a full render", async (t) => {
  const vault = await populatedVault("open-brain-mirror-readonly-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const before = await fingerprint(vault.root);
  const mirror = await buildMirror(vault.config, vault.root, { now: NOW });
  formatMirror(mirror);
  await renderMirror(vault.config, vault.root, { now: NOW });
  await buildOrganReport(vault.config, vault.root);
  const after = await fingerprint(vault.root);

  assert.equal(after, before, "a full render must not change one byte of the vault");
  // The render is not empty either: a mirror that shows nothing would pass the
  // fingerprint test for the wrong reason.
  assert.ok(mirror.budget.chars > 500, `the render must carry real content, got ${String(mirror.budget.chars)} chars`);
});

test("a disarmed learning capability makes the mirror read nothing and say how to arm it", async (t) => {
  const armed = await populatedVault("open-brain-mirror-disarmed-data-");
  t.after(async () => rm(armed.root, { recursive: true, force: true }));

  // Same vault, same data, capability turned off underneath.
  await writeFile(
    join(armed.root, "00_index", "vault.config.yml"),
    "capabilities:\n  learning:\n    enabled: false\n",
    "utf8",
  );
  const config = await loadConfig(armed.root);

  const mirror = await buildMirror(config, armed.root, { now: NOW });
  assert.equal(mirror.learning_enabled, false);
  assert.deepEqual(mirror.diagnostics, [], "nothing was read, so nothing is diagnosed");
  assert.equal(beliefsSection(mirror).beliefs.length, 0);
  assert.equal(autonomousSection(mirror).moves.length, 0);

  for (const id of MIRROR_SECTION_IDS) {
    const section = sectionOf(mirror, id);
    assert.match(
      section.notes.join(" "),
      /learning capability is disarmed/u,
      `section ${id} must say why it is empty`,
    );
    assert.match(
      section.notes.join(" "),
      /open-brain capabilities enable learning/u,
      `section ${id} must name the command that arms it`,
    );
  }

  const organs = mirror.organs;
  assert.equal(organs.layer_inactive, true);
  const learning = organs.capabilities.find((capability) => capability.name === "learning");
  assert.ok(learning);
  assert.equal(learning.enabled, false);
  assert.equal(learning.arm_with, "open-brain capabilities enable learning");
});

test("every section is capped, returns its budget, and says how to see the rest", async (t) => {
  const vault = await populatedVault("open-brain-mirror-cap-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const full = await buildMirror(vault.config, vault.root, { now: NOW });
  for (const section of full.sections) {
    assert.ok(
      section.text.length <= DEFAULT_SECTION_CAPS[section.id],
      `section ${section.id} must fit its cap`,
    );
    assert.equal(typeof section.budget.chars, "number");
    assert.equal(typeof section.budget.token_estimate, "number");
  }

  // A cap small enough to bite. The truncation is announced, counted, and it
  // says where the rest lives.
  const squeezed = await buildMirror(vault.config, vault.root, {
    now: NOW,
    caps: {
      beliefs: 200,
      week: 200,
      uncertain: 200,
      blind: 200,
      autonomous: 200,
      unbuilt: 200,
    },
  });
  const truncated = squeezed.sections.filter((section) => section.budget.truncated);
  assert.ok(truncated.length >= 4, "a 200 character cap must bite on most sections");
  for (const section of truncated) {
    assert.ok(section.text.includes("TRUNCATED"), `section ${section.id} must announce its cut`);
    assert.ok(section.next, `section ${section.id} must say how to see the rest`);
    assert.ok(
      section.budget.items_shown < section.budget.items_total,
      `section ${section.id} must count what it dropped`,
    );
  }
  assert.equal(squeezed.budget.truncated, true);
  assert.ok(squeezed.budget.chars < full.budget.chars);
});

test("the mirror names the organs that are not built and the rules that never conclude", async (t) => {
  const vault = await populatedVault("open-brain-mirror-unbuilt-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const mirror = await buildMirror(vault.config, vault.root, { now: NOW });
  const section = unbuiltSection(mirror);
  const absent = section.organs.organs.filter((organ) => !organ.built).map((organ) => organ.name);

  assert.deepEqual(
    absent.sort(),
    ["generalized consolidation", "inferrer", "metabolism", "voice"],
    "the four absent organs are named, not hidden",
  );
  for (const organ of LEARNING_ORGANS.filter((item) => !item.built)) {
    assert.ok(organ.consequence, `${organ.name} must say what its absence costs`);
    assert.ok(section.text.includes(organ.name), `${organ.name} must be visible in the render`);
  }

  assert.deepEqual(
    section.organs.rules_disarmed.map((rule) => rule.rule).sort(),
    ["deliverable_shipped", "rapid_followup", "wasted_load"],
  );
  for (const rule of section.organs.rules_disarmed) {
    assert.ok(rule.reason.length > 20, `${rule.rule} must say why it stays disarmed`);
  }
  assert.deepEqual(section.organs.sensors_built, ["circulation"]);
  assert.deepEqual(section.organs.sensors_declared_unbuilt, []);
  assert.ok(section.notes.includes(NO_PROPOSAL_PRODUCER_NOTE));
  // The honesty section must fit whole under its default cap. An honesty that
  // gets truncated first is the honesty nobody reads.
  assert.equal(section.budget.truncated, false);

  // Consolidation is disarmed in this vault, so the section that would show its
  // work says so and names the command that would arm it.
  assert.match(
    weekSection(mirror).notes.join(" "),
    /capabilities enable learning\.consolidate/u,
  );
});

test("an empty vault says each section is empty instead of inventing filler", async (t) => {
  const vault = await armedVault("open-brain-mirror-empty-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const mirror = await buildMirror(vault.config, vault.root, { now: NOW });

  assert.deepEqual(beliefsSection(mirror).beliefs, []);
  assert.match(beliefsSection(mirror).notes.join(" "), /No belief store in this vault yet/u);
  assert.deepEqual(uncertainSection(mirror).beliefs, []);
  assert.match(uncertainSection(mirror).notes.join(" "), /No belief sits at rank shadow/u);

  const week = weekSection(mirror);
  assert.equal(week.decisions, 0);
  assert.equal(week.circulation.available, false);
  assert.match(week.text, /no observation has ever been written/u);

  const blind = blindSection(mirror);
  assert.deepEqual(blind.undetermined_zones, []);
  assert.equal(blind.circulation_blind_spot.available, false);
  assert.equal(blind.graft_failures.present, false);
  assert.match(blind.text, /never been created/u);

  const autonomous = autonomousSection(mirror);
  assert.deepEqual(autonomous.moves, []);
  assert.match(autonomous.text, /no confidence moved on its own/u);

  // Every source is reported absent, and none of them is reported as a zero.
  for (const diagnostic of mirror.diagnostics) {
    assert.equal(diagnostic.present, false, `${diagnostic.source} must be reported absent`);
    assert.equal(diagnostic.items, undefined);
  }
});

test("a belief store that cannot be read is reported, and the render still holds", async (t) => {
  const vault = await populatedVault("open-brain-mirror-corrupt-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  await writeFile(beliefsPath(vault.config, vault.root), "{ not json at all", "utf8");

  const mirror = await buildMirror(vault.config, vault.root, { now: NOW });
  const diagnostic = mirror.diagnostics.find((item) => item.source === "beliefs.json");
  assert.ok(diagnostic);
  assert.equal(diagnostic.present, true);
  assert.ok(diagnostic.error, "an unreadable store is reported with its reason");

  assert.deepEqual(beliefsSection(mirror).beliefs, []);
  assert.match(beliefsSection(mirror).notes.join(" "), /could not be read/u);
  // The rest of the mirror is unaffected: one broken file does not blind it.
  assert.equal(weekSection(mirror).decisions, 2);
  assert.ok(formatMirror(mirror).length > 500);
});

test("an absent failure trace and a trace holding no failure are two different statements", async (t) => {
  const empty = await armedVault("open-brain-mirror-trace-absent-");
  t.after(async () => rm(empty.root, { recursive: true, force: true }));
  const absent = blindSection(await buildMirror(empty.config, empty.root, { now: NOW }));
  assert.equal(absent.graft_failures.present, false);
  assert.equal(absent.graft_failures.count, 0);
  assert.match(absent.text, /not the same statement as zero failure recorded/u);

  const withTrace = await populatedVault("open-brain-mirror-trace-present-");
  t.after(async () => rm(withTrace.root, { recursive: true, force: true }));
  const present = blindSection(await buildMirror(withTrace.config, withTrace.root, { now: NOW }));
  assert.equal(present.graft_failures.present, true);
  assert.equal(present.graft_failures.count, 1);
  assert.deepEqual(Object.keys(present.graft_failures.by_origin), ["learning.confidence"]);
  assert.ok(present.graft_failures.latest);
  assert.match(present.graft_failures.latest.error, /disk full/u);
});

test("circulation is presented as a floor, never as a total", async (t) => {
  const vault = await populatedVault("open-brain-mirror-floor-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const mirror = await buildMirror(vault.config, vault.root, { now: NOW });
  assert.ok(weekSection(mirror).notes.includes(CIRCULATION_FLOOR_NOTE));
  assert.ok(blindSection(mirror).notes.includes(CIRCULATION_FLOOR_NOTE));

  const week = weekSection(mirror);
  assert.equal(week.circulation.available, true);
  assert.equal(week.circulation.documents_measured, 1);
  assert.equal(week.circulation.reads_measured, 4);

  const spot = blindSection(mirror).circulation_blind_spot;
  assert.equal(spot.available, true);
  assert.equal(spot.population_total, 3);
  assert.equal(spot.never_measured, 2);
});

test("what the layer decided alone stays separate from what a human decided, lock included", async (t) => {
  const vault = await populatedVault("open-brain-mirror-autonomous-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const section = autonomousSection(await buildMirror(vault.config, vault.root, { now: NOW }));

  const causes = section.moves.map((entry) => entry.cause).sort();
  assert.deepEqual(causes, [
    "application_confirmed",
    "application_confirmed",
    "application_confirmed",
    "application_corrected",
  ]);
  assert.ok(
    section.moves.every((entry) => entry.cause !== "human_engrave"),
    "a human move is never counted as a decision the layer took",
  );

  // The engraved belief is locked, so its confirmation wrote a mark and moved
  // nothing. That is the replay signature, and it is reported as such.
  assert.equal(section.consumptions_without_move.count, 1);
  assert.match(section.text, /mark written, confidence unchanged/u);
  assert.match(section.notes.join(" "), /signature of a verdict replaying/u);

  assert.equal(section.human_moves.length, 1);
  const human = section.human_moves[0];
  assert.ok(human);
  assert.equal(human.cause, "human_engrave");
  assert.equal(human.locked, true, "the lock state is reported, never set here");
  assert.match(section.text, /lock now held/u);
});

test("a belief that only a human hand can promote says so, with the ceiling that holds it", async (t) => {
  const vault = await populatedVault("open-brain-mirror-rank-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const section = beliefsSection(await buildMirror(vault.config, vault.root, { now: NOW }));
  const ranked = section.beliefs.map((item) => item.rank);
  assert.deepEqual(ranked, ["law", "active"], "only active and law beliefs are held here");

  const law = section.beliefs[0];
  assert.ok(law);
  assert.equal(law.confidence, 8);
  assert.equal(law.locked, true);
  assert.equal(law.next_rank, undefined, "a law has no next rank to reach");

  const active = section.beliefs[1];
  assert.ok(active);
  assert.equal(active.locked, false);
  assert.ok(active.next_rank);
  assert.equal(active.next_rank.reachable, false);
  assert.equal(active.next_rank.growth_cap, 6.5);
  assert.match(section.text, /door shut: automatic growth stops at 6\.5/u);
  assert.ok(active.quote.length > 0, "every line traces back to real evidence");

  const shadow = uncertainSection(await buildMirror(vault.config, vault.root, { now: NOW }));
  assert.equal(shadow.beliefs.length, 1);
  const demoted = shadow.beliefs[0];
  assert.ok(demoted);
  assert.ok(demoted.demoted_by);
  assert.equal(demoted.demoted_by.cause, "application_corrected");
  assert.equal(demoted.demoted_by.effective, true);
});

test("the render carries no em dash and no en dash", async (t) => {
  const vault = await populatedVault("open-brain-mirror-dashes-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const rendered = await renderMirror(vault.config, vault.root, { now: NOW });
  assert.equal(rendered.text.includes(EM_DASH), false, "no em dash in the mirror output");
  assert.equal(rendered.text.includes(EN_DASH), false, "no en dash in the mirror output");
  assert.equal(/[ \t]+\n/u.test(rendered.text), false, "no trailing whitespace in the mirror output");
  assert.equal(rendered.budget.chars, rendered.text.length);
  assert.ok(rendered.budget.token_estimate > 0);
});

test("the organ report answers on a vault where nothing is armed and nothing exists", async (t) => {
  const vault = await disarmedVault("open-brain-mirror-organs-");
  t.after(async () => rm(vault.root, { recursive: true, force: true }));

  const organs = await buildOrganReport(vault.config, vault.root);
  assert.equal(organs.belief_store_present, false);
  assert.equal(organs.layer_inactive, true);
  assert.equal(organs.organs_absent, 4);
  assert.equal(organs.organs_built, LEARNING_ORGANS.length - 4);
  assert.deepEqual(organs.rules_armed, [
    "sterile_route",
    "belief_corrected",
    "belief_confirmed",
    "dead_output",
  ]);
  assert.equal(organs.rules_total, 7);
  assert.deepEqual(
    organs.capabilities.map((capability) => capability.enabled),
    [false, false, false],
  );
});
