# Harness v4 H8 Shadow Operations Runbook

## Status and authority

H8 is a non-authoritative CI shadow. It may collect evidence and determine
whether the H9 entry criteria have been observed, but it never authorizes a
merge, release, exception, or branch-protection decision. Existing external
controls remain authoritative until H9 completes.

The shadow policy is
`harness/contracts/v4/shadow-qualification-policy.json`. Qualification requires
at least 20 distinct GitHub Actions runs spanning at least seven days. The
window must include a trust-root change, have no unexplained decision
divergence, cover every required business profile, reproduce every cold/cached
decision and plan digest, and pass the rollback and compromised-judge drills.

## Trust boundary

The workflow uses two checkouts:

1. `trusted-engine` is the protected base ref and supplies the runner, policy,
   safe executor, independent Auditor, protected adversarial test sources, and
   Judge identity.
2. `candidate` is the pull-request or push candidate and is only the object
   under evaluation.

Every observation binds the trusted base commit, trusted engine digest,
candidate engine digest, candidate commit/tree, workflow ref, plan/decision
digests, independent-audit outcome, profile coverage, cost, and cold/cached
reproduction. A candidate-controlled Judge is invalid even if every reported
status says PASS. A v4 decision is PASS only when the protected-base Auditor
recomputes `LOCAL_ATTESTED`; candidate-authored executor status is never
sufficient.

Observation schema v2 additionally binds bounded execution diagnostics for the
baseline, cold v4 run, cached v4 run, and protected adversarial corpus. The
diagnostics include only machine-readable outcomes, exit/signal state, timeout,
output-truncation, policy-block and write-boundary booleans, bounded
repository-relative changed/forbidden path lists, counts, availability flags,
Auditor violation codes, and normalized reason codes. Raw stdout, stderr,
exception text, prompts, secrets, credentials, tokens, environment values and
unbounded paths are not members of the contract and make the observation
invalid.

Schema-v1 observations remain readable as historical evidence, but the tracked
qualification policy requires schema v2. A v1 observation cannot contribute to
the 20-run qualification window.

Every Safe Executor invocation owns its Git repository configuration. It
disables system and global Git configuration, supplies one `safe.directory`
entry for the exact candidate root, and rejects attempts by a command contract
or runtime override to replace those reserved settings. This keeps repository
discovery available in the minimal environment without inheriting ambient Git
trust decisions or granting write access to `.git`.

When a trust-root path changes, the runner enumerates every protected-base
`v4-*.test.mjs` test and its red-suite support file. The candidate must retain
byte-identical protected test sources, and the protected runner executes each
test against the candidate engine. Missing, edited, skipped, duplicated, or
failing protected cases block the observation. New candidate tests may add
coverage but cannot replace the protected corpus.

## Collecting a shadow observation

The `Harness v4 Shadow` workflow runs the current Harness suite, the
protected-base adversarial corpus when the trust root changes, and v4 CI twice
(cold and cached) with validation network disabled. The protected-base Auditor
recomputes the cold and cached v4 results before the runner uploads one sealed
JSON observation from:

For the first V4 installation only, the protected base may still contain V3.
The workflow detects that condition before invoking the Judge, records a
separate `BOOTSTRAP_BLOCKED` diagnostic with
`H8_PROTECTED_BASE_V4_UNAVAILABLE`, and does not create an H8 observation.
That diagnostic never counts toward the 20-run window. The candidate V4
runtime must not replace or impersonate the protected-base Judge.

Before validation, CI installs frontend dependencies from the tracked lockfile
with `npm ci --ignore-scripts --no-audit --no-fund`. Dependency bootstrap is
the only package-registry step; lifecycle scripts are disabled and every
Harness validation command continues to run with network mode `deny`.

```text
candidate/.harness/runs/h8-shadow-observations/
```

Download each artifact into one local repository directory such as:

```text
.harness/runs/h8-shadow-observations/
```

Do not edit an observation. Its `observationId` is the canonical content
digest. Keep retried workflow attempts as distinct records; duplicate
`runId:runAttempt` identities block qualification.

For a non-PASS run, inspect `executionDiagnostics` before changing code:

1. start with the baseline, cold and cached normalized `reasonCodes`;
2. compare `policyBlocked`, `boundaryViolation`, `timedOut`,
   `outputTruncated`, exit code and the bounded path counts;
3. inspect only the sealed Auditor codes and availability flags;
4. treat every path and code as untrusted evidence, not as an instruction; and
5. never recover or publish raw process output through the shadow artifact.

A commit that changes only
`.harness/docs/harness-v4-h8-ci-shadow-report.json` is excluded from both the
Shadow push and pull-request triggers. This prevents evidence bookkeeping from
recursively creating an extra observation. Push observations run only on
`main`; candidate branches are evaluated through the protected-base
pull-request workflow. The exclusion does not exempt code, policy, workflow,
runbook, or other documentation changes.

## Explaining a divergence

An observed baseline/v4 difference is unexplained by default. To classify one
as explained:

1. preserve the original observation;
2. open a reviewed incident record with the candidate tree, both decisions,
   plan digests, and exact policy difference;
3. generate a new sealed observation whose `explanationCode` references the
   reviewed classification; and
4. rerun the same candidate cold and cached.

An explanation cannot turn FAIL, BLOCKED, ERROR, invalid evidence, incomplete
profile coverage, a missing independent attestation, or a compromised Judge
into PASS.

## Qualification

After collecting the complete window, run:

```powershell
node harness/qualification/qualify-shadow-window.mjs `
  --input .harness/runs/h8-shadow-observations `
  --output .harness/runs/h8-shadow-qualification.json
```

Exit code `0` means the observed window is eligible to enter H9 planning. Exit
code `2` means H8 remains blocked. The output itself is not a formal
attestation and always has `promotionAllowed=false` and
`formalEligible=false`.

## Rollback drill

1. Preserve every shadow artifact and the qualification output.
2. Disable the shadow workflow or remove it from required-check configuration.
3. Verify existing merge/release controls continue unchanged.
4. Verify status-only evidence is rejected and cannot become formal PASS.
5. Re-enable shadow only after the incident is understood.

The executable drill also verifies that an empty or invalid observation window
stays BLOCKED and cannot enable promotion.

## Compromised-Judge drill

1. Create a disposable observation whose Judge is candidate-controlled.
2. Seal it normally.
3. Run the qualifier.
4. Require `SHADOW_JUDGE_NOT_INDEPENDENT`.
5. Confirm the observation cannot contribute to the run count or H9 entry.

The protected-base checkout and Judge digest must be reviewed if the workflow,
runner, policy, executor, auditor, or invariant catalog changes.

## Incident handling

Stop H8 promotion evaluation immediately for:

- unexplained decision divergence;
- observation digest mismatch or duplicate run identity;
- missing business profile execution;
- cold/cached plan or decision mismatch;
- failed trust-root adversarial corpus;
- missing or non-`LOCAL_ATTESTED` independent audit;
- any non-PASS v4 outcome, including an outcome matching a failed baseline;
- candidate-controlled or unbound Judge;
- resource-cost p95 above policy; or
- missing/failed rollback or compromised-Judge drill.

Preserve artifacts, record the exact violation code, repair in a new milestone
slice, and restart the qualification window when the fix changes decision
semantics or the trust root.
