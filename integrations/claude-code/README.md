---
lifecycle: reference
---

# Claude Code integration

## What gets written

`open-brain hooks install --target claude-code` merges its entries into
`.claude/settings.json` inside the vault. That file belongs to you: it can
already hold your own hooks, your status line, your permissions, your
environment variables, and the hooks of other tools. The merge is built around
that fact.

## How the merge behaves

- **Your values win.** Open Brain contributes to `hooks` and to nothing else. A
  `statusLine`, a `model`, a `permissions` block is never overwritten.
- **The command string is the identity of an entry.** Claude Code's format gives
  an entry no id, no name, and no source, so the full command is the only stable
  key available. Comparison collapses whitespace and nothing else: quotes are
  not normalized and variables are not resolved, because a vault path containing
  a space depends on those quotes.
- **Every command Open Brain writes contains `open-brain hook `.** That makes
  ownership an exact predicate rather than a guess, which is what lets a renamed
  or retired hook be cleaned up without ever touching an entry that is not ours.
- **Installing twice changes nothing.** The second run produces byte-identical
  content and writes no file at all. An entry you add between two installs comes
  back untouched.
- **Invalid JSON stops everything.** If the file exists and does not parse, Open
  Brain writes nothing, backs up nothing, and tells you which file and where the
  parse failed. A corrupt settings file is reported, never guessed at.
- **One backup, overwritten.** Before a real change, the previous content goes to
  `.claude/settings.json.bak`. Running install forty times leaves one backup, not
  forty.
- **Writes are atomic.** Content goes to a temporary sibling, is flushed, and
  only then replaces the target, so a crash never leaves a half-written settings
  file. Two concurrent installs are serialized by a lock.

## The entries

| Event | Matcher | Command | Timeout |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | `open-brain hook session-start` | 5 s |
| `UserPromptSubmit` | none | `open-brain hook user-prompt-submit` | 5 s |
| `PreToolUse` | `Write\|Edit\|Bash` | `open-brain hook pre-tool-use` | 5 s |
| `PostToolUse` | `Write\|Edit` | `open-brain hook post-tool-use` | 5 s |
| `Stop` | none | `open-brain hook stop` | 5 s |
| `PreCompact` | `auto\|manual` | `open-brain hook pre-compact` | 5 s |

The declared timeout stays strictly above the internal budget of 2000 ms, so the
internal deadline always fires first and the hook gets to return what it already
has instead of being killed mid-sentence. A test asserts that nesting, because a
timeout that drifts away from the code drifts in silence.

## What Claude Code does not have

- **No turn identifier.** Nothing in a payload says what changed during this
  exact turn, so the stop hook compares modification times instead. That is
  coarser than the Codex path and it can be wrong in both directions: a file
  touched by another process counts, and a change made and reverted within the
  turn does not.
- **No `apply_patch`, `exec`, or `exec_command`.** Those exist only on Codex.

## What is deliberately not ported

- **No inline shell hook.** Open Brain never writes a hook that shells out to
  `jq` or any other system tool. A Node CLI cannot assume what is installed on
  your machine, and Codex forbids it outright.
- **No `SessionEnd` entry.** The end-of-turn ritual lives on `Stop`, which fires
  every turn rather than once at the very end.

## Repair

`open-brain doctor` is the one repair path. It reports wiring that is absent,
partial, or duplicated, and it never touches an entry Open Brain does not own.

## If you edit a command by hand

Changing the text of an Open Brain command breaks the ownership match: the next
install adds the correct entry back and removes yours, because it can no longer
tell your edit apart from a stale entry. Change the behaviour through the vault
configuration instead, or through `OPEN_BRAIN_HOOK_BUDGET_MS` for the time
budget.
