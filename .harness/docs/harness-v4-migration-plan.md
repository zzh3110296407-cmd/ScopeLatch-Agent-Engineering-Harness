# Harness v4 Migration Plan

Status: approved for incremental implementation
Authority: `HARNESS_V4_TRUST_CONTRACT.md`
Migration line: v3 development compatibility -> v4 formal authority

## 1. Migration rule

Harness v4 is delivered in ten independently reviewable milestones. A
milestone may start only after its predecessor has:

- a bounded implementation scope;
- an executable negative and positive test set;
- an independently reproducible report;
- no unresolved blocker in its acceptance criteria; and
- an exact milestone marker.

During migration, v3 remains available for development feedback. Its
`passed` and `passed-or-skipped` outcomes are explicitly provisional and
cannot authorize protected merge, release, or a v4 formal attestation.

## 2. Dependency graph

```text
H0 Trust contract and adversarial baseline
 |
 v
H1 Fail-closed outcomes and complete required-check execution
 |
 v
H2 Content-addressed evidence graph
 |
 v
H3 Exact Git candidate and delivery binding
 |
 v
H4 Executable invariant catalog and deterministic planner
 |
 v
H5 Independent read-only auditor
 |
 v
H6 Concurrent-run isolation, leases, CAS and recovery
 |
 v
H7 Safe structured executor and toolchain/network policy
 |
 v
H8 CI shadow operation and adversarial qualification
 |
 v
H9 Formal cutover and v3 adjudicator retirement
```

## 3. Milestones

### H0 — Trust contract and red baseline

Deliver:

- the versioned trust contract;
- this migration plan;
- a machine-readable adversarial catalog;
- an executable v4 target red suite;
- a deterministic baseline test; and
- a bounded tracked baseline report.

Acceptance:

- every executable H0 adversarial case is observed against v3;
- target failures are catalogued rather than hidden;
- the ordinary Harness test suite remains green;
- the report is derived from file hashes and observed red-suite output; and
- marker `HARNESS_V4_H0_TRUST_CONTRACT_BASELINE: PASS` is reproducible.

Rollback:

- remove only the six H0 artifacts; v3 runtime behavior is unchanged.

### H1 — Fail-closed outcomes

Deliver:

- a closed check/result state machine;
- strict plan and graph validation;
- required-unavailable and zero-applicable-check blocking;
- required synchronization checks compiled into the graph; and
- development verdicts separated from formal verdicts.

Acceptance:

- H0 cases `empty-plan-blocked`, `required-unavailable-blocked`,
  `optional-failure-not-formal-pass`,
  `missing-required-graph-node-blocked`, and
  `required-sync-checks-compiled` pass;
- no `skipped` or `passed-or-skipped` result is formal eligible; and
- legacy callers receive an explicit provisional projection.

Rollback:

- switch callers to the v3 compatibility adapter; formal issuance remains
  disabled.

### H2 — Content-addressed evidence graph

Deliver:

- canonical JSON and closed artifact schemas;
- content-addressed artifacts and parent links;
- plan, impact, source-authority, engine, policy, command and result digests;
- cross-run artifact rejection; and
- tamper detection before aggregation.

Acceptance:

- all H0 tamper and cross-run probes pass;
- unknown fields, duplicate IDs, missing parents and digest mismatches block;
- every acceptance claim resolves to concrete `CheckResult` identities.

Rollback:

- retain v4 artifacts read-only; return execution to provisional mode.

### H3 — Exact Git candidate binding

Deliver:

- `CandidateSnapshot`;
- independent worktree/index/tree identities;
- NUL-safe Git observation;
- frozen candidate creation; and
- post-validation delivery-tree equality.

Acceptance:

- Git command failures block;
- staged-index-only changes alter candidate identity;
- Unicode and special paths are observed correctly;
- candidate commit/tree drift invalidates the run; and
- dirty mutable worktrees cannot receive a formal verdict.

Rollback:

- retain candidate artifacts for diagnosis; disable formal attestation.

### H4 — Executable invariant catalog

Deliver:

- one versioned catalog as the applicability authority;
- deterministic trigger and dependency closure;
- required synchronization compilation;
- impacted test selectors as executable nodes or blocking gaps; and
- conservative handling of unknown changed files.

Acceptance:

- planner output is reproducible for identical inputs;
- every required acceptance statement maps to result IDs;
- no handwritten report-only acceptance keys are allowed;
- catalog coverage and orphan checks are machine verified.

Rollback:

- pin the previous trusted catalog; do not fall back to ad hoc formal planning.

### H5 — Independent auditor

Deliver:

- a read-only auditor process/package;
- independent artifact parsing, graph resolution and result aggregation;
- trusted engine/policy/source-authority verification; and
- signed or digest-bound attestation output.

Acceptance:

- executor-written verdicts are ignored;
- auditor recomputation detects all corpus tampering;
- only the auditor can create `LOCAL_ATTESTED`, `FORMAL_PASS`, or
  `FORMAL_EXCEPTION`.

Rollback:

- stop issuing attestations; retain development validation.

### H6 — Concurrent-run isolation and atomic state

Deliver:

- per-task isolated worktrees or immutable candidate workspaces;
- collision-resistant run IDs;
- owner/nonce/TTL/heartbeat leases;
- CAS or transactional mutable state; and
- crash recovery with explicit abort/resume semantics.

Acceptance:

- parallel runs cannot share evidence, ownership or output directories;
- lease acquisition is exclusive;
- no lost updates occur in stress tests;
- `latest-run.json` has no authority.

Rollback:

- serialize formal runs and block new attestations until state is consistent.

### H7 — Safe executor and toolchain policy

Deliver:

- executable-plus-argument command contracts;
- no-shell execution;
- bounded CPU, memory, time, process, output and writable paths;
- minimal environment and secret redaction;
- denied-by-default network policy; and
- validation side-effect enforcement.

Acceptance:

- injection, secret-output, runaway-process and write-boundary probes pass;
- network access requires an explicit invariant policy;
- validators cannot change candidate source bytes.

Rollback:

- disable affected executor profile; never broaden permissions to preserve
  availability.

### H8 — CI shadow and qualification

Deliver:

- CI execution of v4 beside the current workflow;
- operational metrics for coverage, block reasons, reproducibility and cost;
- the full adversarial corpus on every Harness trust-root change; and
- incident/runbook exercises.

Acceptance:

- an agreed shadow window has zero unexplained decision divergence;
- business-code changes trigger relevant formal profiles;
- cold-run and cached-run reproducibility targets are met;
- rollback and compromised-judge drills succeed.

Rollback:

- stop promotion decisions from v4 while preserving shadow evidence.

### H9 — Formal cutover

Deliver:

- protected-branch/release enforcement of trusted v4 attestations;
- v3 read compatibility without v3 adjudication authority;
- operator documentation, ownership and support boundaries; and
- removal schedule for legacy mutable state and status vocabulary.

Acceptance:

- v3 formal-decision usage is zero;
- the delivered tree equals the attested tree;
- production policy rejects absent, stale or invalid v4 attestations;
- marker `HARNESS_V4_FORMAL_CUTOVER: PASS` is independently reproduced.

Rollback:

- pause protected delivery or return to an explicitly provisional workflow;
  never reinstate v3 `passed` as formal proof.

## 4. Compatibility window

| Capability | H0-H4 | H5-H8 | H9 |
|---|---|---|---|
| v3 planning/development feedback | Supported | Supported | Adapter only |
| v3 `passed` display | Provisional label required | Provisional label required | Historical only |
| v4 artifact generation | Incremental | Complete | Required |
| v4 independent attestation | Unavailable | Shadow/local, then CI | Required |
| protected merge/release authority | Existing external controls | External controls plus shadow | v4 attestation |

## 5. Change control

- Contract changes require a new contract version and explicit approval.
- Each milestone starts with a fresh Harness plan naming exact write targets.
- Tests are written or activated before runtime changes.
- A milestone report is reconstructed from observations, never patched from an
  earlier report's acceptance booleans.
- No milestone may weaken a previously green adversarial invariant.
- Repository or validation instability outside the milestone is reported
  separately; it cannot be converted into a milestone success.
