# Privacy

## Local by design

OpenBrain is a local command-line tool. It does not run a hosted backend, require an OpenBrain account, or send product telemetry.

Your vault stays in the location you choose. OpenBrain cannot make a selected AI assistant, operating system, Git host, package registry, or model provider private. Those services have their own terms, pricing, retention, and data-handling practices.

## Free Mode local state

When Calibrated Free Mode is enabled, its local state may contain only:

- the selected mode;
- timestamps needed to apply the interaction budget; and
- opaque fingerprints of dismissed ideas so they are not suggested again without materially new evidence.

It must not persist prompts, private reasoning, chain-of-thought, source content, secrets, credentials, or telemetry. An opaque fingerprint is a non-readable marker, not a copy of a prompt or idea.

If onboarding is skipped, Free Mode defaults to `off`.

This state lives at `.open-brain/local/free-mode-state.json` inside the vault. It contains only opaque SHA-256 fingerprints of dismissed ideas, never their raw text, and is excluded from Git by the vault's `.gitignore`. It can be cleared with `open-brain free-mode reset`.

## Your AI provider

OpenBrain coordinates behavior through local files and loader instructions. Conversational AI is supplied by the CLI or provider you select. That provider may charge for usage or process content according to its own terms. Review those terms before opening sensitive files in an AI-enabled environment.

## Public collaboration

Opening an issue, discussion, pull request, or security report is a deliberate external action. Do not include secrets, personal data, private client information, unredacted logs, or vault content in public reports. Use the responsible disclosure path in [SECURITY.md](SECURITY.md) for vulnerabilities.

## Changes to this statement

Material privacy changes will be documented in the changelog and release notes before they are released.
