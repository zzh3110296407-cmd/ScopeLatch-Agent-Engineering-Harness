# Repository Agent Rules

These rules apply to the ScopeLatch Agent Engineering Harness repository.

## Required Workflow

Before any file-changing task, create a Harness plan:

```bash
node harness/cli.mjs plan "<task description with every intended repository-relative write path>"
```

Read the generated context pack, impact report, and validation plan. Must Read files, direct targets, reverse dependents, and impacted tests are read/validation context only. Edit only `impact-report.json.writeTargets`. If another file is required, create a fresh plan that names its exact path; do not expand an active run.

The Stop Hook automatically runs Guard, validation, a second Guard, and the PR report. Before committing, confirm the active run is closed; without hooks, close it manually:

```bash
node harness/cli.mjs closeout --run .harness/runs/<run>
```

## Repository Boundaries

- Do not commit `.harness/runs`, `.harness/state`, `.harness/cache`, `.harness/security`, or local Codex configuration.
- Keep the engine, Hook policy, tests, documentation, and CI synchronized.
- Do not weaken Guard, security scanning, session binding, or validation merely to make a check pass.
- Never add real credentials, private keys, machine-local paths, private source snapshots, or generated failure records.
- Preserve compatibility with Windows, Linux, and macOS unless a documented platform limitation applies.

## Validation

Run the focused checks from the active validation plan. For repository-wide changes, run:

```bash
npm test
node harness/cli.mjs status
node harness/cli.mjs security --profile public-release
```

Use the Docker sandbox for untrusted commands. Harness is not an operating-system security boundary.

## Final Report

Report changed files, behavior, risks, validations, skipped checks with reasons, and remaining limitations.
