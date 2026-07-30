# Harness v4 H9 Formal Cutover Specification

Status: implementation installed; formal activation remains fail-closed
Authority: `HARNESS_V4_TRUST_CONTRACT.md` and `harness-v4-migration-plan.md`
Contract lines: `harness-trust-v4.0.0` plus approved
`harness-v4-only-runtime-v1.0.0` cutover
Date: 2026-07-30

## 1. Objective

H9 makes a trusted v4 attestation the only possible proof for protected merge
or release. It does not reinterpret a development result, status-only input,
an externally green workflow, or an H8 shadow observation as formal proof.

The implementation may be installed before all activation prerequisites exist,
but production policy must remain blocked until every prerequisite is
independently observed.

## 2. Non-negotiable decisions

1. Only the independent Auditor may issue `FORMAL_PASS` or
   `FORMAL_EXCEPTION`.
2. A formal decision is bound to one immutable candidate commit and tree. The
   delivered tree must equal the attested tree.
3. H8 must report an independently qualified observation window before formal
   issuance is possible. A deferred H8 window is not a waiver.
4. GitHub protected-branch or release policy must require the trusted formal
   check. Merely creating a green workflow is not enforcement.
5. Harness `4.0.0` is the only active runtime. Status-only evidence and removed
   engine formats are rejected rather than projected through a compatibility
   adapter.
6. Missing, stale, malformed, ambiguous, candidate-controlled, unbound or
   unverifiable evidence is `BLOCKED` or `INVALIDATED`, never PASS.

These decisions restate the approved trust contract; they do not weaken or
replace it.

## 3. Trust and data flow

```text
frozen candidate checkout
        |
        v
trusted v4 planner/executor -> content-addressed evidence
        |                              |
        +------------------------------+
                       |
                       v
independent read-only Auditor
                       |
                       v
closed FORMAL_PASS attestation
                       |
                       v
production verifier checks exact delivery tree + freshness + CI identity
                       |
                       v
externally required protected-branch/release check
```

The candidate branch is the evaluated object, not its own trust root. A
candidate-controlled workflow or Auditor cannot qualify itself.

## 4. Versioned contracts

### 4.1 Formal cutover policy

The tracked policy is closed and versioned. It binds:

- repository identity and default protected branch;
- trusted workflow path, job/check name and provider;
- accepted attestation contract and outcome;
- maximum attestation age;
- exact candidate commit/tree requirements;
- H8 qualification report and policy identities;
- the V4-only engine and outcome contract;
- external enforcement requirement; and
- rollback mode (`provisional-only`).

Runtime input may make policy stricter but cannot weaken a tracked requirement.

### 4.2 Formal CI authority

The Auditor receives a closed authority record containing GitHub repository,
workflow, run ID, run attempt, event, ref, candidate commit/tree, base commit,
protected-base engine digest and observation time. It rejects unknown fields,
unsafe strings, missing identities and mismatches with the frozen candidate.

Environment variables are transport inputs, not proof by themselves. The
Auditor seals the validated authority record into the attestation. External
branch policy supplies the final trust boundary that makes the check required.

### 4.3 Formal attestation

The v4 attestation contains:

- exact run, candidate commit and candidate tree;
- candidate snapshot, plan, policy, source authority, catalog, engine and
  evidence-root digests;
- trusted CI authority digest;
- H8 qualification digest;
- required check and invariant counts;
- outcome and exception references;
- issued and expiry times; and
- independent Auditor identity and attestation digest.

Only `FORMAL_PASS` with no exception references can satisfy an ordinary
protected-delivery requirement.

### 4.4 V4-only runtime

The installed runtime is identified by `harness/version.json` as `4.0.0`.
Validation and process decisions require an explicit V4 `outcome`; status-only
records are contract-invalid. Historical reports remain immutable documents
but have no reader, adapter, writer or adjudication path in the active engine.

## 5. Production verification rules

The production verifier rejects the attestation unless all of these are true:

1. schema, contract and canonical digest are valid;
2. outcome is `FORMAL_PASS`;
3. repository, workflow, job and protected branch match policy;
4. attestation is not expired or future-dated beyond the allowed skew;
5. attested commit/tree equal the delivery commit/tree exactly;
6. candidate, engine, policy, catalog, plan, source-authority and evidence
   digests are present and valid;
7. independent Auditor identity and authority digest match policy;
8. H8 qualification is recomputed from raw sealed observations, is
   `QUALIFIED`, has `eligibleForH9=true`, and is bound by digest;
9. no exception, missing required check, or status-only decision exists; and
10. external enforcement is reported as installed and independently verified.

No "allow missing," "continue on error," report-only Boolean or development
status is accepted at this boundary.

## 6. Workflow requirements

The formal Windows workflow:

- checks out the protected-base Judge separately from the candidate;
- uses pinned Node/Python patch versions and immutable action commit SHAs;
- installs only pinned/locked validation dependencies;
- runs the candidate through the trusted v4 execution and Auditor path;
- verifies the exact delivery commit and tree before publishing;
- uploads one immutable, closed attestation artifact;
- returns non-zero for every non-`FORMAL_PASS` result; and
- never uses `continue-on-error` on the formal decision.

Until H8 qualification and external enforcement exist, the workflow must fail
closed with explicit bounded reason codes. It may demonstrate readiness but
cannot be called a successful formal cutover.

The repository-controlled variable `HARNESS_V4_FORMAL_ENABLED` is the external
activation gate. It remains absent or false during initial V4 bootstrap. A
disabled/skipped job emits no attestation and is never formal evidence. The
variable may be set to `true` only after H8 qualification, required-check
enforcement and the trusted H8 artifact run ID are independently verified.

## 7. Acceptance catalog

H9 isolated acceptance must observe all of the following:

| Acceptance ID | Required observation |
|---|---|
| `formal_attestation_is_auditor_only` | Executor and compatibility sources cannot emit formal outcomes. |
| `formal_ci_authority_is_closed` | Unknown, missing or mismatched CI identity is blocked. |
| `delivery_tree_equals_attested_tree` | Commit/tree mismatch invalidates delivery. |
| `absent_stale_invalid_attestation_rejected` | Missing, expired, future, malformed and digest-tampered artifacts are blocked. |
| `h8_qualification_is_required` | Current 1/20 report blocks; a complete synthetic qualified fixture can pass contract tests. |
| `v4_only_runtime_is_installed` | Engine 4.0.0 is active, the compatibility adapter is absent and status-only evidence is rejected. |
| `rollback_is_v4_fail_closed` | Provisional mode disables delivery and never restores a removed-engine path. |
| `external_enforcement_is_verified` | Branch/ruleset requirement is observed from GitHub, not inferred from a workflow file. |
| `formal_workflow_is_fail_closed` | Required formal job has no `continue-on-error` and rejects unavailable proof. |
| `report_is_observation_derived` | H9 marker is computed from acceptance results and external facts, not handwritten. |

The exact formal marker is emitted only when every row passes:

```text
HARNESS_V4_FORMAL_CUTOVER: PASS
```

If implementation is ready but H8 or external enforcement is unavailable, the
only truthful marker is:

```text
HARNESS_V4_FORMAL_CUTOVER: BLOCKED
```

with bounded reason codes.

## 8. External activation prerequisites

Formal activation requires:

- H8: 20 qualified GitHub Actions observations spanning at least seven days,
  including one qualified trust-root change;
- a GitHub protected-branch rule or ruleset requiring the trusted formal
  check;
- repository variable `HARNESS_V4_FORMAL_ENABLED=true`, set only after the
  preceding prerequisites are verified; and
- an independently observed successful formal run for the exact delivery tree.

The repository is currently private and its current GitHub plan does not expose
branch protection or rulesets through the API. Implementation therefore
remains fail-closed until the repository owner enables that GitHub capability.
Changing repository visibility or subscription is outside code authority and
requires explicit owner action.

## 9. Rollback

Rollback performs one of two safe actions:

1. pause protected delivery while retaining evidence; or
2. return to explicit V4 `PROVISIONAL_PASS` development feedback.

Rollback never:

- accepts a status-only record as formal proof;
- marks a missing formal check successful;
- reuses a stale attestation for another tree; or
- deletes evidence required for incident review.

## 10. Ownership and support

- Harness maintainers own engine, policy and schema changes.
- The independent Auditor owner reviews attestation logic and trust-root
  updates.
- Repository administrators own protected-branch/ruleset installation.
- Release operators verify exact delivered-tree equality and artifact
  retention.
- Product teams consume formal results but cannot waive failed requirements.

Incidents involving candidate drift, invalid evidence, Auditor mismatch or
enforcement removal stop protected delivery immediately.

## 11. Completed runtime removal

The V4-only cutover removes the compatibility adapter, status-only aggregation,
commit authorization for `passed-or-skipped`, formal-policy compatibility
fields and removed-engine decision counters in one versioned change.

Historical H0-H9 reports and V1-V3 hardening documents remain immutable audit
records. They are outside the active source boundary and cannot satisfy current
acceptance.

## 12. Implementation slices

1. closed policy and formal verifier with V4-only red/green tests;
2. formal-CI Auditor authority and attestation issuance;
3. fail-closed Windows workflow, raw H8 qualification recomputation and
   immutable artifact publication;
4. operator runbook, observation-derived report and external enforcement
   probe;
5. isolated H9 closeout, followed by full Harness acceptance.

Each slice receives its own Harness plan and may proceed only after its focused
tests and closeout pass.
