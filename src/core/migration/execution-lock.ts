import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, stat, unlink, utimes } from 'node:fs/promises';
import { hostname as systemHostname } from 'node:os';
import path from 'node:path';
import { resolveHarnessStatePath } from '../git.js';
import { MigrationExecutionError } from './executor-types.js';

const LOCK_FILE = 'migration-execution.lock.json';
const DEFAULT_RECLAIM_CLAIM_TIMEOUT_MS = 30_000;

export type MigrationExecutionLockMode = 'apply' | 'resume';

export interface MigrationExecutionLockOwner {
  schemaVersion: 1;
  ownerId: string;
  migrationId: string;
  mode: MigrationExecutionLockMode;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export type MigrationExecutionLockStatus =
  | {
      state: 'none';
      path: string;
    }
  | {
      state: 'active' | 'stale';
      path: string;
      owner: MigrationExecutionLockOwner;
      reason: 'process-alive' | 'process-missing' | 'foreign-host';
      recoveryClaimPresent: boolean;
    }
  | {
      state: 'corrupt';
      path: string;
      error: {
        code: 'MIGRATION_LOCK_CORRUPT';
        message: string;
      };
    };

export interface MigrationExecutionLockDependencies {
  now?: () => Date;
  hostname?: () => string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  reclaimClaimTimeoutMs?: number;
}

export interface MigrationExecutionLockLease {
  readonly path: string;
  readonly owner: MigrationExecutionLockOwner;
  release(): Promise<void>;
}

function now(dependencies: MigrationExecutionLockDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}

function host(dependencies: MigrationExecutionLockDependencies): string {
  return (dependencies.hostname ?? systemHostname)();
}

function ownerPid(dependencies: MigrationExecutionLockDependencies): number {
  return dependencies.pid ?? process.pid;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM and platform-specific access errors mean the process may exist.
    // Treat them as active rather than risking concurrent mutation.
    return true;
  }
}

function processAlive(
  pid: number,
  dependencies: MigrationExecutionLockDependencies,
): boolean {
  return (dependencies.isProcessAlive ?? defaultProcessAlive)(pid);
}

function assertOwner(value: unknown): MigrationExecutionLockOwner {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Lock record must be a JSON object.');
  }
  const record = value as Partial<MigrationExecutionLockOwner>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.ownerId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.ownerId) ||
    typeof record.migrationId !== 'string' ||
    record.migrationId.length === 0 ||
    (record.mode !== 'apply' && record.mode !== 'resume') ||
    !Number.isInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    typeof record.hostname !== 'string' ||
    record.hostname.length === 0 ||
    typeof record.acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(record.acquiredAt))
  ) {
    throw new Error('Lock record has an unsupported shape.');
  }
  return record as MigrationExecutionLockOwner;
}

async function readOwner(lockPath: string): Promise<MigrationExecutionLockOwner | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MigrationExecutionError(
      'MIGRATION_LOCK_CORRUPT',
      'Migration execution lock is not valid JSON.',
      { lockPath, cause: (error as Error).message },
    );
  }

  try {
    return assertOwner(parsed);
  } catch (error) {
    throw new MigrationExecutionError(
      'MIGRATION_LOCK_CORRUPT',
      'Migration execution lock has an unsupported shape.',
      { lockPath, cause: (error as Error).message },
    );
  }
}

async function exclusiveWriteRecord(
  target: string,
  owner: MigrationExecutionLockOwner,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${owner.ownerId}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function ownerState(
  owner: MigrationExecutionLockOwner,
  dependencies: MigrationExecutionLockDependencies,
): { state: 'active' | 'stale'; reason: 'process-alive' | 'process-missing' | 'foreign-host' } {
  if (owner.hostname !== host(dependencies)) {
    // Cross-host process liveness cannot be proven portably. Fail closed.
    return { state: 'active', reason: 'foreign-host' };
  }
  return processAlive(owner.pid, dependencies)
    ? { state: 'active', reason: 'process-alive' }
    : { state: 'stale', reason: 'process-missing' };
}

async function reclaimClaimPath(
  projectRoot: string,
  ownerId: string,
): Promise<string> {
  return resolveHarnessStatePath(
    projectRoot,
    `migration-execution.reclaim-${ownerId}.json`,
    'migration execution stale-lock reclaim claim',
  );
}

async function claimPresent(
  projectRoot: string,
  ownerId: string,
): Promise<boolean> {
  const claim = await reclaimClaimPath(projectRoot, ownerId);
  try {
    await stat(claim);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function migrationExecutionLockPath(projectRoot: string): Promise<string> {
  return resolveHarnessStatePath(
    projectRoot,
    LOCK_FILE,
    'migration execution lock',
  );
}

export async function inspectMigrationExecutionLock(
  projectRoot: string,
  dependencies: MigrationExecutionLockDependencies = {},
): Promise<MigrationExecutionLockStatus> {
  const lockPath = await migrationExecutionLockPath(projectRoot);
  let owner: MigrationExecutionLockOwner | null;
  try {
    owner = await readOwner(lockPath);
  } catch (error) {
    if (error instanceof MigrationExecutionError && error.code === 'MIGRATION_LOCK_CORRUPT') {
      return {
        state: 'corrupt',
        path: lockPath,
        error: { code: error.code, message: error.message },
      };
    }
    throw error;
  }

  if (owner === null) return { state: 'none', path: lockPath };

  const state = ownerState(owner, dependencies);
  return {
    ...state,
    path: lockPath,
    owner,
    recoveryClaimPresent: await claimPresent(projectRoot, owner.ownerId),
  };
}

function activeError(status: Extract<MigrationExecutionLockStatus, { state: 'active' }>): MigrationExecutionError {
  return new MigrationExecutionError(
    'MIGRATION_LOCK_ACTIVE',
    `Migration execution is already active for ${status.owner.migrationId}.`,
    {
      lockPath: status.path,
      owner: status.owner,
      reason: status.reason,
    },
  );
}

async function createOwnerRecord(
  projectRoot: string,
  migrationId: string,
  mode: MigrationExecutionLockMode,
  dependencies: MigrationExecutionLockDependencies,
): Promise<{ path: string; owner: MigrationExecutionLockOwner }> {
  const lockPath = await migrationExecutionLockPath(projectRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });

  // Re-resolve after creating the parent so #25 filesystem containment is
  // checked against the actual directory entry used for the lock mutation.
  const checkedPath = await migrationExecutionLockPath(projectRoot);
  const owner: MigrationExecutionLockOwner = {
    schemaVersion: 1,
    ownerId: randomUUID(),
    migrationId,
    mode,
    pid: ownerPid(dependencies),
    hostname: host(dependencies),
    acquiredAt: now(dependencies).toISOString(),
  };
  await exclusiveWriteRecord(checkedPath, owner);
  return { path: checkedPath, owner };
}

async function releaseOwnedLock(
  projectRoot: string,
  lease: { path: string; owner: MigrationExecutionLockOwner },
): Promise<void> {
  const currentPath = await migrationExecutionLockPath(projectRoot);
  const current = await readOwner(currentPath);
  if (current === null) return;
  if (current.ownerId !== lease.owner.ownerId) {
    throw new MigrationExecutionError(
      'MIGRATION_LOCK_LOST',
      'Migration execution lock ownership changed before release.',
      {
        expectedOwnerId: lease.owner.ownerId,
        actualOwnerId: current.ownerId,
        lockPath: currentPath,
      },
    );
  }
  await unlink(currentPath);
}

async function acquireReclaimClaim(
  projectRoot: string,
  staleOwner: MigrationExecutionLockOwner,
  dependencies: MigrationExecutionLockDependencies,
): Promise<string> {
  const lockPath = await migrationExecutionLockPath(projectRoot);
  const claimPath = await reclaimClaimPath(projectRoot, staleOwner.ownerId);
  const timeout = dependencies.reclaimClaimTimeoutMs ?? DEFAULT_RECLAIM_CLAIM_TIMEOUT_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await link(lockPath, claimPath);
      const timestamp = now(dependencies);
      await utimes(claimPath, timestamp, timestamp);
      return claimPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const metadata = await stat(claimPath);
      const ageMs = Math.max(0, now(dependencies).getTime() - metadata.mtimeMs);
      if (ageMs < timeout) {
        throw new MigrationExecutionError(
          'MIGRATION_LOCK_RECOVERY_IN_PROGRESS',
          'Another process is already recovering the stale migration execution lock.',
          {
            lockPath,
            claimPath,
            staleOwner,
            claimAgeMs: ageMs,
          },
        );
      }

      // A crashed reclaimer must not block recovery forever. The claim is
      // only a hard-link guard for the already-stale lock generation.
      await rm(claimPath, { force: true });
    }
  }

  throw new MigrationExecutionError(
    'MIGRATION_LOCK_RECOVERY_IN_PROGRESS',
    'Could not acquire stale migration lock recovery claim.',
    { lockPath, claimPath, staleOwner },
  );
}

async function takeOverStaleLock(
  projectRoot: string,
  staleStatus: Extract<MigrationExecutionLockStatus, { state: 'stale' }>,
  migrationId: string,
  mode: MigrationExecutionLockMode,
  dependencies: MigrationExecutionLockDependencies,
): Promise<{ path: string; owner: MigrationExecutionLockOwner }> {
  const claimPath = await acquireReclaimClaim(projectRoot, staleStatus.owner, dependencies);
  try {
    const claimOwner = await readOwner(claimPath);
    if (claimOwner?.ownerId !== staleStatus.owner.ownerId) {
      throw new MigrationExecutionError(
        'MIGRATION_LOCK_RECOVERY_IN_PROGRESS',
        'Stale migration lock recovery claim no longer matches the inspected lock generation.',
        {
          claimPath,
          expectedOwnerId: staleStatus.owner.ownerId,
          actualOwnerId: claimOwner?.ownerId ?? null,
        },
      );
    }

    const claimedState = ownerState(claimOwner, dependencies);
    if (claimedState.state !== 'stale') {
      throw new MigrationExecutionError(
        'MIGRATION_LOCK_ACTIVE',
        `Migration execution lock became active again for ${claimOwner.migrationId}.`,
        { owner: claimOwner, reason: claimedState.reason },
      );
    }

    const lockPath = await migrationExecutionLockPath(projectRoot);
    const currentOwner = await readOwner(lockPath);
    if (currentOwner === null || currentOwner.ownerId !== staleStatus.owner.ownerId) {
      const current = await inspectMigrationExecutionLock(projectRoot, dependencies);
      if (current.state === 'active') throw activeError(current);
      throw new MigrationExecutionError(
        'MIGRATION_LOCK_RECOVERY_IN_PROGRESS',
        'Migration execution lock changed while stale recovery was being claimed.',
        {
          expectedOwnerId: staleStatus.owner.ownerId,
          actualState: current.state,
        },
      );
    }

    await unlink(lockPath);

    try {
      return await createOwnerRecord(projectRoot, migrationId, mode, dependencies);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await inspectMigrationExecutionLock(projectRoot, dependencies);
      if (current.state === 'active') throw activeError(current);
      throw new MigrationExecutionError(
        'MIGRATION_LOCK_RECOVERY_IN_PROGRESS',
        'Another process acquired the migration execution lock during stale recovery.',
        { currentState: current.state },
      );
    }
  } finally {
    await rm(claimPath, { force: true });
  }
}

export async function acquireMigrationExecutionLock(
  projectRoot: string,
  migrationId: string,
  mode: MigrationExecutionLockMode,
  dependencies: MigrationExecutionLockDependencies = {},
): Promise<MigrationExecutionLockLease> {
  let acquired: { path: string; owner: MigrationExecutionLockOwner };
  try {
    acquired = await createOwnerRecord(projectRoot, migrationId, mode, dependencies);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const status = await inspectMigrationExecutionLock(projectRoot, dependencies);
    if (status.state === 'active') throw activeError(status);
    if (status.state === 'corrupt') {
      throw new MigrationExecutionError(
        'MIGRATION_LOCK_CORRUPT',
        status.error.message,
        { lockPath: status.path },
      );
    }
    if (status.state === 'none') {
      // The owner may have released between EEXIST and inspection.
      acquired = await createOwnerRecord(projectRoot, migrationId, mode, dependencies);
    } else {
      acquired = await takeOverStaleLock(
        projectRoot,
        status,
        migrationId,
        mode,
        dependencies,
      );
    }
  }

  let released = false;
  return {
    path: acquired.path,
    owner: acquired.owner,
    async release(): Promise<void> {
      if (released) return;
      await releaseOwnedLock(projectRoot, acquired);
      released = true;
    },
  };
}
