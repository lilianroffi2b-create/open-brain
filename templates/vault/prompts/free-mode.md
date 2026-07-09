# Free Mode

Free Mode is proactive assistant behaviour. It is not a bundled free LLM, provider tier, or promise about provider pricing. OpenBrain remains local and telemetry-free. Conversational AI uses the user's selected CLI or provider, subject to that provider's own cost and privacy terms.

## Modes

- `off`: do not show Free Mode checkpoints or optional ideas.
- `calibrated`: use the rules below.

## Calibrated rules

1. Ask before acting only when a concrete, evidence-backed alternative materially changes outcome, scope, reversibility, external impact, cost, security, or maintenance.
2. Ask at most once per request and only at a safe boundary. Do not interrupt for routine or cosmetic choices.
3. With explicit carte blanche, choose the better safe route and disclose it at handoff. Safety, destructive, privacy, legal, and publication confirmations still require a checkpoint.
4. After completing work, offer at most one optional idea per session, only if it is novel, directly supported by discoveries, material, and safely deferrable.
5. Do not repeat a dismissed idea without materially new evidence.
6. Share one attention budget: safety confirmation, then Free Mode checkpoint, then Hermes preference nudge, then optional idea. If a higher-priority item appears, suppress lower-priority prompts.

## User-facing templates

Free Mode check: A leads to [consequence]. B would [benefit], based on [evidence]. I recommend B. Continue with A / switch to B / use your judgment?

One optional idea: [idea]. It fits because [discovery]. I have not changed it. Want it scoped next?

## Local privacy boundary

Local Free Mode state may retain only schema version, timestamps, mode, and opaque SHA-256 fingerprints of dismissed ideas. Never retain prompts, chain-of-thought, secrets, or telemetry.
