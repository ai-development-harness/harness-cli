import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import {
  ProjectionDerivationError,
  affectedSteps,
  buildArtifactInventory,
  buildProjectState,
  buildTraceabilityCoverage,
  projectStatus,
  resolveStepNext,
  stepList,
  stepShow,
  validateProjections,
  writeProjections,
} from '../src/core/project/index.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-project-state-'));
  roots.push(root);
  await writeConfig(root, {
    ...DEFAULT_CONFIG,
    project: {
      initialized: true,
      name: 'Fixture',
      initializedAt: '2026-10-06T00:00:00Z',
    },
  });
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function req(id: string, steps: string[] = []): string {
  return `---
schema: 1
id: ${id}
priority: high
source: brief
steps:
${steps.map((item) => `  - ${item}`).join('\n') || '  []'}
adrs: []
---

# ${id} — Requirement ${id}

## Requirement

fixture

## Rationale

fixture

## Acceptance

fixture
`;
}

function adr(id: string, status = 'accepted', steps: string[] = []): string {
  return `---
schema: 1
id: ${id}
status: ${status}
date: 2026-10-06
deciders:
  - team
supersedes: []
superseded_by: []
requirements: []
steps:
${steps.map((item) => `  - ${item}`).join('\n') || '  []'}
---

# ${id} — Decision ${id}

## Context

fixture

## Problem

fixture

## Decision

fixture

## Alternatives considered

fixture

## Consequences

fixture

## Security implications

fixture

## Data / migration implications

fixture

## Compatibility / operational implications

fixture
`;
}

function step(
  id: string,
  options: {
    priority?: string;
    status?: string;
    dependsOn?: string[];
    requirements?: string[];
    adrs?: string[];
    phase?: string;
    risks?: string[];
    planStatus?: string;
  } = {},
): string {
  const priority = options.priority ?? 'medium';
  const status = options.status ?? 'planned';
  const depends = options.dependsOn ?? [];
  const requirements = options.requirements ?? [];
  const adrs = options.adrs ?? [];
  const phase = options.phase ?? 'foundation';
  const risks = options.risks ?? ['none'];
  const planStatus = options.planStatus ?? 'not_planned';
  return `---
schema: 1
id: ${id}
status: ${status}
type: implementation
priority: ${priority}
phase: ${phase}
depends_on:
${depends.map((item) => `  - ${item}`).join('\n') || '  []'}
requirements:
${requirements.map((item) => `  - ${item}`).join('\n') || '  []'}
adrs:
${adrs.map((item) => `  - ${item}`).join('\n') || '  []'}
architecture_refs: []
risk_flags:
${risks.map((item) => `  - ${item}`).join('\n')}
plan:
  status: ${planStatus}
  revision: 0
  context_basis: null
  content_hash: null
  reviewed_report: null
  planned_at: null
---

# ${id} — Step ${id}

## Goal

fixture

## Context

fixture

## Scope

fixture

## Mutation policy

### Allowed

fixture

### Conditional

fixture

### Forbidden

fixture

## Out of scope

fixture

## Acceptance criteria

fixture

## Verification

fixture

## Deliverables

fixture

## Implementation plan

fixture

## Evidence


## Blocker / Failure reason


`;
}

function oq(id: string, affects: string[], status = 'open'): string {
  return `---
schema: 1
id: ${id}
status: ${status}
affects:
${affects.map((item) => `  - ${item}`).join('\n')}
created_at: 2026-10-06T00:00:00Z
resolved_at: null
---

# ${id} — Question ${id}

## Context

fixture

## Decision needed

fixture

## Resolution


`;
}

function prn(id: string): string {
  return `---
schema: 1
id: ${id}
status: active
severity: blocking
scope: project
superseded_by: null
requirements: []
adrs: []
---

# ${id} — Principle ${id}

## Rule

fixture

## Rationale

fixture

## Applies to

fixture

## Exceptions / approved deviation

fixture
`;
}

async function validFixture(root: string): Promise<void> {
  await write(root, 'docs/requirements/REQ-001-feature.md', req('REQ-001', ['STEP-001']));
  await write(root, 'docs/adr/ADR-001-decision.md', adr('ADR-001'));
  await write(root, 'planning/tasks/STEP-001.md', step('STEP-001', {
    priority: 'critical',
    requirements: ['REQ-001'],
  }));
  await write(root, 'docs/open-questions/OQ-001-choice.md', oq('OQ-001', ['STEP-001'], 'resolved'));
  await write(root, 'docs/principles/PRN-001-rule.md', prn('PRN-001'));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project state read models', () => {
  it('preserves graph diagnostics and missing nodes instead of inventing links', async () => {
    const root = await tempRoot();
    await validFixture(root);
    await write(root, 'planning/tasks/STEP-001.md', step('STEP-001', {
      priority: 'critical',
      requirements: ['REQ-001'],
      dependsOn: ['STEP-999'],
    }));

    const state = await buildProjectState(root);
    const graph = state.graph as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

    expect(state.status).toBe('PASS');
    expect(state.integrity).toBe('degraded');
    expect(graph.nodes.some((item) => item.id === 'MISSING:STEP-999' && item.status === 'missing')).toBe(true);
    expect(
      graph.edges.some(
        (item) => item.source === 'STEP-001' && item.target === 'MISSING:STEP-999' && item.relation === 'depends_on',
      ),
    ).toBe(true);
    expect(
      (state.diagnostics as Array<Record<string, unknown>>).some((item) => item.code === 'MISSING_REFERENCE'),
    ).toBe(true);

    await expect(writeProjections(root)).rejects.toBeInstanceOf(ProjectionDerivationError);
    const next = await resolveStepNext(root);
    expect(next.status).toBe('BLOCKED');
    expect(next.reasonCode).toBe('STEP_NEXT_STATE_INVALID');
  });

  it('builds deterministic traceability coverage from an injected completion fact provider', async () => {
    const root = await tempRoot();
    await validFixture(root);
    await write(root, 'planning/tasks/STEP-001.md', step('STEP-001', {
      status: 'completed',
      priority: 'critical',
      requirements: ['REQ-001'],
    }));

    const inventory = await buildArtifactInventory(root);
    const providers = {
      completion: async (stepId: string) => ({
        complete: stepId === 'STEP-001',
        proofHash: 'sha256:fixture',
        reasons: [],
      }),
    };

    const first = await buildTraceabilityCoverage(inventory, providers);
    const second = await buildTraceabilityCoverage(inventory, providers);
    expect(first).toEqual(second);
    expect(first.status).toBe('PASS');
    expect(first.metrics.verified).toBe(1);
    expect(first.requirements[0].status).toBe('verified');
  });

  it('rebuilds all tracked projections idempotently from canonical artifacts', async () => {
    const root = await tempRoot();
    await validFixture(root);
    const providers = {
      completion: async () => ({ complete: false, reasons: ['incomplete'] }),
    };

    const first = await writeProjections(root, providers);
    const second = await writeProjections(root, providers);

    expect(first).toEqual([
      'docs/requirements/SPEC.md',
      'docs/requirements/STATUS.md',
      'planning/PLAN.md',
      'planning/STATUS.md',
      'docs/OPEN_QUESTIONS.md',
    ]);
    expect(second).toEqual([]);
    expect(await validateProjections(root, providers)).toEqual([]);

    const roadmap = await readFile(path.join(root, 'planning/PLAN.md'), 'utf8');
    expect(roadmap).toContain('| STEP-001 | Step STEP-001 | implementation | critical | planned |');
  });

  it('exposes STEP LIST/SHOW plus stale-plan and affected-step facts through providers', async () => {
    const root = await tempRoot();
    await validFixture(root);
    const providers = {
      planFreshness: async (stepId: string) => ({
        status: stepId === 'STEP-001' ? ('stale' as const) : ('fresh' as const),
        causes: stepId === 'STEP-001'
          ? [{ component: 'REQ@REQ-001', change: 'changed' }]
          : [],
        action: stepId === 'STEP-001' ? 'STEP PLAN STEP-001' : null,
      }),
    };

    const listed = await stepList(root, providers);
    expect(listed.status).toBe('PASS');
    const row = (listed.steps as Array<Record<string, unknown>>)[0];
    expect(row.planFreshness).toBe('stale');
    expect(row.planRemediation).toBe('STEP PLAN STEP-001');

    const shown = await stepShow(root, '001', providers);
    expect(shown.status).toBe('PASS');
    expect((shown.step as Record<string, unknown>).id).toBe('STEP-001');

    const affected = await affectedSteps(root, ['REQ-001'], providers);
    expect(affected.affected).toEqual([
      {
        step: 'STEP-001',
        reasons: ['linked requirement changed: REQ-001'],
        plan: 'stale',
        causes: [{ component: 'REQ@REQ-001', change: 'changed' }],
        action: 'STEP PLAN STEP-001',
      },
    ]);

    const status = await projectStatus(root, providers);
    expect(status.status).toBe('PASS');
    expect((status.summary as Record<string, unknown>).stalePlans).toBe(1);
  });

  it('ranks STEP NEXT by continuity, lifecycle, priority, downstream impact, risk and roadmap order', async () => {
    const root = await tempRoot();
    await write(root, 'planning/tasks/STEP-001.md', step('STEP-001', { priority: 'high' }));
    await write(root, 'planning/tasks/STEP-002.md', step('STEP-002', {
      priority: 'high',
      dependsOn: ['STEP-001'],
    }));
    await write(root, 'planning/tasks/STEP-003.md', step('STEP-003', {
      priority: 'critical',
      risks: ['security-sensitive', 'public-api'],
    }));

    const ranked = await resolveStepNext(root);
    expect(ranked.status).toBe('PASS');
    expect(ranked.command).toBe('STEP PLAN STEP-003');
    expect((ranked.selected as Record<string, unknown>).source).toBe('fresh');

    const continuity = await resolveStepNext(root, {
      unresolvedExecutions: async () => [{
        executionId: 'exec-1',
        status: 'RESUME',
        command: 'STEP PLAN STEP-002',
      }],
    });
    expect(continuity.command).toBe('STEP PLAN STEP-002');
    expect(continuity.reasonCode).toBe('RESUME_STEP_EXECUTION');
  });

  it('blocks projection and STEP NEXT derivation on dependency cycles', async () => {
    const root = await tempRoot();
    await write(root, 'planning/tasks/STEP-001.md', step('STEP-001', { dependsOn: ['STEP-002'] }));
    await write(root, 'planning/tasks/STEP-002.md', step('STEP-002', { dependsOn: ['STEP-001'] }));

    const next = await resolveStepNext(root);
    expect(next.status).toBe('BLOCKED');
    expect(next.reasonCode).toBe('STEP_NEXT_STATE_INVALID');
    await expect(writeProjections(root)).rejects.toBeInstanceOf(ProjectionDerivationError);
  });
});
