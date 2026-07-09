---
name: openbrain-onboarding
description: Start or resume the OpenBrain conversational onboarding flow.
---

# OpenBrain onboarding

Read `prompts/onboarding.md` from the current vault and follow its four layers in order, one at a time: (1) identity, (2) working style, which seeds preferences with `open-brain prefs add`, (3) vault context, and (4) current work. After each layer, confirm what you recorded and let the user stop, skip, or continue.

Do not infer consent from a skipped question. In particular, leave `interaction.free_mode` set to `off` unless the user explicitly selects Calibrated Free Mode during the working-style layer.
