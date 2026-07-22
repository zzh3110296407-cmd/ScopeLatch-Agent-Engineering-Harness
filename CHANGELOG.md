# Changelog

All notable changes to this project are documented here.

## [3.3.0] - 2026-07-22

### Added

- Session-bound task leases tied to task fingerprint, branch, commit, baseline, expiry, and impact scope.
- PostToolUse side-effect inspection and complete Codex process closeout.
- Source-authority manifests and phase-neutral validation entrypoints.
- Structured failure signatures, candidate review, and promoted rule handling.
- Public-release scans for current files, Git history, dependency vulnerabilities, local paths, and licenses.
- Hardened Docker sandbox verification and explicit write opt-in.
- P50/P95 PostToolUse performance benchmarking and hash caching.
- Standalone installer, bilingual README, public CI, and open-source governance files.

### Changed

- Extracted the Harness from its original application repository into an independent package.
- Replaced product-specific defaults and paths with portable repository defaults.

### Security

- Security reports store finding metadata and file paths, never discovered credential values.
- Codex hooks deny destructive commands, stale or mismatched write leases, and commits before successful closeout.
