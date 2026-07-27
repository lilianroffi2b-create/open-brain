# OpenBrain onboarding

OpenBrain is usable before onboarding finishes. Run these five layers in order, one at a time. After each layer, confirm what you recorded and let the user stop, skip, or continue. Never infer consent from silence.

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

## Layer 5: Capabilities

Goal: let the user decide what this vault is allowed to do. This is the only layer that changes what OpenBrain may read, write, or spend, so it is the one layer where the rules below are absolute.

Every capability ships whole and disarmed. A vault that finishes onboarding with nothing armed is a working vault, and a user who reads a framing and says no is a success, not a failure.

Four rules, in this order:

1. **Frame, then ask.** Run `open-brain capabilities explain <name>` and recite what it prints: what the capability does, what it reads, what it writes, what it costs, the risk of arming it, and how to turn it off. Recite it, do not summarize away the cost or the risk. The framing always comes before the answer, never after.
2. **Ask, do not push.** Ask a plain question and wait. No recommendation, no default, no leading phrasing. Silence, a skipped question, or a change of subject is a no.
3. **One at a time.** Explain one capability, ask about it, then move to the next. Never explain all seven in one message: that pours seven framings into the conversation and nobody reads the seventh.
4. **Arm only with the command.** `open-brain capabilities enable <name>` is the only way anything is armed, and it runs after the framing and after an explicit yes. Show the `writes` it prints back, so the user sees exactly what changed.

Ask in this order, from the least engaging to the most:

1. `hooks`, wire OpenBrain into the events of the host CLI. Local, free.
2. `capture`, fill the staging area with candidates. Local, free. If the user declined hooks, say that capture then works in manual mode: nothing triggers it on its own, and it applies only to what the user or a command puts through it.
3. `learning`, the decision journal and sensors. Observational, it concludes nothing.
4. `learning.evaluate`, score beliefs and move their confidence. **Do not ask this one if `learning` was declined.** Say why it is not being offered: it reads a journal that would not exist.
5. `transcripts`, read session transcripts. **A yes is not enough.** Say before the answer that consent is per directory, then ask which directory, then arm with `open-brain capabilities enable transcripts --path <directory>`. Without a named directory, nothing is armed.
6. `classifier`, ask a model to classify staged candidates. **Say the cost before the answer:** it is the only capability that spends money, the cap is `capabilities.classifier.daily_call_budget` at 25 calls per day by default, `open-brain capabilities list` prints the cap in force, and `open-brain classify --dry-run` prints what would be sent before a single call is made.
7. `learning.consolidate`, delete beliefs that lost their support. **Do not ask this one unless `learning.evaluate` is armed, and never propose it on your own initiative.** Arm it only when the user asks for it in their own words, and only with `open-brain capabilities enable learning.consolidate --confirm "enable learning.consolidate"`. It is the only capability that deletes, no preset arms it, and no global `--yes` arms it.

Finish by showing `open-brain capabilities list`, and say that `open-brain capabilities disable <name>` turns any of them off immediately, taking its children with it.

Onboarding is complete. Tell the user they can rerun any layer at any time, and that Layer 5 also runs on its own with `open-brain onboarding --interactive`.
