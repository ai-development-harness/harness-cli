import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHarnessStatePath } from '../git.js';
import { UpdateError } from './errors.js';
import type { UpdateCheckpoint, UpdatePhase } from './types.js';

const STATE_FILE = 'update/update-status.json';
const PHASES: readonly UpdatePhase[] = ['prepared', 'migration_verified', 'pin_written', 'verified'];

function validate(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['update checkpoint must be an object'];
  }
  const item = value as Partial<UpdateCheckpoint>;
  const errors: string[] = [];
  if (item.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof item.operationId !== 'string' || item.operationId.length === 0) errors.push('operationId must be non-empty');
  if (!PHASES.includes(item.phase as UpdatePhase)) errors.push('phase is invalid');
  for (const key of ['currentRelease', 'targetRelease'] as const) {
    if (typeof item[key] !== 'string' || !/^\d+\.\d+\.\d+$/.test(item[key]!)) errors.push(`${key} must be semver`);
  }
  if (typeof item.targetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.targetDigest)) errors.push('targetDigest must be sha256');
  for (const key of ['projectSchemaBefore', 'projectSchemaAfter'] as const) {
    if (!Number.isInteger(item[key]) || (item[key] ?? -1) < 0) errors.push(`${key} must be non-negative integer`);
  }
  if (typeof item.migrationRequired !== 'boolean') errors.push('migrationRequired must be boolean');
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (typeof item[key] !== 'string' || Number.isNaN(Date.parse(item[key]!))) errors.push(`${key} must be ISO-8601`);
  }
  return errors;
}

async function targetPath(projectRoot: string): Promise<string> {
  return resolveHarnessStatePath(projectRoot, STATE_FILE, 'Harness update checkpoint');
}

export async function readUpdateCheckpoint(projectRoot: string): Promise<UpdateCheckpoint | null> {
  const target = await targetPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UpdateError('UPDATE_STATE_CORRUPT', 'Harness update checkpoint is not valid JSON.', {
      cause: (error as Error).message,
    });
  }
  const errors = validate(parsed);
  if (errors.length > 0) {
    throw new UpdateError('UPDATE_STATE_CORRUPT', 'Harness update checkpoint is invalid.', { errors });
  }
  return parsed as UpdateCheckpoint;
}

export async function writeUpdateCheckpoint(
  projectRoot: string,
  next: Omit<UpdateCheckpoint, 'schemaVersion' | 'createdAt' | 'updatedAt'>,
): Promise<UpdateCheckpoint> {
  const previous = await readUpdateCheckpoint(projectRoot);
  const now = new Date().toISOString();
  const sameOperation =
    previous !== null &&
    previous.operationId === next.operationId &&
    previous.currentRelease === next.currentRelease &&
    previous.targetRelease === next.targetRelease &&
    previous.targetDigest === next.targetDigest;

  if (previous && !sameOperation && previous.phase !== 'verified') {
    throw new UpdateError(
      'UPDATE_STATE_CONFLICT',
      'Another Harness update checkpoint is already active for this worktree.',
      { existing: previous, requestedOperationId: next.operationId },
    );
  }
  if (previous && sameOperation && PHASES.indexOf(next.phase) < PHASES.indexOf(previous.phase)) {
    throw new UpdateError('UPDATE_STATE_CONFLICT', 'Harness update checkpoint phase cannot move backwards.');
  }

  const checkpoint: UpdateCheckpoint = {
    schemaVersion: 1,
    ...next,
    createdAt: sameOperation ? previous!.createdAt : now,
    updatedAt: now,
  };
  const errors = validate(checkpoint);
  if (errors.length > 0) {
    throw new UpdateError('UPDATE_STATE_CORRUPT', 'Refusing to persist invalid Harness update checkpoint.', { errors });
  }

  const target = await targetPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const checked = await targetPath(projectRoot);
  const temporary = `${checked}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, checked);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
  return checkpoint;
}
