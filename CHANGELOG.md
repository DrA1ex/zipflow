# Changelog

## 1.3.2 — Phase 1 release hardening

- Pinned all runtime dependencies and added a published `npm-shrinkwrap.json` plus a two-install package verification command.
- Replaced numeric SemVer coercion with exact SemVer parsing and comparison, including prereleases, build metadata, large identifiers, and invalid registry responses.
- Preserved cancelled check operations as cancellations and added scoped operation ownership for Git checkpoints.
- Hardened built-in check filenames and made `cwd :: command` parsing quote-aware and relative-directory-only.
- Preserved existing executable modes when archive entries omit Unix mode metadata.
- Added bounded run-history retention, startup cleanup for orphaned temporary run directories, durable atomic JSON writes, and heartbeat-based project-lock ownership.
- Added `zipflow --version` for package and clean-install smoke tests.
