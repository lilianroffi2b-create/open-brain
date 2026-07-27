# Privacy

## Local by design

OpenBrain is a local command-line tool. It does not run a hosted backend, require an OpenBrain account, or send product telemetry.

Your vault stays in the location you choose. OpenBrain cannot make a selected AI assistant, operating system, Git host, package registry, or model provider private. Those services have their own terms, pricing, retention, and data-handling practices.

A new vault ships with every optional capability disarmed. With nothing armed, OpenBrain reads nothing outside the vault root and sends nothing anywhere, but commands you run yourself still write: `open-brain prefs add`, `open-brain staging add`, `open-brain sync`, `open-brain gc --apply`, and others take effect on a disarmed vault, because a capability gates what Open Brain does on its own, never what you explicitly ask it to do. Everything below describes what changes once you arm something, one capability at a time, and how to check or undo that choice.

## Capabilities and what each one can see

| Capability | Reads | Sends off this machine |
|---|---|---|
| `hooks` | This vault only: its index, living state, routing table, and preference core. | Nothing. |
| `capture` | The vault, plus a transcript directory only if you have separately consented to it through `transcripts`. | Nothing. |
| `transcripts` | Files under the directories you name in `capabilities.transcripts.roots`. The only capability that reads outside the vault root, and it reads nothing until a directory is named. | Nothing. It reads from disk and writes derived candidates back into the vault; it never contacts a network. |
| `classifier` | Staged candidates already in the vault. Never a transcript directly, never the preference kernel. | The text of the staged candidates it is given. It writes that text to a workspace outside the vault and hands it to your host CLI's own model call rather than sending it itself; see below for why. |
| `learning` | The vault's own artifacts: index, routing decisions, preference ledger, living state. | Nothing. |
| `learning.evaluate` | The decision journal, the sensor readings, and the belief store, all inside the vault. | Nothing. |
| `learning.consolidate` | The document you name, its own archive, and Open Brain's record of the last write it made to that document. | Nothing. It moves the overflow into that document's archive rather than sending it anywhere. |

Run `open-brain capabilities list` to see what is armed in a given vault, and `open-brain capabilities explain <name>` to read any one of these in full before arming it.

## Session transcripts

This is the most privacy-sensitive capability in OpenBrain, because a session transcript is the densest concentration of secrets a developer machine produces.

**What is read.** The session transcript files your AI CLI writes to disk: full conversation turns, tool calls, and their output, exactly as your host CLI recorded them.

**Where.** Only under directories listed in `capabilities.transcripts.roots`, which normally sit outside the vault. Nothing is read until at least one directory is named there.

**Under what consent.** Consent is per path, never global. Naming a directory happens explicitly, with `open-brain capabilities enable transcripts --path <directory>` (comma-separated for more than one), never as a side effect of arming another capability. `open-brain transcripts scan` lists the files inside the directories you consented to without reading their content; `open-brain transcripts show --transcript <file>` reads a bounded, capped sample of one file so you can inspect it directly.

**When.** On demand, through `open-brain transcripts scan` and `open-brain transcripts show`, or through `open-brain capture scan` when the `capture` capability is also armed and reads from a transcript you consented to. Nothing is read automatically on a schedule.

**What redaction covers.** Redaction is on by default whenever a transcript is read or its content is staged. It recognises and replaces:

- PEM private key blocks, from the BEGIN line to the END line.
- JSON web tokens, recognised by their three dot-separated segments after `eyJ`.
- Vendor API keys with a fixed prefix: `sk-` and `pk-` keys, GitHub `gh*_` tokens, AWS `AKIA` identifiers, Slack `xox*-` tokens, Google `AIza` keys, `npm_` tokens, and `Bearer` values in an authorization header.
- Assignments whose left side names a secret: `key`, `api_key`, `access_key`, `secret`, `client_secret`, `token`, `auth_token`, `password`, `passwd`, `pwd`, `authorization`.
- Email addresses.
- The user name segment of a home directory path, on Unix and on Windows. The rest of the path is kept, because a path without its owner is still useful and no longer identifies anyone.

**What redaction does NOT cover.** It is a filter, not a guarantee, and it recognises shapes, not meaning:

- Secrets with no recognisable shape: a password typed as a sentence, an internal hostname, a database connection string with an unusual scheme.
- Names of people, companies, clients, and projects. A transcript is full of them and no pattern can tell them from any other word.
- Source code, file contents, and command output quoted inside a message.
- Internal URLs, IP addresses, phone numbers, postal addresses, and account numbers.
- Anything that is only sensitive in context, which is most of what makes a transcript private.

Read what was actually kept before you trust it: `open-brain transcripts show --transcript <file>` prints the redacted sample, and the same command with `--raw` prints it unredacted so you can compare, at the cost of that unredacted text appearing in your terminal and its scrollback.

**How to disable.** `open-brain capabilities disable transcripts` stops all reading immediately.

**How to erase what was derived.** `open-brain transcripts purge` deletes every candidate ever derived from a transcript, and names which ones, including a candidate you already decided on through `open-brain sync` and that now lives in a monthly archive under `10_memory/staging/archive/`. Add `--include-prompt` to also delete candidates captured from a submitted prompt, `--dry-run` to see the list first, and `--yes` to actually delete.

## What can leave this machine

Of the seven capabilities, exactly one causes anything to leave this machine: `classifier`. OpenBrain has no provider client, no API key, and no network code of its own: when armed, `classifier` writes the text of staged candidates, never a raw transcript and never the preference kernel directly, to a workspace file outside the vault, then hands your host CLI an instruction to read it and classify it with its own model access. The request that actually reaches a provider is the host's, billed under its own terms. Calls are capped by `capabilities.classifier.daily_call_budget` (25 per day by default), and a run stops when the budget is spent.

`open-brain classify --dry-run` shows exactly what would be sent and what it would cost, and makes no call. With `classifier` disarmed, `classify --dry-run` still prices a hypothetical run but the command cannot make a real call at all: the capability is checked before a request is issued, and OpenBrain has no model client of its own to fall back on.

## The preference kernel's tamper evidence

Direct writes to the preference ledger and its generated core are refused before they happen by a pre-effect guard. That guard lives inside a `PreToolUse` hook, so it only exists under a host CLI that has hooks, with the `hooks` capability armed. Under any other CLI, or with hooks disarmed, that guard does not run.

A second, independent layer runs regardless: every legitimate write to the preference kernel is recorded with its provenance (which command wrote it, through which validation path), and any content that does not match the last recorded write is detected. It is not prevented. Nothing here makes the preference kernel impossible to modify by hand; it makes a modification impossible to hide. That record lives under `.open-brain/local/`, outside the indexed vault: it is excluded from the scan and from git by the vault's `.gitignore`, so it never becomes source material and never travels with the vault.

## The learning layer stays local

The learning layer (journal, sensors, evaluator, belief store) reads and writes only inside the vault. No model call, no network call, at any of its three capability levels. Its journal does build a detailed history of your sessions, and if you version your vault in git, that history inherits whatever visibility the repository has: a private local vault stays private, a vault pushed to a shared or public remote publishes the journal along with everything else.

`learning.consolidate` is the one place in OpenBrain that trims a live document rather than only appending to it: it folds the overflow of the document you name, once it passes the ceiling declared in its own front matter, into that document's archive, leaving a pointer behind. It never touches the belief store or a belief's confidence, and it never deletes: the overflow lands in the archive intact. It never arms implicitly, not through a preset, not through `--yes`, not by enabling its parent capability. It is undone with `open-brain learn consolidate --document <path> --restore --confirm <path>`, which restores the document from the archive consolidation moved content into, not from git; the organ is only allowed to run at all once that restoration has been proven byte-exact across seven fixture cases ahead of time. No git repository is required for either direction.

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
