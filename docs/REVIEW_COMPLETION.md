# Review, Verification and Completion Core

## 1. Scope

`src/core/review/` owns deterministic verification, semantic review commit, completion proof and convergence guards.

Extraction baseline:

- Harness release: `0.10.4`;
- template commit: `9f4aa325154253ab72a8c5940e988046ae872c99`;
- parity case: `PARITY-REVIEW-008`.

The runtime/model may propose semantic content. It does not own:

- Verification execution;
- review gate selection;
- repository revision identity;
- finding fingerprints;
- durable report identity;
- completion state;
- execution cursor;
- convergence stop decisions.

## 2. Verification

STEP `## Verification` accepts only explicit entries:

- `command` — argv command executed with `shell: false`;
- `manual` — explicit manual check.

Shell control operators are rejected. Complex shell logic belongs in a repository script and the Verification entry invokes that script explicitly.

Each command has the configured timeout. Core kills the process tree/group after timeout and stores only bounded evidence:

- exit status;
- duration;
- stdout/stderr SHA-256;
- byte counts;
- bounded diagnostic tail on failure.

A verification command that changes the repository is `BLOCKED`, not PASS.

Generated evidence is delimited by canonical markers in STEP `Evidence`.

Freshness binds evidence to:

1. Verification contract basis;
2. subject repository revision.

The STEP file itself is excluded from subject revision because generated evidence is written into that file. The Verification section is independently covered by contract basis.

## 3. Review surface and specialized reviewers

Review surface prefers the exact implementation baseline captured by Execution State:

`baseline..HEAD + current worktree`.

Baseline must:

- resolve to a commit;
- be an ancestor of current HEAD.

Missing or invalid baseline fails closed to diagnostic surface and requires both `security` and `tests` reviewers.

Additional deterministic triggers:

- security-sensitive risk flags;
- security-relevant changed paths;
- implementation/bugfix/refactor/hardening STEP type;
- code/test changed paths;
- `review.security=always`;
- `review.tests=always`.

The selected gate produces a stable basis hash.

## 4. Review Contract v2

New STEP reviews use structured findings contract v2.

Finding identity is the stable hash of:

- category;
- location;
- scenario;
- expected;
- observed.

Presentation and repair guidance do not change identity.

Categories:

- `implementation`;
- `evidence`;
- `contract`.

Verdict rules:

- PASS: zero material findings;
- FAIL: implementation/evidence findings, never contract findings;
- BLOCKED: at least one contract/evidence blocker.

Required specialized reviewer results are part of the report metadata. PASS requires every selected specialized reviewer to PASS.

## 5. Review expectation and stale-basis guard

Before semantic STEP REVIEW work starts, Execution State stores `ReviewExpectationV1`:

- repository revision;
- specialized review gate basis;
- planning context basis;
- verification basis;
- required reviewer set.

At proposal commit Core recomputes the expectation.

Any mismatch returns `REVIEW_STALE_BASIS`; the model proposal is not committed.

Review revision normalizes only the Core-owned STEP lifecycle `status` field. Any other STEP content mutation remains visible.

## 6. Immutable review history

New report names are canonical UTC-second identities:

`REVIEW-YYYYMMDDTHHMMSSZ.md`

Collision handling reserves the next canonical second with exclusive create semantics.

Existing reports are immutable. Git mutation/rename/delete of report-shaped paths is rejected by the immutability check.

Each report is bound to exact `execution_id`. This also provides crash recovery: if the report was durably created but execution cursor was not committed, retry finds the same report instead of creating a second semantic history entry.

## 7. Semantic writer authority

`commitStepReview()` is the commit boundary.

Order:

1. resolve exact active executionId;
2. require current `STEP REVIEW STEP-NNN`;
3. compare stamped Review Expectation;
4. normalize semantic proposal;
5. enforce specialized gate;
6. evaluate Completion Convergence Gate;
7. create immutable report;
8. validate report;
9. finalize STEP completion when eligible;
10. commit execution result through `completeCurrent(... expectedExecutionId)`.

Model prose cannot create machine PASS outside this path.

`commitStepPlan()` follows the same principle for PLAN:

- verifies original PLAN Intent Basis before mutation;
- validates planner payload;
- writes canonical plan draft;
- creates immutable independent planning review;
- fail-closes if basis changes before Ready stamp;
- stamps Ready plan only after matching PASS review;
- commits execution result with exact executionId.

## 8. Completion Convergence Gate

Review PASS is necessary but not sufficient for ordinary STEP completion.

Deterministic precheck requires:

- machine-discoverable Acceptance criteria;
- fresh Verification PASS;
- current implementation prerequisites.

Semantic completion payload covers:

- every Acceptance criterion;
- requirement obligations;
- planned scope;
- specialized obligations;
- structured completion gaps.

Results:

- `pass → PASS`;
- `fix → FAIL / FIX`;
- `blocked → BLOCKED`.

A `contract_gap` cannot route to FIX.

## 9. STEP completion proof

Completion proof is durable historical proof, not a current-worktree review.

For ordinary implementation-like STEP it requires:

- STEP status `completed`;
- durable Evidence;
- valid immutable PASS review;
- Completion Contract result PASS.

Core-owned lifecycle/projection changes after report creation do not erase that historical proof.

Type-specific proof remains for research, ADR, audit and review STEP types.

## 10. Progress and convergence

Progress samples are bounded to 8 entries.

Material facts include planning basis, plan hash, acceptance/evidence, completion proof, verification and review findings. Repository activity is fingerprinted separately.

Generic guards:

- repeated no-change semantic resume → `EXECUTION_STAGNATION`;
- repeated worsening → `EXECUTION_DRIFT`;
- equivalent non-repair state cycle → `EXECUTION_CYCLE`.

FIX/REVIEW loops use the stronger adaptive repair policy instead.

## 11. Adaptive FIX ↔ REVIEW policy

Latest immutable review snapshots are compared by finding fingerprints.

Within the same contract basis:

- same findings + changed revision → `REPEATED_FINDINGS`;
- same findings + unchanged revision → `NO_PROGRESS`;
- verification regression → `REGRESSION`;
- higher-severity newly introduced finding → `REGRESSION`;
- no finding resolved and severity not reduced → `NO_PROGRESS`.

These stop decisions run before the hard `maxFixReviewCycles` limit. The hard cap remains a final safety bound.

## 12. Requirements

Implemented by this module:

- `CLI-REQ-003`;
- `CLI-REQ-140`–`CLI-REQ-148`;
- `CLI-REQ-182`;
- `CLI-REQ-210`–`CLI-REQ-215`;
- `CLI-REQ-251`–`CLI-REQ-254`.
