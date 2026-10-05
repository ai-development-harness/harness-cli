import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { findGitRoot, trackedWorkingTreeBlobSha1 } from '../git.js';
import { ReleaseStore } from '../releases/store.js';
import type { MigrationPlan, MigrationPlanOperation } from './plan-types.js';
import {
  createMigrationCheckpoint,
  loadMigrationCheckpoint,
  migrationCheckpointExists,
  removeMigrationCheckpoint,
  saveMigrationJournal,
  savePartialMigrationReport,
} from './checkpoint.js';
import {
  MigrationExecutionError,
  type MigrationCheckpointStatus,
  type MigrationExecutionResult,
  type MigrationExecutorDependencies,
  type MigrationJournal,
  type MigrationJournalOperation,
  type MigrationOperationContext,
  type MigrationOperationHandler,
  type MigrationOperationPostcondition,
} from './executor-types.js';

const execFileAsync = promisify(execFile);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(dependencies: MigrationExecutorDependencies): string {
  return (dependencies.now ?? (() => new Date()))().toISOString();
}

async function currentHead(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

function resolveProjectPath(projectRoot: string, portablePath: string): string {
  if (!portablePath || portablePath.startsWith('/') || portablePath.includes('\\')) {
    throw new MigrationExecutionError('PLAN_INVALID', `Unsafe migration path: ${portablePath}.`, { path: portablePath });
  }
  const segments = portablePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new MigrationExecutionError('PLAN_INVALID', `Unsafe migration path: ${portablePath}.`, { path: portablePath });
  }
  const resolved = path.resolve(projectRoot, ...segments);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MigrationExecutionError('PLAN_INVALID', `Migration path escapes project root: ${portablePath}.`, {
      path: portablePath,
    });
  }
  return resolved;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertOperationPrecondition(
  projectRoot: string,
  operation: MigrationPlanOperation,
): Promise<void> {
  const target = resolveProjectPath(projectRoot, operation.path);
  switch (operation.precondition.kind) {
    case 'none':
      return;
    case 'absent': {
      if (await fileExists(target)) {
        throw new MigrationExecutionError('PLAN_STALE', `Expected path to be absent: ${operation.path}.`, {
          operationId: operation.id,
          path: operation.path,
        });
      }
      return;
    }
    case 'sha256': {
      let bytes: Buffer;
      try {
        bytes = await readFile(target);
      } catch (error) {
        throw new MigrationExecutionError('PLAN_STALE', `Cannot read precondition path: ${operation.path}.`, {
          operationId: operation.id,
          path: operation.path,
          cause: (error as Error).message,
        });
      }
      const actual = sha256(bytes);
      if (actual !== operation.precondition.value) {
        throw new MigrationExecutionError('PLAN_STALE', `SHA-256 precondition changed: ${operation.path}.`, {
          operationId: operation.id,
          path: operation.path,
          expected: operation.precondition.value,
          actual,
        });
      }
      return;
    }
    case 'git-blob-sha1': {
      const actual = await trackedWorkingTreeBlobSha1(projectRoot, operation.path);
      if (actual !== operation.precondition.value) {
        throw new MigrationExecutionError('PLAN_STALE', `Git blob precondition changed: ${operation.path}.`, {
          operationId: operation.id,
          path: operation.path,
          expected: operation.precondition.value,
          actual,
        });
      }
      return;
    }
  }
}

async function assertProjectIdentity(plan: MigrationPlan): Promise<string> {
  if (plan.source.projectRoot === null) {
    throw new MigrationExecutionError('PLAN_INVALID', 'Migration plan has no source project root.');
  }
  const plannedRoot = await realpath(path.resolve(plan.source.projectRoot));
  let actualRoot: string;
  try {
    actualRoot = await realpath(await findGitRoot(plannedRoot));
  } catch (error) {
    throw new MigrationExecutionError('PROJECT_IDENTITY_MISMATCH', 'Planned project is no longer a Git repository.', {
      plannedRoot,
      cause: (error as Error).message,
    });
  }
  if (actualRoot !== plannedRoot) {
    throw new MigrationExecutionError('PROJECT_IDENTITY_MISMATCH', 'Git root does not match migration plan.', {
      plannedRoot,
      actualRoot,
    });
  }
  const head = await currentHead(plannedRoot);
  if (head !== plan.preconditions.expectedHeadSha || head !== plan.source.headSha) {
    throw new MigrationExecutionError('PLAN_STALE', 'Git HEAD changed after migration planning.', {
      expectedHeadSha: plan.preconditions.expectedHeadSha,
      sourceHeadSha: plan.source.headSha,
      actualHeadSha: head,
    });
  }
  return plannedRoot;
}

function assertReadyPlan(plan: MigrationPlan): void {
  if (
    plan.schemaVersion !== 1 ||
    !plan.migrationId ||
    plan.status !== 'ready' ||
    plan.blockers.length > 0 ||
    plan.source.projectRoot === null ||
    !plan.preconditions.migrationCheckpointAbsent
  ) {
    throw new MigrationExecutionError('PLAN_BLOCKED', 'Migration plan is not executable.', {
      migrationId: plan.migrationId,
      status: plan.status,
      blockerCount: plan.blockers.length,
    });
  }
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    if (!operation.id || ids.has(operation.id)) {
      throw new MigrationExecutionError('PLAN_INVALID', 'Migration plan contains missing or duplicate operation ids.', {
        operationId: operation.id,
      });
    }
    ids.add(operation.id);
    resolveProjectPath(plan.source.projectRoot ?? '', operation.path);
    if (operation.kind === 'BLOCK_CONFLICT') {
      throw new MigrationExecutionError('PLAN_BLOCKED', 'Executable plan contains BLOCK_CONFLICT operation.', {
        operationId: operation.id,
        path: operation.path,
      });
    }
  }
}

function preserveHandler(): MigrationOperationHandler {
  return {
    async apply(context): Promise<MigrationOperationPostcondition> {
      return { preservedPath: context.operation.path };
    },
    async verify(context, postcondition): Promise<boolean> {
      if (postcondition.preservedPath !== context.operation.path) return false;
      try {
        await assertOperationPrecondition(context.projectRoot, context.operation);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function handlerFor(
  operation: MigrationPlanOperation,
  dependencies: MigrationExecutorDependencies,
): MigrationOperationHandler | null {
  if (operation.kind === 'PRESERVE') return preserveHandler();
  return dependencies.handlers?.[operation.kind] ?? null;
}

function assertHandlersAvailable(plan: MigrationPlan, dependencies: MigrationExecutorDependencies): void {
  const missing = plan.operations
    .filter((operation) => handlerFor(operation, dependencies) === null)
    .map((operation) => ({ id: operation.id, kind: operation.kind, path: operation.path }));
  if (missing.length > 0) {
    throw new MigrationExecutionError(
      'OPERATION_HANDLER_MISSING',
      'Migration plan requires operation handlers that are not installed.',
      { operations: missing },
    );
  }
}

async function assertTargetRelease(plan: MigrationPlan, dependencies: MigrationExecutorDependencies): Promise<void> {
  if (plan.target.harnessRelease === null || plan.target.releaseDigest === null) {
    throw new MigrationExecutionError('PLAN_INVALID', 'Ready migration plan has no verified target release identity.');
  }
  try {
    const release = await (dependencies.releaseStore ?? new ReleaseStore()).verify(plan.target.harnessRelease);
    if (release.digest !== plan.target.releaseDigest) {
      throw new MigrationExecutionError('PLAN_STALE', 'Target Harness release digest changed after planning.', {
        release: plan.target.harnessRelease,
        expectedDigest: plan.target.releaseDigest,
        actualDigest: release.digest,
      });
    }
  } catch (error) {
    if (error instanceof MigrationExecutionError) throw error;
    throw new MigrationExecutionError('PLAN_STALE', 'Target Harness release can no longer be verified.', {
      release: plan.target.harnessRelease,
      cause: (error as Error).message,
    });
  }
}

async function assertInitialPreconditions(plan: MigrationPlan, projectRoot: string): Promise<void> {
  for (const operation of plan.operations) {
    if (!operation.mutates) continue;
    await assertOperationPrecondition(projectRoot, operation);
  }
}

async function persistJournal(
  checkpoint: MigrationCheckpointStatus,
  dependencies: MigrationExecutorDependencies,
): Promise<void> {
  checkpoint.journal.updatedAt = nowIso(dependencies);
  await saveMigrationJournal(checkpoint.paths, checkpoint.journal);
  await savePartialMigrationReport(checkpoint.paths, checkpoint.journal);
}

async function markRecoveryRequired(
  checkpoint: MigrationCheckpointStatus,
  error: MigrationExecutionError,
  operationId: string | null,
  dependencies: MigrationExecutorDependencies,
): Promise<never> {
  checkpoint.journal.state = 'recovery-required';
  checkpoint.journal.recovery = {
    code: error.code,
    message: error.message,
    operationId,
    details: error.details,
  };
  await persistJournal(checkpoint, dependencies);
  throw error;
}

function operationContext(
  checkpoint: MigrationCheckpointStatus,
  operation: MigrationPlanOperation,
  projectRoot: string,
): MigrationOperationContext {
  return {
    plan: checkpoint.plan,
    operation,
    projectRoot,
    checkpoint: checkpoint.paths,
  };
}

async function recoverAppliedOperation(
  checkpoint: MigrationCheckpointStatus,
  journalOperation: MigrationJournalOperation,
  operation: MigrationPlanOperation,
  handler: MigrationOperationHandler,
  projectRoot: string,
  dependencies: MigrationExecutorDependencies,
): Promise<void> {
  const postcondition = journalOperation.postcondition;
  if (postcondition === null) {
    return markRecoveryRequired(
      checkpoint,
      new MigrationExecutionError('JOURNAL_INCONSISTENT', 'Applied operation has no saved postcondition.', {
        operationId: operation.id,
      }),
      operation.id,
      dependencies,
    );
  }
  const ok = await handler.verify(
    operationContext(checkpoint, operation, projectRoot),
    postcondition,
  );
  if (!ok) {
    await markRecoveryRequired(
      checkpoint,
      new MigrationExecutionError('POSTCONDITION_FAILED', 'Applied operation postcondition no longer holds.', {
        operationId: operation.id,
        path: operation.path,
      }),
      operation.id,
      dependencies,
    );
  }
  journalOperation.status = 'verified';
  journalOperation.verifiedAt = nowIso(dependencies);
  await persistJournal(checkpoint, dependencies);
}

async function executePendingOperation(
  checkpoint: MigrationCheckpointStatus,
  journalOperation: MigrationJournalOperation,
  operation: MigrationPlanOperation,
  handler: MigrationOperationHandler,
  projectRoot: string,
  dependencies: MigrationExecutorDependencies,
): Promise<void> {
  try {
    await assertOperationPrecondition(projectRoot, operation);
  } catch (error) {
    if (error instanceof MigrationExecutionError) {
      await markRecoveryRequired(checkpoint, error, operation.id, dependencies);
    }
    throw error;
  }

  journalOperation.status = 'applying';
  await persistJournal(checkpoint, dependencies);

  let postcondition: MigrationOperationPostcondition;
  try {
    postcondition = await handler.apply(operationContext(checkpoint, operation, projectRoot));
  } catch (error) {
    return markRecoveryRequired(
      checkpoint,
      new MigrationExecutionError(
        'OPERATION_INDETERMINATE',
        'Operation handler failed after execution entered the applying state; automatic retry is unsafe.',
        { operationId: operation.id, path: operation.path, cause: (error as Error).message },
      ),
      operation.id,
      dependencies,
    );
  }

  journalOperation.status = 'applied';
  journalOperation.postcondition = postcondition;
  journalOperation.appliedAt = nowIso(dependencies);
  await persistJournal(checkpoint, dependencies);
  await dependencies.hooks?.afterOperationApplied?.(operation);

  const verified = await handler.verify(
    operationContext(checkpoint, operation, projectRoot),
    postcondition,
  );
  if (!verified) {
    await markRecoveryRequired(
      checkpoint,
      new MigrationExecutionError('POSTCONDITION_FAILED', 'Operation postcondition verification failed.', {
        operationId: operation.id,
        path: operation.path,
      }),
      operation.id,
      dependencies,
    );
  }

  journalOperation.status = 'verified';
  journalOperation.verifiedAt = nowIso(dependencies);
  await persistJournal(checkpoint, dependencies);
  await dependencies.hooks?.afterOperationVerified?.(operation);
}

async function runCheckpoint(
  checkpoint: MigrationCheckpointStatus,
  dependencies: MigrationExecutorDependencies,
): Promise<MigrationExecutionResult> {
  const projectRoot = await assertProjectIdentity(checkpoint.plan);
  assertHandlersAvailable(checkpoint.plan, dependencies);
  await assertTargetRelease(checkpoint.plan, dependencies);

  if (checkpoint.journal.state === 'recovery-required') {
    const recovery = checkpoint.journal.recovery;
    throw new MigrationExecutionError(
      recovery?.code ?? 'JOURNAL_INCONSISTENT',
      recovery?.message ?? 'Migration requires manual recovery before resume.',
      recovery?.details ?? {},
    );
  }

  if (checkpoint.journal.state === 'completed') {
    const verifiedOperations = checkpoint.journal.operations.filter((operation) => operation.status === 'verified').length;
    await removeMigrationCheckpoint(checkpoint.paths);
    return { migrationId: checkpoint.plan.migrationId, status: 'completed', verifiedOperations, checkpointRemoved: true };
  }

  checkpoint.journal.state = 'running';
  checkpoint.journal.recovery = null;
  await persistJournal(checkpoint, dependencies);

  for (let index = 0; index < checkpoint.plan.operations.length; index += 1) {
    const operation = checkpoint.plan.operations[index];
    const journalOperation = checkpoint.journal.operations[index];
    const handler = handlerFor(operation, dependencies)!;

    if (journalOperation.status === 'verified') continue;
    if (journalOperation.status === 'applying') {
      await markRecoveryRequired(
        checkpoint,
        new MigrationExecutionError(
          'OPERATION_INDETERMINATE',
          'Migration stopped while an operation was applying; automatic replay is unsafe.',
          { operationId: operation.id, path: operation.path },
        ),
        operation.id,
        dependencies,
      );
    }
    if (journalOperation.status === 'applied') {
      await recoverAppliedOperation(
        checkpoint,
        journalOperation,
        operation,
        handler,
        projectRoot,
        dependencies,
      );
      continue;
    }
    await executePendingOperation(
      checkpoint,
      journalOperation,
      operation,
      handler,
      projectRoot,
      dependencies,
    );
  }

  checkpoint.journal.state = 'completed';
  checkpoint.journal.recovery = null;
  await persistJournal(checkpoint, dependencies);
  const verifiedOperations = checkpoint.journal.operations.filter((operation) => operation.status === 'verified').length;
  await removeMigrationCheckpoint(checkpoint.paths);
  return {
    migrationId: checkpoint.plan.migrationId,
    status: 'completed',
    verifiedOperations,
    checkpointRemoved: true,
  };
}

export async function executeMigration(
  plan: MigrationPlan,
  dependencies: MigrationExecutorDependencies = {},
): Promise<MigrationExecutionResult> {
  assertReadyPlan(plan);
  const projectRoot = await assertProjectIdentity(plan);
  assertHandlersAvailable(plan, dependencies);
  await assertTargetRelease(plan, dependencies);
  if (await migrationCheckpointExists(projectRoot, plan.migrationId)) {
    throw new MigrationExecutionError(
      'MIGRATION_CHECKPOINT_EXISTS',
      `Migration checkpoint already exists: ${plan.migrationId}. Use resume instead.`,
      { migrationId: plan.migrationId },
    );
  }
  await assertInitialPreconditions(plan, projectRoot);
  const checkpoint = await createMigrationCheckpoint(plan, projectRoot, dependencies.now ?? (() => new Date()));
  return runCheckpoint(checkpoint, dependencies);
}

export async function resumeMigration(
  projectRoot: string,
  migrationId: string,
  dependencies: MigrationExecutorDependencies = {},
): Promise<MigrationExecutionResult> {
  const checkpoint = await loadMigrationCheckpoint(projectRoot, migrationId);
  return runCheckpoint(checkpoint, dependencies);
}

export async function inspectMigrationCheckpoint(
  projectRoot: string,
  migrationId: string,
): Promise<MigrationCheckpointStatus> {
  return loadMigrationCheckpoint(projectRoot, migrationId);
}
