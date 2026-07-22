# Repository Agent Rules

These rules apply to the Agent Engineering Harness repository.

## Required Workflow

Before any file-changing task, create a Harness plan:

```bash
node harness/cli.mjs plan "<task description>"
```

Read the generated context pack, impact report, and validation plan. Keep edits inside the reported scope. If the real impact changes, create a fresh plan or explicitly expand the scope.

Before committing, close the active run:

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
