# OpenBrain

<p align="center">
  <img src="https://raw.githubusercontent.com/lilianroffi2b-create/open-brain/main/assets/openbrain-hero.png" alt="OpenBrain: the brain is the folder" width="880">
</p>

[![CI](https://github.com/lilianroffi2b-create/open-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/lilianroffi2b-create/open-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenBrain is a local, file-based continuity layer for AI assistants used from a terminal. It creates a portable vault with a living state, lightweight routing, preferences, and loader instructions that work across supported CLI assistants.

OpenBrain is not a hosted service, database, web application, or model provider. Your files remain on your machine and the assistant you choose remains responsible for its own pricing, privacy terms, and data handling.

## What it provides

- A portable folder that acts as the source of continuity for an AI-assisted project.
- A deterministic local CLI for indexing, routing, health checks, updates, and preferences.
- Generated loader blocks for compatible assistants, while preserving each loader's user-owned text.
- An optional Calibrated Free Mode for more deliberate proactive assistance.
- Seven optional capabilities, hooks, capture, transcript reading, model-assisted classification, and a three-part learning layer, every one of them shipped disarmed. See [Everything ships disarmed](#everything-ships-disarmed).

## Quick start

Requirements: Node.js 22.14.0 or later and Git when you want local version history.

The package installs and runs as a single binary, `open-brain`.

```sh
npx @lilian-rpm/open-brain@latest init
npx @lilian-rpm/open-brain@latest scan
```

`scan` builds the index; `status --auto` keeps it fresh afterward.

Open the generated vault in your preferred AI CLI, then ask it to start onboarding. The onboarding flow is conversational and can be stopped at any layer.

The package is pre-release software. Check the release notes before relying on it for important work.

## Commands

Every command below accepts `--root <path>` to target a vault outside the current directory, except `feedback` and `parity`, which do not operate on a vault at all. This table lists the full flag surface; run `open-brain <command> --help` for citty's own rendering of any one of them.

### Vault lifecycle

| Command | What it does |
|---|---|
| `init [target] [--no-git]` | Create a new vault without overwriting existing files. |
| `update` | Replace the copied engine, manifest, and managed loader blocks, and make sure the Free Mode local state matches the config. |
| `doctor [--repair]` | Inspect vault directories, loaders, the redline record, and capability configuration; `--repair` fixes only safe generated wiring. |
| `scan` | Scan the vault and write deterministic local index artifacts. |
| `status [--auto] [--rescan]` | Show vault health, optionally rescanning stale indexes. |
| `health` | Check vault structure, freshness, index integrity, and the preference kernel. |
| `route [<query>] [--suggest] [--min-docs <n>]` | Return the smallest relevant reading route for a request, or propose new routes. |
| `ingest [--batch-id <id>]` | Import supported files from the configured inbox. |
| `gc [--write <path> \| --approve <path> --reviewer <name> \| --apply <path>]` | Propose, approve, or apply safe cleanup. Never deletes outright. |
| `skin <universal\|brain> [--dry-run]` | Apply a portable directory naming preset. |
| `loader-sync` | Synchronize the generated Free Mode block in supported loaders. |
| `feedback` | Print opt-in, safe environment details for a feedback report. |
| `parity [--json]` | Show the frozen parity reference against the private engine. |

### Preferences and Free Mode

`prefs add` and `prefs log` write to the preference kernel directly, so both
demand the same proof of human presence as `sync validate`: standard input has
to be a terminal, or the call has to say `--unattended` and accept the one
guarantee that removes.

| Command | What it does |
|---|---|
| `prefs validate` | Validate the preference ledger without changing it. |
| `prefs add --id <id> --text <text> --weight <1-5> [--status <status>] [--date <date>] [--core] [--operation-id <id>] [--unattended]` | Create a preference; seeds the always-on core when it qualifies. |
| `prefs list [--status <status>] [--domain <domain>] [--min-weight <1-5>] [--stale-days <n>]` | List preferences with deterministic filters. |
| `prefs regen` | Regenerate the preference core and portable loader mirrors from the ledger already on disk. Cannot introduce a preference. |
| `prefs log --id <id> --signal <signal> [--weight <1-5>] [--status <status>] [--date <date>] [--quote <text>] [--operation-id <id>] [--unattended]` | Append evidence to an existing preference. |
| `free-mode on`, `free-mode off` | Enable or disable Calibrated Free Mode. |
| `free-mode status` | Show Free Mode state without exposing fingerprints. |
| `free-mode dismiss <idea>` | Record an idea so it is never proposed again. |
| `free-mode check <idea>` | Check whether an idea was already dismissed. |
| `free-mode reset` | Erase every remembered dismissal. |

### Capabilities and onboarding

Every capability below ships disarmed. See [Everything ships disarmed](#everything-ships-disarmed).

| Command | What it does |
|---|---|
| `onboarding [--interactive] [--dry-run] [--max-chars <n>]` | Frame every capability, then ask, one at a time. Nothing is armed without an explicit yes. |
| `capabilities list` | Show what is armed, what is not, and any configuration that contradicts itself. |
| `capabilities explain <name> [--json] [--max-chars <n>]` | Say what a capability does, reads, writes, costs, risks, and how to turn it off. |
| `capabilities enable <name> [--path <dir>] [--target claude-code,codex] [--provider none\|claude-code-subagent] [--confirm "..."] [--dry-run]` | Arm one capability. |
| `capabilities disable <name> [--dry-run]` | Disarm one capability and everything that depends on it, effective immediately. |

### Hooks and the pre-effect guard

| Command | What it does |
|---|---|
| `hooks install [--target claude-code,codex]` | Register the Open Brain hook entry point with the supported host CLIs. |
| `hooks uninstall [--target claude-code,codex]` | Remove only the entries Open Brain owns. |
| `hooks status` | Report what is wired, what is not, and whether the capability is armed. |
| `hook <event>` | Run one hook event with its JSON payload on stdin. Called by your host CLI, not by you. |
| `guard <tool> [--command <cmd> \| --file <path> \| --patch <text>] [--cwd <dir>]` | Ask the pre-effect guard whether a tool call would write to the preference kernel. |

### Capture, transcripts, and classification

| Command | What it does |
|---|---|
| `capture scan --transcript <file> [--max-messages <n>] [--dry-run]` | Replay capture detection over one transcript and stage what it finds. |
| `capture mine [--since <days>] [--min-occurrences <n>] [--min-sessions <n>] [--max-chars <n>]` | Read only: find corrections that keep coming back across distinct sessions. |
| `capture markers [--test "..."]` | Print the capture pre-filter that is actually in force. |
| `transcripts scan [--max-files <n>] [--max-chars <n>]` | List transcript files inside the directories you consented to. |
| `transcripts show --transcript <file> [--max-messages <n>] [--max-chars <n>] [--raw]` | Read a bounded sample of one consented transcript, redacted by default. |
| `transcripts purge [--include-prompt] [--dry-run] [--yes]` | Delete every candidate ever derived from a transcript, active and archived. |
| `classify [--dry-run] [--max-items <n>] [--max-chars <n>]` | Send staged candidates to a model for typing and scoring. The only command that spends money. |

### The human gate

`sync validate` refuses without proof a human is behind it: standard input has
to be a terminal and `--confirm` has to repeat the `confirmation_token`
`sync show` printed for that batch, or the call has to say `--unattended`,
which waives only the terminal check, never the token.

| Command | What it does |
|---|---|
| `staging list [--status <status>] [--pending] [--include-archived] [--max-chars <n>]` | List staged candidates, capped and with the cost of the listing. |
| `staging show <id> [--max-chars <n>]` | Show one candidate in full. |
| `staging add --quote "<text>" [--signal <signal>] [--source <source>] [--markers <list>] [--context <text>] [--harness <name>] [--session-id <id>] [--operation-id <id>]` | Stage a candidate by hand. Works with no capability armed. |
| `staging drop [--id <ids>] [--status <status>] [--older-than <days>] [--include-archived] [--source <sources>] [--reason <text>] --yes` | Delete active candidates outright. Destructive, needs `--yes`. |
| `staging compact` | Move decided candidates into their monthly archive. |
| `staging status` | Count what is staged and what still awaits a decision. |
| `sync pending` | List the batches that still need a decision. Run this before anything else. |
| `sync staged [--limit <n>] [--max-chars <n>]` | Return the next deterministic slice of staged candidates. |
| `sync prepare --input <path> [--selection <id>] [--max-chars <n>]` | Turn a classification file into an immutable batch waiting for a decision. |
| `sync show --batch <id> [--from <n>] [--max-chars <n>]` | Present a batch item by item; the response carries the `confirmation_token` validate needs back. |
| `sync resume --batch <id>` | Pick a batch back up after an interruption. Never runs a classifier. |
| `sync validate --batch <id> --approve "<numbers>" --confirm <token> [--unattended]` (alias `sync apply`) | Freeze your decision and apply exactly it. The only path from the staging area's sas into the preference kernel. |
| `sync undo <batch> --yes` | Reverse an applied batch from its own record, not from git. |

### Learning layer

Incomplete by design. See [The learning layer is incomplete, and says so](#the-learning-layer-is-incomplete-and-says-so).

| Command | What it does |
|---|---|
| `learn status` | What is armed, what is built, what is absent, and whether the layer is acting. |
| `learn mirror [--json] [--max-chars <n>] [--days <n>]` | What the layer believes, what it decided alone, and what it cannot do. |
| `learn journal [--limit <n>] [--max-chars <n>] [--type <types>] [--session <id>] [--since <ts>] [--until <ts>] [--partitions <n>]` | A bounded read of the decision journal, newest entries first. |
| `learn sensors [--run] [--limit <n>] [--max-chars <n>] [--subject <name>]` | Run one sensor pass. Observes and writes readings; concludes nothing. |
| `learn evaluate [--show] [--consume] [--limit <n>] [--max-chars <n>] [--since <ts>]` | Score decisions against what happened; `--consume` lets the verdicts move belief confidence. |
| `learn beliefs [--id <id>] [--rank <rank>] [--limit <n>] [--max-chars <n>]` | The belief population: rank, confidence, counters, lock, and history. |
| `learn rollback --date <ts> [--id <ids>] [--max-chars <n>] [--apply --confirm <ts>]` | Bring confidences back to a date. Plans first, writes only on a matching confirmation. |
| `learn consolidate --document <path> [--confirm <path>] [--mode strict\|bootstrap\|resume] [--restore]` | The one operation that trims a bounded document, folding its overflow into its archive. Shows its safety catch first. `--restore --confirm <path>` undoes it from the archive, not from git. |

## Preferences engine

OpenBrain tracks working preferences with Hermes, its internal preference engine: a weighted ledger of preferences strengthened over time by evidence-backed nudges rather than one-off overrides. The ledger lives in the vault under `10_memory/preferences/` and is inspected, listed, or regenerated with the `prefs` command.

## Free Mode

Free Mode is an assistant-behavior setting. It is not a bundled LLM, a free model tier, or a promise of free AI usage.

The supported settings are:

```yaml
interaction:
  free_mode: off # or: calibrated
```

`off` suppresses Free Mode prompts. `calibrated` is the recommended onboarding choice and remains deliberately restrained:

- It raises at most one evidence-backed checkpoint at a safe boundary when a concrete alternative materially changes scope, reversibility, external impact, cost, security, or maintenance.
- With clear carte blanche, it chooses the safer route when appropriate and discloses that choice at handoff. Safety, destructive, privacy, legal, and publication confirmations still need a checkpoint.
- It may offer at most one new, material, safely deferrable idea per session after work is complete.
- It does not repeat dismissed ideas without materially new evidence.

Safety confirmations take priority over Free Mode, which takes priority over preference nudges and optional ideas. Routine or cosmetic choices should not interrupt the work.

OpenBrain stores no prompts, private reasoning, secrets, or telemetry for this feature. Its local state is limited to the selected mode, timestamps, and opaque fingerprints that prevent already-dismissed ideas from being repeated. Your selected CLI or model provider may have separate costs, retention, and privacy terms.

`loader-sync` renders one generated Free Mode block into `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, while preserving text outside its managed markers.

### Free Mode: how it actually runs

Calibrated Free Mode is a discipline your AI CLI agent follows, not a runtime engine. OpenBrain does not intercept, gate, or enforce the assistant's behaviour. It ships two things: a generated Free Mode block written into your agent loaders (AGENTS.md, CLAUDE.md, GEMINI.md) that tells the agent when to raise at most one material checkpoint per turn and when it may offer a single optional idea, and a small set of commands the agent uses to stay honest across turns. Before offering an idea the agent runs `open-brain free-mode check "the idea"`; a non-zero exit means you dismissed that idea before, so it stays silent. When you decline an idea, the agent runs `open-brain free-mode dismiss "the idea"` so it is never raised again. All enforcement is the agent choosing to follow the loader block and call these commands; there is no background process.

Local Free Mode state lives in `.open-brain/local/free-mode-state.json` and holds only the mode, timestamps, and opaque SHA-256 fingerprints of dismissed ideas. The raw idea text, your prompts, and any chain-of-thought are never written there. Run `open-brain free-mode reset` to erase every remembered dismissal; turning Free Mode off never deletes this state.

## Everything ships disarmed

A new vault has seven capabilities, and all of them are off. With every capability disarmed, Open Brain reads nothing outside the vault and never spends a cent on its own, but a command you run yourself, `prefs add`, `staging add`, `sync`, `gc --apply`, and others, still writes: a capability gates what Open Brain does unprompted, never what you explicitly ask it to do. Arming one is deliberate: walk through all of them with `open-brain onboarding`, or read and arm one at a time with `open-brain capabilities explain <name>` and `open-brain capabilities enable <name>`.

| Capability | What it does | What it costs |
|---|---|---|
| `hooks` | Wires Open Brain into the events of your AI CLI. | Nothing. No model call, no network call. |
| `capture` | Fills the staging area with preference and memory candidates. | Nothing. Extraction is deterministic and local. |
| `transcripts` | Reads session transcripts from directories you name. | No money, no network. Disk reads, and privacy surface: it is the only capability that reads outside the vault root. |
| `classifier` | Asks a model to classify staged candidates. | Money. The only capability that causes candidate text to leave your machine, handed to your host CLI's own model call. |
| `learning` | Records what Open Brain did and what happened next. | Nothing. Local disk only. |
| `learning.evaluate` | Scores beliefs against what actually happened and moves their confidence. | Nothing. Deterministic, local. |
| `learning.consolidate` | Folds a document you name into its archive once it passes its declared ceiling. | No money. Data: it moves bytes out of the live document, and it never arms implicitly, not through a preset, not through `--yes`, not by enabling its parent. |

`open-brain capabilities list` shows what is armed in a given vault. Disarming a capability with `open-brain capabilities disable <name>` takes effect immediately; it does not delete what the capability already wrote.

## Harness support degrades openly

Open Brain wires itself into a host AI CLI through hooks, and hooks are not the same thing everywhere it runs:

| Level | Host | What works |
|---|---|---|
| Full | Claude Code | Route injection, session context, lint after writes, end-of-turn handoff, the pre-effect guard on the preference kernel. |
| Full plus | Codex | Everything above, plus per-turn precision through a stable `turn_id`. |
| Degraded | Any CLI with no hook mechanism, for example Gemini CLI | Nothing automatic. |

On a CLI with no hooks, nothing runs by itself, and Open Brain says so rather than pretending otherwise. The capabilities that depend on hooks are announced unavailable, and each has a manual command in its place: `open-brain hook session-start` reads the same payload a hook would receive and prints the same block, and the generated loader spells out the ritual (read the living state at the start of a session, update it at the end) as something asked of the assistant instead of guaranteed by the host. See [integrations/README.md](integrations/README.md) for the full hook contract and [integrations/claude-code/README.md](integrations/claude-code/README.md) and [integrations/codex/README.md](integrations/codex/README.md) for exactly what each host does and does not have.

## The preference kernel's protection is detection, not invulnerability

Direct writes to the preference ledger and its generated core are refused before they happen by a pre-effect guard, but that guard lives inside a `PreToolUse` hook. Under a host CLI with no hooks, or with the `hooks` capability disarmed, that guard does not run at all.

A second, independent layer runs after the fact regardless of hooks: every legitimate write to the preference kernel is recorded with its provenance, and any content that does not match the last recorded write is **detected**. It is not prevented. Nothing in Open Brain makes the preference kernel impossible to modify by hand; the second layer makes a modification impossible to hide. That record lives under `.open-brain/local/`, outside the indexed vault, excluded from git, and it never travels with the vault.

## Neither the gate nor consolidation depend on git

`open-brain sync validate` is the only path from the staging area's sas into the preference kernel, and `open-brain sync undo <batch>` reverses a batch it applied. That reversal reads a record written before the batch touched its first file and sealed after the last one, not the vault's git history. It works on a vault that is not a git repository at all, and it refuses rather than overwrite when a file no longer holds exactly the bytes the batch left behind. `open-brain prefs add` is a second, deliberate door into the kernel, for a preference you state yourself rather than one proposed for review, and it demands the same proof that a human is present as `sync validate` does: a terminal on standard input, or `--unattended` said out loud. `open-brain prefs regen` only re-renders the kernel's generated core and loader mirrors from the ledger already on disk; it cannot introduce a preference. Every write to the kernel, through either door, is recorded with its own provenance.

`learning.consolidate`, the belief-deletion operation described above, is undone the same way in spirit: `open-brain learn consolidate --document <path> --restore --confirm <path>` restores the document from the archive consolidation moved content into, not from git. Consolidation is only allowed to run at all once `verifyReversibility` has proven that exact restoration byte for byte, across seven fixture cases covering plain text, same-day entries, accented and emoji content, CRLF line endings, JSONL blocks, and multi-round chains; a proof that fails leaves the organ refusing to run rather than moving anything. Neither mechanism needs a git repository.

## The learning layer is incomplete, and says so

The learning layer observes, scores, and (once `learning.evaluate` is armed and run with `--consume`) moves belief confidence. Four organs it would need to act entirely on its own are not built:

- **An inferrer**, which would infer beliefs nobody stated. No belief of origin `inferred` is ever created; a belief only ever enters from a human statement.
- **A metabolism**, which would retire a belief, a document, or an organ on its own. The only retirement that exists is the slow decay of dormancy, plus an explicit rollback.
- **A voice**, which would build a writing profile from how you actually phrase things. Nothing produces writing patches and nothing consumes them.
- **Generalized consolidation**, which would decide on its own which bounded document to fold. Consolidation only ever runs on a document you name.

Three of the evaluator's rules, `rapid_followup`, `wasted_load`, and `deliverable_shipped`, are measured but disarmed by contract: each answers undetermined and never moves a confidence, because the source data or calibration they would need does not exist yet.

`open-brain learn mirror` names all of this itself, every time it runs, whether or not anything is armed.

## Privacy and security

OpenBrain is designed to run locally and does not include product telemetry. See [PRIVACY.md](PRIVACY.md) for the full data-handling contract, including exactly what session-transcript reading covers and does not cover, and [SECURITY.md](SECURITY.md) for responsible disclosure guidance.

Do not place credentials, private client material, or personal data in public issues, examples, fixtures, or pull requests.

## Contributing

Contributions must be generic and privacy-safe. In particular, do not import personal vaults, private histories, raw source material, secrets, or copied user prompts. Use synthetic fixtures only.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review process, and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for the external release gates.

## License

OpenBrain is released under the [MIT License](LICENSE). The name and visual identity are covered separately in [BRAND.md](BRAND.md).
