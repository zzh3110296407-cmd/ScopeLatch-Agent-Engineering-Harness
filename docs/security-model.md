# Security Model

## Assets

- repository source and history;
- credentials and provider configuration;
- validation integrity;
- task scope and user intent;
- generated reports and failure knowledge;
- developer workstation and CI runner.

## Threats Addressed

- stale or unrelated plans authorizing a new task;
- writes outside the reported impact scope;
- branch, commit, or baseline drift;
- destructive shell and Git operations;
- test deletion, runtime-data commits, lockfile drift, and public API/client drift;
- credentials, high-entropy secrets, private keys, machine paths, and missing release licenses;
- high or critical dependency advisories;
- unvalidated completion and commits before closeout.

## Enforcement Layers

1. **PreToolUse:** validates the active lease and rejects recognized dangerous or unscoped operations.
2. **PostToolUse:** compares actual Git-visible side effects with the bound impact report.
3. **Closeout:** runs Guard, planned checks, a second Guard, report generation, and failure handling.
4. **Security scanner:** checks the current tree, optional Git history, dependencies, local paths, and licensing without recording secret values.
5. **Docker sandbox:** optionally runs commands with no network, a read-only workspace, dropped capabilities, no privilege escalation, and resource limits.

## Explicit Non-Guarantees

- Harness is not a kernel or hypervisor boundary.
- Hook matching depends on the agent platform emitting supported tool events.
- Regex and command parsing cannot classify every possible write mechanism.
- Git-based Guard cannot observe side effects outside the repository or changes hidden from its snapshot model.
- Dependency scanners depend on available package-manager tooling and advisory services.
- Context ranking is heuristic and still requires human review for high-risk work.

## Safe Deployment

- Review and trust `.codex/config.toml` before enabling Hooks.
- Protect configuration and workflow changes with code review.
- Keep generated Harness state ignored and private.
- Use least-privilege CI tokens and read-only permissions by default.
- Use the Docker sandbox or stronger isolation for untrusted code.
- Run public-release security scanning before tags or distribution.
- Revoke leaked credentials immediately; do not rely on deleting one file.
