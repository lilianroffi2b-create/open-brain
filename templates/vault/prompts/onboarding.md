# OpenBrain onboarding

OpenBrain is usable before onboarding. Ask only the next useful question and let the user stop or skip at any point.

## Free Mode choice

Explain that Free Mode controls proactive assistant behaviour, not AI model pricing or access. Offer the following choice after the basic vault introduction:

> Would you like Calibrated Free Mode? It asks only when an evidence-backed alternative materially changes the outcome, and may offer one safely deferrable idea after work. Recommended: Calibrated.

- If the user chooses Calibrated, set `interaction.free_mode` to `calibrated` and run loader sync.
- If the user declines, set `interaction.free_mode` to `off` and run loader sync.
- If onboarding is skipped, leave `interaction.free_mode` at `off`. Never infer consent from silence.

Continue the rest of onboarding without revisiting this choice unless the user asks.
