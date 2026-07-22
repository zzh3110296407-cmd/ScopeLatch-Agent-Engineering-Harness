# Release Checklist

## Repository

- [ ] Version matches `package.json`, `harness/version.json`, `CHANGELOG.md`, and the sandbox image tag.
- [ ] README links and commands work from a fresh clone.
- [ ] No runtime state, local configuration, generated reports, or test caches are tracked.
- [ ] License, NOTICE, SECURITY, and contribution documents are present.

## Verification

- [ ] `npm test`
- [ ] `node harness/cli.mjs status`
- [ ] `node harness/cli.mjs index`
- [ ] `node harness/cli.mjs security --profile public-release`
- [ ] Installer tested against a temporary repository.
- [ ] `node harness/cli.mjs sandbox --verify --build` when Docker is available.
- [ ] GitHub Actions pass on Windows and Linux.

## Security

- [ ] Current-tree secret scan has no blockers.
- [ ] Git-history scan has no blockers.
- [ ] Dependency audit has no high or critical findings.
- [ ] No machine-local paths or private source references remain.
- [ ] Any previously exposed credential has been revoked and removed from history.

## Publication

- [ ] Create the GitHub repository without auto-generating conflicting files.
- [ ] Review the initial diff before the first commit.
- [ ] Push `main` and confirm CI.
- [ ] Enable GitHub Private Vulnerability Reporting.
- [ ] Protect `main` and require the Harness CI check.
- [ ] Create a signed `v3.3.0` tag only after all checks pass.
