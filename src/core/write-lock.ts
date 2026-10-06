import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname as systemHostname } from 'node:os';
import path from 'node:path';
import { resolveHarnessStatePath } from './git.js';

const LOCK_FILE = 'core-write.lock.json';

export interface CoreWriteLockOwner {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly kind: string;
  readonly operationId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CoreWriteLockDependencies {
  readonly now?: () => Date;
  readonly hostname?: () => string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class CoreWriteLockError extends Error {
  constructor(
    readonly code: 'CORE_WRITE_LOCK_ACTIVE' | 'CORE_WRITE_LOCK_CORRUPT' | 'CORE_WRITE_LOCK_LOST',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CoreWriteLockError';
  }
}

export interface CoreWriteLockLease {
  readonly path: string;
  readonly owner: CoreWriteLockOwner;
  release(): Promise<void>;
}

function dependencyNow(dependencies: CoreWriteLockDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}

function dependencyHostname(dependencies: CoreWriteLockDependencies): string {
  return (dependencies.hostname ?? systemHostname)();
}

function dependencyPid(dependencies: CoreWriteLockDependencies): number {
  return dependencies.pid ?? process.pid;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isProcessAlive(pid: number, dependencies: CoreWriteLockDependencies): boolean {
  return (dependencies.isProcessAlive ?? defaultProcessAlive)(pid);
}

function assertOwner(value: unknown): CoreWriteLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('lock record must be an object');
  }
  const item = value as Partial<CoreWriteLockOwner>;
  if (
    item.schemaVersion !== 1 ||
    typeof item.ownerId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(item.ownerId) ||
    typeof item.kind !== 'string' ||
    item.kind.length === 0 ||
    typeof item.operationId !== 'string' ||
    item.operationId.length === 0 ||
    !Number.isInteger(item.pid) ||
    (item.pid ?? 0) <= 0 ||
    typeof item.hostname !== 'string' ||
    item.hostname.length === 0 ||
    typeof item.acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(item.acquiredAt))
  ) {
    throw new Error('lock record has an unsupported shape');
  }
  return item as CoreWriteLockOwner;
}

async function readOwner(lockPath: string): Promise<CoreWriteLockOwner | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return assertOwner(JSON.parse(raw));
  } catch (error) {
    throw new CoreWriteLockError(
      'CORE_WRITE_LOCK_CORRUPT',
      'Core write lock is corrupt.',
      { lockPath, cause: (error as Error).message },
    );
  }
}

export async function coreWriteLockPath(projectRoot: string): Promise<string> {
  return resolveHarnessStatePath(projectRoot, LOCK_FILE, 'Core write execution lock');
}

async function createLock(
  projectRoot: string,
  kind: string,
  operationId: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  dependencies: CoreWriteLockDependencies,
): Promise<{ path: string; owner: CoreWriteLockOwner }> {
  const target = await coreWriteLockPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const checked = await coreWriteLockPath(projectRoot);
  const owner: CoreWriteLockOwner = {
    schemaVersion: 1,
    ownerId: randomUUID(),
    kind,
    operationId,
    pid: dependencyPid(dependencies),
    hostname: dependencyHostname(dependencies),
    acquiredAt: dependencyNow(dependencies).toISOString(),
    ...(metadata ? { metadata } : {}),
  };
  let handle;
  try {
    handle = await open(checked, 'wx');
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  return { path: checked, owner };
}

function active(owner: CoreWriteLockOwner, dependencies: CoreWriteLockDependencies): boolean {
  if (owner.hostname !== dependencyHostname(dependencies)) return true;
  return isProcessAlive(owner.pid, dependencies);
}

export async function acquireCoreWriteLock(
  projectRoot: string,
  kind: string,
  operationId: string,
  metadata?: Readonly<Record<string, unknown>>,
  dependencies: CoreWriteLockDependencies = {},
): Promise<CoreWriteLockLease> {
  let acquired: { path: string; owner: CoreWriteLockOwner } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      acquired = await createLock(projectRoot, kind, operationId, metadata, dependencies);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockPath = await coreWriteLockPath(projectRoot);
      const owner = await readOwner(lockPath);
      if (owner === null) continue;
      if (active(owner, dependencies)) {
        throw new CoreWriteLockError(
          'CORE_WRITE_LOCK_ACTIVE',
          `Another Core write execution is active: ${owner.kind}/${owner.operationId}.`,
          { lockPath, owner },
        );
      }
      // Dead same-host process. Remove only the generation we just inspected.
      const current = await readOwner(lockPath);
      if (current?.ownerId !== owner.ownerId) continue;
      await unlink(lockPath);
    }
  }

  if (!acquired) {
    throw new CoreWriteLockError(
      'CORE_WRITE_LOCK_ACTIVE',
      'Could not acquire Core write execution lock.',
    );
  }

  let released = false;
  return {
    path: acquired.path,
    owner: acquired.owner,
    async release(): Promise<void> {
      if (released) return;
      const current = await readOwner(acquired!.path);
      if (!current || current.ownerId !== acquired!.owner.ownerId) {
        throw new CoreWriteLockError(
          'CORE_WRITE_LOCK_LOST',
          'Core write lock ownership changed before release.',
          {
            lockPath: acquired!.path,
            expectedOwnerId: acquired!.owner.ownerId,
            actualOwnerId: current?.ownerId ?? null,
          },
        );
      }
      await unlink(acquired!.path);
      released = true;
    },
  };
}
