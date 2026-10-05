import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BaselineCommand {
  domain: string;
  operation: string;
  canonical: string;
  dispatch: 'deterministic' | 'semantic';
  reasoning: 'none' | 'required' | 'conditional';
  chainAllowed: boolean;
  target: string;
  input: string;
}

interface ParityCase {
  id: string;
  behavior: string;
  plannedIssue: number | null;
  sourceTests: string[];
  templateSources: string[];
  targetCoreModule: string;
  cutoverCondition: string;
}

const fixturePath = fileURLToPath(
  new URL('./fixtures/extraction-baseline-v0.10.4.json', import.meta.url),
);
const baseline = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  schemaVersion: number;
  source: {
    repository: string;
    commit: string;
    harnessRelease: string;
    floatingReferenceAllowed: boolean;
    sourceAnchors: Array<{ path: string; blobSha: string; size: number }>;
  };
  intentionalThinArchitectureChanges: Array<{ id: string }>;
  commandModel: {
    count: number;
    authorityContract: Record<string, unknown>;
    validationOrder: string[];
    domains: Record<string, { transitions: unknown[] }>;
    commands: BaselineCommand[];
    reasoningCommandCount: number;
  };
  artifactContracts: {
    canonicalArtifacts: string[];
    durableReportKinds: string[];
    projectionKinds: string[];
    reviewVerdicts: string[];
    findingCategories: string[];
    immutabilityRule: string;
  };
  executionStateContract: {
    schemaVersion: number;
    sourceStorage: string;
    targetStorage: string;
    modes: string[];
    executionStatuses: string[];
    commandResults: string[];
    resolverStatuses: string[];
    bounds: {
      recentTerminals: number;
      currentDetailsBytes: number;
      intentBasisBytes: number;
      progressTelemetrySamples: number;
    };
    invariants: string[];
  };
  runtimeAdapterContract: {
    methods: string[];
    capabilities: string[];
    events: string[];
    adapters: string[];
  };
  selfTests: { count: number; discoveryRule: string; files: string[] };
  parityCases: ParityCase[];
  criticalNegativeCases: Array<{ id: string; sourceTests: string[] }>;
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

describe('Harness v0.10.4 extraction baseline', () => {
  it('is pinned to an immutable upstream snapshot instead of floating main', () => {
    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.source).toMatchObject({
      repository: 'ai-development-harness/ai-development-harness-template',
      commit: '9f4aa325154253ab72a8c5940e988046ae872c99',
      harnessRelease: '0.10.4',
      floatingReferenceAllowed: false,
    });

    expect(baseline.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.source.sourceAnchors.length).toBeGreaterThanOrEqual(30);
    for (const anchor of baseline.source.sourceAnchors) {
      expect(anchor.blobSha, anchor.path).toMatch(/^[0-9a-f]{40}$/);
      expect(anchor.size, anchor.path).toBeGreaterThan(0);
    }
  });

  it('captures all 32 canonical commands and the closed authority/validation contract', () => {
    expect(baseline.commandModel.count).toBe(32);
    expect(baseline.commandModel.commands).toHaveLength(32);
    expect(unique(baseline.commandModel.commands.map((command) => command.canonical))).toHaveLength(32);
    expect(baseline.commandModel.reasoningCommandCount).toBe(32);
    expect(baseline.commandModel.validationOrder).toEqual([
      'tokenize',
      'normalize',
      'transition-table',
      'runtime-preconditions',
      'dispatch',
    ]);
    expect(baseline.commandModel.authorityContract).toMatchObject({
      semanticResult: 'proposal',
      executionStateCommit: 'dispatcher',
      transitionCommit: 'dispatcher',
      canonicalArtifactCommit: 'deterministic-writer',
      sideEffectCommit: 'deterministic-action',
    });

    const domainCounts = Object.fromEntries(
      Object.entries(
        baseline.commandModel.commands.reduce<Record<string, number>>((acc, command) => {
          acc[command.domain] = (acc[command.domain] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(domainCounts).toEqual({
      GIT: 6,
      GITHUB: 1,
      HARNESS: 7,
      PROJECT: 4,
      RELEASE: 1,
      SKILL: 3,
      STEP: 10,
    });

    expect(baseline.commandModel.domains.STEP.transitions).toHaveLength(4);
    expect(baseline.commandModel.domains.HARNESS.transitions).toHaveLength(1);
    expect(baseline.commandModel.domains.GIT.transitions).toHaveLength(5);
  });

  it('keeps deterministic and semantic command boundaries explicit', () => {
    for (const command of baseline.commandModel.commands) {
      if (command.reasoning === 'none') {
        expect(command.dispatch, command.canonical).toBe('deterministic');
      }
    }

    expect(
      baseline.commandModel.commands.find((command) => command.canonical === 'STEP RUN STEP-NNN'),
    ).toMatchObject({ reasoning: 'conditional', dispatch: 'semantic' });
    expect(
      baseline.commandModel.commands.find((command) => command.canonical === 'GIT PUSH'),
    ).toMatchObject({ reasoning: 'conditional', dispatch: 'semantic' });
  });

  it('captures project artifact/report/projection contracts without treating projections as canonical state', () => {
    expect(baseline.artifactContracts.canonicalArtifacts).toEqual(['REQ', 'ADR', 'STEP', 'OQ', 'PRN']);
    expect(baseline.artifactContracts.durableReportKinds).toContain('implementation-review');
    expect(baseline.artifactContracts.durableReportKinds).toContain('planning-review');
    expect(baseline.artifactContracts.projectionKinds).toEqual(
      expect.arrayContaining(['roadmap', 'project-status', 'open-questions-index']),
    );
  });

  it('captures execution-state and immutable review contracts explicitly', () => {
    expect(baseline.artifactContracts.reviewVerdicts).toEqual(['pass', 'fail', 'blocked']);
    expect(baseline.artifactContracts.findingCategories).toEqual([
      'implementation',
      'evidence',
      'contract',
    ]);
    expect(baseline.artifactContracts.immutabilityRule).toContain('cannot be overwritten');

    expect(baseline.executionStateContract).toMatchObject({
      schemaVersion: 2,
      sourceStorage: '.harness/local/execution/execution-status.json',
      targetStorage: 'git-private ai-harness',
      modes: ['single', 'chain', 'orchestration'],
      executionStatuses: ['running', 'complete', 'blocked'],
      commandResults: ['SUCCESS', 'PASS', 'FAIL', 'BLOCKED'],
      resolverStatuses: ['RESUME', 'NEXT', 'DONE', 'BLOCKED', 'NOT_FOUND'],
      bounds: {
        recentTerminals: 100,
        currentDetailsBytes: 16_384,
        intentBasisBytes: 16_384,
        progressTelemetrySamples: 8,
      },
    });
    expect(baseline.executionStateContract.invariants).toEqual(
      expect.arrayContaining([
        expect.stringContaining('executionId'),
        expect.stringContaining('monotonic'),
        expect.stringContaining('intent basis'),
      ]),
    );
  });

  it('captures the exact discoverable synthetic self-test inventory without executing upstream scripts', () => {
    expect(baseline.selfTests.discoveryRule).toBe('.harness/tools/*-self-test.py');
    expect(baseline.selfTests.count).toBe(42);
    expect(baseline.selfTests.files).toHaveLength(42);
    expect(unique(baseline.selfTests.files)).toHaveLength(42);
    expect([...baseline.selfTests.files].sort()).toEqual(baseline.selfTests.files);
    for (const name of baseline.selfTests.files) expect(name).toMatch(/-self-test\.py$/);
  });

  it('defines stable parity case IDs mapped to future Core ownership and upstream tests', () => {
    expect(baseline.parityCases.length).toBeGreaterThanOrEqual(10);
    expect(unique(baseline.parityCases.map((item) => item.id))).toHaveLength(
      baseline.parityCases.length,
    );

    const selfTests = new Set(baseline.selfTests.files);
    for (const item of baseline.parityCases) {
      expect(item.id).toMatch(/^PARITY-[A-Z]+-\d{3}$/);
      expect(item.templateSources.length, item.id).toBeGreaterThan(0);
      expect(item.targetCoreModule, item.id).toMatch(/^core\//);
      expect(item.cutoverCondition.length, item.id).toBeGreaterThan(20);
      for (const test of item.sourceTests) {
        expect(selfTests.has(test), `${item.id}: ${test}`).toBe(true);
      }
    }

    expect(baseline.parityCases.find((item) => item.id === 'PARITY-UPDATE-010')?.behavior).toBe(
      'intentional-architecture-change',
    );
    expect(
      baseline.parityCases.find((item) => item.id === 'PARITY-RUNTIME-011')?.behavior,
    ).toBe('contract-only-deferred-implementation');
  });

  it('pins critical negative cases to existing upstream synthetic tests', () => {
    expect(baseline.criticalNegativeCases.length).toBeGreaterThanOrEqual(10);
    expect(unique(baseline.criticalNegativeCases.map((item) => item.id))).toHaveLength(
      baseline.criticalNegativeCases.length,
    );
    const selfTests = new Set(baseline.selfTests.files);
    for (const item of baseline.criticalNegativeCases) {
      expect(item.id).toMatch(/^NEG-[A-Z0-9-]+$/);
      expect(item.sourceTests.length, item.id).toBeGreaterThan(0);
      for (const test of item.sourceTests) {
        expect(selfTests.has(test), `${item.id}: ${test}`).toBe(true);
      }
    }
  });

  it('records intentional thin-architecture deltas separately from semantic parity', () => {
    expect(baseline.intentionalThinArchitectureChanges.map((item) => item.id)).toEqual([
      'THIN-001',
      'THIN-002',
      'THIN-003',
    ]);
    expect(baseline.runtimeAdapterContract.adapters).toEqual(['codex', 'claude']);
    expect(baseline.runtimeAdapterContract.methods).toEqual([
      'getIdentity',
      'getCapabilities',
      'getAccount',
      'start',
      'resume',
      'cancel',
      'status',
    ]);
  });
});
