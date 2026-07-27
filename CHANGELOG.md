# Changelog

All notable changes to OpenBrain are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Nothing added below is armed by default. A vault created with `init` still ships with all seven capabilities disarmed; every item below is something you can turn on, not something that started running.

### Added

- Seven optional capabilities (`hooks`, `capture`, `transcripts`, `classifier`, `learning`, `learning.evaluate`, `learning.consolidate`), inspected and armed one at a time with `open-brain capabilities list|explain|enable|disable`, or walked through together with `open-brain onboarding`.
- `open-brain hooks install|uninstall|status` and `open-brain hook <event>`: a single, idempotent entry point that wires OpenBrain into Claude Code and Codex hook events (session start, prompt submit, pre/post tool use, stop, pre-compact), with a documented JSON contract, a 2000ms per-hook time budget, and a manual fallback command for any CLI with no hook mechanism.
- `open-brain guard`: the pre-effect check a `PreToolUse` hook uses to refuse direct writes to the preference ledger and its generated core.
- A second, post-effect layer of tamper evidence for the preference kernel, independent of hooks: every legitimate write is recorded with its provenance, and any content that does not match the last recorded write is detected, not prevented.
- `open-brain capture scan|mine|markers`: deterministic, local extraction of preference and memory candidates from a transcript or from whatever a hook already saw, behind a documented marker pre-filter.
- `open-brain transcripts scan|show|purge`: reads session transcripts only from directories named through `capabilities enable transcripts --path`, consent per path and never global, with redaction on by default and a documented list of what it covers and what it does not.
- `open-brain classify [--dry-run]`: sends staged candidates to a model for typing and scoring, capped by a daily call budget, and prices a run before it can ever spend one. The only capability that spends money or sends anything off the machine.
- `open-brain staging list|show|add|drop|compact|status` and `open-brain sync pending|staged|prepare|show|resume|validate|apply|undo`: the human gate between anything staged and the preference kernel. `sync validate` (alias `sync apply`) is the only path from that gate into the kernel; `prefs add` is a second, deliberate door, for a preference you state yourself, and both demand the same proof that a human is present. `sync undo` reverses an applied batch from a record written before the batch and sealed after it, not from git; it works on a vault that is not a git repository at all.
- `open-brain learn status|mirror|journal|sensors|evaluate|beliefs|rollback|consolidate`: a decision journal, sensors, an evaluator, and a belief store, gated behind `learning`, `learning.evaluate`, and `learning.consolidate`. Four organs the layer would need to act on its own (an inferrer, a metabolism, a voice, and generalized consolidation) are not built, and three evaluation rules are measured but disarmed by contract, never moving a confidence. `open-brain learn mirror` names all of this itself, every time it runs.
- A folder named in a route's `read_order` is now served by that folder's `_index.md` before any file inside it, including files the same route names one by one. The index is the only document that can say which of its neighbours answers the question; ranking it under them spent the reading budget on whichever file happened to match a word.
- `open-brain health` now audits the reading path, not just index integrity: folders holding documents with no `_index.md`, index links that resolve to no file and no folder, indexed folders their parent index never mentions, and vault layers no route can reach. A well-formed catalog says nothing about whether a reader can arrive anywhere, and both failures survive every check that came before. They are reported as warnings, never as a broken vault, and `status` does not run the audit, so session start costs exactly what it did.
- `PARITY.md`: a frozen, dated reference to the private engine this project owes a capability debt to, so a comparison against it stays a finite, answerable question instead of a moving target.
- Per-host integration references documenting exactly what gets written to `.claude/settings.json` and `.codex/hooks.json`, the merge rules that protect entries OpenBrain does not own, and where Claude Code and Codex differ.

### Changed

- `prefs add` now requires `--quote` and accepts `--domains`, `--why`, `--apply`, and `--source`. `staging add` has always demanded a citation, and every batch reaching the kernel through `sync validate` carries the proofs its candidates were staged with; the direct door was the only one that accepted a preference governing every turn with nothing behind it. Scripts that call `prefs add` need the flag added.
- The parity reference moved from snapshot `2026-07-a` to `2026-07-b` (2026-07-27). What the recapture adds to the comparison: a folder entry in a reading route resolved through the folder's index, and a stated preference entering the kernel at the weight it was stated with, carrying the citation that justified it. One difference is recorded as deliberate rather than closed, in PARITY.md: an explicitly stated preference does not close a staged candidate for the same rule here, because the gate is where that decision belongs.
- README now lists the full command surface in one table, grouped by area, instead of leaving about half of it reachable only through `--help`.
- README states plainly that the package installs and runs as the `open-brain` binary.
- PRIVACY.md expanded substantially: what session-transcript reading covers, where, under what consent, exactly what redaction does and does not catch, how to turn it off, and how to erase everything derived from it.

## 0.1.0-alpha.2 - 2026-07-10

### Fixed

- Stale shard artifacts are removed when a vault shrinks below the shard threshold, so scans self-heal instead of serving records for deleted files.
- A corrupt or unreadable `vault.config.yml` is surfaced as a CLI warning and a health error instead of silently falling back to defaults.
- Expected CLI errors print a single clean line to stderr without stack frames or a duplicated message.
- Quickstart commands are pinned to the same version so the second command no longer resolves a different published spec.

## 0.1.0-alpha.1 - 2026-07-10

### Added

- Initial public release documentation and release controls.
- Real garbage collection apply mode with archive moves and re-checked guards.
- `route --suggest` command.
- Freshness change detection.
- `prefs add` command with automatic preference core regeneration.
- Free Mode `dismiss`, `check`, and `reset` commands.
- Layered onboarding flow.
- Packaging metadata for npm publishing.

### Fixed

- Delta note rotation.
