import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import {
  completeCurrent,
  readExecutionState,
  startExecution,
} from '../src/core/execution/index.js';
import {
  commitStepPlan,
  commitStepReview,
  compareRepairSnapshots,
  normalizeFindings,
  observeResume,
  parseArgv,
  reportForExecution,
  runStepVerification,
  stepCompletionProof,
  validateReviewImmutability,
  verificationFreshness,
} from '../src/core/review/index.js';
import type {
  ProgressSample,
  ReviewFinding,
} from '../src/core/review/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function put(root: string, relative: string, value: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, 'utf8');
}

function req(body = 'Completion requires trusted evidence.') {
  return `---
schema: 1
id: REQ-001
priority: medium
source: test
steps:
  - STEP-001
adrs:
  - ADR-001
---

# REQ-001 — Completion gate

## Requirement

${body}

## Rationale

Deterministic completion.

## Acceptance

- Trusted review is required.
`;
}

function adr() {
  return `---
schema: 1
id: ADR-001
status: accepted
date: 2026-10-06
deciders:
  - team
supersedes: []
superseded_by: []
requirements:
  - REQ-001
steps:
  - STEP-001
---

# ADR-001 — Review authority

## Context

Review output is semantic.

## Problem

Model prose must not commit state.

## Decision

Core owns review and completion commits.

## Alternatives considered

Trust prose.

## Consequences

Durable evidence is required.

## Security implications

Core validates review scope.

## Data / migration implications

None.

## Compatibility / operational implications

Reports are immutable.
`;
}

function principle() {
  return `---
schema: 1
id: PRN-001
status: active
severity: blocking
scope: project
requirements:
  - REQ-001
adrs:
  - ADR-001
superseded_by: null
---

# PRN-001 — Trusted completion

## Rule

Completion must be proven by Core.

## Rationale

Chat history is not authoritative.

## Applies to

STEP completion.

## Exceptions / approved deviation

None.
`;
}

function step() {
  return `---
schema: 1
id: STEP-001
status: in_progress
type: implementation
priority: medium
phase: implementation
depends_on: []
requirements:
  - REQ-001
adrs:
  - ADR-001
architecture_refs:
  - docs/architecture.md#review
risk_flags:
  - security-sensitive
plan:
  status: draft
  revision: 0
  context_basis: null
  content_hash: null
  reviewed_report: null
  planned_at: null
  execution_groups: {}
  context_components: []
---

# STEP-001 — Trusted review

## Goal

Move review and completion authority into Core.

## Context

Synthetic review fixture.

## Scope

- Review writer.
- Completion proof.

## Mutation policy

### Allowed

- src
- tests

### Conditional

- planning

### Forbidden

- secrets

## Out of scope

- Runtime adapters.

## Acceptance criteria

- Core closes the STEP only after trusted verification and review.

## Verification

- command: `node -e "process.exit(0)"`

## Deliverables

- Core review gate.

## Implementation plan

### 1. Initial placeholder

Replace during PLAN.

## Evidence

—

## Blocker / Failure reason

—
`;
}

async function repositoryFixture(): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-review-'));
  roots.push(base);
  const repo = path.join(base, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Harness Test']);

  await writeConfig(repo, {
    ...DEFAULT_CONFIG,
    project: {
      initialized: true,
      name: 'Review Fixture',
      initializedAt: '2026-10-06T00:00:00Z',
    },
  });
  await put(repo, 'docs/requirements/REQ-001-review.md', req());
  await put(repo, 'docs/adr/ADR-001-review.md', adr());
  await put(repo, 'docs/principles/PRN-001-review.md', principle());
  await put(repo, 'docs/architecture.md', '# Architecture\n\n## Review\n\nCore owns review commits.\n');
  await put(repo, 'planning/tasks/STEP-001.md', step());
  await put(repo, 'README.md', '# fixture\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'fixture']);
  return repo;
}

const planProposal = {
  implementationPlan: [{
    title: 'Implement review gate',
    actions: ['Add deterministic review/completion authority.'],
    files: ['src/auth.ts'],
    tests: ['Run review gate tests.'],
    risks: ['Review state must remain bound to exact revision.'],
  }],
  verification: [{
    kind: 'command',
    value: 'node -e "process.exit(0)"',
  }],
  executionGroups: [],
};

const planningReviewProposal = {
  verdict: 'pass',
  findings: [],
  rationale: 'Plan is internally consistent and verifiable.',
};

async function readyPlan(repo: string): Promise<void> {
  const execution = await startExecution(repo, 'STEP PLAN STEP-001');
  const result = await commitStepPlan(repo, {
    rootCommand: execution.rootCommand,
    stepId: 'STEP-001',
    executionId: execution.executionId,
    plannerProposal: planProposal,
    reviewProposal: planningReviewProposal,
    now: new Date('2026-10-06T07:00:00Z'),
  });
  expect(result).toMatchObject({
    status: 'PASS',
    completionResult: 'SUCCESS',
    stepId: 'STEP-001',
    planRevision: 1,
  });
}

async function implementedAndVerified(repo: string): Promise<void> {
  await readyPlan(repo);
  const execution = await startExecution(repo, 'STEP IMPLEMENT STEP-001');
  await put(repo, 'src/auth.ts', 'export const reviewAuthority = true;\n');
  await completeCurrent(repo, execution.rootCommand, 'SUCCESS', {
    expectedExecutionId: execution.executionId,
  });
  const verification = await runStepVerification(repo, 'STEP-001');
  expect(verification).toMatchObject({ status: 'PASS' });
  await expect(verificationFreshness(repo, 'STEP-001')).resolves.toMatchObject({
    status: 'PASS',
    fresh: true,
  });
}

function passCompletionProposal() {
  return {
    disposition: 'pass',
    coverage: [{
      criterion: 'Core closes the STEP only after trusted verification and review.',
      status: 'covered',
      evidence: ['Verification PASS and immutable review contract.'],
    }],
    assertions: {
      requirementObligations: {
        status: 'covered',
        evidence: ['REQ-001 reviewed.'],
      },
      plannedScope: {
        status: 'covered',
        evidence: ['Implementation plan reviewed.'],
      },
      specializedObligations: {
        status: 'covered',
        evidence: ['Security and tests reviewers passed.'],
      },
    },
    findings: [],
    rationale: 'Acceptance and all obligations are covered.',
  };
}

function passReviewProposal() {
  return {
    verdict: 'pass',
    findings: [],
    verificationObservations: 'Generated Verification evidence is PASS and fresh.',
    rationale: 'No material implementation, evidence, or contract findings remain.',
    specializedReviews: {
      security: { status: 'pass', summary: 'Security-sensitive surface reviewed.' },
      tests: { status: 'pass', summary: 'Test obligations reviewed.' },
    },
    completion: passCompletionProposal(),
  };
}

function finding(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    title: 'Broken behavior',
    severity: 'high',
    category: 'implementation',
    location: { path: 'src/auth.ts', line: 1 },
    scenario: {
      given: 'a valid request',
      when: 'review runs',
      then: 'the invariant must hold',
    },
    expected: 'Invariant holds.',
    observed: 'Invariant is violated.',
    impact: 'Completion would be unsafe.',
    repair: {
      direction: 'Restore the invariant.',
      admissibleAlternatives: [],
    },
    constraints: [],
    evidence: ['src/auth.ts:1'],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    ),
  );
});

describe('review, verification and completion Core', () => {
  it('rejects shell control operators before Verification execution', () => {
    expect(() => parseArgv('node -e "process.exit(0)" && echo unsafe')).toThrow(
      /shell control operators are not supported/,
    );
  });

  it('detects Verification repository mutation as BLOCKED evidence', async () => {
    const repo = await repositoryFixture();
    await readyPlan(repo);
    const task = path.join(repo, 'planning/tasks/STEP-001.md');
    const raw = await readFile(task, 'utf8');
    await writeFile(
      task,
      raw.replace(
        '- command: `node -e "process.exit(0)"`',
        '- command: `node -e "require(\'fs\').writeFileSync(\'verification-mutation.txt\',\'x\')"`',
      ),
      'utf8',
    );

    const result = await runStepVerification(repo, 'STEP-001');
    expect(result).toMatchObject({
      status: 'BLOCKED',
      reasonCode: 'VERIFICATION_MUTATED_REPOSITORY',
    });
  }, 30_000);

  it('commits PLAN payload through Core and rejects stale pre-write intent', async () => {
    const repo = await repositoryFixture();
    const stale = await startExecution(repo, 'STEP PLAN STEP-001');
    await put(repo, 'docs/requirements/REQ-001-review.md', req('Changed after semantic handoff.'));
    await expect(
      commitStepPlan(repo, {
        rootCommand: stale.rootCommand,
        stepId: 'STEP-001',
        executionId: stale.executionId,
        plannerProposal: planProposal,
        reviewProposal: planningReviewProposal,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_STALE_BASIS' });

    const state = await readExecutionState(repo);
    expect(state.executions[0].current.status).toBe('running');
  }, 30_000);

  it('completes STEP only through fresh Verification + immutable PASS review + completion PASS', async () => {
    const repo = await repositoryFixture();
    await implementedAndVerified(repo);

    const reviewExecution = await startExecution(repo, 'STEP REVIEW STEP-001');
    expect(reviewExecution.current.context.reviewExpectation).toMatchObject({
      stepId: 'STEP-001',
      requiredReviewers: ['security', 'tests'],
    });

    const result = await commitStepReview(repo, {
      rootCommand: reviewExecution.rootCommand,
      stepId: 'STEP-001',
      executionId: reviewExecution.executionId,
      proposal: passReviewProposal(),
      now: new Date('2026-10-06T07:01:00Z'),
    });
    expect(result).toMatchObject({
      status: 'PASS',
      verdict: 'pass',
      stepCompletion: { completed: true },
    });

    const proof = await stepCompletionProof(repo, 'STEP-001');
    expect(proof.complete).toBe(true);
    expect(proof.reasons).toEqual([]);

    const task = await readFile(path.join(repo, 'planning/tasks/STEP-001.md'), 'utf8');
    expect(task).toMatch(/status: completed/);

    const report = await reportForExecution(repo, 'STEP-001', reviewExecution.executionId);
    expect(report).not.toBeNull();
    expect(report?.completionResult).toBe('PASS');
    expect(report?.relativePath).toMatch(
      /^planning\/reviews\/STEP-001\/REVIEW-20261006T070100Z\.md$/,
    );
  }, 30_000);

  it('rejects a stale review proposal when repository revision changes after handoff', async () => {
    const repo = await repositoryFixture();
    await implementedAndVerified(repo);
    const reviewExecution = await startExecution(repo, 'STEP REVIEW STEP-001');
    await put(repo, 'src/auth.ts', 'export const reviewAuthority = false;\n');

    await expect(
      commitStepReview(repo, {
        rootCommand: reviewExecution.rootCommand,
        stepId: 'STEP-001',
        executionId: reviewExecution.executionId,
        proposal: passReviewProposal(),
      }),
    ).rejects.toMatchObject({
      code: 'REVIEW_STALE_BASIS',
      details: { remediation: 'STEP REVIEW STEP-001' },
    });

    expect(
      await reportForExecution(repo, 'STEP-001', reviewExecution.executionId),
    ).toBeNull();
  }, 30_000);

  it('persists canonical FAIL and BLOCKED review verdicts without completing STEP', async () => {
    const failRepo = await repositoryFixture();
    await implementedAndVerified(failRepo);
    const failExecution = await startExecution(failRepo, 'STEP REVIEW STEP-001');
    const failResult = await commitStepReview(failRepo, {
      rootCommand: failExecution.rootCommand,
      stepId: 'STEP-001',
      executionId: failExecution.executionId,
      proposal: {
        verdict: 'fail',
        findings: [finding()],
        verificationObservations: 'Verification is fresh but implementation has a material defect.',
        rationale: 'The implementation finding must route to FIX.',
        specializedReviews: {
          security: { status: 'pass', summary: 'No security blocker in the finding.' },
          tests: { status: 'fail', summary: 'Behavior does not satisfy the reviewed scenario.' },
        },
        completion: null,
      },
      now: new Date('2026-10-06T07:03:00Z'),
    });
    expect(failResult).toMatchObject({ status: 'FAIL', verdict: 'fail' });
    expect((await stepCompletionProof(failRepo, 'STEP-001')).complete).toBe(false);

    const blockedRepo = await repositoryFixture();
    await implementedAndVerified(blockedRepo);
    const blockedExecution = await startExecution(blockedRepo, 'STEP REVIEW STEP-001');
    const blockedResult = await commitStepReview(blockedRepo, {
      rootCommand: blockedExecution.rootCommand,
      stepId: 'STEP-001',
      executionId: blockedExecution.executionId,
      proposal: {
        verdict: 'blocked',
        findings: [finding({
          category: 'contract',
          title: 'Contract ambiguity',
          observed: 'The canonical contract is ambiguous.',
          expected: 'The contract determines one safe behavior.',
        })],
        verificationObservations: 'Verification cannot resolve a contract ambiguity.',
        rationale: 'Contract defect must block rather than route to FIX.',
        specializedReviews: {
          security: { status: 'blocked', summary: 'Security behavior depends on the missing contract.' },
          tests: { status: 'pass', summary: 'Existing tests execute, but cannot resolve contract intent.' },
        },
        completion: null,
      },
      now: new Date('2026-10-06T07:04:00Z'),
    });
    expect(blockedResult).toMatchObject({ status: 'BLOCKED', verdict: 'blocked' });
    expect((await stepCompletionProof(blockedRepo, 'STEP-001')).complete).toBe(false);
  }, 60_000);

  it('does not allow model PASS prose to bypass material finding rules', async () => {
    const repo = await repositoryFixture();
    await implementedAndVerified(repo);
    const reviewExecution = await startExecution(repo, 'STEP REVIEW STEP-001');
    await expect(
      commitStepReview(repo, {
        rootCommand: reviewExecution.rootCommand,
        stepId: 'STEP-001',
        executionId: reviewExecution.executionId,
        proposal: {
          ...passReviewProposal(),
          findings: [finding()],
        },
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_CONTRACT_INVALID' });
  }, 30_000);

  it('preserves stable finding identity and stops repeated repair findings', () => {
    const first = normalizeFindings([finding()])[0];
    const renamed = normalizeFindings([finding({
      title: 'Reviewer renamed this finding',
      severity: 'medium',
      repair: {
        direction: 'A more precise repair direction.',
        admissibleAlternatives: ['Equivalent safe implementation.'],
      },
    })])[0];
    expect(renamed.fingerprint).toBe(first.fingerprint);

    const result = compareRepairSnapshots(
      {
        report: 'before.md',
        verdict: 'fail',
        contractBasis: 'sha256:' + 'a'.repeat(64),
        verificationBasis: 'sha256:' + 'b'.repeat(64),
        verificationStatus: 'FAIL',
        reviewedRevision: { gitHead: '1'.repeat(40), worktreeHash: null },
        findings: [first],
      },
      {
        report: 'after.md',
        verdict: 'fail',
        contractBasis: 'sha256:' + 'a'.repeat(64),
        verificationBasis: 'sha256:' + 'b'.repeat(64),
        verificationStatus: 'FAIL',
        reviewedRevision: { gitHead: '2'.repeat(40), worktreeHash: null },
        findings: [renamed],
      },
      1,
    );
    expect(result).toMatchObject({
      reasonCode: 'REPEATED_FINDINGS',
      stopDecision: 'REPEATED_FINDINGS',
      resolved: 0,
      introduced: 0,
      persisted: 1,
    });

    const regression = compareRepairSnapshots(
      {
        report: 'before.md',
        verdict: 'fail',
        contractBasis: 'sha256:' + 'a'.repeat(64),
        verificationBasis: 'sha256:' + 'b'.repeat(64),
        verificationStatus: 'PASS',
        reviewedRevision: { gitHead: '1'.repeat(40), worktreeHash: null },
        findings: [first],
      },
      {
        report: 'after.md',
        verdict: 'fail',
        contractBasis: 'sha256:' + 'a'.repeat(64),
        verificationBasis: 'sha256:' + 'c'.repeat(64),
        verificationStatus: 'FAIL',
        reviewedRevision: { gitHead: '2'.repeat(40), worktreeHash: null },
        findings: [],
      },
      2,
    );
    expect(regression).toMatchObject({
      reasonCode: 'REGRESSION',
      verificationRegressed: true,
    });
  });

  it('stops repeated semantic resume after bounded no-progress samples', () => {
    const sample: ProgressSample = {
      schemaVersion: 1,
      stepId: 'STEP-001',
      command: 'STEP IMPLEMENT STEP-001',
      operation: 'IMPLEMENT',
      materialFingerprint: 'sha256:' + '1'.repeat(64),
      activityFingerprint: 'sha256:' + '2'.repeat(64),
      fingerprint: 'sha256:' + '3'.repeat(64),
      metrics: {
        stepStatus: 'in_progress',
        completionComplete: false,
        completionReasonCount: 2,
        completionPrecheckFindingCount: 1,
        reviewFindingCount: 0,
        completionFindingCount: 0,
        verificationStatus: 'FAIL',
      },
      capturedAt: '2026-10-06T07:00:00Z',
    };
    const first = observeResume(undefined, sample);
    const second = observeResume(first.telemetry, sample);
    expect(second.blocker).toBeNull();
    const third = observeResume(second.telemetry, sample);
    expect(third.blocker).toMatchObject({
      reasonCode: 'EXECUTION_STAGNATION',
      unchangedAttempts: 2,
    });
    expect(third.telemetry.samples.length).toBeLessThanOrEqual(8);
  });

  it('detects mutation of committed immutable review history', async () => {
    const repo = await repositoryFixture();
    await implementedAndVerified(repo);
    const reviewExecution = await startExecution(repo, 'STEP REVIEW STEP-001');
    const result = await commitStepReview(repo, {
      rootCommand: reviewExecution.rootCommand,
      stepId: 'STEP-001',
      executionId: reviewExecution.executionId,
      proposal: passReviewProposal(),
      now: new Date('2026-10-06T07:02:00Z'),
    });
    expect(await validateReviewImmutability(repo)).toEqual([]);

    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'review history']);
    const reportPath = path.join(repo, ...(String(result.report).split('/')));
    await writeFile(reportPath, (await readFile(reportPath, 'utf8')) + '\nmutated\n', 'utf8');
    const errors = await validateReviewImmutability(repo);
    expect(errors.some((item) => item.includes('immutable review history changed'))).toBe(true);
  }, 30_000);
});
