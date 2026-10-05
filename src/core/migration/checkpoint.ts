import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveHarnessStatePath } from '../git.js';
import { serializeMigrationPlan } from './planner.js';
import type { MigrationPlan } from './plan-types.js';
import {
  MigrationExecutionError,
  type MigrationCheckpointPaths,
  type MigrationCheckpointStatus,
  type MigrationJournal,
} from './executor-types.js';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return true;
    throw error;
  }
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
    // Some platforms/filesystems do not support fsync on directories.
  }
}

export async function atomicWriteText(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function exclusiveWriteText(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    // A hard link creates the final directory entry atomically and fails
    // with EEXIST instead of replacing a target that appeared after preflight.
    await link(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function assertSafeMigrationId(migrationId: string): void {
  if (
    migrationId.length > 128 ||
    !/^migration-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(migrationId)
  ) {
    throw new MigrationExecutionError('PLAN_INVALID', 'Unsafe migration id.', { migrationId });
  }
}

export async function migrationCheckpointPaths(
  projectRoot: string,
  migrationId: string,
): Promise<MigrationCheckpointPaths> {
  assertSafeMigrationId(migrationId);
  const prefix = `migrations/${migrationId}`;
  const [root, plan, journal, backups, partialReport] = await Promise.all([
    resolveHarnessStatePath(projectRoot, prefix, 'migration checkpoint'),
    resolveHarnessStatePath(projectRoot, `${prefix}/plan.json`, 'migration checkpoint plan'),
    resolveHarnessStatePath(projectRoot, `${prefix}/journal.json`, 'migration checkpoint journal'),
    resolveHarnessStatePath(projectRoot, `${prefix}/backups`, 'migration checkpoint backups'),
    resolveHarnessStatePath(projectRoot, `${prefix}/report.partial.json`, 'migration checkpoint partial report'),
  ]);
  return { root, plan, journal, backups, partialReport };
}

function parsePlan(raw: string): MigrationPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new MigrationExecutionError('CHECKPOINT_PLAN_CORRUPT', 'Checkpoint plan.json is not valid JSON.', {
      cause: (error as Error).message,
    });
  }

  if (typeof value !== 'object' || value === null) {
    throw new MigrationExecutionError('CHECKPOINT_PLAN_CORRUPT', 'Checkpoint plan.json is not an object.');
  }
  const plan = value as Partial<MigrationPlan>;
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.migrationId !== 'string' ||
    (plan.status !== 'ready' && plan.status !== 'blocked') ||
    !Array.isArray(plan.operations) ||
    typeof plan.source !== 'object' ||
    plan.source === null ||
    typeof plan.target !== 'object' ||
    plan.target === null ||
    typeof plan.preconditions !== 'object' ||
    plan.preconditions === null ||
    !Array.isArray(plan.blockers) ||
    !Array.isArray(plan.warnings) ||
    !Array.isArray(plan.verification)
  ) {
    throw new MigrationExecutionError('CHECKPOINT_PLAN_CORRUPT', 'Checkpoint plan.json has an unsupported shape.');
  }
  return plan as MigrationPlan;
}

function parseJournal(raw: string): MigrationJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new MigrationExecutionError('JOURNAL_CORRUPT', 'Migration journal is not valid JSON.', {
      cause: (error as Error).message,
    });
  }

  if (typeof value !== 'object' || value === null) {
    throw new MigrationExecutionError('JOURNAL_CORRUPT', 'Migration journal is not an object.');
  }
  const journal = value as Partial<MigrationJournal>;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.migrationId !== 'string' ||
    typeof journal.planSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(journal.planSha256) ||
    !['prepared', 'running', 'recovery-required', 'completed'].includes(journal.state ?? '') ||
    typeof journal.createdAt !== 'string' ||
    typeof journal.updatedAt !== 'string' ||
    !Array.isArray(journal.operations)
  ) {
    throw new MigrationExecutionError('JOURNAL_CORRUPT', 'Migration journal has an unsupported shape.');
  }

  for (const operation of journal.operations) {
    if (
      typeof operation !== 'object' ||
      operation === null ||
      typeof operation.id !== 'string' ||
      typeof operation.kind !== 'string' ||
      typeof operation.path !== 'string' ||
      !['pending', 'applying', 'applied', 'verified'].includes(operation.status) ||
      (operation.postcondition !== null && (typeof operation.postcondition !== 'object' || Array.isArray(operation.postcondition)))
    ) {
      throw new MigrationExecutionError('JOURNAL_CORRUPT', 'Migration journal contains an invalid operation record.');
    }
  }

  return journal as MigrationJournal;
}

function validateJournalAgainstPlan(plan: MigrationPlan, journal: MigrationJournal, planBytes: string): void {
  if (journal.migrationId !== plan.migrationId) {
    throw new MigrationExecutionError('JOURNAL_INCONSISTENT', 'Journal migrationId does not match plan.', {
      planMigrationId: plan.migrationId,
      journalMigrationId: journal.migrationId,
    });
  }

  const actualPlanSha256 = sha256(planBytes);
  if (journal.planSha256 !== actualPlanSha256) {
    throw new MigrationExecutionError('JOURNAL_INCONSISTENT', 'Saved plan digest does not match journal.', {
      expected: journal.planSha256,
      actual: actualPlanSha256,
    });
  }

  if (journal.operations.length !== plan.operations.length) {
    throw new MigrationExecutionError('JOURNAL_INCONSISTENT', 'Journal operation count does not match saved plan.');
  }

  const ids = new Set<string>();
  for (let index = 0; index < plan.operations.length; index += 1) {
    const planned = plan.operations[index];
    const journaled = journal.operations[index];
    if (ids.has(journaled.id)) {
      throw new MigrationExecutionError('JOURNAL_INCONSISTENT', `Duplicate operation id in journal: ${journaled.id}.`);
    }
    ids.add(journaled.id);
    if (
      journaled.id !== planned.id ||
      journaled.kind !== planned.kind ||
      journaled.path !== planned.path
    ) {
      throw new MigrationExecutionError('JOURNAL_INCONSISTENT', 'Journal operation does not match saved plan.', {
        index,
        planned: { id: planned.id, kind: planned.kind, path: planned.path },
        journaled: { id: journaled.id, kind: journaled.kind, path: journaled.path },
      });
    }
  }
}

export async function migrationCheckpointExists(
  projectRoot: string,
  migrationId: string,
): Promise<boolean> {
  const paths = await migrationCheckpointPaths(projectRoot, migrationId);
  try {
    await readFile(paths.plan);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function createMigrationCheckpoint(
  plan: MigrationPlan,
  projectRoot: string,
  now: () => Date,
): Promise<MigrationCheckpointStatus> {
  const paths = await migrationCheckpointPaths(projectRoot, plan.migrationId);
  await mkdir(path.dirname(paths.root), { recursive: true });
  try {
    await mkdir(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MigrationExecutionError(
        'MIGRATION_CHECKPOINT_EXISTS',
        `Migration checkpoint already exists: ${plan.migrationId}. Use resume instead.`,
        { migrationId: plan.migrationId, checkpoint: paths.root },
      );
    }
    throw error;
  }
  await mkdir(paths.backups);

  const planBytes = serializeMigrationPlan(plan);
  const timestamp = now().toISOString();
  const journal: MigrationJournal = {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    planSha256: sha256(planBytes),
    state: 'prepared',
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'pending',
      postcondition: null,
      appliedAt: null,
      verifiedAt: null,
    })),
    recovery: null,
  };

  try {
    await atomicWriteText(paths.plan, planBytes);
    await atomicWriteText(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
    await atomicWriteText(
      paths.partialReport,
      `${JSON.stringify({ schemaVersion: 1, migrationId: plan.migrationId, state: 'prepared', updatedAt: timestamp }, null, 2)}\n`,
    );
  } catch (error) {
    await rm(paths.root, { recursive: true, force: true });
    throw error;
  }

  return { plan, journal, paths };
}

export async function loadMigrationCheckpoint(
  projectRoot: string,
  migrationId: string,
): Promise<MigrationCheckpointStatus> {
  const paths = await migrationCheckpointPaths(projectRoot, migrationId);
  if (!(await exists(paths.plan)) || !(await exists(paths.journal))) {
    throw new MigrationExecutionError('MIGRATION_CHECKPOINT_MISSING', `Migration checkpoint is incomplete or missing: ${migrationId}.`, {
      migrationId,
      checkpoint: paths.root,
    });
  }

  const [planBytes, journalBytes] = await Promise.all([
    readFile(paths.plan, 'utf8'),
    readFile(paths.journal, 'utf8'),
  ]);
  const plan = parsePlan(planBytes);
  const journal = parseJournal(journalBytes);
  validateJournalAgainstPlan(plan, journal, planBytes);
  return { plan, journal, paths };
}

export async function saveMigrationJournal(
  paths: MigrationCheckpointPaths,
  journal: MigrationJournal,
): Promise<void> {
  await atomicWriteText(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
}

export async function savePartialMigrationReport(
  paths: MigrationCheckpointPaths,
  journal: MigrationJournal,
): Promise<void> {
  await atomicWriteText(
    paths.partialReport,
    `${JSON.stringify({
      schemaVersion: 1,
      migrationId: journal.migrationId,
      state: journal.state,
      updatedAt: journal.updatedAt,
      verifiedOperations: journal.operations.filter((operation) => operation.status === 'verified').length,
      totalOperations: journal.operations.length,
      recovery: journal.recovery,
    }, null, 2)}\n`,
  );
}

export async function removeMigrationCheckpoint(paths: MigrationCheckpointPaths): Promise<void> {
  await rm(paths.root, { recursive: true, force: true });
}

export function migrationPlanDigest(plan: MigrationPlan): string {
  return sha256(serializeMigrationPlan(plan));
}
