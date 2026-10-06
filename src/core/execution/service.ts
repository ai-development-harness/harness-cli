import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../config.js';
import type { UnresolvedExecutionFact } from '../project/index.js';
import {
  CHAIN_SEPARATOR,
  parseCanonicalCommand,
  validateCommandText,
} from '../protocol/index.js';
import { acquireCoreWriteLock } from '../write-lock.js';
import { captureReviewExpectation } from '../review/expectation.js';
import {
  captureProgress,
  observeResume as observeProgressResume,
  observeTransition as observeProgressTransition,
} from '../review/progress.js';
import { repairCycleDecision } from '../review/repair.js';
import { ExecutionStateError } from './errors.js';
import { captureIntentBasis, intentResumeBlocker, throwIntentBlocker } from './intent.js';
import {
  emptyExecutionState,
  loadExecutionState,
  saveExecutionState,
} from './storage.js';
import {
  RECENT_TERMINAL_LIMIT,
  type CommandResult,
  type ExecutionCommandContext,
  type ExecutionCurrent,
  type ExecutionMode,
  type ExecutionRecord,
  type ExecutionResolution,
  type ExecutionState,
  type StepRecoveryBaseline,
  type TerminalExecution,
} from './types.js';

const execFileAsync = promisify(execFile);

interface NormalizedRoot {
  readonly mode: ExecutionMode;
  readonly rootCommand: string;
  readonly sequence: readonly string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizedRoot(rawCommand: string): NormalizedRoot {
  const validation = validateCommandText(rawCommand);
  if (!validation.valid) {
    throw new ExecutionStateError(
      'EXECUTION_INVALID_TRANSITION',
      `${validation.code}: ${validation.message}`,
      { validation },
    );
  }
  const sequence = validation.normalized;
  const first = parseCanonicalCommand(sequence[0]);
  const orchestration =
    sequence.length === 1 &&
    first.valid &&
    first.domain === 'STEP' &&
    first.operation === 'RUN';
  return {
    mode: orchestration ? 'orchestration' : sequence.length > 1 ? 'chain' : 'single',
    rootCommand: sequence.join(` ${CHAIN_SEPARATOR} `),
    sequence,
  };
}

function latestActive(
  state: ExecutionState,
  rootCommand: string,
): ExecutionRecord | null {
  const matches = state.executions.filter((item) => item.rootCommand === rootCommand);
  return matches.sort((a, b) => b.ordinal - a.ordinal)[0] ?? null;
}

function latestInvocation(
  state: ExecutionState,
  rootCommand: string,
): { kind: 'active'; value: ExecutionRecord } | { kind: 'terminal'; value: TerminalExecution } | null {
  const candidates: Array<{ kind: 'active' | 'terminal'; value: ExecutionRecord | TerminalExecution }> = [
    ...state.executions.filter((item) => item.rootCommand === rootCommand).map((value) => ({ kind: 'active' as const, value })),
    ...state.recentTerminals.filter((item) => item.rootCommand === rootCommand).map((value) => ({ kind: 'terminal' as const, value })),
  ];
  const latest = candidates.sort((a, b) => b.value.ordinal - a.value.ordinal)[0];
  return latest as ReturnType<typeof latestInvocation> ?? null;
}

function terminalFromExecution(execution: ExecutionRecord): TerminalExecution {
  return {
    executionId: execution.executionId,
    ordinal: execution.ordinal,
    rootCommand: execution.rootCommand,
    mode: execution.mode,
    status: execution.status === 'blocked' ? 'blocked' : 'complete',
    current: {
      command: execution.current.command,
      status: execution.current.status,
      result: execution.current.result,
      completedAt: execution.current.completedAt,
      ...(execution.current.details ? { details: execution.current.details } : {}),
    },
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
  };
}

function appendTerminal(state: ExecutionState, terminal: TerminalExecution): void {
  state.recentTerminals.push(terminal);
  state.recentTerminals.sort((a, b) => a.ordinal - b.ordinal);
  if (state.recentTerminals.length > RECENT_TERMINAL_LIMIT) {
    state.recentTerminals.splice(0, state.recentTerminals.length - RECENT_TERMINAL_LIMIT);
  }
}

function compactExecution(state: ExecutionState, execution: ExecutionRecord): void {
  state.executions = state.executions.filter((item) => item.executionId !== execution.executionId);
  appendTerminal(state, terminalFromExecution(execution));
}

function finishRoot(
  state: ExecutionState,
  execution: ExecutionRecord,
  blocked = false,
  blockedBy?: Readonly<Record<string, unknown>>,
): void {
  const timestamp = nowIso();
  execution.status = blocked ? 'blocked' : 'complete';
  execution.completedAt = timestamp;
  execution.updatedAt = timestamp;
  if (blockedBy) execution.blockedBy = blockedBy;
  if (!blocked) compactExecution(state, execution);
}

async function commandContext(
  projectRoot: string,
  command: string,
  baseline?: StepRecoveryBaseline,
  previousProgress?: ExecutionCommandContext['progress'],
): Promise<Readonly<{
  context: ExecutionCommandContext;
  progressBlocker?: Readonly<Record<string, unknown>>;
}>> {
  const context: {
    intentBasis?: Awaited<ReturnType<typeof captureIntentBasis>>;
    intentBasisError?: { reasonCode: 'INTENT_BASIS_UNAVAILABLE'; message: string };
    implementationBaseline?: StepRecoveryBaseline;
    reviewExpectation?: Awaited<ReturnType<typeof captureReviewExpectation>>;
    reviewExpectationError?: { reasonCode: 'REVIEW_EXPECTATION_UNAVAILABLE'; message: string };
    progress?: ExecutionCommandContext['progress'];
  } = {};

  const parsed = parseCanonicalCommand(command);
  try {
    const intentBasis = await captureIntentBasis(projectRoot, command);
    if (intentBasis) context.intentBasis = intentBasis;
  } catch (error) {
    // Fresh diagnostic execution may start even if canonical context is incomplete.
    // Resume remains fail-closed because the original capture error is durable.
    context.intentBasisError = {
      reasonCode: 'INTENT_BASIS_UNAVAILABLE',
      message: (error as Error).message,
    };
  }

  if (baseline) context.implementationBaseline = baseline;

  if (
    parsed.valid &&
    parsed.domain === 'STEP' &&
    parsed.operation === 'REVIEW' &&
    parsed.target
  ) {
    try {
      context.reviewExpectation = await captureReviewExpectation(
        projectRoot,
        parsed.target,
        baseline?.gitHead ?? null,
      );
    } catch (error) {
      context.reviewExpectationError = {
        reasonCode: 'REVIEW_EXPECTATION_UNAVAILABLE',
        message: (error as Error).message,
      };
    }
  }

  let progressBlocker: Readonly<Record<string, unknown>> | undefined;
  if (
    parsed.valid &&
    parsed.domain === 'STEP' &&
    parsed.target &&
    ['PLAN', 'IMPLEMENT', 'REVIEW', 'FIX'].includes(parsed.operation)
  ) {
    try {
      const sample = await captureProgress(
        projectRoot,
        parsed.target,
        parsed.normalized,
        parsed.operation as 'PLAN' | 'IMPLEMENT' | 'REVIEW' | 'FIX',
      );
      const observed = observeProgressTransition(previousProgress, sample, {
        suppressStop: parsed.operation === 'REVIEW' || parsed.operation === 'FIX',
      });
      context.progress = observed.telemetry;
      progressBlocker = observed.blocker ?? undefined;
    } catch {
      // Progress telemetry is a guard. If canonical facts cannot be sampled,
      // intent/review contracts still remain authoritative and resume-safe.
    }
  }

  return {
    context: context as ExecutionCommandContext,
    ...(progressBlocker ? { progressBlocker } : {}),
  };
}

async function observeSemanticResume(
  projectRoot: string,
  execution: ExecutionRecord,
): Promise<Readonly<Record<string, unknown>> | null> {
  const parsed = parseCanonicalCommand(execution.current.command);
  if (
    !parsed.valid ||
    parsed.domain !== 'STEP' ||
    !parsed.target ||
    !['PLAN', 'IMPLEMENT', 'REVIEW', 'FIX'].includes(parsed.operation)
  ) {
    return null;
  }
  try {
    const sample = await captureProgress(
      projectRoot,
      parsed.target,
      parsed.normalized,
      parsed.operation as 'PLAN' | 'IMPLEMENT' | 'REVIEW' | 'FIX',
    );
    const observed = observeProgressResume(execution.current.context.progress, sample, {
      suppressStop: parsed.operation === 'REVIEW' || parsed.operation === 'FIX',
    });
    execution.current.context = {
      ...execution.current.context,
      progress: observed.telemetry,
    };
    return observed.blocker;
  } catch {
    return null;
  }
}

async function gitHead(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const value = stdout.trim();
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function implementationBaseline(
  projectRoot: string,
  executionId: string,
  command: string,
): Promise<StepRecoveryBaseline | undefined> {
  const parsed = parseCanonicalCommand(command);
  if (!parsed.valid || parsed.domain !== 'STEP' || parsed.operation !== 'IMPLEMENT' || !parsed.target) {
    return undefined;
  }
  const head = await gitHead(projectRoot);
  if (!head) return undefined;
  return {
    stepId: parsed.target,
    gitHead: head,
    capturedAt: nowIso(),
    sourceExecutionId: executionId,
  };
}

async function withMutation<T>(
  projectRoot: string,
  operationId: string,
  callback: (state: ExecutionState) => Promise<T>,
): Promise<T> {
  const lease = await acquireCoreWriteLock(
    projectRoot,
    'execution-state',
    operationId,
    undefined,
    { contention: 'wait-same-kind' },
  );
  try {
    const state = await loadExecutionState(projectRoot);
    const result = await callback(state);
    await saveExecutionState(projectRoot, state);
    return result;
  } finally {
    await lease.release();
  }
}

function newCurrent(
  command: string,
  context: ExecutionCommandContext,
  attempt = 1,
): ExecutionCurrent {
  return {
    command,
    status: 'running',
    result: null,
    attempt,
    startedAt: nowIso(),
    completedAt: null,
    context,
  };
}

function blockedResolution(
  execution: ExecutionRecord,
  blocker?: Readonly<Record<string, unknown>>,
): ExecutionResolution {
  return {
    status: 'BLOCKED',
    executionId: execution.executionId,
    rootCommand: execution.rootCommand,
    command: null,
    reasonCode: String(blocker?.reasonCode ?? execution.blockedBy?.reasonCode ?? 'EXECUTION_BLOCKED'),
    ...(blocker?.remediation || execution.blockedBy?.remediation
      ? { remediation: String(blocker?.remediation ?? execution.blockedBy?.remediation) }
      : {}),
    ...(blocker ? { intent: blocker } : {}),
    fixReviewCycles: execution.fixReviewCycles,
  };
}

async function runningResolution(
  projectRoot: string,
  execution: ExecutionRecord,
): Promise<ExecutionResolution> {
  if (
    execution.mode === 'orchestration' &&
    execution.current.command === execution.rootCommand
  ) {
    const parsed = parseCanonicalCommand(execution.rootCommand);
    const target = parsed.valid ? parsed.target : null;
    return {
      status: 'NEXT',
      executionId: execution.executionId,
      rootCommand: execution.rootCommand,
      command: target ? `STEP PLAN ${target}` : null,
      reasonCode: 'ORCHESTRATION_START',
      fixReviewCycles: execution.fixReviewCycles,
    };
  }

  const blocker = await intentResumeBlocker(projectRoot, execution);
  if (blocker) return blockedResolution(execution, blocker);
  return {
    status: 'RESUME',
    executionId: execution.executionId,
    rootCommand: execution.rootCommand,
    command: execution.current.command,
    reasonCode: 'INTERRUPTED_COMMAND',
    fixReviewCycles: execution.fixReviewCycles,
  };
}

function nextChain(
  execution: ExecutionRecord,
): ExecutionResolution {
  const validation = validateCommandText(execution.rootCommand);
  if (!validation.valid || validation.code !== 'VALID_CHAIN') {
    return {
      status: 'BLOCKED',
      executionId: execution.executionId,
      rootCommand: execution.rootCommand,
      command: null,
      reasonCode: 'CHAIN_CONTRACT_INVALID',
    };
  }
  const index = execution.currentIndex ?? 0;
  if (index >= execution.sequence.length - 1) {
    return {
      status: 'DONE',
      executionId: execution.executionId,
      rootCommand: execution.rootCommand,
      command: null,
      reasonCode: 'EXECUTION_COMPLETE',
    };
  }
  const edge = validation.transitions[index];
  if (!edge.onPreviousResult.includes(String(execution.current.result))) {
    return {
      status: 'DONE',
      executionId: execution.executionId,
      rootCommand: execution.rootCommand,
      command: null,
      reasonCode: 'CHAIN_CONDITION_NOT_MET',
    };
  }
  return {
    status: 'NEXT',
    executionId: execution.executionId,
    rootCommand: execution.rootCommand,
    command: execution.sequence[index + 1],
    reasonCode: 'CHAIN_NEXT_SEGMENT',
    fixReviewCycles: execution.fixReviewCycles,
  };
}

function nextOrchestration(execution: ExecutionRecord): ExecutionResolution {
  const current = parseCanonicalCommand(execution.current.command);
  const target = current.valid ? current.target : null;
  const operation = current.valid ? current.operation : null;
  const result = execution.current.result;
  const base = {
    executionId: execution.executionId,
    rootCommand: execution.rootCommand,
    fixReviewCycles: execution.fixReviewCycles,
  };

  if (!target || !operation) return { ...base, status: 'BLOCKED', command: null, reasonCode: 'ORCHESTRATION_STATE_INVALID' };
  if (operation === 'PLAN' && result === 'SUCCESS') {
    return { ...base, status: 'NEXT', command: `STEP IMPLEMENT ${target}`, reasonCode: 'ORCHESTRATION_NEXT' };
  }
  if (operation === 'IMPLEMENT' && result === 'SUCCESS') {
    return { ...base, status: 'NEXT', command: `STEP REVIEW ${target}`, reasonCode: 'ORCHESTRATION_NEXT' };
  }
  if (operation === 'REVIEW' && result === 'PASS') {
    return { ...base, status: 'DONE', command: null, reasonCode: 'EXECUTION_COMPLETE' };
  }
  if (operation === 'REVIEW' && result === 'FAIL') {
    if (execution.fixReviewCycles >= execution.maxFixReviewCycles) {
      return { ...base, status: 'BLOCKED', command: null, reasonCode: 'FIX_REVIEW_LIMIT_REACHED' };
    }
    return { ...base, status: 'NEXT', command: `STEP FIX ${target}`, reasonCode: 'ORCHESTRATION_REPAIR' };
  }
  if (operation === 'FIX' && result === 'SUCCESS') {
    return { ...base, status: 'NEXT', command: `STEP REVIEW ${target}`, reasonCode: 'ORCHESTRATION_REVIEW_AFTER_FIX' };
  }
  return { ...base, status: 'BLOCKED', command: null, reasonCode: 'COMMAND_RESULT_BLOCKED' };
}

async function resolveExecutionInternal(
  projectRoot: string,
  state: ExecutionState,
  execution: ExecutionRecord,
  mutate: boolean,
): Promise<ExecutionResolution> {
  if (execution.status === 'blocked') return blockedResolution(execution);
  if (execution.status === 'complete') {
    return {
      status: 'DONE',
      executionId: execution.executionId,
      rootCommand: execution.rootCommand,
      command: null,
      reasonCode: 'EXECUTION_COMPLETE',
    };
  }

  if (execution.current.status === 'running') {
    const resolution = await runningResolution(projectRoot, execution);
    if (resolution.status === 'BLOCKED' && mutate) {
      execution.current.status = 'blocked';
      execution.current.result = 'BLOCKED';
      execution.current.completedAt = nowIso();
      finishRoot(state, execution, true, resolution.intent);
    }
    return resolution;
  }

  if (execution.current.status === 'blocked') return blockedResolution(execution);

  const resolution =
    execution.mode === 'chain'
      ? nextChain(execution)
      : execution.mode === 'orchestration'
        ? nextOrchestration(execution)
        : {
            status: 'DONE' as const,
            executionId: execution.executionId,
            rootCommand: execution.rootCommand,
            command: null,
            reasonCode: 'EXECUTION_COMPLETE',
          };

  if (mutate && resolution.status === 'DONE') {
    if (execution.mode === 'chain') {
      const nextIndex = (execution.currentIndex ?? 0) + 1;
      execution.notExecuted = execution.sequence.slice(nextIndex);
    }
    finishRoot(state, execution, false);
  } else if (mutate && resolution.status === 'BLOCKED') {
    finishRoot(state, execution, true, { reasonCode: resolution.reasonCode });
  }
  return resolution;
}

export async function startExecution(
  projectRoot: string,
  rawCommand: string,
): Promise<ExecutionRecord> {
  const normalized = normalizedRoot(rawCommand);
  const outcome = await withMutation(
    projectRoot,
    `start:${randomUUID()}`,
    async (state): Promise<{ execution: ExecutionRecord; blocker?: Readonly<Record<string, unknown>> }> => {
      const latest = latestInvocation(state, normalized.rootCommand);
      if (latest?.kind === 'active' && latest.value.status === 'running') {
        const execution = latest.value;
        if (execution.current.status === 'running') {
          const blocker = await intentResumeBlocker(projectRoot, execution);
          if (blocker) {
            execution.current.status = 'blocked';
            execution.current.result = 'BLOCKED';
            execution.current.completedAt = nowIso();
            finishRoot(state, execution, true, blocker);
            return { execution, blocker };
          }
          execution.current.attempt += 1;
          execution.current.startedAt = nowIso();
          execution.updatedAt = nowIso();
        }
        return { execution };
      }

      // A newer invocation of the same root makes any older blocked full record
      // historical. Compact it before allocating the next ordinal so full state
      // remains bounded while the latest actionable blocker stays recoverable.
      for (const blocked of [...state.executions]) {
        if (blocked.rootCommand === normalized.rootCommand && blocked.status === 'blocked') {
          compactExecution(state, blocked);
        }
      }

      const config = await readConfig(projectRoot);
      const ordinal = state.nextOrdinal;
      state.nextOrdinal += 1;
      const firstCommand =
        normalized.mode === 'orchestration' ? normalized.rootCommand : normalized.sequence[0];
      const executionId = `exec-${randomUUID().replaceAll('-', '')}`;
      const context = await commandContext(projectRoot, firstCommand);
      const timestamp = nowIso();
      const execution: ExecutionRecord = {
        executionId,
        ordinal,
        mode: normalized.mode,
        requestedCommand: rawCommand.trim(),
        rootCommand: normalized.rootCommand,
        sequence: normalized.sequence,
        currentIndex: normalized.mode === 'orchestration' ? null : 0,
        status: 'running',
        current: {
          command: firstCommand,
          status: 'running',
          result: null,
          attempt: 1,
          startedAt: timestamp,
          completedAt: null,
          context,
        },
        notExecuted: [],
        fixReviewCycles: 0,
        maxFixReviewCycles: config.execution.maxFixReviewCycles,
        startedAt: timestamp,
        completedAt: null,
        updatedAt: timestamp,
      };
      state.executions.push(execution);
      return { execution };
    },
  );
  if (outcome.blocker) throwIntentBlocker(outcome.blocker);
  return outcome.execution;
}

export async function beginCommand(
  projectRoot: string,
  rootCommand: string,
  command: string,
): Promise<ExecutionRecord> {
  const normalized = normalizedRoot(rootCommand);
  const parsed = parseCanonicalCommand(command);
  if (!parsed.valid) {
    throw new ExecutionStateError('EXECUTION_INVALID_TRANSITION', parsed.message, { parsed });
  }

  const outcome = await withMutation(
    projectRoot,
    `begin:${randomUUID()}`,
    async (state): Promise<{ execution: ExecutionRecord; blocker?: Readonly<Record<string, unknown>> }> => {
      const execution = latestActive(state, normalized.rootCommand);
      if (!execution || execution.status !== 'running') {
        throw new ExecutionStateError('EXECUTION_NOT_FOUND', `active execution not found for ${normalized.rootCommand}`);
      }

      if (execution.current.status === 'running' && execution.current.command === parsed.normalized) {
        const blocker = await intentResumeBlocker(projectRoot, execution);
        if (blocker) {
          execution.current.status = 'blocked';
          execution.current.result = 'BLOCKED';
          execution.current.completedAt = nowIso();
          finishRoot(state, execution, true, blocker);
          return { execution, blocker };
        }
        execution.current.attempt += 1;
        execution.current.startedAt = nowIso();
        execution.updatedAt = nowIso();
        return { execution };
      }

      const resolution = await resolveExecutionInternal(projectRoot, state, execution, false);
      if (resolution.status !== 'NEXT' || resolution.command !== parsed.normalized) {
        throw new ExecutionStateError(
          'EXECUTION_INVALID_TRANSITION',
          `command ${parsed.normalized} is not the next command for ${normalized.rootCommand}`,
          { resolution },
        );
      }

      const baseline = await implementationBaseline(projectRoot, execution.executionId, parsed.normalized);
      if (baseline) state.stepRecovery[baseline.stepId] = baseline;
      const context = await commandContext(projectRoot, parsed.normalized, baseline);
      execution.current = newCurrent(parsed.normalized, context);
      if (execution.mode === 'chain') execution.currentIndex = (execution.currentIndex ?? 0) + 1;
      execution.updatedAt = nowIso();
      return { execution };
    },
  );
  if (outcome.blocker) throwIntentBlocker(outcome.blocker);
  return outcome.execution;
}

export async function completeCurrent(
  projectRoot: string,
  rootCommand: string,
  result: CommandResult,
  options: {
    readonly command?: string;
    readonly expectedExecutionId?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<ExecutionRecord | TerminalExecution> {
  const normalized = normalizedRoot(rootCommand);
  return withMutation(projectRoot, `complete:${randomUUID()}`, async (state) => {
    const execution = latestActive(state, normalized.rootCommand);
    if (!execution || execution.status !== 'running') {
      if (options.expectedExecutionId) {
        throw new ExecutionStateError(
          'STALE_SEMANTIC_RESULT',
          'semantic result no longer owns an active execution',
          { expectedExecutionId: options.expectedExecutionId, currentExecutionId: execution?.executionId ?? null },
        );
      }
      throw new ExecutionStateError('EXECUTION_NOT_FOUND', `active execution not found for ${normalized.rootCommand}`);
    }
    if (
      options.expectedExecutionId &&
      execution.executionId !== options.expectedExecutionId
    ) {
      throw new ExecutionStateError(
        'STALE_SEMANTIC_RESULT',
        'semantic result belongs to a stale executionId',
        {
          expectedExecutionId: options.expectedExecutionId,
          currentExecutionId: execution.executionId,
        },
      );
    }

    if (options.command) {
      const command = parseCanonicalCommand(options.command);
      if (!command.valid || command.normalized !== execution.current.command) {
        throw new ExecutionStateError(
          'EXECUTION_INVALID_TRANSITION',
          'completion command does not match current command',
          { current: execution.current.command, supplied: options.command },
        );
      }
    }
    if (execution.current.status !== 'running') {
      throw new ExecutionStateError('EXECUTION_INVALID_TRANSITION', 'current command is not running');
    }

    execution.current.status = result === 'BLOCKED' ? 'blocked' : 'complete';
    execution.current.result = result;
    execution.current.completedAt = nowIso();
    if (options.details) execution.current.details = options.details;
    execution.updatedAt = nowIso();

    const current = parseCanonicalCommand(execution.current.command);
    if (
      execution.mode === 'orchestration' &&
      current.valid &&
      current.operation === 'FIX' &&
      result === 'SUCCESS'
    ) {
      execution.fixReviewCycles += 1;
    }

    if (result === 'BLOCKED') {
      finishRoot(state, execution, true, { reasonCode: 'COMMAND_BLOCKED' });
      return execution;
    }
    if (execution.mode === 'single') {
      finishRoot(state, execution, false);
      return terminalFromExecution(execution);
    }

    const resolution = await resolveExecutionInternal(projectRoot, state, execution, true);
    if (resolution.status === 'DONE') return terminalFromExecution(execution);
    return execution;
  });
}

export async function blockExecution(
  projectRoot: string,
  rootCommand: string,
  reason: Readonly<Record<string, unknown>>,
  expectedExecutionId?: string,
): Promise<ExecutionRecord> {
  const normalized = normalizedRoot(rootCommand);
  return withMutation(projectRoot, `block:${randomUUID()}`, async (state) => {
    const execution = latestActive(state, normalized.rootCommand);
    if (!execution || execution.status !== 'running') {
      throw new ExecutionStateError('EXECUTION_NOT_FOUND', `active execution not found for ${normalized.rootCommand}`);
    }
    if (expectedExecutionId && execution.executionId !== expectedExecutionId) {
      throw new ExecutionStateError(
        'STALE_SEMANTIC_RESULT',
        'block result belongs to a stale executionId',
        { expectedExecutionId, currentExecutionId: execution.executionId },
      );
    }
    if (execution.current.status === 'running') {
      execution.current.status = 'blocked';
      execution.current.result = 'BLOCKED';
      execution.current.completedAt = nowIso();
    }
    finishRoot(state, execution, true, reason);
    return execution;
  });
}

export async function resolveRoot(
  projectRoot: string,
  rootCommand: string,
  options: { readonly mutate?: boolean } = {},
): Promise<ExecutionResolution> {
  const normalized = normalizedRoot(rootCommand);
  if (options.mutate) {
    return withMutation(projectRoot, `resolve:${randomUUID()}`, async (state) => {
      const latest = latestInvocation(state, normalized.rootCommand);
      if (!latest) return { status: 'NOT_FOUND', command: null, reasonCode: 'EXECUTION_NOT_FOUND' };
      if (latest.kind === 'terminal') {
        return {
          status: latest.value.status === 'complete' ? 'DONE' : 'BLOCKED',
          executionId: latest.value.executionId,
          rootCommand: latest.value.rootCommand,
          command: null,
          reasonCode: latest.value.status === 'complete' ? 'EXECUTION_COMPLETE' : 'EXECUTION_BLOCKED',
        };
      }
      return resolveExecutionInternal(projectRoot, state, latest.value, true);
    });
  }

  const state = await loadExecutionState(projectRoot);
  const latest = latestInvocation(state, normalized.rootCommand);
  if (!latest) return { status: 'NOT_FOUND', command: null, reasonCode: 'EXECUTION_NOT_FOUND' };
  if (latest.kind === 'terminal') {
    return {
      status: latest.value.status === 'complete' ? 'DONE' : 'BLOCKED',
      executionId: latest.value.executionId,
      rootCommand: latest.value.rootCommand,
      command: null,
      reasonCode: latest.value.status === 'complete' ? 'EXECUTION_COMPLETE' : 'EXECUTION_BLOCKED',
    };
  }
  return resolveExecutionInternal(projectRoot, state, latest.value, false);
}

export async function unresolvedExecutions(
  projectRoot: string,
  options: { readonly mutate?: boolean } = {},
): Promise<ExecutionResolution[]> {
  const state = await loadExecutionState(projectRoot);
  const latestOrdinal = new Map<string, number>();
  for (const item of [...state.executions, ...state.recentTerminals]) {
    latestOrdinal.set(item.rootCommand, Math.max(latestOrdinal.get(item.rootCommand) ?? 0, item.ordinal));
  }

  const values: ExecutionResolution[] = [];
  for (const execution of state.executions) {
    if (latestOrdinal.get(execution.rootCommand) !== execution.ordinal) continue;
    if (!['running', 'blocked'].includes(execution.status)) continue;
    values.push(
      options.mutate
        ? await resolveRoot(projectRoot, execution.rootCommand, { mutate: true })
        : await resolveExecutionInternal(projectRoot, state, execution, false),
    );
  }
  return values.sort((a, b) => {
    const aExec = state.executions.find((item) => item.executionId === a.executionId);
    const bExec = state.executions.find((item) => item.executionId === b.executionId);
    return String(bExec?.updatedAt ?? '').localeCompare(String(aExec?.updatedAt ?? ''));
  });
}

export async function unresolvedExecutionFacts(
  projectRoot: string,
): Promise<readonly UnresolvedExecutionFact[]> {
  const resolutions = await unresolvedExecutions(projectRoot, { mutate: false });
  return resolutions.flatMap((item) =>
    (item.status === 'RESUME' || item.status === 'NEXT') && item.command && item.executionId
      ? [{
          executionId: item.executionId,
          status: item.status,
          command: item.command,
          rootCommand: item.rootCommand,
        }]
      : [],
  );
}

export async function findCompleted(
  projectRoot: string,
  command: string,
  options: { readonly result?: CommandResult; readonly latestOnly?: boolean } = {},
): Promise<TerminalExecution | null> {
  const parsed = parseCanonicalCommand(command);
  if (!parsed.valid) throw new ExecutionStateError('EXECUTION_INVALID_TRANSITION', parsed.message);
  const state = await loadExecutionState(projectRoot);
  const terminals = state.recentTerminals
    .filter((item) => item.status === 'complete')
    .sort((a, b) => a.ordinal - b.ordinal);
  const candidates = options.latestOnly ? terminals.slice(-1) : terminals.reverse();
  for (const item of candidates) {
    if (
      item.current.command === parsed.normalized &&
      item.current.status === 'complete' &&
      (options.result === undefined || item.current.result === options.result)
    ) return item;
  }
  return null;
}

export async function readExecutionState(projectRoot: string): Promise<ExecutionState> {
  return loadExecutionState(projectRoot);
}

export { emptyExecutionState };
