import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DurableArtifactError,
  createDurableArtifact,
  validateProjectArtifacts,
} from '../src/core/artifacts/index.js';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-artifacts-'));
  roots.push(root);
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function sections(names: readonly string[], empty: ReadonlySet<string> = new Set()): string {
  return names
    .map((name) => `## ${name}\n\n${empty.has(name) ? '' : 'fixture'}\n`)
    .join('\n');
}

const reqSections = ['Requirement', 'Rationale', 'Acceptance'];
const adrSections = [
  'Context',
  'Problem',
  'Decision',
  'Alternatives considered',
  'Consequences',
  'Security implications',
  'Data / migration implications',
  'Compatibility / operational implications',
];
const stepSections = [
  'Goal',
  'Context',
  'Scope',
  'Mutation policy',
  'Out of scope',
  'Acceptance criteria',
  'Verification',
  'Deliverables',
  'Implementation plan',
  'Evidence',
  'Blocker / Failure reason',
];
const prnSections = ['Rule', 'Rationale', 'Applies to', 'Exceptions / approved deviation'];

async function writeTemplates(root: string): Promise<void> {
  await write(
    root,
    'docs/requirements/TEMPLATE.md',
    `---
schema: 1
id: REQ-NNN
priority: medium
source: brief
steps: []
adrs: []
---

# REQ-NNN — Template

${sections(reqSections)}
`,
  );
  await write(
    root,
    'docs/adr/TEMPLATE.md',
    `---
schema: 1
id: ADR-NNN
status: proposed
date: null
deciders: []
supersedes: []
superseded_by: []
requirements: []
steps: []
---

# ADR-NNN — Template

${sections(adrSections)}
`,
  );
  await write(
    root,
    'planning/tasks/TEMPLATE.md',
    `---
schema: 1
id: STEP-NNN
status: planned
type: implementation
priority: medium
phase: TBD
depends_on: []
requirements: []
adrs: []
architecture_refs: []
risk_flags:
  - none
plan:
  status: not_planned
  revision: 0
  context_basis: null
  content_hash: null
  reviewed_report: null
  planned_at: null
---

# STEP-NNN — Template

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


`,
  );
  await write(
    root,
    'docs/open-questions/TEMPLATE.md',
    `---
schema: 1
id: OQ-NNN
status: open
affects:
  - PROJECT
created_at: 2026-10-05T22:00:00Z
resolved_at: null
---

# OQ-NNN — Template

## Context

fixture

## Decision needed

fixture

## Resolution


`,
  );
  await write(
    root,
    'docs/principles/TEMPLATE.md',
    `---
schema: 1
id: PRN-NNN
status: active
severity: blocking
scope: project
superseded_by: null
requirements: []
adrs: []
---

# PRN-NNN — Template

${sections(prnSections)}
`,
  );
}

async function writeValidProject(root: string): Promise<void> {
  await writeConfig(root, DEFAULT_CONFIG);
  await writeTemplates(root);

  await write(
    root,
    'docs/requirements/REQ-001-feature.md',
    `---
schema: 1
id: REQ-001
priority: high
source: brief
steps:
  - STEP-001
adrs:
  - ADR-001
---

# REQ-001 — Feature

${sections(reqSections)}
`,
  );

  await write(
    root,
    'docs/adr/ADR-001-decision.md',
    `---
schema: 1
id: ADR-001
status: accepted
date: 2026-10-05
deciders:
  - team
supersedes: []
superseded_by: []
requirements:
  - REQ-001
steps:
  - STEP-001
---

# ADR-001 — Decision

${sections(adrSections)}
`,
  );

  await write(
    root,
    'planning/tasks/STEP-001.md',
    `---
schema: 1
id: STEP-001
status: planned
type: implementation
priority: high
phase: foundation
depends_on: []
requirements:
  - REQ-001
adrs:
  - ADR-001
architecture_refs: []
risk_flags:
  - none
plan:
  status: not_planned
  revision: 0
  context_basis: null
  content_hash: null
  reviewed_report: null
  planned_at: null
---

# STEP-001 — Implement

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


`,
  );

  await write(
    root,
    'docs/open-questions/OQ-001-choice.md',
    `---
schema: 1
id: OQ-001
status: resolved
affects:
  - STEP-001
created_at: 2026-10-05T21:00:00Z
resolved_at: 2026-10-05T21:30:00Z
---

# OQ-001 — Choice

## Context

fixture

## Decision needed

fixture

## Resolution

done
`,
  );

  await write(
    root,
    'docs/principles/PRN-001-rule.md',
    `---
schema: 1
id: PRN-001
status: active
severity: blocking
scope: project
superseded_by: null
requirements:
  - REQ-001
adrs:
  - ADR-001
---

# PRN-001 — Rule

${sections(prnSections)}
`,
  );

  await write(
    root,
    'planning/reviews/STEP-001/REVIEW-20261005T220000Z.md',
    `---
schema: 1
kind: step_review
step_id: STEP-001
verdict: pass
reviewer_role: reviewer
created_at: 2026-10-05T22:00:00Z
---

# STEP REVIEW STEP-001 — 2026-10-05 22:00

${sections(['Scope checked', 'Findings', 'Verdict rationale'])}
`,
  );

  await write(
    root,
    'planning/plan-reviews/STEP-001/PLAN-REVIEW-20261005T220100Z.md',
    `---
schema: 1
kind: planning_review
step_id: STEP-001
verdict: pass
reviewer_role: reviewer
finding_count: 0
context_basis: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
plan_content_hash: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
created_at: 2026-10-05T22:01:00Z
---

# Planning Review STEP-001 — 2026-10-05 22:01

${sections(['Scope checked', 'Findings', 'Verdict rationale'])}
`,
  );

  await write(
    root,
    'planning/init-reviews/INIT-REVIEW-20261005T220200Z.md',
    `---
schema: 1
kind: init_review
stage: requirements
verdict: pass
reviewer_role: reviewer
finding_count: 0
basis: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
created_at: 2026-10-05T22:02:00Z
---

# PROJECT INIT Review — requirements — 2026-10-05 22:02

${sections(['Scope checked', 'Findings', 'Verdict rationale'])}
`,
  );

  await write(
    root,
    'planning/audits/AUDIT-20261005T220300Z.md',
    `---
schema: 1
kind: audit
scope: project
mode: audit
created_at: 2026-10-05T22:03:00Z
result: complete
---

# Audit — 2026-10-05

${sections(['Sources checked', 'Actual state', 'Drift / findings', 'Evidence', 'Corrective actions'])}
`,
  );

  await write(
    root,
    'planning/releases/RELEASE-20261005T220400Z.md',
    `---
schema: 1
kind: release_check
target: v1.0.0
verdict: ready
created_at: 2026-10-05T22:04:00Z
---

# Release Check — 2026-10-05

${sections([
      'Requirements / scope',
      'Verification gates',
      'Security / migrations / compatibility',
      'Unresolved blockers',
      'Evidence',
    ])}
`,
  );

  await write(
    root,
    'planning/skill-searches/SKILL-SEARCH-20261005T220500Z.md',
    `---
schema: 1
kind: skill_search
query: formatter
status: complete
created_at: 2026-10-05T22:05:00Z
candidate_count: 1
---

# SKILL SEARCH — 2026-10-05 22:05

## Search strategy

fixture

## Ranking criteria

fixture

## Candidates

### #1 — formatter

- Repository: owner/repo
- Path: skills/formatter
- URL: https://example.invalid/repo
- Ref/commit inspected: abcdef
- License: MIT
- Why it fits: fixture
- Limitations: none
- Safety notes: reviewed
- Recommendation: use

## Rejected / notable alternatives

none

## Next command

SKILL INSTALL: #1
`,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release-owned artifact contracts', () => {
  it('validates a v0.10.4-shaped project through one Core service', async () => {
    const root = await tempRoot();
    await writeValidProject(root);

    const result = await validateProjectArtifacts(root);

    expect(result.status).toBe('PASS');
    expect(result.diagnostics).toEqual([]);
    expect(result.checked).toMatchObject({
      requirement: 1,
      adr: 1,
      step: 1,
      open_question: 1,
      principle: 1,
      step_review: 1,
      planning_review: 1,
      init_review: 1,
      audit: 1,
      release_check: 1,
      skill_search: 1,
      template: 5,
    });
  });

  it('returns typed diagnostics for invalid IDs, statuses, sections and references', async () => {
    const root = await tempRoot();
    await writeValidProject(root);

    await write(
      root,
      'docs/requirements/REQ-001-feature.md',
      `---
schema: 1
id: REQ-XYZ
priority: urgent
source: brief
steps:
  - STEP-999
adrs: []
---

# REQ-XYZ — Broken

## Requirement

fixture

## Rationale

fixture
`,
    );

    const adrPath = path.join(root, 'docs/adr/ADR-001-decision.md');
    const adr = await readFile(adrPath, 'utf8');
    await write(root, 'docs/adr/ADR-001-decision.md', adr.replace('status: accepted', 'status: invalid'));

    const oqPath = path.join(root, 'docs/open-questions/OQ-001-choice.md');
    const oq = await readFile(oqPath, 'utf8');
    await write(
      root,
      'docs/open-questions/OQ-001-choice.md',
      oq.replace(/## Decision needed\n\nfixture\n\n/, ''),
    );

    const result = await validateProjectArtifacts(root);

    expect(result.status).toBe('FAIL');
    expect(result.diagnostics.some((item) => item.code === 'ARTIFACT_ID')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'ARTIFACT_STATUS')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'ARTIFACT_SECTION')).toBe(true);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'ARTIFACT_REFERENCE' || item.code === 'ARTIFACT_REVERSE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('detects STEP dependency cycles and ADR supersession cycles deterministically', async () => {
    const root = await tempRoot();
    await writeValidProject(root);

    const step1 = await readFile(path.join(root, 'planning/tasks/STEP-001.md'), 'utf8');
    await write(
      root,
      'planning/tasks/STEP-001.md',
      step1.replace('depends_on: []', 'depends_on:\n  - STEP-002'),
    );
    await write(
      root,
      'planning/tasks/STEP-002.md',
      step1
        .replace(/STEP-001/g, 'STEP-002')
        .replace('depends_on: []', 'depends_on:\n  - STEP-001')
        .replace('requirements:\n  - REQ-001', 'requirements: []')
        .replace('adrs:\n  - ADR-001', 'adrs: []'),
    );

    const adr1 = await readFile(path.join(root, 'docs/adr/ADR-001-decision.md'), 'utf8');
    await write(
      root,
      'docs/adr/ADR-001-decision.md',
      adr1
        .replace('status: accepted', 'status: superseded')
        .replace('supersedes: []', 'supersedes:\n  - ADR-002')
        .replace('superseded_by: []', 'superseded_by:\n  - ADR-002'),
    );
    await write(
      root,
      'docs/adr/ADR-002-second.md',
      adr1
        .replace(/ADR-001/g, 'ADR-002')
        .replace('status: accepted', 'status: superseded')
        .replace('supersedes: []', 'supersedes:\n  - ADR-001')
        .replace('superseded_by: []', 'superseded_by:\n  - ADR-001')
        .replace('requirements:\n  - REQ-001', 'requirements: []')
        .replace('steps:\n  - STEP-001', 'steps: []'),
    );

    const result = await validateProjectArtifacts(root);
    expect(result.status).toBe('FAIL');
    expect(result.diagnostics.filter((item) => item.code === 'ARTIFACT_CYCLE').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects malformed durable report timestamp identity and candidate shape', async () => {
    const root = await tempRoot();
    await writeValidProject(root);

    await write(
      root,
      'planning/skill-searches/SKILL-SEARCH-20261005T220500Z.md',
      `---
schema: 1
kind: skill_search
query: formatter
status: complete
created_at: 2026-10-05T23:05:00Z
candidate_count: 2
---

# SKILL SEARCH — broken

## Search strategy

fixture

## Ranking criteria

fixture

## Candidates

### #2 — formatter

- Repository: owner/repo

## Rejected / notable alternatives

none

## Next command

none
`,
    );

    const result = await validateProjectArtifacts(root);
    expect(result.status).toBe('FAIL');
    expect(result.diagnostics.some((item) => item.code === 'ARTIFACT_REPORT_IDENTITY')).toBe(true);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'ARTIFACT_FIELD' && item.path.includes('SKILL-SEARCH-'),
      ),
    ).toBe(true);
  });

  it('creates durable artifacts exclusively and never overwrites history', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'planning', 'audits', 'AUDIT-20261005T220000Z.md');

    await createDurableArtifact(root, target, 'first');
    await expect(createDurableArtifact(root, target, 'second')).rejects.toBeInstanceOf(DurableArtifactError);
    await expect(readFile(target, 'utf8')).resolves.toBe('first');
  });
});
