# Contributing to OpenBrain

Thanks for helping make OpenBrain useful without making it invasive.

## Contribution boundary

All contributions must be generic, portable, and privacy-safe. Do not submit:

- personal or customer vaults;
- copied Git history from another project;
- credentials, tokens, private configuration, or local paths;
- raw third-party material without a clear right to redistribute it; or
- copied prompts, transcripts, or hidden instructions from another assistant or product.

Use newly written content and synthetic fixtures. If a test needs realistic data, invent it and make its synthetic nature clear.

## Development setup

Use Node.js 22.14.0 or later. Changes must remain compatible with Node 22 and Node 24.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:golden
npm run audit:package
npm pack --dry-run
```

The golden suite uses synthetic fixtures to protect parity without shipping personal data. The package audit validates the publish allowlist. Before submitting a change, make sure a clean installation of the packed tarball can invoke the CLI.

`bin/cli.js` is no longer committed. Run `npm run build` before using the CLI from a fresh checkout; `npx` and `npm pack` regenerate it automatically through the `prepack` script.

## Pull requests

Keep pull requests focused and describe:

1. the user-visible behavior changed;
2. tests run, including any platform-specific checks;
3. any migration or compatibility impact; and
4. the provenance of new fixtures, examples, or documentation.

Do not combine unrelated cleanup with a behavior change. Maintainers may request a provenance or privacy review before merging.

## Free Mode changes

Free Mode must remain optional, calibrated, and respectful of the shared attention budget. A change must preserve these guarantees:

- no routine interruption for reversible or cosmetic choices;
- no more than one material checkpoint per request;
- no repeated dismissed idea without materially new evidence;
- no Free Mode prompt when the feature is off; and
- no sensitive content in Free Mode state.

Free Mode is proactive assistant behavior, not a model, provider, or free usage tier.

## Code of conduct

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
