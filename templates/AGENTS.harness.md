# Repository Agent Rules

## Required Harness Workflow

Use Harness before any task that creates, edits, deletes, moves, or regenerates repository files. Read-only inspection and explanation do not require a plan.

```bash
node harness/cli.mjs plan "<task description with every intended repository-relative write path>"
```

Read the generated context pack, impact report, and validation plan before editing. Must Read files, direct targets, reverse dependents, and impacted tests are read/validation context only. Edit only `impact-report.json.writeTargets`. If another file is required, create a fresh plan that names its exact path; do not expand an active run.

The Stop Hook automatically performs Guard, validation, a second Guard, and the PR report. Before committing, confirm the run is closed; without hooks, close it manually:

```bash
node harness/cli.mjs closeout --run .harness/runs/<run>
```

Do not bypass failed Guards, delete tests to make validation pass, commit runtime state, or expose credentials. If a required check is unavailable, report the exact check and reason.

For public releases, run:

```bash
node harness/cli.mjs security --profile public-release
```

Harness is a repository control plane, not an operating-system sandbox. Use the hardened container for untrusted commands:

```bash
node harness/cli.mjs sandbox --verify --build
node harness/cli.mjs sandbox --build -- <command> [args...]
```
