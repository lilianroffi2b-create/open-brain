# OpenBrain

[![CI](https://github.com/lilianroffi2b-create/open-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/lilianroffi2b-create/open-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenBrain is a local, file-based continuity layer for AI assistants used from a terminal. It creates a portable vault with a living state, lightweight routing, preferences, and loader instructions that work across supported CLI assistants.

OpenBrain is not a hosted service, database, web application, or model provider. Your files remain on your machine and the assistant you choose remains responsible for its own pricing, privacy terms, and data handling.

## What it provides

- A portable folder that acts as the source of continuity for an AI-assisted project.
- A deterministic local CLI for indexing, routing, health checks, updates, and preferences.
- Generated loader blocks for compatible assistants, while preserving each loader's user-owned text.
- An optional Calibrated Free Mode for more deliberate proactive assistance.

## Quick start

Requirements: Node.js 22.14.0 or later and Git when you want local version history.

```sh
npx @lilian-rpm/open-brain@latest init
open-brain scan
```

`scan` builds the index; `status --auto` keeps it fresh afterward.

Open the generated vault in your preferred AI CLI, then ask it to start onboarding. The onboarding flow is conversational and can be stopped at any layer.

The package is pre-release software. Check the release notes before relying on it for important work.

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

## Privacy and security

OpenBrain is designed to run locally and does not include product telemetry. See [PRIVACY.md](PRIVACY.md) for the data-handling contract and [SECURITY.md](SECURITY.md) for responsible disclosure guidance.

Do not place credentials, private client material, or personal data in public issues, examples, fixtures, or pull requests.

## Contributing

Contributions must be generic and privacy-safe. In particular, do not import personal vaults, private histories, raw source material, secrets, or copied user prompts. Use synthetic fixtures only.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review process, and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for the external release gates.

## License

OpenBrain is released under the [MIT License](LICENSE). The name and visual identity are covered separately in [BRAND.md](BRAND.md).
