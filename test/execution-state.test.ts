import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import {
  beginCommand,
  completeCurrent,
  executionStatePath,
  readExecutionState,
  resolveRoot,
  saveExecutionState,
  startExecution,
  unresolvedExecutions,
} from '../src/core/execution/index.js';
import { harnessStatePath } from '../src/core/git.js';
import { acquireMigrationExecutionLock } from '../src/core/migration/execution-lock.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function put(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

const req = (body = 'Resume the same intent.') => `---
schema: 1
id: REQ-001
priority: medium
source: test
steps:
  - STEP-001
adrs:
  - ADR-001
---

# REQ-001 — Resume

## Requirement

${body}

## Rationale

Durability.

## Acceptance

Resume is safe.
`;

const adr = (decision = 'Use canonical fingerprints.') => `---
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

# ADR-001 — Resume basis

## Context

Context

## Problem

Problem

## Decision

${decision}

## Alternatives considered

Chat history.

## Consequences

Safe resume.

## Security implications

None

## Data / migration implications

None

## Compatibility / operational implications

None
`;

const principle = (rule = 'Resume from canonical state.') => `---
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

# PRN-001 — Resume

## Rule

${rule}

## Rationale

Reason

## Applies to

Project

## Exceptions / approved deviation

None
`;

const step = (planLine = 'Implement safely.', acceptance = 'Works.') => `---
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
  - docs/architecture.md#resume
risk_flags:
  - none
plan:
  status: ready
  revision: 1
  context_basis: null
  context_components: []
  content_hash: null
  reviewed_report: null
  planned_at: 2026-10-06T00:00:00Z
---

# STEP-001 — Resume

## Goal

Goal

## Context

Context

## Scope

Scope

## Mutation policy

### Allowed

src

### Conditional

tests

### Forbidden

secrets

## Out of scope

Out

## Acceptance criteria

${acceptance}

## Verification

Tests

## Deliverables

Code

## Implementation plan

### 1. Implement

${planLine}

## Evidence


## Blocker / Failure reason


`;

async function repositoryFixture(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-execution-'));
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
      name: 'Execution Fixture',
      initializedAt: '2026-10-06T00:00:00Z',
    },
    execution: {
      ...DEFAULT_CONFIG.execution,
      maxFixReviewCycles: 1,
    },
  });
  await put(repo, 'docs/requirements/REQ-001-resume.md', req());
  await put(repo, 'docs/adr/ADR-001-resume.md', adr());
  await put(repo, 'docs/principles/PRN-001-resume.md', principle());
  await put(repo, 'docs/architecture.md', '# Architecture\n\n## Resume\n\nStable architecture.\n');
  await put(repo, 'planning/tasks/STEP-001.md', step());
  await put(repo, 'README.md', '# fixture\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'fixture']);
  return { base, repo };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ExecutionStateService', () => {
  it('stores schema-v2 state only in Git-private ai-harness', async () => {
    const { repo } = await repositoryFixture();
    const execution = await startExecution(repo, 'PROJECT STATUS');
    expect(execution.mode).toBe('single');
    expect(execution.ordinal).toBe(1);

    const stateRoot = await harnessStatePath(repo);
    const stateFile = await executionStatePath(repo);
    expect(stateFile.startsWith(stateRoot)).toBe(true);
    expect(stateFile.includes('.harness/local')).toBe(false);

    await completeCurrent(repo, 'PROJECT STATUS', 'SUCCESS', {
      expectedExecutionId: execution.executionId,
    });
    const state = await readExecutionState(repo);
    expect(state.schemaVersion).toBe(2);
    expect(state.executions).toHaveLength(0);
    expect(state.recentTerminals).toHaveLength(1);
    expect(state.nextOrdinal).toBe(2);
  });

  it('supports explicit chain selection through CTS result edges', async () => {
    const { repo } = await repositoryFixture();
    const root = 'GIT CHECK > COMMIT > PUSH';
    const execution = await startExecution(repo, root);
    expect(execution.mode).toBe('chain');
    expect(execution.current.command).toBe('GIT CHECK');

    await completeCurrent(repo, root, 'PASS', { expectedExecutionId: execution.executionId });
    await expect(resolveRoot(repo, root)).resolves.toMatchObject({
      status: 'NEXT',
      command: 'GIT COMMIT',
      reasonCode: 'CHAIN_NEXT_SEGMENT',
    });
    await beginCommand(repo, root, 'GIT COMMIT');
    await completeCurrent(repo, root, 'SUCCESS', { expectedExecutionId: execution.executionId });
    await expect(resolveRoot(repo, root)).resolves.toMatchObject({
      status: 'NEXT',
      command: 'GIT PUSH',
    });
    await beginCommand(repo, root, 'GIT PUSH');
    await completeCurrent(repo, root, 'SUCCESS', { expectedExecutionId: execution.executionId });
    await expect(resolveRoot(repo, root)).resolves.toMatchObject({ status: 'DONE' });
  });

  it('orchestrates STEP RUN and persists a STEP implementation recovery baseline', async () => {
    const { repo } = await repositoryFixture();
    const execution = await startExecution(repo, 'STEP RUN STEP-001');
    expect(execution.mode).toBe('orchestration');
    await expect(resolveRoot(repo, execution.rootCommand)).resolves.toMatchObject({
      status: 'NEXT',
      command: 'STEP PLAN STEP-001',
    });

    await beginCommand(repo, execution.rootCommand, 'STEP PLAN STEP-001');
    await completeCurrent(repo, execution.rootCommand, 'SUCCESS', {
      expectedExecutionId: execution.executionId,
    });
    await beginCommand(repo, execution.rootCommand, 'STEP IMPLEMENT STEP-001');

    const state = await readExecutionState(repo);
    expect(state.stepRecovery['STEP-001']).toMatchObject({
      stepId: 'STEP-001',
      sourceExecutionId: execution.executionId,
    });
    expect(state.stepRecovery['STEP-001'].gitHead).toMatch(/^[0-9a-f]{40}$/);

    await completeCurrent(repo, execution.rootCommand, 'SUCCESS', {
      expectedExecutionId: execution.executionId,
    });
    await beginCommand(repo, execution.rootCommand, 'STEP REVIEW STEP-001');
    await completeCurrent(repo, execution.rootCommand, 'FAIL', {
      expectedExecutionId: execution.executionId,
    });
    await expect(resolveRoot(repo, execution.rootCommand)).resolves.toMatchObject({
      status: 'NEXT',
      command: 'STEP FIX STEP-001',
    });
    await beginCommand(repo, execution.rootCommand, 'STEP FIX STEP-001');
    await completeCurrent(repo, execution.rootCommand, 'SUCCESS', {
      expectedExecutionId: execution.executionId,
    });
    await beginCommand(repo, execution.rootCommand, 'STEP REVIEW STEP-001');
    await completeCurrent(repo, execution.rootCommand, 'FAIL', {
      expectedExecutionId: execution.executionId,
    });
    await expect(resolveRoot(repo, execution.rootCommand)).resolves.toMatchObject({
      status: 'BLOCKED',
      reasonCode: 'FIX_REVIEW_LIMIT_REACHED',
      fixReviewCycles: 1,
    });
  });

  it('resumes unchanged semantic intent and ignores unrelated repository changes', async () => {
    const { repo } = await repositoryFixture();
    const execution = await startExecution(repo, 'STEP REVIEW STEP-001');
    const stored = execution.current.context.intentBasis;
    expect(stored?.contextBasis).toMatch(/^sha256:/);

    await put(repo, 'notes.txt', 'unrelated\n');
    await expect(resolveRoot(repo, execution.rootCommand)).resolves.toMatchObject({
      status: 'RESUME',
      command: 'STEP REVIEW STEP-001',
    });

    const resumed = await startExecution(repo, 'STEP REVIEW STEP-001');
    expect(resumed.executionId).toBe(execution.executionId);
    expect(resumed.current.attempt).toBe(2);
    expect(resumed.current.context.intentBasis).toEqual(stored);
  });

  it('blocks stale REQ/ADR/STEP/plan intent with exact taxonomy without overwriting old basis', async () => {
    const mutations: Array<{
      name: string;
      file: string;
      content: string;
      reason: string;
    }> = [
      {
        name: 'REQ',
        file: 'docs/requirements/REQ-001-resume.md',
        content: req('Changed requirement.'),
        reason: 'INTENT_BASIS_STALE',
      },
      {
        name: 'ADR',
        file: 'docs/adr/ADR-001-resume.md',
        content: adr('Changed architecture decision.'),
        reason: 'ARCHITECTURE_BASIS_CHANGED',
      },
      {
        name: 'STEP',
        file: 'planning/tasks/STEP-001.md',
        content: step('Implement safely.', 'Changed acceptance.'),
        reason: 'TASK_CONTRACT_CHANGED',
      },
      {
        name: 'plan',
        file: 'planning/tasks/STEP-001.md',
        content: step('Changed implementation plan.'),
        reason: 'PLAN_BASIS_STALE',
      },
    ];

    for (const mutation of mutations) {
      const { repo } = await repositoryFixture();
      const execution = await startExecution(repo, 'STEP REVIEW STEP-001');
      const oldBasis = execution.current.context.intentBasis;
      await put(repo, mutation.file, mutation.content);
      const resolved = await resolveRoot(repo, execution.rootCommand);
      expect(resolved.status, mutation.name).toBe('BLOCKED');
      expect(resolved.reasonCode, mutation.name).toBe(mutation.reason);
      expect(resolved.remediation).toBe('STEP PLAN STEP-001');
      const state = await readExecutionState(repo);
      expect(state.executions[0].current.context.intentBasis).toEqual(oldBasis);
    }
  });

  it('durably blocks an explicit stale resume before returning the error', async () => {
    const { repo } = await repositoryFixture();
    const execution = await startExecution(repo, 'STEP REVIEW STEP-001');
    const originalBasis = execution.current.context.intentBasis;
    await put(repo, 'docs/requirements/REQ-001-resume.md', req('Changed before explicit resume.'));

    await expect(startExecution(repo, execution.rootCommand)).rejects.toMatchObject({
      code: 'INTENT_BASIS_STALE',
      details: {
        remediation: 'STEP PLAN STEP-001',
      },
    });

    const blocked = await readExecutionState(repo);
    expect(blocked.executions).toHaveLength(1);
    expect(blocked.executions[0]).toMatchObject({
      executionId: execution.executionId,
      status: 'blocked',
      blockedBy: { reasonCode: 'INTENT_BASIS_STALE' },
    });
    expect(blocked.executions[0].current.context.intentBasis).toEqual(originalBasis);

    await put(repo, 'docs/requirements/REQ-001-resume.md', req());
    const next = await startExecution(repo, execution.rootCommand);
    expect(next.executionId).not.toBe(execution.executionId);
    const advanced = await readExecutionState(repo);
    expect(advanced.executions).toHaveLength(1);
    expect(advanced.executions[0].executionId).toBe(next.executionId);
    expect(advanced.recentTerminals.some((item) =>
      item.executionId === execution.executionId && item.status === 'blocked'
    )).toBe(true);
  });

  it('does not treat PLAN output mutation as stale intent', async () => {
    const { repo } = await repositoryFixture();
    const execution = await startExecution(repo, 'STEP PLAN STEP-001');
    await put(repo, 'planning/tasks/STEP-001.md', step('PLAN wrote a new draft.'));
    await expect(resolveRoot(repo, execution.rootCommand)).resolves.toMatchObject({
      status: 'RESUME',
      reasonCode: 'INTERRUPTED_COMMAND',
    });
  });

  it('rejects a stale semantic result bound to an older executionId', async () => {
    const { repo } = await repositoryFixture();
    const first = await startExecution(repo, 'PROJECT STATUS');
    await completeCurrent(repo, first.rootCommand, 'SUCCESS', {
      expectedExecutionId: first.executionId,
    });
    const second = await startExecution(repo, 'PROJECT STATUS');
    expect(second.executionId).not.toBe(first.executionId);

    await expect(
      completeCurrent(repo, second.rootCommand, 'SUCCESS', {
        expectedExecutionId: first.executionId,
      }),
    ).rejects.toMatchObject({
      code: 'STALE_SEMANTIC_RESULT',
      details: {
        expectedExecutionId: first.executionId,
        currentExecutionId: second.executionId,
      },
    });
  });

  it('keeps terminal history bounded to 100 records and ordinal monotonic', async () => {
    const { repo } = await repositoryFixture();
    const timestamp = '2026-10-06T00:00:00.000Z';
    await saveExecutionState(repo, {
      schemaVersion: 2,
      executions: [],
      stepRecovery: {},
      recentTerminals: Array.from({ length: 100 }, (_, index) => {
        const ordinal = index + 1;
        return {
          executionId: `exec-seeded-${String(ordinal).padStart(3, '0')}`,
          ordinal,
          rootCommand: 'PROJECT STATUS',
          mode: 'single' as const,
          status: 'complete' as const,
          current: {
            command: 'PROJECT STATUS',
            status: 'complete' as const,
            result: 'SUCCESS' as const,
            completedAt: timestamp,
            details: { iteration: ordinal },
          },
          completedAt: timestamp,
          updatedAt: timestamp,
        };
      }),
      nextOrdinal: 101,
    });

    const execution = await startExecution(repo, 'PROJECT STATUS');
    expect(execution.ordinal).toBe(101);
    await completeCurrent(repo, execution.rootCommand, 'SUCCESS', {
      expectedExecutionId: execution.executionId,
      details: { iteration: 101 },
    });

    const state = await readExecutionState(repo);
    expect(state.recentTerminals).toHaveLength(100);
    expect(state.nextOrdinal).toBe(102);
    expect(state.recentTerminals[0].ordinal).toBe(2);
    expect(state.recentTerminals.at(-1)?.ordinal).toBe(101);
  });

  it('retains an interrupted root when a newer independent command completes', async () => {
    const { repo } = await repositoryFixture();
    const run = await startExecution(repo, 'STEP RUN STEP-001');
    await beginCommand(repo, run.rootCommand, 'STEP PLAN STEP-001');

    const overlay = await startExecution(repo, 'GIT CHECK');
    await completeCurrent(repo, overlay.rootCommand, 'PASS', {
      expectedExecutionId: overlay.executionId,
    });

    const unresolved = await unresolvedExecutions(repo);
    expect(unresolved.some((item) =>
      item.executionId === run.executionId &&
      item.status === 'RESUME' &&
      item.command === 'STEP PLAN STEP-001'
    )).toBe(true);
  });

  it('uses one Core write concurrency model for migrations and execution state', async () => {
    const { repo } = await repositoryFixture();
    const migration = await acquireMigrationExecutionLock(repo, 'migration-concurrency', 'apply');
    try {
      await expect(startExecution(repo, 'PROJECT STATUS')).rejects.toMatchObject({
        code: 'CORE_WRITE_LOCK_ACTIVE',
        details: {
          owner: expect.objectContaining({
            kind: 'migration',
            operationId: 'migration-concurrency',
          }),
        },
      });
    } finally {
      await migration.release();
    }
    await expect(startExecution(repo, 'PROJECT STATUS')).resolves.toMatchObject({
      ordinal: 1,
    });
  });

  it('isolates execution state between linked Git worktrees', async () => {
    const { base, repo } = await repositoryFixture();
    const worktree = path.join(base, 'worktree');
    await git(repo, ['worktree', 'add', '-b', 'execution-worktree', worktree]);

    const [mainRoot, worktreeRoot] = await Promise.all([
      harnessStatePath(repo),
      harnessStatePath(worktree),
    ]);
    expect(mainRoot).not.toBe(worktreeRoot);

    const main = await startExecution(repo, 'PROJECT STATUS');
    const other = await startExecution(worktree, 'PROJECT STATUS');
    expect(main.ordinal).toBe(1);
    expect(other.ordinal).toBe(1);
    expect(await executionStatePath(repo)).not.toBe(await executionStatePath(worktree));

    const mainState = JSON.parse(await readFile(await executionStatePath(repo), 'utf8'));
    const worktreeState = JSON.parse(await readFile(await executionStatePath(worktree), 'utf8'));
    expect(mainState.executions[0].executionId).toBe(main.executionId);
    expect(worktreeState.executions[0].executionId).toBe(other.executionId);
  });
});
