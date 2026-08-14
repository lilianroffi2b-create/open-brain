---
name: openbrain-onboarding
description: Start or resume the OpenBrain conversational onboarding flow, including the capability framing that decides what the vault is allowed to do.
---

# OpenBrain onboarding

Read `prompts/onboarding.md` from the current vault and follow its five layers in order, one at a time: (1) identity, (2) working style, which seeds preferences with `open-brain prefs add`, (3) vault context, (4) current work, and (5) capabilities. After each layer, confirm what you recorded and let the user stop, skip, or continue.

Do not infer consent from a skipped question. In particular, leave `interaction.free_mode` set to `off` unless the user explicitly selects Calibrated Free Mode during the working-style layer.

The same walk exists as a terminal command, `open-brain onboarding --interactive`. It asks the same questions in the same order and uses the same wording. Use this skill when the user would rather answer in conversation.

## Layer 5, capabilities

Every capability ships whole and disarmed. This layer is where the user decides what the vault may read, write, and spend, so treat the rules below as absolute.

**Never arm anything you have not framed first.** Run `open-brain capabilities explain <name>` and recite what it prints: what it does, what it reads, what it writes, what it costs, the risk of arming it, and how to turn it off. That output is the single source of truth for the wording. Do not paraphrase it, do not shorten away the cost or the risk, and do not write your own friendlier version.

**Ask, do not push.** Ask a plain question and wait for an answer. No recommendation, no default, no leading phrasing. Silence, a skipped question, or a change of subject is a no. A user who reads the framing and declines is a success.

**One capability at a time.** Explain one, ask about it, then move on. Never explain several in one message, and never run `explain` for all seven at once: the framing is dense on purpose and it is only useful next to the question it belongs to.

**Arm only with the command**, after the framing and after an explicit yes:

    open-brain capabilities enable <name>

Show the `writes` field it prints back so the user sees exactly which keys changed. Nothing else in `00_index/vault.config.yml` is touched.

### Order, and the four questions that are not plain yes or no

Ask in this order: `hooks`, `capture`, `learning`, `learning.evaluate`, `transcripts`, `classifier`, `learning.consolidate`.

- `capture` after a declined `hooks`: still offer it, and say that capture then runs in manual mode. Nothing triggers it on its own; it applies only to what the user or a command puts through it.
- `learning.evaluate`: do not ask it at all if `learning` was declined. Say it is not being offered, and why: it reads a journal that would not exist.
- `transcripts`: say before the answer that consent is per directory and never global. A yes with no directory named arms nothing. Then ask which directory and arm with `open-brain capabilities enable transcripts --path <directory>`. This is the only capability that reads outside the vault.
- `classifier`: say the cost before the answer. It is the only capability that spends money, the cap is `capabilities.classifier.daily_call_budget` at 25 calls per day by default, `open-brain capabilities list` prints the cap in force, and `open-brain classify --dry-run` prints what would be sent before any call is made.
- `learning.consolidate`: do not ask it unless `learning.evaluate` is armed, and **never propose it on your own initiative**. It is the only capability that deletes. Arm it only when the user asks for it in their own words, and only with:

      open-brain capabilities enable learning.consolidate --confirm "enable learning.consolidate"

  No preset arms it, no global `--yes` arms it, and arming `learning` does not arm it. If you are unsure whether the user asked for it, they did not.

### Closing the layer

Show `open-brain capabilities list` so the user sees what ended up armed, and tell them that `open-brain capabilities disable <name>` turns any of them off immediately and takes its children with it.

If the user stops in the middle of this layer, stop. Nothing was armed that you did not arm explicitly, and a vault with every capability disarmed works.
