# Security Policy

## Supported Version

Security fixes are applied to the latest released minor version. Older snapshots may not receive patches.

## Reporting a Vulnerability

Use GitHub Private Vulnerability Reporting for the repository when available. Do not open a public issue for an unpatched vulnerability or include credentials, exploit payloads, private repository content, or user data in public discussion.

Include the affected version, component, reproduction conditions, impact, and a minimal safe proof of concept. Maintainers will acknowledge the report, validate severity, coordinate a fix, and publish an advisory when appropriate.

## Important Boundary

Harness is not an operating-system sandbox. Hook enforcement depends on supported agent events and trusted repository configuration. Diff Guard detects repository changes visible to Git, while the optional Docker sandbox supplies stronger process isolation for untrusted commands.

Before publishing a fork or release, run:

```bash
node harness/cli.mjs security --profile public-release
```

Security reports intentionally omit discovered secret values. If a real credential is ever committed, revoke it immediately and clean Git history; deleting it only from the latest file is insufficient.
