---
name: openbrain-sync
description: The human gate of Open Brain. Classifies the staging area, prepares an immutable batch, has the user approve items one by one, and applies only what was approved.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, AskUserQuestion, Agent, Bash(open-brain sync:*), Bash(open-brain staging:*), Bash(open-brain classify:*)
---

# Open Brain sync

This skill is the only path from the staging area to the preference ledger and
to memory notes. No direct call to `open-brain prefs`, no direct write to
`_ledger.json`, `_core.md` or `10_memory/notes/` is allowed from here. The gate
is deterministic and identical on every host: the same commands, the same
immutable batch, the same item by item validation, the same idempotent apply.

**Never run this yourself.** It is started by the user and by nobody else. The
front matter says so and the CLI does not care who is asking: nothing is written
without the approval step below.

## 1. The token gate

Run this first, before invoking any classifier:

```
open-brain sync pending
```

If `active_batches` is not empty, **never run the classifier again**. Use `show`
to present a batch in phase `proposed`. Use `resume` for a batch in phase
`needs_resume`, `decision_needs_resume`, `decided`, `applying`, `apply_failed`
or `complete_needs_compact`.

Only if no batch is active, run:

```
open-brain sync staged
```

If `count` is zero, answer exactly `Nothing staged to review.` and stop before
invoking any agent. The command returns a deterministic slice, bounded in both
items and characters, with a `selection_id` and a `remaining_count`. The
classifier receives that slice and nothing else: not the candidates beyond it,
not the ones already proposed.

## 2. Read-only classification

Invoke `openbrain-classifier` explicitly with the full `staged` array. Require
only its strict JSON array. Write that JSON to a scratch file outside the vault
with the Write tool. **Never use `echo`, a heredoc, or shell interpolation for
classified content**: it is data, and a shell would turn quotes, backticks and
`$()` into commands.

`open-brain classify --dry-run` prints what would be sent and what it would
cost before anything is spent. The classifier capability ships disarmed; when it
is off, classify by hand and go straight to `prepare`. That path never costs
anything.

## 3. The immutable batch

```
open-brain sync prepare --input <scratch> --selection <selection_id>
```

Pass back exactly the `selection_id` that `staged` returned. A candidate that
arrives while the classifier is thinking stays staged for the next batch and
does not invalidate the slice you committed to. The gate revalidates everything:
exhaustive coverage of the slice, the evidence threshold, the weights, the
targets, the preconditions and the final contents. It persists the batch and
performs only `staged` to `proposed`. After an interruption:

```
open-brain sync resume --batch <batch_id>
```

Never re-run the classifier for a batch that already exists.

## 4. Presentation and the human gate

```
open-brain sync show --batch <batch_id>
```

Show the numbered items. Each option states exactly the type, the target, the
final content or diff, the weight, the domains, the why, the apply, the
preconditions, the proofs, the evidence basis and the recommendation. Flag the
weak ones. A `reject_only` item is shown as a recorded rejection: it is never
offered as a checkable option and it can never enter the approved list.

The presentation is capped and reports its cost. When it says it truncated,
read the rest with `--from <n>` before deciding. An item nobody read is still an
item being rejected.

The response also carries a `confirmation_token`: keep it. `sync validate`
needs it back, unchanged, to prove this exact batch was actually shown before
anything was approved.

Use AskUserQuestion in multi-selection mode, four items maximum per question. A
checked option is approved. **Any unchecked option is rejected.** There is no
abstention. With more than four items, collect the answers over several
questions, then form the global list of indices. This interaction is the
explicit human decision on the batch.

## 5. One single apply

Validate the indices locally: positive integers, unique, within range. Then run
exactly one command, with the batch id, the indices, and the token from step 4
as separate arguments:

```
open-brain sync validate --batch <batch_id> --approve "<indices you approve>" --confirm <confirmation_token> --unattended
```

`--confirm` must be exactly the `confirmation_token` `sync show` returned for
this batch in step 4; retyping it is what proves the batch was read rather than
approved sight unseen. `--unattended` is required here because this command
runs from an agent's shell, which has no terminal on standard input to prove a
human is present; it waives only that one guarantee, never the token, and the
CLI prints a warning on stderr every time it is used. Do not add `--unattended`
to any command this skill does not explicitly show it on.

To reject everything, pass an empty string to `--approve`. The flag has no
default and must always be typed. The gate rechecks every precondition before
the first mutation, freezes the decision, applies the idempotent operations,
moves the candidates through the strict cycle, reindexes once if a note really
reached the vault, then archives a finished batch.

## 6. Report, resume, reversal

Report what was applied, what was rejected, what failed and what remains. A
different selection for a batch that is already decided is refused, by design.

```
open-brain sync pending
open-brain sync show --batch <batch_id>
open-brain sync resume --batch <batch_id>
open-brain sync undo <batch_id> --yes
```

`undo` reverses an applied batch from the record written next to it: the state
of every file before the batch, byte for byte. It does not use git and does not
assume the vault is a repository. It restores only when every file still holds
exactly what the batch left behind, and it refuses with a precise explanation
when something moved since. The batch itself stays on record as applied and then
reversed: the files go back, the history does not.
