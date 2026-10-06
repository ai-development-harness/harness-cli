import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHarnessStatePath } from '../git.js';
import { ExecutionStateError } from './errors.js';
import {
  EXECUTION_STATE_SCHEMA_VERSION,
  MAX_DETAILS_BYTES,
  MAX_INTENT_BASIS_BYTES,
  MAX_PROGRESS_SAMPLES,
  RECENT_TERMINAL_LIMIT,
  type ExecutionRecord,
  type ExecutionState,
  type IntentBasisV1,
  type StepRecoveryBaseline,
  type TerminalExecution,
} from './types.js';

const STATE_FILE = 'execution/execution-status.json';

export function emptyExecutionState(): ExecutionState {
  return {
    schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
    executions: [],
    stepRecovery: {},
    recentTerminals: [],
    nextOrdinal: 1,
  };
}

export async function executionStatePath(projectRoot: string): Promise<string> {
  return resolveHarnessStatePath(projectRoot, STATE_FILE, 'execution state');
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value);
}

function validateIntentBasis(value: unknown, prefix: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${prefix} must be an object`];
  }
  if (jsonBytes(value) > MAX_INTENT_BASIS_BYTES) {
    return [`${prefix} exceeds ${MAX_INTENT_BASIS_BYTES} UTF-8 JSON bytes`];
  }
  const item = value as Partial<IntentBasisV1>;
  if (!Number.isInteger(item.schemaVersion) || (item.schemaVersion ?? 0) < 1) {
    return [`${prefix}.schemaVersion must be >= 1`];
  }
  // Future versions remain readable so resume can fail with an exact blocker.
  if (item.schemaVersion !== 1) return [];
  const errors: string[] = [];
  if (typeof item.stepId !== 'string' || !/^STEP-\d{3,}$/.test(item.stepId)) errors.push(`${prefix}.stepId must be STEP-NNN`);
  if (typeof item.command !== 'string' || item.command.length === 0) errors.push(`${prefix}.command must be non-empty`);
  if (!['PLAN', 'IMPLEMENT', 'REVIEW', 'FIX'].includes(String(item.operation))) errors.push(`${prefix}.operation is invalid`);
  if (!validSha256(item.contextBasis)) errors.push(`${prefix}.contextBasis must be sha256`);
  if (
    !Array.isArray(item.contextComponents) ||
    item.contextComponents.some((component) =>
      typeof component !== 'string' ||
      !component.includes('=') ||
      !validSha256(component.slice(component.lastIndexOf('=') + 1))
    )
  ) {
    errors.push(`${prefix}.contextComponents must be COMPONENT=sha256 strings`);
  } else if (new Set(item.contextComponents).size !== item.contextComponents.length) {
    errors.push(`${prefix}.contextComponents must be unique`);
  }
  if (typeof item.planContentRequired !== 'boolean') errors.push(`${prefix}.planContentRequired must be boolean`);
  if (item.planContentRequired === true && !validSha256(item.planContentHash)) {
    errors.push(`${prefix}.planContentHash must be sha256 when required`);
  }
  if (item.planContentRequired === false && item.planContentHash !== null) {
    errors.push(`${prefix}.planContentHash must be null when not required`);
  }
  if (
    item.planRevision !== null &&
    (!Number.isInteger(item.planRevision) || (item.planRevision ?? -1) < 0)
  ) {
    errors.push(`${prefix}.planRevision must be null or non-negative integer`);
  }
  if (!validIso(item.capturedAt)) errors.push(`${prefix}.capturedAt must be ISO-8601`);
  return errors;
}

function validateBaseline(value: unknown, prefix: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${prefix} must be an object`];
  const item = value as Partial<StepRecoveryBaseline>;
  const errors: string[] = [];
  if (typeof item.stepId !== 'string' || !/^STEP-\d{3,}$/.test(item.stepId)) errors.push(`${prefix}.stepId must be STEP-NNN`);
  if (typeof item.gitHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item.gitHead)) errors.push(`${prefix}.gitHead must be a 40/64-hex Git OID`);
  if (!validIso(item.capturedAt)) errors.push(`${prefix}.capturedAt must be ISO-8601`);
  if (typeof item.sourceExecutionId !== 'string' || !item.sourceExecutionId) errors.push(`${prefix}.sourceExecutionId must be non-empty`);
  return errors;
}

function validateExecution(value: unknown, prefix: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${prefix} must be an object`];
  const item = value as Partial<ExecutionRecord>;
  const errors: string[] = [];
  if (typeof item.executionId !== 'string' || !item.executionId.startsWith('exec-')) errors.push(`${prefix}.executionId is invalid`);
  if (!Number.isInteger(item.ordinal) || (item.ordinal ?? 0) < 1) errors.push(`${prefix}.ordinal must be >= 1`);
  if (!['single', 'chain', 'orchestration'].includes(String(item.mode))) errors.push(`${prefix}.mode is invalid`);
  if (typeof item.rootCommand !== 'string' || !item.rootCommand) errors.push(`${prefix}.rootCommand must be non-empty`);
  if (!Array.isArray(item.sequence) || item.sequence.some((entry) => typeof entry !== 'string' || !entry)) errors.push(`${prefix}.sequence is invalid`);
  if (!['running', 'complete', 'blocked'].includes(String(item.status))) errors.push(`${prefix}.status is invalid`);
  if (!Number.isInteger(item.fixReviewCycles) || (item.fixReviewCycles ?? -1) < 0) errors.push(`${prefix}.fixReviewCycles must be >= 0`);
  if (!Number.isInteger(item.maxFixReviewCycles) || (item.maxFixReviewCycles ?? 0) < 1 || (item.maxFixReviewCycles ?? 0) > 5) errors.push(`${prefix}.maxFixReviewCycles must be 1..5`);
  if (!validIso(item.startedAt) || !validIso(item.updatedAt)) errors.push(`${prefix} timestamps are invalid`);

  const current = item.current;
  if (typeof current !== 'object' || current === null) {
    errors.push(`${prefix}.current must be an object`);
  } else {
    if (typeof current.command !== 'string' || !current.command) errors.push(`${prefix}.current.command must be non-empty`);
    if (!['running', 'complete', 'blocked'].includes(String(current.status))) errors.push(`${prefix}.current.status is invalid`);
    if (current.result !== null && !['SUCCESS', 'PASS', 'FAIL', 'BLOCKED'].includes(String(current.result))) errors.push(`${prefix}.current.result is invalid`);
    if (!Number.isInteger(current.attempt) || current.attempt < 1) errors.push(`${prefix}.current.attempt must be >= 1`);
    if (!validIso(current.startedAt)) errors.push(`${prefix}.current.startedAt is invalid`);
    if (current.completedAt !== null && !validIso(current.completedAt)) errors.push(`${prefix}.current.completedAt is invalid`);
    errors.push(...validateIntentBasis(current.context?.intentBasis, `${prefix}.current.context.intentBasis`));
    if (current.context?.implementationBaseline !== undefined) {
      errors.push(...validateBaseline(current.context.implementationBaseline, `${prefix}.current.context.implementationBaseline`));
    }
    if (current.context?.progress !== undefined) {
      const progress = current.context.progress as any;
      if (
        typeof progress !== 'object' ||
        progress === null ||
        progress.schemaVersion !== 1 ||
        !Array.isArray(progress.samples)
      ) {
        errors.push(`${prefix}.current.context.progress must be telemetry schemaVersion=1`);
      } else if (progress.samples.length > MAX_PROGRESS_SAMPLES) {
        errors.push(`${prefix}.current.context.progress.samples exceeds ${MAX_PROGRESS_SAMPLES}`);
      }
    }
    if (current.context?.reviewExpectation !== undefined) {
      const expectation = current.context.reviewExpectation as any;
      if (
        typeof expectation !== 'object' ||
        expectation === null ||
        expectation.schemaVersion !== 1 ||
        typeof expectation.stepId !== 'string' ||
        !/^STEP-\d{3,}$/.test(expectation.stepId) ||
        typeof expectation.gateBasis !== 'string' ||
        typeof expectation.contextBasis !== 'string' ||
        typeof expectation.verificationBasis !== 'string'
      ) {
        errors.push(`${prefix}.current.context.reviewExpectation is invalid`);
      }
    }
    if (current.details !== undefined && jsonBytes(current.details) > MAX_DETAILS_BYTES) {
      errors.push(`${prefix}.current.details exceeds ${MAX_DETAILS_BYTES} UTF-8 JSON bytes`);
    }
  }
  return errors;
}

function validateTerminal(value: unknown, prefix: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${prefix} must be an object`];
  const item = value as Partial<TerminalExecution>;
  const errors: string[] = [];
  if (typeof item.executionId !== 'string' || !item.executionId.startsWith('exec-')) errors.push(`${prefix}.executionId is invalid`);
  if (!Number.isInteger(item.ordinal) || (item.ordinal ?? 0) < 1) errors.push(`${prefix}.ordinal must be >= 1`);
  if (!['single', 'chain', 'orchestration'].includes(String(item.mode))) errors.push(`${prefix}.mode is invalid`);
  if (!['complete', 'blocked'].includes(String(item.status))) errors.push(`${prefix}.status is invalid`);
  if (item.current?.details !== undefined && jsonBytes(item.current.details) > MAX_DETAILS_BYTES) {
    errors.push(`${prefix}.current.details exceeds ${MAX_DETAILS_BYTES} UTF-8 JSON bytes`);
  }
  return errors;
}

export function validateExecutionState(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['execution-status: root must be an object'];
  const state = value as Partial<ExecutionState>;
  if (state.schemaVersion !== 2) return [`execution-status: unsupported schemaVersion ${String(state.schemaVersion)}`];
  const errors: string[] = [];
  if (!Array.isArray(state.executions)) errors.push('execution-status: executions must be an array');
  if (!Array.isArray(state.recentTerminals)) errors.push('execution-status: recentTerminals must be an array');
  if (typeof state.stepRecovery !== 'object' || state.stepRecovery === null || Array.isArray(state.stepRecovery)) errors.push('execution-status: stepRecovery must be an object');
  if (!Number.isInteger(state.nextOrdinal) || (state.nextOrdinal ?? 0) < 1) errors.push('execution-status: nextOrdinal must be >= 1');

  for (const [index, item] of (state.executions ?? []).entries()) errors.push(...validateExecution(item, `execution-status.executions[${index}]`));
  for (const [index, item] of (state.recentTerminals ?? []).entries()) errors.push(...validateTerminal(item, `execution-status.recentTerminals[${index}]`));
  if ((state.recentTerminals?.length ?? 0) > RECENT_TERMINAL_LIMIT) errors.push(`execution-status: recentTerminals exceeds ${RECENT_TERMINAL_LIMIT}`);
  for (const [stepId, baseline] of Object.entries(state.stepRecovery ?? {})) {
    errors.push(...validateBaseline(baseline, `execution-status.stepRecovery.${stepId}`));
    if ((baseline as StepRecoveryBaseline).stepId !== stepId) errors.push(`execution-status.stepRecovery.${stepId}.stepId mismatch`);
  }

  const invocations = [...(state.executions ?? []), ...(state.recentTerminals ?? [])] as Array<{ executionId: string; ordinal: number }>;
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const item of invocations) {
    if (ids.has(item.executionId)) errors.push(`execution-status: duplicate executionId ${item.executionId}`);
    ids.add(item.executionId);
    if (ordinals.has(item.ordinal)) errors.push(`execution-status: duplicate ordinal ${item.ordinal}`);
    ordinals.add(item.ordinal);
  }
  const maxOrdinal = Math.max(0, ...[...ordinals]);
  if ((state.nextOrdinal ?? 0) <= maxOrdinal) errors.push('execution-status: nextOrdinal must be greater than all stored ordinals');
  return errors;
}

export async function loadExecutionState(projectRoot: string): Promise<ExecutionState> {
  const target = await executionStatePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyExecutionState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExecutionStateError('EXECUTION_STATE_CORRUPT', 'Execution state is not valid JSON.', {
      target,
      cause: (error as Error).message,
    });
  }
  const errors = validateExecutionState(parsed);
  if (errors.length > 0) {
    throw new ExecutionStateError('EXECUTION_STATE_CORRUPT', 'Execution state contract is invalid.', {
      target,
      errors,
    });
  }
  return parsed as ExecutionState;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not portable; file fsync + atomic rename remains the fallback.
  }
}

export async function saveExecutionState(projectRoot: string, state: ExecutionState): Promise<void> {
  const errors = validateExecutionState(state);
  if (errors.length > 0) {
    throw new ExecutionStateError('EXECUTION_STATE_CORRUPT', 'Refusing to persist invalid execution state.', { errors });
  }
  const target = await executionStatePath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  // Re-resolve after directory creation to keep Git-private containment authoritative.
  const checked = await executionStatePath(projectRoot);
  const temporary = `${checked}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, checked);
    await syncDirectory(path.dirname(checked));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
