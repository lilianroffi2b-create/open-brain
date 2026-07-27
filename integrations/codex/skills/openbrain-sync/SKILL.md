---
name: openbrain-sync
description: The human gate of Open Brain. Classifies the staging area, prepares an immutable batch, has the user approve items one by one, and applies only what was approved.
disable-model-invocation: true
---

# Open Brain sync

Codex port of the gate. **The logic is not reimplemented here.** The gate is one
CLI, identical on every host: the same commands, the same immutable batch, the
same item by item validation, the same idempotent apply. Only the invocation
syntax and the way the user is asked differ, and both differences are stated
below rather than hidden.

Invoke it with `$openbrain-sync`. On Claude Code the same skill is
`/openbrain-sync`.

This skill is the only path from the staging area to the preference ledger and
to memory notes. No direct call to `open-brain prefs`, no direct write to
`_ledger.json`, `_core.md` or `10_memory/notes/`.

**Never run this yourself.** It is started by the user and by nobody else.

## 1. The token gate

```
open-brain sync pending
```

If `active_batches` is not empty, **never run the classifier again**. Use `show`
for a batch in phase `proposed`. Use `resume` for `needs_resume`,
`decision_needs_resume`, `decided`, `applying`, `apply_failed` or
`complete_needs_compact`.

Only if no batch is active:

```
open-brain sync staged
```

If `count` is zero, answer exactly `Nothing staged to review.` and stop. The
slice is deterministic and bounded; it carries a `selection_id` and a
`remaining_count`. The classifier receives that slice and nothing else.

## 2. Read-only classification

Invoke the `openbrain-classifier` agent explicitly with the full `staged` array.
Require only its strict JSON array. Write it to a scratch file outside the vault
with the file write tool, never with `apply_patch` on a vault path, and **never
with `echo`, a heredoc or shell interpolation**: classified content is data, and
a shell would turn quotes, backticks and `$()` into commands.

`open-brain classify --dry-run` prices the run before anything is spent. The
classifier capability ships disarmed; while it is off, classify by hand and go
straight to `prepare`. That path never costs anything.

## 3. The immutable batch

```
open-brain sync prepare --input <scratch> --selection <selection_id>
```

Pass back exactly the `selection_id` from `staged`. A deposit that lands during
classification joins the next slice and does not invalidate this one. After an
interruption, `open-brain sync resume --batch <batch_id>`. Never re-run the
classifier for a batch that already exists.

## 4. Presentation and the human gate

```
open-brain sync show --batch <batch_id>
```

Show the numbered items with their type, target, final content or diff, weight,
domains, why, apply, preconditions, proofs, evidence basis and recommendation.
Flag the weak ones. A `reject_only` item is shown as a recorded rejection, is
never offered as a checkable option, and can never enter the approved list.

The presentation is capped and reports its cost. When it announces a truncation,
read the rest with `--from <n>` before deciding.

**Codex has no AskUserQuestion.** Ask in plain text instead: list the numbered
items, in groups of at most four, and ask the user to answer with the numbers
they approve. State explicitly, every time, that an item not named is rejected
and that there is no abstention. Then read back the full list of indices you
understood and wait for a confirmation before running anything. That read-back
is what replaces the checkboxes; do not skip it.

## 5. One single apply

```
open-brain sync validate --batch <batch_id> --approve "<indices you approve>"
```

To reject everything, pass an empty string. The flag has no default and must
always be typed. The gate rechecks every precondition before the first mutation,
freezes the decision, applies the idempotent operations, reindexes once if a
note really reached the vault, then archives a finished batch.

## 6. Report, resume, reversal

```
open-brain sync pending
open-brain sync show --batch <batch_id>
open-brain sync resume --batch <batch_id>
open-brain sync undo <batch_id> --yes
```

`undo` reverses an applied batch from the record written next to it: the state
of every file before the batch, byte for byte. It does not use git and does not
assume the vault is a repository. It restores only when every file still holds
exactly what the batch left behind, and refuses with a precise explanation when
something moved since.
