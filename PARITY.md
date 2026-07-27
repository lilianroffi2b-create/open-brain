# Parity reference

Open Brain grew out of a private Python engine that its author uses every day. The public
project is not a port of that engine, but it does owe it a debt: whatever the private engine
can do, Open Brain is meant to do as well.

That promise is only checkable if the thing being compared against holds still.

## What the reference is

One named snapshot of the private engine, captured once, with the list of modules that the
comparison covers:

- engine: `lrpm-brain-python`
- snapshot: `2026-07-b`
- date: `2026-07-27`

The snapshot label is opaque on purpose. The reference engine is a private repository, and
publishing one of its revision identifiers here would tie the two together for anyone reading
this file. The label is enough to say which capture a behaviour was compared against, which is
all the reference is for.

The reference lives in code, in `src/core/parity.ts`, as `PARITY_REFERENCE`. It is the single
source of truth, and `open-brain parity` prints it.

## Why it is frozen

A reference that tracks "the private engine as it is today" is not a reference. It moves
faster than the public project can follow, so a gap can never be closed, only reported. Worse,
nobody can tell whether a difference is a real gap or simply a change made yesterday on the
other side.

Freezing the reference makes parity a finite, answerable question: for this commit, on this
date, for these modules, is the capability present in Open Brain or not.

The reference also has nothing to do with implementation. Parity is about capability, not
about matching code, file names, or internal structure. Open Brain is a different program
written in a different language, and it stays free to solve the same problem its own way.

## What it is not

- Not a compatibility guarantee. Open Brain does not read the private engine's files.
- Not a roadmap. A module listed in the reference may be deliberately absent from Open Brain
  when it is private business logic rather than a capability of a brain.
- Not a version number. `captured_by` records the Open Brain version at the moment of the
  capture, and it stays put when Open Brain is released again.

## Where the two engines solve it differently

Parity is about capability, so a capability met by another route is met. One
difference is worth naming, because it looks like a gap and is not:

- When a preference is stated outright while a candidate for the same rule is
  already staged, the reference engine closes that candidate along the direct
  write. Open Brain leaves it staged, where the next `sync` presents it and the
  human decides it there. Both end with one preference and no ghost in the
  staging area; only Open Brain makes the human say so, and the gate is already
  the place where that is said.

## How the reference moves

Moving it is a deliberate act, never a side effect of a build:

1. Confirm that the current reference is fully met, or that every remaining gap is written
   down and accepted.
2. Capture the new commit and date of the private engine, and the module list that the new
   comparison covers.
3. Update `PARITY_REFERENCE` in `src/core/parity.ts` and this document in the same commit.
4. Record the move in `CHANGELOG.md`, with what the new reference adds to the comparison.

A recapture that is not accompanied by both of those edits is a bug: the printed reference and
this page must never disagree.
