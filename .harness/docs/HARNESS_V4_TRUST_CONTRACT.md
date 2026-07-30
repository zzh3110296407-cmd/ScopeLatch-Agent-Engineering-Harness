# Harness v4 Trust Contract

Status: approved implementation authority
Contract version: `harness-trust-v4.0.0`
Approved decisions: 2026-07-29

## 1. Objective

Harness v4 is a delivery-proof system. Its formal result must prove that one
exact Git candidate was evaluated by one trusted engine and policy set, that
every applicable required invariant produced valid evidence, and that an
independent auditor recomputed the decision.

Harness v4 does not treat the absence of an observed failure as proof of
success. Missing, skipped, stale, unreadable, unbound, or unverifiable evidence
is a blocked decision.

## 2. Approved non-negotiable decisions

1. A formal result is bound to an exact Git tree object ID. A mutable worktree
   can produce development feedback only.
2. Development success is always `PROVISIONAL_PASS`; it is never promoted to a
   formal result without freezing and independently auditing a candidate.
3. A required check cannot be waived into `FORMAL_PASS`. An approved exception
   is reported as `FORMAL_EXCEPTION` and remains visibly distinct from success.
4. Only an independent, read-only auditor may issue a formal attestation. The
   planner and executor cannot certify their own output.

These decisions can be changed only by a new contract version and an explicit
human approval. Runtime configuration cannot weaken them.

## 3. Proof statement

A `FORMAL_PASS` attestation means all of the following are true:

- the repository, base commit, candidate tree, index tree, submodules, and
  declared dependency locks are identified by immutable digests;
- the engine, policy catalog, source authority, execution plan, toolchain, and
  evidence objects are identified by immutable digests;
- the candidate was checked out in an isolated validation workspace;
- the complete applicable invariant set was deterministically derived;
- every applicable required check ran and returned `PASS`;
- there are no unresolved coverage gaps, missing artifacts, required waivers,
  validation side effects, or identity conflicts;
- the candidate tree did not drift before, during, or after validation;
- an independent auditor recomputed the artifact graph, invariant coverage,
  result aggregation, and candidate identity; and
- the attested tree is the tree proposed for merge or release.

If any clause cannot be proven, the result is not `FORMAL_PASS`.

## 4. Trust boundaries

### 4.1 Advisory control plane

The context builder, impact analyzer, development planner, hooks, repair
assistant, reports, and knowledge base improve workflow quality. They may
suggest scope and checks, but they do not constitute formal proof.

### 4.2 Formal execution plane

The formal execution plane accepts only a frozen candidate, a validated policy
snapshot, and a deterministic execution plan. It runs checks in isolation with
bounded resources and stores result evidence by content digest.

### 4.3 Attestation plane

The attestation plane is read-only. It does not trust status fields written by
the planner or executor. It independently parses strict artifacts, resolves the
evidence graph, recomputes the outcome, and binds the decision to the candidate
tree.

### 4.4 Trust root

Formal validation uses a pinned Harness engine and policy authority that the
candidate branch cannot silently replace. A Harness engine change requires the
last trusted engine to validate the candidate engine, the candidate engine to
pass the adversarial corpus, and explicit approval of the new engine digest.

## 5. Operating modes

| Mode | Input | Isolation | Eligible outcomes |
|---|---|---|---|
| `development` | Mutable worktree | Best effort | `PROVISIONAL_PASS`, `FAIL`, `BLOCKED`, `ERROR` |
| `formal-local` | Frozen Git candidate | Required | `LOCAL_ATTESTED`, `FAIL`, `BLOCKED`, `ERROR` |
| `formal-ci` | Frozen Git candidate | Required, clean runner | `FORMAL_PASS`, `FORMAL_EXCEPTION`, `FAIL`, `BLOCKED`, `ERROR` |

`LOCAL_ATTESTED` is useful offline evidence but is not sufficient for protected
merge or release unless repository policy explicitly designates that auditor as
a trusted formal authority.

## 6. State model

Run lifecycle states:

```text
DRAFT
  -> PLANNED
  -> CANDIDATE_FROZEN
  -> VALIDATING
  -> VALIDATED
  -> AUDITING
  -> ATTESTED
```

Terminal or invalidation states:

```text
FAIL
BLOCKED
ERROR
CANCELED
INVALIDATED
ABORTED
```

`PROVISIONAL_PASS` is a development verdict, not a lifecycle shortcut to
`ATTESTED`.

### 6.1 Check result vocabulary

Every check result is exactly one of:

- `PASS`: the declared assertion ran and succeeded;
- `FAIL`: the assertion ran and found a product or contract violation;
- `BLOCKED`: required evidence or execution capability was unavailable;
- `ERROR`: the checker or runner malfunctioned;
- `CANCELED`: execution did not complete;
- `NOT_APPLICABLE`: the catalog supplied a machine-verifiable reason that the
  invariant does not apply.

`SKIPPED` and `passed-or-skipped` are legacy states and are never formal-pass
eligible.

### 6.2 Formal aggregation truth table

| Condition | Formal aggregate |
|---|---|
| Zero applicable required checks | `BLOCKED` |
| Any applicable required `FAIL` | `FAIL` |
| Any applicable required `BLOCKED`, `ERROR`, or `CANCELED` | `BLOCKED` |
| Missing or unknown check/result state | `BLOCKED` |
| Required check has a waiver | `FORMAL_EXCEPTION` |
| Candidate, policy, plan, evidence, or engine digest mismatch | `INVALIDATED` |
| All applicable required checks `PASS`, graph complete, auditor accepts | `FORMAL_PASS` |

An informational observation is not a check. If an executed assertion fails,
it cannot be hidden behind an `optional` flag and still produce formal success.

## 7. Formal artifact contracts

All formal artifacts use closed, versioned schemas and canonical JSON. Unknown
fields, duplicate identities, path traversal, cross-run references, and missing
parents are rejected.

### 7.1 `RunSpec`

Defines `run_id`, mode, repository identity, task identity, caller identity,
creation time, expiry, and the requested acceptance profile. Run IDs use a
collision-resistant random or UUID form; timestamps and slugs are display data
only.

### 7.2 `CandidateSnapshot`

Defines `base_commit_oid`, `candidate_tree_oid`, `index_tree_oid`,
`patch_digest`, submodule OIDs, lockfile digests, and repository identity.
Formal candidates cannot be created from an unattributed dirty baseline.

### 7.3 `PolicySnapshot`

Defines the trusted engine digest, policy catalog digest, source-authority
digest, acceptance-profile digest, and toolchain constraints.

### 7.4 `ExecutionPlan`

Contains the deterministic invariant closure and execution DAG. Every command
uses a structured executable/argument form, declares its working directory,
resource limits, environment profile, network policy, expected artifacts, and
dependencies. Shell command strings are not a formal command contract.

### 7.5 `CheckResult`

Contains the invariant ID and version, candidate digest, command-spec digest,
runner identity, start/end observations, exit state, sanitized output digests,
produced-artifact digests, and the closed result vocabulary.

### 7.6 `EvidenceIndex`

Contains the content address, size, media type, schema version, run identity,
and parent digests of every artifact. A path is a storage hint, never identity.

### 7.7 `FormalAttestation`

Contains the candidate tree OID, engine/policy/toolchain digests, execution-plan
digest, evidence root digest, required invariant counts, auditor identity,
auditor version, final outcome, and exception references. Only the auditor may
create this artifact.

## 8. Executable invariant catalog

The policy catalog is the single authority for applicability and validation
coverage. Each invariant declares:

```yaml
invariantId: example.domain.behavior
version: 1
owner: team-or-module
triggers:
  paths: []
  symbols: []
  changeKinds: []
requires:
  capabilities: []
  testSelectors: []
  artifacts: []
waiverPolicy: forbidden
formalEligible: true
```

Required synchronizations are compiled into required plan nodes. Impacted test
selectors are executed or recorded as a blocking coverage gap. Unknown changed
files take the conservative profile; they never silently receive zero checks.

Each acceptance statement maps to explicit invariant result IDs. Reports cannot
introduce unobserved Boolean claims.

## 9. Candidate and Git rules

- Git observation failures are errors, never an empty change set.
- Formal Git commands use NUL-delimited output and support Unicode paths.
- Worktree bytes, index blobs, and candidate tree blobs are separately
  identified.
- Formal validation runs against the candidate tree, not whichever bytes happen
  to be in the developer worktree.
- Branch, base, HEAD, index, submodule, config, source authority, and policy drift
  invalidate the run.
- A cached result is reusable only when candidate, invariant, engine, policy,
  toolchain, environment, and declared dependency digests match.

## 10. Multi-agent and storage rules

- Each agent/task receives an isolated worktree or equivalent immutable
  candidate workspace.
- A lease has an owner, nonce, TTL, heartbeat, and atomic acquisition.
- State updates use transactional or compare-and-swap semantics.
- `latest-run.json` may support UI navigation but grants no identity, lease, or
  attestation authority.
- A concurrent writer cannot be credited to another run merely because a path
  was in its allowed scope.
- Crash recovery can resume or abort a run but cannot synthesize completion.

## 11. Execution and network safety

- Formal commands use executable plus argument arrays and do not use
  `shell: true`.
- The runner passes a minimal allowlisted environment.
- Network access is denied by default. A network-requiring invariant must
  declare its destination policy and cannot persist credentials or raw provider
  payloads.
- stdout and stderr are size-bounded and sanitized before persistence.
- Secrets, tokens, private keys, raw prompts, raw provider responses, and hidden
  reasoning are never evidence payloads.
- CPU, memory, time, process count, writable paths, and output directories are
  bounded.
- A validator that changes candidate source bytes fails the run.

## 12. Compatibility and deprecation

- V4 is the only active planner, executor, outcome engine and adjudicator.
- V3 status-only records are contract-invalid at active V4 boundaries and
  cannot be upgraded, projected or adapted into current evidence.
- Historical V3 documents may remain in Git history for human audit only.
  Runtime code must not import them, read them as decision inputs or emit V3
  compatibility projections.
- No active compatibility adapter or parallel V3 implementation is permitted.
- Rollback may return a domain to development/provisional service, but no
  rollback can restore v3 formal-pass authority.

## 13. Success criteria

Harness v4 is production-eligible only when:

1. every cataloged false-pass probe returns `FAIL`, `BLOCKED`, or `INVALIDATED`;
2. applicable required-check execution coverage is 100 percent;
3. evidence tampering and cross-run mixing detection is 100 percent in the
   adversarial corpus;
4. the attested candidate tree equals the delivered tree;
5. the same candidate/policy/toolchain decision is reproducible;
6. concurrent runs show no shared state, lost updates, or cross-attribution;
7. Unicode and special Git paths are correctly observed;
8. an independent auditor can reproduce every formal decision;
9. business-code changes trigger the relevant formal CI profile; and
10. v3 active formal decision usage reaches zero before its adjudicator is
    removed.

## 14. Always, ask first, never

Always:

- fail closed at trust boundaries;
- bind decisions to immutable identities;
- test a defect with a failing probe before fixing it;
- keep development convenience distinct from formal assurance;
- record exact missing evidence and reason codes.

Ask first:

- changing this trust contract;
- adding a new trusted engine or auditor digest;
- permitting network access or credentials in a formal invariant;
- changing formal waiver policy;
- changing protected-branch attestation requirements.

Never:

- promote missing, skipped, stale, or unverifiable evidence to PASS;
- let a candidate branch silently replace its own judge;
- validate mutable worktree bytes and attest different index/tree bytes;
- accept handwritten report claims as execution evidence;
- let an exception or rollback masquerade as formal success.
