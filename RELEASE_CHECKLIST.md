# Release checklist

Every box below is intentionally unchecked. This file records required gates; it does not claim that any external action has been completed.

## 1. Separate the private source

- [ ] Rotate or revoke every credential that may have appeared in prior history, then reset related administrative access outside this repository.
- [ ] Record rotation evidence only in an appropriate private system, never in Git, issues, release notes, fixtures, or logs.
- [ ] Confirm this repository has a newly created history on `main`, with no fork, import, copied commits, or shared remote history.
- [ ] Confirm every tracked file is newly written, generic, synthetic, or redistributable under a verified license.

## 2. Create the private release repository

- [ ] Create the GitHub repository as private before the first push.
- [ ] Enable Issues, Dependabot, secret scanning, and push protection where the plan supports them.
- [ ] Keep Wiki, Discussions, Projects, and Sponsorship disabled initially.
- [ ] Configure noreply commit identity, squash merges, automatic deletion of merged branches, no force pushes, and a protected `main` ruleset requiring CI and package-audit checks.

## 3. Pass the public-boundary audit

- [ ] Run Gitleaks, or an equivalent scanner, against the full new-repository history and working tree.
- [ ] Manually review `git ls-files`, the complete package tarball, fixtures, documentation, and generated files for private names, paths, data, credentials, copied prompts, and third-party material.
- [ ] Verify the package allowlist and `npm pack --dry-run` output contain only intended distributable files.
- [ ] Pass type checking, linting, tests, synthetic golden tests, and clean-install smoke tests on Linux, macOS, and Windows with Node 22 and Node 24.
- [ ] Verify Free Mode behavior: no cosmetic interruption, one material checkpoint, carte-blanche disclosure, no repeated dismissed idea, Off-mode suppression, idempotent loaders, and no sensitive local state.

## 4. Reserve the package name safely

- [ ] Recheck that the intended package name is available immediately before publishing.
- [ ] Make the repository public only after the Phase 0 parity and public-boundary gates pass.
- [ ] Publish a functional `0.1.0-alpha.1` manually with npm two-factor authentication to reserve the name.
- [ ] Inspect the published package and complete a clean-machine installation smoke test.

## 5. Move to trusted publishing

- [ ] Configure npm trusted publishing for the exact GitHub repository and release workflow only after the package exists.
- [ ] Disable token-based publishing after trusted publishing is active.
- [ ] Verify provenance appears on a test release.
- [ ] Publish stable releases only after the full release suite, package inspection, fresh-machine smoke test, and matching GitHub Release are complete.
