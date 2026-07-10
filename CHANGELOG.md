# Changelog

All notable changes to OpenBrain are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.1.0-alpha.2 - 2026-07-10

### Fixed

- Stale shard artifacts are removed when a vault shrinks below the shard threshold, so scans self-heal instead of serving records for deleted files.
- A corrupt or unreadable `vault.config.yml` is surfaced as a CLI warning and a health error instead of silently falling back to defaults.
- Expected CLI errors print a single clean line to stderr without stack frames or a duplicated message.
- Quickstart commands are pinned to the same version so the second command no longer resolves a different published spec.

## 0.1.0-alpha.1 - 2026-07-10

### Added

- Initial public release documentation and release controls.
- Real garbage collection apply mode with archive moves and re-checked guards.
- `route --suggest` command.
- Freshness change detection.
- `prefs add` command with automatic preference core regeneration.
- Free Mode `dismiss`, `check`, and `reset` commands.
- Layered onboarding flow.
- Packaging metadata for npm publishing.

### Fixed

- Delta note rotation.
