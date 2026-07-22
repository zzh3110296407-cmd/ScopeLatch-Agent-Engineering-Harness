# Configuration

Harness reads configuration in this order:

1. `.harness/harness.config.json`
2. `harness.config.json`
3. `.harness/harness.config.example.json`

The installer creates `.harness/harness.config.json` and protects it with `.harness/.gitignore`. Keep a reviewed example in version control when teammates need the same policy.

## Essential Settings

### Repository and state

- `repoName`: human-readable repository name.
- `packageManager`: `auto`, `npm`, `pnpm`, `yarn`, or the repository's supported value.
- `outputDir`: run dossiers; normally `.harness/runs`.
- `stateDir`: local leases and session state; normally `.harness/state`.

### Source priority

`context.sourcePriority` controls which files count as authoritative.

- `canonicalSourceRoot`: current source root, usually `.` or `src`.
- `autoDetectCanonicalSource`: when false, use the configured root.
- `authorityManifestPath`: optional formal readiness manifest.
- `requireAuthorityManifest`: fail health checks unless the manifest is valid.
- `activeSourceRoots`: current implementation paths.
- `referenceSourceRoots`: architecture and supporting evidence.
- `historicalPathPatterns`: old versions that should be strongly down-ranked.
- `generatedPathPatterns`: generated evidence that should not become must-read source.

For repositories with multiple competing source versions, adapt [`templates/source-authority.example.json`](../templates/source-authority.example.json), track it as `.harness/source-authority.json`, and declare readiness files plus a validation profile.

### Validation commands

Portable templates start with `auto`. Replace these with explicit repository commands before enforcing closeout:

```json
{
  "commands": {
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "testUnit": "npm run test:unit",
    "testIntegration": "npm run test:integration",
    "testContract": "npm run test:contract",
    "testE2E": "npm run test:e2e",
    "build": "npm run build",
    "generateClient": "none",
    "fullCI": "npm run ci"
  }
}
```

Use `none` only when the capability genuinely does not exist. Harness reports unavailable and skipped checks rather than pretending they passed.

### Change budget

- `maxRepairRounds`: bounded automatic repair count.
- `forbiddenDirs`: paths a normal task must never change.
- `escalateOn`: risk signals that increase review and validation depth.

### Security profiles

- `private-development`: secrets and severe dependency issues block; local paths warn; a root license is optional.
- `public-release`: local paths and missing licensing become blockers, and release-oriented checks apply.

Never weaken scanning to hide a finding. Use placeholders for documentation and test credentials, revoke real leaked credentials, and clean Git history when necessary.

## Configuration Health

Run:

```bash
node harness/cli.mjs status
```

Health checks report source authority, required exclusions, forbidden runtime paths, explicit command coverage, phase-neutral entrypoints, risk rules, and security profile.
