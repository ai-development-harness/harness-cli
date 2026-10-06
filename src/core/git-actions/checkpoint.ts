import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHarnessStatePath } from '../git.js';
import { GitActionError } from './errors.js';
import type { SideEffectCheckpoint, SideEffectKind, SideEffectPhase } from './types.js';

const CHECKPOINT_FILE = 'git/side-effects.json';
const MAX_PROOF_BYTES = 8 * 1024;
const PHASES: readonly SideEffectPhase[] = [
  'prepared',
  'side_effect_started',
  'side_effect_observed',
  'postconditions_verified',
];

interface SideEffectState {
  readonly schemaVersion: 1;
  readonly checkpoints: Readonly<Record<string, SideEffectCheckpoint>>;
}

function emptyState(): SideEffectState {
  return { schemaVersion: 1, checkpoints: {} };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function secretLikeKeys(value: unknown, prefix = 'proof'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => secretLikeKeys(child, `${prefix}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = `${prefix}.${key}`;
    if (/(password|passwd|secret|token|credential|authorization)/i.test(key)) found.push(next);
    found.push(...secretLikeKeys(child, next));
  }
  return found;
}

function validateCheckpoint(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['checkpoint must be an object'];
  const item = value as Partial<SideEffectCheckpoint>;
  const errors: string[] = [];
  if (item.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof item.operationId !== 'string' || item.operationId.length === 0) errors.push('operationId must be non-empty');
  if (!['git_commit', 'git_push', 'provider_pr'].includes(String(item.kind))) errors.push('kind is invalid');
  if (!PHASES.includes(item.phase as SideEffectPhase)) errors.push('phase is invalid');
  if (!Number.isInteger(item.attempt) || (item.attempt ?? 0) < 1) errors.push('attempt must be >= 1');
  for (const key of ['preparedAt', 'updatedAt'] as const) {
    if (typeof item[key] !== 'string' || Number.isNaN(Date.parse(item[key]!))) errors.push(`${key} must be ISO-8601`);
  }
  if (typeof item.proof !== 'object' || item.proof === null || Array.isArray(item.proof)) {
    errors.push('proof must be an object');
  } else {
    if (jsonBytes(item.proof) > MAX_PROOF_BYTES) errors.push(`proof exceeds ${MAX_PROOF_BYTES} UTF-8 JSON bytes`);
    const secretKeys = secretLikeKeys(item.proof);
    if (secretKeys.length > 0) errors.push(`proof contains forbidden secret-like keys: ${secretKeys.join(', ')}`);
  }
  return errors;
}

async function checkpointPath(projectRoot: string): Promise<string> {
  return resolveHarnessStatePath(projectRoot, CHECKPOINT_FILE, 'Git side-effect checkpoints');
}

async function loadState(projectRoot: string): Promise<SideEffectState> {
  const target = await checkpointPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Git side-effect checkpoint state is not valid JSON.', {
      cause: (error as Error).message,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Git side-effect checkpoint state must be an object.');
  }
  const state = parsed as Partial<SideEffectState>;
  if (state.schemaVersion !== 1 || typeof state.checkpoints !== 'object' || state.checkpoints === null || Array.isArray(state.checkpoints)) {
    throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Git side-effect checkpoint state has an unsupported schema.');
  }
  for (const [operationId, checkpoint] of Object.entries(state.checkpoints)) {
    const errors = validateCheckpoint(checkpoint);
    if (errors.length > 0 || (checkpoint as SideEffectCheckpoint).operationId !== operationId) {
      throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Git side-effect checkpoint is invalid.', {
        operationId,
        errors,
      });
    }
  }
  return state as SideEffectState;
}

async function saveState(projectRoot: string, state: SideEffectState): Promise<void> {
  const target = await checkpointPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const checked = await checkpointPath(projectRoot);
  const temporary = `${checked}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, checked);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function readSideEffectCheckpoint(
  projectRoot: string,
  operationId: string,
): Promise<SideEffectCheckpoint | null> {
  return (await loadState(projectRoot)).checkpoints[operationId] ?? null;
}

export async function writeSideEffectCheckpoint(
  projectRoot: string,
  input: {
    readonly operationId: string;
    readonly kind: SideEffectKind;
    readonly phase: SideEffectPhase;
    readonly proof: Readonly<Record<string, unknown>>;
  },
): Promise<SideEffectCheckpoint> {
  const state = await loadState(projectRoot);
  const previous = state.checkpoints[input.operationId];
  const now = new Date().toISOString();
  let attempt = previous?.attempt ?? 1;
  let preparedAt = previous?.preparedAt ?? now;

  if (previous) {
    if (previous.kind !== input.kind) {
      throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Side-effect kind cannot change for an operation.');
    }
    const previousIndex = PHASES.indexOf(previous.phase);
    const nextIndex = PHASES.indexOf(input.phase);
    if (nextIndex < previousIndex) {
      if (input.phase !== 'prepared') {
        throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Side-effect phase cannot move backwards.');
      }
      attempt += 1;
      preparedAt = now;
    }
  } else if (input.phase !== 'prepared') {
    throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'First side-effect checkpoint must be prepared.');
  }

  const checkpoint: SideEffectCheckpoint = {
    schemaVersion: 1,
    operationId: input.operationId,
    kind: input.kind,
    phase: input.phase,
    attempt,
    preparedAt,
    updatedAt: now,
    proof: input.proof,
  };
  const errors = validateCheckpoint(checkpoint);
  if (errors.length > 0) {
    throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Refusing to persist invalid side-effect checkpoint.', { errors });
  }

  await saveState(projectRoot, {
    schemaVersion: 1,
    checkpoints: { ...state.checkpoints, [input.operationId]: checkpoint },
  });
  return checkpoint;
}
