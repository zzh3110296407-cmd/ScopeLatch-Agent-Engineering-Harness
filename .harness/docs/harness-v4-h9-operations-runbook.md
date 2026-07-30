# Harness v4 H9 Operations Runbook

Status: implementation installed; formal activation blocked
Contract: `harness-formal-cutover-v4.1.0`
Required check: `Harness v4 Formal Attestation`

## 1. Current state

The H9 policy, independent Auditor issuance path, V4-only runtime,
trusted-base Windows runner and fail-closed GitHub Actions workflow are
implemented in the current candidate. The runtime reports engine `4.0.0`;
status-only validation evidence is rejected.

Formal activation is not complete. The tracked H8 evidence contains one
qualified Windows observation out of twenty and spans zero of the required
seven days. GitHub returned HTTP 403 for both branch protection and repository
rulesets because the repository is private on a plan that does not expose
those features. No operator may reinterpret implementation readiness as a
formal cutover.

The authoritative current marker is:

```text
HARNESS_V4_FORMAL_CUTOVER: BLOCKED
```

## 2. Trust boundary

The formal workflow evaluates a frozen candidate with code checked out from
the protected base. It downloads raw H8 observations and recomputes
qualification with the protected-base algorithm. It does not trust a
precomputed `qualified=true` value from an artifact.

The independent Auditor is the only component allowed to upgrade a
digest-valid `LOCAL_ATTESTED` record to `FORMAL_PASS`. The runner then checks:

- exact candidate commit and tree;
- protected-base CI authority;
- H8 qualification and its canonical digest;
- fresh external enforcement evidence;
- formal attestation freshness and canonical digest; and
- explicit V4 outcomes throughout the validation and formal-decision chain.

The executor, candidate checkout and workflow exit status have no independent
adjudication authority. No compatibility adapter is installed.

## 3. Activation prerequisites

All prerequisites are mandatory:

1. Twenty qualified GitHub Actions observations spanning at least seven days.
2. At least one qualified observation changes the Harness trust root and
   passes the protected adversarial corpus.
3. Cold and cached v4 decisions and plans reproduce exactly in every
   qualifying observation.
4. No unexplained baseline/v4 decision divergence exists.
5. The H8 qualification artifact contains the raw, sealed observation set.
6. GitHub branch protection or an active ruleset requires
   `Harness v4 Formal Attestation` on `main`.
7. Repository variable `HARNESS_V4_FORMAL_ENABLED` is set to `true` only after
   items 1–6 are independently verified.
8. A formal workflow run accepts the exact delivery commit and tree.

The long H8 observation window may be deferred for development closeout, but
it cannot be waived for formal activation.

## 4. Preparing H8 evidence

After the H8 window is complete:

1. Download all qualifying immutable observation artifacts.
2. Place only the raw observation JSON files in one directory.
3. Run the trusted `evaluateShadowWindow` path against the entire set.
4. Confirm `qualificationStatus=QUALIFIED`, `eligibleForH9=true`,
   `promotionAllowed=false`, `formalEligible=false`, and no violations.
5. Publish the raw set as an immutable artifact named
   `harness-v4-h8-qualified-observations`.
6. Set repository variable `HARNESS_H8_QUALIFICATION_RUN_ID` to the trusted
   run that owns that artifact.

The formal runner recomputes the qualification. Editing only a summary or
report cannot make the window pass.

## 5. Installing external enforcement

Repository administrators must enable exactly one supported mode:

- branch protection on `main`; or
- an active branch ruleset that applies to `main`.

The policy must require the exact check name:

```text
Harness v4 Formal Attestation
```

After installation, query GitHub directly and verify that the required check
appears in the effective policy. Do not infer enforcement from the existence
of `.github/workflows/harness-v4-formal.yml`.

Only after H8 qualification and enforcement are both verified, set repository
variable `HARNESS_V4_FORMAL_ENABLED=true`. Keep the variable absent or false
during initial V4 bootstrap. A skipped job while the gate is disabled is not a
formal attestation and cannot satisfy H9.

Changing repository visibility or purchasing a GitHub plan is an owner
decision and is outside Harness code authority.

## 6. Running formal CI

Formal CI is triggered only by `pull_request` or `merge_group`. It has no
manual-dispatch success path and no `continue-on-error`. The formal job is
inactive unless the administrator-controlled
`HARNESS_V4_FORMAL_ENABLED=true` gate is present.

The workflow:

1. checks out the protected base and exact candidate separately;
2. installs pinned Node, Python, action commits and validation dependencies;
3. initializes ignored candidate runtime state;
4. downloads the raw qualified H8 observation set;
5. queries only GitHub API endpoints for enforcement evidence;
6. runs the trusted formal runner on Windows;
7. uploads a closed formal-delivery artifact even when blocked; and
8. returns non-zero unless the final result is formally eligible.

The artifact must contain `FORMAL_PASS`, the exact commit/tree, a fresh
attestation, zero exceptions and no violations before it can satisfy delivery.

## 7. Failure handling

Treat these classes as stop-line conditions:

| Reason code | Operator action |
|---|---|
| `H9_H8_OBSERVATION_SET_UNAVAILABLE` | Restore the immutable raw H8 artifact and trusted run ID. |
| `H9_H8_QUALIFICATION_REQUIRED` | Continue the H8 window; do not bypass it. |
| `H9_EXTERNAL_ENFORCEMENT_REQUIRED` | Install or restore branch/ruleset enforcement. |
| `H9_TRUSTED_BASE_COMMIT_MISMATCH` | Re-run from the expected protected base. |
| `H9_LOCAL_ATTESTATION_DIGEST_INVALID` | Quarantine the run and investigate evidence mutation. |
| `H9_DELIVERY_COMMIT_MISMATCH` | Re-run for the actual delivery commit. |
| `H9_DELIVERY_TREE_MISMATCH` | Stop delivery and investigate candidate drift. |
| `H9_ATTESTATION_STALE` | Re-run formal CI; never extend an old record. |
| `H9_FORMAL_EXECUTION_NOT_PASS` | Repair the failed required profile, then re-run. |

Raw process output, secrets, tokens and provider responses do not belong in
the formal artifact. Preserve the GitHub run and immutable artifact for
incident review.

## 8. Rollback

Safe rollback pauses protected delivery or returns development feedback to
explicit V4 provisional mode. It retains evidence and never restores a removed
runtime or status-upgrade path.

Rollback must not:

- mark a missing formal check successful;
- accept status-only evidence as formal proof;
- reuse an attestation for another tree;
- remove external enforcement before delivery is paused; or
- delete evidence required for review.

## 9. Ownership

- Harness maintainers own engine, policy and contract changes.
- Independent Auditor owners review issuance and validation changes.
- Repository administrators own branch protection/rulesets.
- Release operators verify delivered-tree equality and artifact retention.
- Product teams may consume results but cannot waive blockers.

Every trust-root change requires the full H5-H9 regression chain before merge.
