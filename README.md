# OpenBrain

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
npx open-brain@latest init
```

Open the generated vault in your preferred AI CLI, then ask it to start onboarding. The onboarding flow is conversational and can be stopped at any layer.

The package is pre-release software. Check the release notes before relying on it for important work.

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

## Privacy and security

OpenBrain is designed to run locally and does not include product telemetry. See [PRIVACY.md](PRIVACY.md) for the data-handling contract and [SECURITY.md](SECURITY.md) for responsible disclosure guidance.

Do not place credentials, private client material, or personal data in public issues, examples, fixtures, or pull requests.

## Contributing

Contributions must be generic and privacy-safe. In particular, do not import personal vaults, private histories, raw source material, secrets, or copied user prompts. Use synthetic fixtures only.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review process, and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for the external release gates.

## License

OpenBrain is released under the [MIT License](LICENSE). The name and visual identity are covered separately in [BRAND.md](BRAND.md).
