---
lifecycle: reference
---

# Codex integration

## What gets written

`open-brain hooks install --target codex` writes `.codex/hooks.json` inside the
vault. Unlike Claude Code, Codex keeps its hooks in a dedicated file rather than
in a larger settings file, so the document has exactly two root keys,
`description` and `hooks`.

The same merge logic applies: entries are identified by their full command
string, entries Open Brain does not own are preserved, installing twice changes
nothing, and invalid JSON stops everything without a write.

## The entries

| Event | Matcher | Command | Timeout |
|---|---|---|---|
| `SessionStart` | `^(?:startup\|resume\|clear\|compact)$` | `open-brain hook session-start` | 5 s |
| `UserPromptSubmit` | none | `open-brain hook user-prompt-submit` | 5 s |
| `PreToolUse` | `^(?:Bash\|exec_command\|exec\|apply_patch\|Edit\|Write)$` | `open-brain hook pre-tool-use` | 5 s |
| `PostToolUse` | `^(?:apply_patch\|Edit\|Write)$` | `open-brain hook post-tool-use` | 5 s |
| `Stop` | none | `open-brain hook stop` | 5 s |
| `PreCompact` | `^(?:auto\|manual)$` | `open-brain hook pre-compact` | 5 s |

Matchers here are real regular expressions and they are anchored. An unanchored
alternation would match far more tools than intended, and a `PostToolUse` hook
that fires on every `Bash` call is a hook that gets uninstalled.

Every entry carries a timeout, which Codex requires, and a status message, which
it displays while the hook runs. No entry is marked `async`.

## One entry point, two hosts

The same command serves both hosts and nothing branches on an environment
variable or a flag. The harness is recognised from the shape of the payload:

- **`turn_id` present** means Codex. It has to be a non-empty string of at most
  256 characters with no space in it.
- **`turn_id` absent** means Claude Code.

This matters because `$CLAUDE_PROJECT_DIR` does not exist here. Every hook
resolves the vault from the payload's working directory first and treats that
variable as a fallback only, which is exactly why the same code runs unchanged
under both hosts.

## What Codex has that Claude Code does not

- **`turn_id`.** A stable identity for the current turn, which is what makes
  per-turn precision possible at all.
- **`apply_patch`, `exec`, `exec_command`.** `apply_patch` is how Codex writes,
  edits, moves, and deletes files, and its textual patch format is parsed into
  the same normalized list of file changes as `Write` and `Edit`, so a rule
  written once applies on both hosts. A `*** Move to:` line makes a file new at
  its destination even when its content is old.
- **A timeout and a status message per entry.**

## What Codex does not have

- **No `$CLAUDE_PROJECT_DIR`.** See above.
- **No status line.** There is no equivalent in `hooks.json`.
- **No inline shell hooks.** Codex runs the configured command and nothing else,
  which is a constraint Open Brain would have adopted anyway.
- **No `SessionEnd`.** Open Brain registers none, on either host.

## The one place the output form branches

Codex expresses a stop block as `{"decision":"block","reason":"..."}` on stdout
with exit 0. Claude Code expresses it as exit 2 with the message on stderr. Both
are native, both are correct, and Open Brain uses each host's own form rather
than forcing one contract on both: flattening them would throw away the
mechanism of whichever host lost the vote.

The branch is decided from the payload, on `turn_id`, in the one function that
knows any output shape. Handlers return an abstract outcome and never write JSON
by hand, so there is exactly one place to look when a host changes its mind.

Every other event has a single form on both hosts: the `additionalContext`
envelope for injected context, `permissionDecision: deny` for a pre-effect
refusal, and `{"decision":"block","reason":"..."}` for a post-effect block.

`open-brain hooks status` prints this difference alongside the rest.
