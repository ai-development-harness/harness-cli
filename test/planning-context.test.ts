import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import {
  ContextContractError,
  contentHash,
  dependencyLayers,
  implementationPrerequisiteFailures,
  normalizeExecutionGroups,
  planContentHash,
  planStaleness,
  planningContextBasis,
  planningContextFingerprints,
  stableHash,
  topologicalGroupOrder,
  buildContextContract,
  validateContextExpansion,
  latestPlanningReviewFor,
  validatePlanningState,
} from '../src/core/planning/index.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'harness-planning-'));
  roots.push(value);
  await writeConfig(value, {
    ...DEFAULT_CONFIG,
    project: { initialized: true, name: 'Fixture', initializedAt: '2026-10-06T00:00:00Z' },
  });
  return value;
}

async function put(projectRoot: string, relative: string, content: string): Promise<void> {
  const target = path.join(projectRoot, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function requirement(id = 'REQ-001', priority = 'high', body = 'Need capability'): string {
  return `---
schema: 1
id: ${id}
priority: ${priority}
source: brief
steps:
  - STEP-001
adrs: []
---

# ${id} — Requirement

## Requirement

${body}

## Rationale

Reason

## Acceptance

Accepted
`;
}

function adr(id = 'ADR-001', status = 'accepted'): string {
  return `---
schema: 1
id: ${id}
status: ${status}
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

# ${id} — Decision

## Context

Context

## Problem

Problem

## Decision

Decision

## Alternatives considered

Alternative

## Consequences

Consequences

## Security implications

None

## Data / migration implications

None

## Compatibility / operational implications

None
`;
}

function step(options: {
  status?: string;
  priority?: string;
  phase?: string;
  requirements?: string[];
  adrs?: string[];
  dependencies?: string[];
  riskFlags?: string[];
  implementation?: string;
  plan?: Record<string, unknown>;
} = {}): string {
  const plan = options.plan ?? {
    status: 'not_planned',
    revision: 0,
    context_basis: null,
    context_components: [],
    content_hash: null,
    reviewed_report: null,
    planned_at: null,
  };
  const yamlValue = (value: unknown, indent = 2): string => {
    if (value === null) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return '\n' + value.map((item) => `${' '.repeat(indent)}- ${String(item)}`).join('\n');
    }
    if (typeof value === 'object' && value !== null) {
      return '\n' + Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => {
          const rendered = yamlValue(item, indent + 2);
          return rendered.startsWith('\n')
            ? `${' '.repeat(indent)}${key}:${rendered}`
            : `${' '.repeat(indent)}${key}: ${rendered}`;
        })
        .join('\n');
    }
    return String(value);
  };
  const planYaml = Object.entries(plan)
    .map(([key, value]) => {
      const rendered = yamlValue(value, 4);
      return rendered.startsWith('\n') ? `  ${key}:${rendered}` : `  ${key}: ${rendered}`;
    })
    .join('\n');

  const list = (values: string[]) => values.length === 0 ? '[]' : `\n${values.map((item) => `  - ${item}`).join('\n')}`;

  return `---
schema: 1
id: STEP-001
status: ${options.status ?? 'planned'}
type: implementation
priority: ${options.priority ?? 'high'}
phase: ${options.phase ?? 'foundation'}
depends_on: ${list(options.dependencies ?? [])}
requirements: ${list(options.requirements ?? ['REQ-001'])}
adrs: ${list(options.adrs ?? ['ADR-001'])}
architecture_refs: []
risk_flags: ${list(options.riskFlags ?? ['none'])}
plan:
${planYaml}
---

# STEP-001 — Implement

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

Accepted

## Verification

Run tests

## Deliverables

Code

## Implementation plan

${options.implementation ?? '### 1. Implement\n\nDo it.'}

## Evidence


## Blocker / Failure reason


`;
}

function dependencyStep(): string {
  return step({ requirements: [], adrs: [], dependencies: [] })
    .replace(/STEP-001/g, 'STEP-002')
    .replace('# STEP-002 — Implement', '# STEP-002 — Dependency');
}

function oq(status = 'resolved'): string {
  return `---
schema: 1
id: OQ-001
status: ${status}
affects:
  - STEP-001
created_at: 2026-10-06T00:00:00Z
resolved_at: null
---

# OQ-001 — Choice

## Context

Context

## Decision needed

Decision?

## Resolution

Resolved
`;
}

function principle(severity = 'blocking', rule = 'Keep compatibility'): string {
  return `---
schema: 1
id: PRN-001
status: active
severity: ${severity}
scope: project
superseded_by: null
requirements:
  - REQ-001
adrs:
  - ADR-001
---

# PRN-001 — Compatibility

## Rule

${rule}

## Rationale

Rationale

## Applies to

Project

## Exceptions / approved deviation

None
`;
}

async function baseFixture(projectRoot: string): Promise<void> {
  await put(projectRoot, 'docs/requirements/REQ-001-feature.md', requirement());
  await put(projectRoot, 'docs/adr/ADR-001-decision.md', adr());
  await put(projectRoot, 'planning/tasks/STEP-001.md', step());
  await put(projectRoot, 'docs/open-questions/OQ-001-choice.md', oq());
  await put(projectRoot, 'docs/principles/PRN-001-compat.md', principle());
  await put(projectRoot, 'docs/architecture.md', '# Architecture\n\n## Relevant Section\n\nStable.\n\n## Other\n\nUnrelated.\n');
}

function planningReview(
  stepId: string,
  basis: string,
  content: string,
  verdict: 'pass' | 'blocked',
  findingCount: number,
): string {
  return `---
schema: 1
kind: planning_review
step_id: ${stepId}
verdict: ${verdict}
reviewer_role: reviewer
finding_count: ${findingCount}
context_basis: ${basis}
plan_content_hash: ${content}
created_at: 2026-10-06T01:00:00Z
---

# Planning Review ${stepId} — 2026-10-06 01:00

## Scope checked

scope

## Findings

${findingCount === 0 ? 'none' : 'finding'}

## Verdict rationale

reason
`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('planning/context contracts', () => {
  it('matches v0.10.4 stable/content hash canonicalization', () => {
    expect(stableHash({ b: [2, { x: 'тест' }], a: 1 }))
      .toBe('sha256:3cb245342095e87dde81d492a6277e0ea850435997b41fc49ae7522570bb7fa0');
    expect(contentHash('\n hello  \r\nworld\t \n\n'))
      .toBe('sha256:e8d35305acc97a1aa0019599b14f468dc1e312162299d44d39ef8f2cf014586b');
  });

  it('preserves execution-group DAG, layers and conflict safety', () => {
    const groups = normalizeExecutionGroups([
      {
        id: 'foundation',
        title: 'Foundation',
        steps: [1],
        dependsOn: [],
        mutationPaths: ['src/core'],
        verificationResponsibilities: ['core tests'],
        parallel: false,
      },
      {
        id: 'api',
        title: 'API',
        steps: [2],
        dependsOn: ['foundation'],
        mutationPaths: ['src/api'],
        verificationResponsibilities: ['api tests'],
        parallel: true,
      },
      {
        id: 'ui',
        title: 'UI',
        steps: [3],
        dependsOn: ['foundation'],
        mutationPaths: ['src/ui'],
        verificationResponsibilities: ['ui tests'],
        parallel: true,
      },
      {
        id: 'integration',
        title: 'Integration',
        steps: [4],
        dependsOn: ['api', 'ui'],
        mutationPaths: ['test/integration'],
        verificationResponsibilities: ['integration tests'],
        parallel: false,
      },
    ], 4);
    expect(topologicalGroupOrder(groups)).toEqual(['foundation', 'api', 'ui', 'integration']);
    expect(dependencyLayers(groups)).toEqual([['foundation'], ['api', 'ui'], ['integration']]);

    expect(() => normalizeExecutionGroups([
      {
        id: 'a',
        title: 'A',
        steps: [1],
        dependsOn: [],
        mutationPaths: ['src'],
        verificationResponsibilities: ['a'],
        parallel: true,
      },
      {
        id: 'b',
        title: 'B',
        steps: [2],
        dependsOn: [],
        mutationPaths: ['src/api'],
        verificationResponsibilities: ['b'],
        parallel: true,
      },
    ], 2)).toThrow(/overlapping mutation surfaces/);

    expect(() => normalizeExecutionGroups([
      {
        id: 'a',
        title: 'A',
        steps: [1],
        dependsOn: ['b'],
        mutationPaths: ['a'],
        verificationResponsibilities: ['a'],
        parallel: false,
      },
      {
        id: 'b',
        title: 'B',
        steps: [2],
        dependsOn: ['a'],
        mutationPaths: ['b'],
        verificationResponsibilities: ['b'],
        parallel: false,
      },
    ], 2)).toThrow(/dependency cycle/);
  });

  it('fingerprints semantic contracts but ignores lifecycle/scheduling metadata', async () => {
    const projectRoot = await root();
    await baseFixture(projectRoot);

    const basisA = await planningContextBasis(projectRoot, 'STEP-001');
    await put(projectRoot, 'docs/requirements/REQ-001-feature.md', requirement('REQ-001', 'low'));
    const basisMetadata = await planningContextBasis(projectRoot, 'STEP-001');
    expect(basisMetadata).toBe(basisA);

    await put(projectRoot, 'planning/tasks/STEP-001.md', step({ status: 'in_progress', priority: 'low', phase: 'later' }));
    expect(await planningContextBasis(projectRoot, 'STEP-001')).toBe(basisA);

    await put(projectRoot, 'docs/requirements/REQ-001-feature.md', requirement('REQ-001', 'low', 'Semantic change'));
    const basisSemantic = await planningContextBasis(projectRoot, 'STEP-001');
    expect(basisSemantic).not.toBe(basisA);

    await put(projectRoot, 'docs/principles/PRN-001-compat.md', principle('advisory', 'Changed advisory'));
    const withoutBlocking = await planningContextBasis(projectRoot, 'STEP-001');
    await put(projectRoot, 'docs/principles/PRN-001-compat.md', principle('blocking', 'Changed blocking'));
    expect(await planningContextBasis(projectRoot, 'STEP-001')).not.toBe(withoutBlocking);
  });

  it('returns component-level stale causes from one coherent snapshot', async () => {
    const projectRoot = await root();
    await baseFixture(projectRoot);
    const fingerprints = await planningContextFingerprints(projectRoot, 'STEP-001');
    const initialContent = await planContentHash(projectRoot, 'STEP-001');

    await put(projectRoot, 'planning/tasks/STEP-001.md', step({
      plan: {
        status: 'ready',
        revision: 1,
        context_basis: fingerprints.basis,
        context_components: [...fingerprints.components],
        content_hash: initialContent,
        reviewed_report: 'planning/plan-reviews/STEP-001/PLAN-REVIEW-20261006T010000Z.md',
        planned_at: '2026-10-06T01:00:00Z',
      },
    }));
    expect((await planStaleness(projectRoot, 'STEP-001')).status).toBe('fresh');

    await put(projectRoot, 'docs/requirements/REQ-001-feature.md', requirement('REQ-001', 'high', 'Changed requirement'));
    const stale = await planStaleness(projectRoot, 'STEP-001');
    expect(stale.status).toBe('stale');
    expect(stale.causes).toContainEqual({ component: 'REQ@REQ-001', change: 'changed' });
    expect(stale.action).toBe('STEP PLAN STEP-001');
  });

  it('builds different minimal manifests for planner/implementer/reviewer without unrelated preload', async () => {
    const projectRoot = await root();
    await baseFixture(projectRoot);
    await put(projectRoot, 'docs/unrelated.md', '# Unrelated\n');

    const planner = await buildContextContract(projectRoot, 'STEP-001', 'planner');
    const implementer = await buildContextContract(projectRoot, 'STEP-001', 'implementer');
    const reviewer = await buildContextContract(projectRoot, 'STEP-001', 'reviewer');

    expect(planner.role).toBe('planner');
    expect(implementer.role).toBe('implementer');
    expect(reviewer.role).toBe('reviewer');
    expect(planner).not.toEqual(reviewer);
    expect(planner.runtimeNeutral).toBe(true);
    expect((planner.metrics as Record<string, unknown>).fullRepositoryPreload).toBe(false);

    const plannerRequired = planner.required as Array<Record<string, unknown>>;
    const implementerRequired = implementer.required as Array<Record<string, unknown>>;
    const reviewerRequired = reviewer.required as Array<Record<string, unknown>>;
    const plannerStep = plannerRequired.find((item) => item.artifact === 'STEP-001')!;
    const reviewerStep = reviewerRequired.find((item) => item.artifact === 'STEP-001')!;
    expect(plannerStep.sections).toContain('Context');
    expect(plannerStep.sections).not.toContain('Evidence');
    expect(reviewerStep.sections).toContain('Evidence');
    expect(plannerRequired.some((item) => item.artifact === 'PRN-001')).toBe(true);
    expect(implementerRequired.some((item) => item.artifact === 'PRN-001')).toBe(false);
    expect(JSON.stringify(planner)).not.toContain('docs/unrelated.md');

    await put(projectRoot, 'src/extra.ts', 'export {};\n');
    await expect(validateContextExpansion(projectRoot, 'src/extra.ts', 'needed for boundary'))
      .resolves.toMatchObject({ status: 'PASS', path: 'src/extra.ts' });
    await put(projectRoot, '.harness/tools/internal.py', 'pass\n');
    await expect(validateContextExpansion(projectRoot, '.harness/tools/internal.py', 'try'))
      .rejects.toBeInstanceOf(ContextContractError);
  });

  it('fails closed on a missing required canonical link', async () => {
    const projectRoot = await root();
    await baseFixture(projectRoot);
    await put(projectRoot, 'planning/tasks/STEP-001.md', step({ requirements: ['REQ-999'] }));

    await expect(planningContextBasis(projectRoot, 'STEP-001')).rejects.toThrow(/REQ-999/);
    await expect(buildContextContract(projectRoot, 'STEP-001', 'planner')).rejects.toThrow(/REQ-999/);
  });

  it('requires exact PASS planning review and dependency completion facts before IMPLEMENT', async () => {
    const projectRoot = await root();
    await baseFixture(projectRoot);
    await put(projectRoot, 'planning/tasks/STEP-002.md', dependencyStep());
    await put(projectRoot, 'planning/tasks/STEP-001.md', step({ dependencies: ['STEP-002'] }));

    const fingerprints = await planningContextFingerprints(projectRoot, 'STEP-001');
    const content = await planContentHash(projectRoot, 'STEP-001');
    const reportRel = 'planning/plan-reviews/STEP-001/PLAN-REVIEW-20261006T010000Z.md';
    await put(projectRoot, reportRel, planningReview('STEP-001', fingerprints.basis, content, 'pass', 0));
    await put(projectRoot, 'planning/tasks/STEP-001.md', step({
      dependencies: ['STEP-002'],
      plan: {
        status: 'ready',
        revision: 1,
        context_basis: fingerprints.basis,
        context_components: [...fingerprints.components],
        content_hash: content,
        reviewed_report: reportRel,
        planned_at: '2026-10-06T01:00:00Z',
      },
    }));

    const withoutProof = await implementationPrerequisiteFailures(projectRoot, 'STEP-001');
    expect(withoutProof).toContain('dependency-unprovable:STEP-002:completion-proof-provider-unavailable');

    const withProof = await implementationPrerequisiteFailures(projectRoot, 'STEP-001', {
      completion: async () => ({ complete: true, proofHash: 'sha256:proof', reasons: [] }),
    });
    expect(withProof).toEqual([]);

    await put(
      projectRoot,
      'planning/plan-reviews/STEP-001/PLAN-REVIEW-20261006T010100Z.md',
      planningReview('STEP-001', fingerprints.basis, content, 'blocked', 1).replace(
        '2026-10-06T01:00:00Z',
        '2026-10-06T01:01:00Z',
      ),
    );
    expect(await latestPlanningReviewFor(projectRoot, 'STEP-001', fingerprints.basis, content)).toBeNull();
  });

  it('validates Ready fingerprints, groups and semantic review linkage', async () => {
    const projectRoot = await root();
    await baseFixture(projectRoot);
    const fingerprints = await planningContextFingerprints(projectRoot, 'STEP-001');

    const implementation = '### 1. Core\n\nDo core.\n\n### 2. UI\n\nDo UI.';
    await put(projectRoot, 'planning/tasks/STEP-001.md', step({
      implementation,
      plan: {
        status: 'draft',
        revision: 1,
        context_basis: null,
        context_components: [],
        content_hash: null,
        reviewed_report: null,
        planned_at: null,
        execution_groups: {
          core: {
            title: 'Core',
            steps: [1],
            dependsOn: [],
            mutationPaths: ['src/core'],
            verificationResponsibilities: ['core tests'],
            parallel: true,
          },
          ui: {
            title: 'UI',
            steps: [2],
            dependsOn: [],
            mutationPaths: ['src/ui'],
            verificationResponsibilities: ['ui tests'],
            parallel: true,
          },
        },
      },
    }));
    const content = await planContentHash(projectRoot, 'STEP-001');
    const reportRel = 'planning/plan-reviews/STEP-001/PLAN-REVIEW-20261006T010000Z.md';
    await put(projectRoot, reportRel, planningReview('STEP-001', fingerprints.basis, content, 'pass', 0));
    await put(projectRoot, 'planning/tasks/STEP-001.md', step({
      implementation,
      plan: {
        status: 'ready',
        revision: 1,
        context_basis: fingerprints.basis,
        context_components: [...fingerprints.components],
        content_hash: content,
        reviewed_report: reportRel,
        planned_at: '2026-10-06T01:00:00Z',
        execution_groups: {
          core: {
            title: 'Core',
            steps: [1],
            dependsOn: [],
            mutationPaths: ['src/core'],
            verificationResponsibilities: ['core tests'],
            parallel: true,
          },
          ui: {
            title: 'UI',
            steps: [2],
            dependsOn: [],
            mutationPaths: ['src/ui'],
            verificationResponsibilities: ['ui tests'],
            parallel: true,
          },
        },
      },
    }));

    expect(await validatePlanningState(projectRoot)).toEqual({ schemaVersion: 1, status: 'PASS', errors: [] });

    await put(projectRoot, 'docs/requirements/REQ-001-feature.md', requirement('REQ-001', 'high', 'Changed after review'));
    const invalid = await validatePlanningState(projectRoot);
    expect(invalid.status).toBe('FAIL');
    expect(invalid.errors.some((item) => item.includes('context_basis is stale'))).toBe(true);
  });
});
