import { describe, expect, it, vi } from 'vitest';
import { ProtocolEngine } from '../src/core/engine/index.js';
import type {
  ProtocolEnginePorts,
  ProtocolExecutionAdapter,
} from '../src/core/engine/index.js';
import type { ExecutionRecord } from '../src/core/execution/index.js';
import { parseCanonicalCommand, validateCommandText } from '../src/core/protocol/index.js';

function record(rootCommand: string, command: string, mode: ExecutionRecord['mode'] = 'single'): ExecutionRecord {
  return {
    executionId: 'exec-test',
    ordinal: 1,
    mode,
    requestedCommand: rootCommand,
    rootCommand,
    sequence: validateCommandText(rootCommand).valid
      ? validateCommandText(rootCommand).normalized
      : [command],
    currentIndex: mode === 'orchestration' ? null : 0,
    status: 'running',
    current: {
      command,
      status: 'running',
      result: null,
      attempt: 1,
      startedAt: '2026-10-06T00:00:00.000Z',
      completedAt: null,
      context: {},
    },
    notExecuted: [],
    fixReviewCycles: 0,
    maxFixReviewCycles: 3,
    startedAt: '2026-10-06T00:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

function fixture(rootCommand: string, options: { orchestration?: boolean } = {}) {
  let current = record(
    rootCommand,
    rootCommand,
    options.orchestration ? 'orchestration' : 'single',
  );
  let done = false;

  const execution: ProtocolExecutionAdapter = {
    startExecution: vi.fn(async () => current),
    currentExecution: vi.fn(async () =>
      current.status === 'running' ? current : null
    ),
    beginCommand: vi.fn(async (_projectRoot, _root, command) => {
      current = { ...current, current: { ...current.current, command, status: 'running', result: null } };
      return current;
    }),
    resolveRoot: vi.fn(async () => {
      if (done) return { status: 'DONE' as const, executionId: current.executionId, rootCommand, command: null, reasonCode: 'EXECUTION_COMPLETE' };
      if (current.mode === 'orchestration' && current.current.command === rootCommand) {
        const parsed = parseCanonicalCommand(rootCommand);
        return {
          status: 'NEXT' as const,
          executionId: current.executionId,
          rootCommand,
          command: `STEP PLAN ${parsed.valid ? parsed.target : 'STEP-001'}`,
          reasonCode: 'ORCHESTRATION_START',
        };
      }
      return { status: 'RESUME' as const, executionId: current.executionId, rootCommand, command: current.current.command, reasonCode: 'INTERRUPTED_COMMAND' };
    }),
    completeCurrent: vi.fn(async (_projectRoot, _root, result) => {
      current.current = { ...current.current, status: result === 'BLOCKED' ? 'blocked' : 'complete', result };
      if (current.mode === 'single') done = true;
      else if (current.mode === 'orchestration' && current.current.command.startsWith('STEP PLAN ')) done = true;
      return current;
    }),
    blockExecution: vi.fn(async () => {
      done = true;
      current.status = 'blocked';
      return current;
    }),
  };

  const ports: ProtocolEnginePorts = {
    deterministicHandler: vi.fn(async () => ({ result: 'SUCCESS' })),
    runtimePrecondition: vi.fn(async () => ({ ok: true })),
    conditionalFastPath: vi.fn(async () => null),
    commitSemanticProposal: vi.fn(async () => ({ result: 'SUCCESS' })),
  };

  return { execution, ports };
}

describe('ProtocolEngine', () => {
  it('fails structural validation before creating execution state', async () => {
    const { execution, ports } = fixture('PROJECT STATUS');
    const engine = new ProtocolEngine('/project', ports, { execution });
    const result = await engine.start('STEP PLAN STEP-001 > GIT PUSH');
    expect(result).toMatchObject({ kind: 'blocked', reasonCode: 'DOMAIN_MISMATCH' });
    expect(execution.startExecution).not.toHaveBeenCalled();
  });

  it('runs reasoning.mode=none through deterministic handler without semantic runtime', async () => {
    const { execution, ports } = fixture('PROJECT STATUS');
    const engine = new ProtocolEngine('/project', ports, { execution });
    const result = await engine.start('PROJECT STATUS');
    expect(result).toMatchObject({ kind: 'terminal', status: 'DONE' });
    expect(ports.deterministicHandler).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'project-status', command: 'PROJECT STATUS' }),
    );
    expect(ports.commitSemanticProposal).not.toHaveBeenCalled();
  });

  it('returns exact semantic handoff and commits proposal only through Core boundary', async () => {
    const { execution, ports } = fixture('STEP PLAN STEP-001');
    const engine = new ProtocolEngine('/project', ports, { execution });
    const handoff = await engine.start('STEP PLAN STEP-001');
    expect(handoff).toMatchObject({
      kind: 'semantic-handoff',
      executionId: 'exec-test',
      command: 'STEP PLAN STEP-001',
      requiredSkill: 'plan-step',
      contextPhase: 'plan',
    });
    expect(ports.commitSemanticProposal).not.toHaveBeenCalled();

    const result = await engine.completeSemantic(
      handoff as Extract<typeof handoff, { kind: 'semantic-handoff' }>,
      { plan: 'proposal' },
    );
    expect(ports.commitSemanticProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'exec-test',
        command: 'STEP PLAN STEP-001',
        proposal: { plan: 'proposal' },
      }),
    );
    expect(execution.completeCurrent).toHaveBeenCalledWith(
      '/project',
      'STEP PLAN STEP-001',
      'SUCCESS',
      expect.objectContaining({ expectedExecutionId: 'exec-test' }),
    );
    expect(result).toMatchObject({ kind: 'terminal', status: 'DONE' });
  });

  it('rejects stale semantic completion before deterministic commit is invoked', async () => {
    const { execution, ports } = fixture('STEP PLAN STEP-001');
    const engine = new ProtocolEngine('/project', ports, { execution });
    const handoff = await engine.start('STEP PLAN STEP-001');
    expect(handoff).toMatchObject({ kind: 'semantic-handoff' });

    const stale = {
      ...(handoff as Extract<typeof handoff, { kind: 'semantic-handoff' }>),
      executionId: 'exec-stale',
      context: { tampered: true },
    };

    const result = await engine.completeSemantic(stale, { plan: 'proposal' });

    expect(result).toMatchObject({
      kind: 'blocked',
      reasonCode: 'STALE_SEMANTIC_RESULT',
      executionId: 'exec-stale',
    });
    expect(ports.commitSemanticProposal).not.toHaveBeenCalled();
    expect(execution.completeCurrent).not.toHaveBeenCalled();
  });

  it('uses trusted execution context rather than caller-returned handoff context', async () => {
    const { execution, ports } = fixture('STEP PLAN STEP-001');
    const engine = new ProtocolEngine('/project', ports, { execution });
    const handoff = await engine.start('STEP PLAN STEP-001');
    expect(handoff).toMatchObject({ kind: 'semantic-handoff' });

    const tampered = {
      ...(handoff as Extract<typeof handoff, { kind: 'semantic-handoff' }>),
      context: { callerInjected: 'must-not-cross-trust-boundary' },
    };
    await engine.completeSemantic(tampered, { plan: 'proposal' });

    expect(ports.commitSemanticProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {},
        proposal: { plan: 'proposal' },
      }),
    );
  });

  it('routes STEP RUN through deterministic orchestration before semantic handoff', async () => {
    const { execution, ports } = fixture('STEP RUN STEP-001', { orchestration: true });
    const engine = new ProtocolEngine('/project', ports, { execution });
    const result = await engine.start('STEP RUN STEP-001');
    expect(result).toMatchObject({
      kind: 'semantic-handoff',
      command: 'STEP PLAN STEP-001',
      requiredSkill: 'plan-step',
    });
    expect(execution.beginCommand).toHaveBeenCalledWith(
      '/project',
      'STEP RUN STEP-001',
      'STEP PLAN STEP-001',
    );
  });

  it('uses conditional fast path without semantic handoff when Core proves it', async () => {
    const { execution, ports } = fixture('GIT PUSH');
    ports.conditionalFastPath = vi.fn(async () => ({ result: 'SUCCESS', details: { proven: true } }));
    const engine = new ProtocolEngine('/project', ports, { execution });
    const result = await engine.start('GIT PUSH');
    expect(ports.conditionalFastPath).toHaveBeenCalled();
    expect(ports.commitSemanticProposal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'terminal', status: 'DONE' });
  });
});
