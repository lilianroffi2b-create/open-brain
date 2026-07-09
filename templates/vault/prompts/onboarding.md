# OpenBrain onboarding

OpenBrain is usable before onboarding finishes. Run these four layers in order, one at a time. After each layer, confirm what you recorded and let the user stop, skip, or continue. Never infer consent from silence.

Each layer writes durable memory into the vault, so a later session can resume from wherever the user stopped.

If no index exists yet, run `open-brain scan` first: it initializes the index that `route` and `status` depend on.

## Layer 1: Identity

Goal: know who the user is and how to address them.

Ask, in one short message, for their name or how they want to be addressed, their role or what they work on, and the language they want replies in. Keep it to a few plain questions.

Record the answers in `10_memory/_state.md` under a short "Who" note. Do not invent details the user did not give. Stop here if the user wants to pause.

## Layer 2: Working style

Goal: capture how the user wants the assistant to work, and seed it as durable, weighted preferences.

Ask a few concrete questions: preferred answer length and format, tone, when to ask before acting, and any hard rules. For each clear preference the user states, add it to the ledger with `open-brain prefs add`. Examples:

    open-brain prefs add --id concise-answers --text "Answer briefly, structured, no filler." --weight 4
    open-brain prefs add --id ask-before-destructive --text "Ask before any destructive or external action." --weight 5 --status law
    open-brain prefs add --id plan-before-build --text "Present a short plan and wait for yes before building." --weight 3

Weight runs 1 through 5 and sets importance; weight 4 and 5 preferences become always-on core. Pass `--core` to force a lower-weight preference into the core, or `--status` to set law, active, proposed, probation, or retired. When a preference lands in the core, the assistant regenerates `10_memory/preferences/_core.md` and the loader mirrors automatically.

Free Mode choice: explain that Free Mode controls proactive assistant behaviour, not model pricing or access. Offer:

> Calibrated Free Mode asks only when an evidence-backed alternative materially changes the outcome, and may offer one safely deferrable idea after work. Recommended: Calibrated.

If the user accepts, run `open-brain free-mode on`. If the user declines or skips, leave it off with `open-brain free-mode off`. Stop here if the user wants to pause.

## Layer 3: Vault context

Goal: orient the user in their own vault so they know what goes where.

Briefly describe the canonical folders and what belongs in each:

- `10_memory/`: durable memory, living state, and preferences.
- `20_contexts/`: standing context and reference briefs.
- `40_sources/`: raw material dropped in to ingest later.
- `50_outputs/`: generated deliverables.

Point out that `open-brain route "<request>"` returns the smallest relevant reading route, and `open-brain scan` refreshes the local index after files change. Stop here if the user wants to pause.

## Layer 4: Current work

Goal: record the first continuity handoff so the next session resumes cleanly.

Ask what the user is working on right now: the active goal, the immediate next step, and anything blocking. Write it into `10_memory/_state.md` under "Current work" and "Handoff". This file is read first at the start of every session and updated at the end of a substantive one.

Onboarding is complete. Tell the user they can rerun any layer at any time.
