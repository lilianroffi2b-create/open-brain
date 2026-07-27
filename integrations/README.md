---
lifecycle: reference
---

# Host integrations

Open Brain wires itself into the events of an AI CLI through a single command:

```
open-brain hook <event>
```

The payload arrives as JSON on standard input. One command for every event, on
every host, is what makes the wiring idempotent: the command string is stable
and unique per event, so installing twice can never produce a duplicate, and
you have no script to install or maintain yourself.

This document covers the contract shared by every host. For exactly what gets
written to your host's own configuration file, the merge rules, and the
differences from the other host, read the reference for the one you use:

- [Claude Code integration](claude-code/README.md)
- [Codex integration](codex/README.md)

## The contract

**stdout never carries bare text.** It carries a single line of JSON whose shape
depends on the event, and for one event on the host.

| Event | Output that speaks |
|---|---|
| `session-start` | exit 0, `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` |
| `user-prompt-submit` | exit 0, `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` |
| `pre-tool-use`, refusal | exit 0, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` |
| `post-tool-use`, block | exit 0, `{"decision":"block","reason":"..."}` |
| `stop`, block | `{"decision":"block","reason":"..."}` on Codex, exit 2 with the message on stderr on Claude Code |
| any event, nothing to say | exit 0, empty stdout |

A hook that fails internally exits 0 in silence, because a hook that fails
loudly breaks a session. The one other exit code in this surface is not a hook
event at all: `open-brain hook <name>` with a name it does not recognize exits
2 with a message on stderr before the runtime above ever runs, because a typo
in the event name is a wiring bug worth seeing, not a session worth breaking.

**A refusal and a soft block are not the same thing.** `permissionDecision: deny`
is the host's first-class refusal: the tool call does not happen. Exit 2 is a
soft block that hands text back to the assistant and lets it decide. The guard
uses the first one, because a red line has to stop a call rather than argue with
it.

**Where the hosts differ, Open Brain branches instead of picking a winner.** Stop
is the one event with two native forms; flattening them into one would throw
away the mechanism of whichever host lost the vote.

The event name in the envelope is echoed back from the payload when the host
sends one, so a host that renames an event still gets an envelope it recognises.

## The events

| Event | When it fires | What Open Brain does |
|---|---|---|
| `session-start` | a session opens, resumes, clears, or resumes after compaction | injects the index status and the living state, capped and costed |
| `user-prompt-submit` | you submit a prompt | injects the routing decision, the first files to read, and the preferences of that domain |
| `pre-tool-use` | before a tool runs | delegates to the guard, which either allows in silence or refuses the call outright |
| `post-tool-use` | after a write or an edit | reports a new Markdown file landing outside the canonical layers, or with no lifecycle front matter |
| `stop` | the assistant finishes a turn | reminds you to update the living state when vault content changed and it did not, and enforces the living state's own load cap |
| `pre-compact` | before the session is compacted | extension point for the staging layer; silent until something registers there |

## The living state has a ceiling, and it sets it itself

A continuity file that grows without a ceiling eventually costs more per session
than it saves. Put a `max_load` key in its front matter, in characters, and the
stop hook keeps it under that:

```markdown
---
lifecycle: master
max_load: 26000
---
```

**Nothing is ever deleted.** The overflow is moved, whole sections at a time, to
`90_archive/state/`, and a pointer line naming the archive and the number of
characters moved stays behind in the living state. The archive is published
before the living state is trimmed, so the worst a crash between the two writes
can do is leave the same text in both files. With no `max_load` declared,
nothing happens at all: the engine never picks a ceiling for you.

## Five rules every hook obeys

1. **It never fails loudly.** Every exception is caught and the process exits 0.
   The only deliberate non-zero exit is a soft block.
2. **It has a time budget.** 2000 ms by default, overridable with
   `OPEN_BRAIN_HOOK_BUDGET_MS`. A handler that checks in before the budget runs
   out returns what it has by then; one still running when the budget fires is
   dropped in silence rather than killed mid-sentence. No hook holds a session
   open.
3. **It is never destructive.** No hook deletes anything, rewrites your prose, or
   touches the preference core. The one hook that moves content, the living
   state consolidation above, moves it into the archive and leaves a pointer.
4. **It respects the capability gate.** With `capabilities.hooks` disabled, a
   hook exits 0 before reading a single byte of vault content. Wiring is not
   arming: you can install the wiring and arm it later, or disarm it without
   touching the host settings file.
5. **`hooks status` reports the wiring and `hooks install` repairs it**, on
   both hosts. Running install again adds back anything missing or partial
   without touching an entry Open Brain does not own. `doctor` covers the rest
   of the vault, not the host settings files.

## Cost, and how it is reported

Every hook that injects context is capped and reports what it spent: characters,
estimated tokens, items shown, items total, and whether it truncated. When it
truncates it says so inside the injected text, with a line naming how much was
left out. A user who cannot see that something was hidden cannot correct it.

## What you actually get, per host

| Level | Host | What works | What does not |
|---|---|---|---|
| Full | Claude Code | route injection, session context, lint after writes, end-of-turn handoff, pre-effect guard | detecting what changed during this exact turn: there is no turn identifier |
| Full plus | Codex | everything above, plus per-turn precision through `turn_id` | the status line and inline shell hooks, which have no Codex equivalent |
| Degraded | Gemini CLI, and any CLI with no hook mechanism | nothing automatic | all of it |

**On a CLI with no hooks, nothing runs by itself.** That is stated here rather
than discovered later. Two things remain true there:

- Every hook has a manual equivalent. `open-brain hook session-start` reads a
  payload on stdin and prints its block on stdout, so the same information is
  one command away.
- The generated loader states the ritual in writing: read the living state at
  the start of a session, update it at the end. The mechanism moves from
  guaranteed by the host to asked of the assistant. That is less reliable, and
  it is better than pretending.

## Commands

```
open-brain hooks install [--target claude-code,codex]
open-brain hooks uninstall [--target claude-code,codex]
open-brain hooks status
```

`install` merges Open Brain's entries into the host settings file and leaves
everything else exactly as it was. `uninstall` removes only the entries Open
Brain owns. `status` reports what is wired, what is not, what is wired twice,
and whether the capability is armed.
