# Architecture

## Design Goal

Agent Engineering Harness turns an unconstrained repository task into a bounded, evidence-backed execution lifecycle. It does not replace tests, code review, CI, or operating-system isolation; it coordinates and verifies them.

## Control Flow

1. `task.mjs` extracts intent, file mentions, domain terms, and risk hints.
2. `indexer.mjs` and `source-authority.mjs` identify repository files, ownership, tests, imports, and the authoritative source root.
3. `context-builder.mjs` ranks active source above reference, historical, duplicate, and generated content.
4. `impact-analyzer.mjs` identifies direct targets, reverse dependencies, risk signals, and required synchronization domains.
5. `validation-planner.mjs` maps impact and L1-L4 risk to available checks.
6. `session-binding.mjs` binds a write lease to the task fingerprint, session fingerprint, branch, commit, expiry, baseline, and allowed scope.
7. Codex Hooks apply the lease before tools run, inspect visible side effects after tools run, and deny stopping before required closeout.
8. `guard.mjs` compares worktree changes with the plan and checks protected boundaries.
9. `validator.mjs` executes the planned validation graph through structured commands without shell interpolation.
10. `closeout.mjs` performs Guard, validation, a second Guard, reporting, metrics, and failure-knowledge handling.
11. `repair.mjs` allows at most the configured number of focused repair rounds.

## Trust Boundaries

- **Repository configuration:** trusted policy input; review changes like code.
- **Task and agent output:** untrusted until scoped and validated.
- **Tool commands:** constrained by Hook parsing and execution policy, but not physically isolated.
- **Git worktree:** evidence source for Guard; non-Git side effects may require additional monitoring.
- **External providers:** credentials and raw payloads must remain outside tracked reports.
- **Docker sandbox:** optional stronger isolation for command execution, still not a substitute for host hardening.

## State Model

Tracked configuration belongs in `.harness/*.json`, `.codex/`, and project rules. Generated state belongs in `.harness/runs`, `.harness/state`, `.harness/cache`, `.harness/security`, and failure logs; these paths must remain ignored.

Run manifests use schema-versioned artifacts and progress through planned, guarded, validated, reported, complete, failed, or blocked states. Commits are denied until the active session-bound run is complete.

## Extensibility

Repository adoption is configuration-first:

- source authority and readiness markers;
- active/reference/historical/generated path groups;
- risk patterns and forbidden paths;
- explicit validation capabilities;
- reviewed project rules.

The bundled task vocabulary and synchronization domains include generic web, API, storage, model-runtime, and narrative-system concepts. Projects can extend these modules or contribute a future external domain-pack interface.
