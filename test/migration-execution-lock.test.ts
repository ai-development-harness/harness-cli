import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessStatePath, resolveHarnessStatePath } from '../src/core/git.js';
import {
  acquireMigrationExecutionLock,
  inspectMigrationExecutionLock,
  migrationExecutionLockPath,
  type MigrationExecutionLockDependencies,
  type MigrationExecutionLockOwner,
} from '../src/core/migration/execution-lock.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function repositoryFixture(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-lock-'));
  temporaryRoots.push(base);
  const repo = path.join(base, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Harness Test']);
  await writeFile(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'fixture']);
  return { base, repo };
}

function deterministicDependencies(): MigrationExecutionLockDependencies {
  return {
    now: () => new Date('2026-10-05T18:00:00.000Z'),
    hostname: () => 'test-host',
    pid: 4242,
    isProcessAlive: (pid) => pid === 4242,
    reclaimClaimTimeoutMs: 1_000,
  };
}

async function writeLock(
  repo: string,
  owner: MigrationExecutionLockOwner,
): Promise<string> {
  const target = await migrationExecutionLockPath(repo);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  return target;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('migration execution lock', () => {
  it('blocks a second mutating migration immediately in the same worktree', async () => {
    const { repo } = await repositoryFixture();
    const lease = await acquireMigrationExecutionLock(repo, 'migration-first', 'apply');

    const status = await inspectMigrationExecutionLock(repo);
    expect(status).toMatchObject({
      state: 'active',
      owner: {
        migrationId: 'migration-first',
        mode: 'apply',
        pid: process.pid,
      },
      reason: 'process-alive',
    });

    await expect(
      acquireMigrationExecutionLock(repo, 'migration-second', 'apply'),
    ).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_ACTIVE',
      details: {
        owner: expect.objectContaining({
          migrationId: 'migration-first',
          mode: 'apply',
        }),
      },
    });

    await lease.release();
    await expect(inspectMigrationExecutionLock(repo)).resolves.toMatchObject({
      state: 'none',
    });
  });

  it('reclaims a stale lock owned by a dead local process', async () => {
    const { repo } = await repositoryFixture();
    const dependencies = deterministicDependencies();
    const staleOwner: MigrationExecutionLockOwner = {
      schemaVersion: 1,
      ownerId: randomUUID(),
      migrationId: 'migration-crashed',
      mode: 'resume',
      pid: 9999,
      hostname: 'test-host',
      acquiredAt: '2026-10-05T17:00:00.000Z',
    };
    await writeLock(repo, staleOwner);

    await expect(
      inspectMigrationExecutionLock(repo, dependencies),
    ).resolves.toMatchObject({
      state: 'stale',
      owner: { migrationId: 'migration-crashed', pid: 9999 },
      reason: 'process-missing',
    });

    const lease = await acquireMigrationExecutionLock(
      repo,
      'migration-recovery',
      'resume',
      dependencies,
    );
    expect(lease.owner).toMatchObject({
      migrationId: 'migration-recovery',
      pid: 4242,
      hostname: 'test-host',
    });

    await lease.release();
    await expect(
      inspectMigrationExecutionLock(repo, dependencies),
    ).resolves.toMatchObject({ state: 'none' });
  });

  it('recovers a stale reclaim claim left by a crashed reclaimer', async () => {
    const { repo } = await repositoryFixture();
    const dependencies = deterministicDependencies();
    const staleOwner: MigrationExecutionLockOwner = {
      schemaVersion: 1,
      ownerId: randomUUID(),
      migrationId: 'migration-crashed',
      mode: 'apply',
      pid: 9999,
      hostname: 'test-host',
      acquiredAt: '2026-10-05T17:00:00.000Z',
    };
    const lockPath = await writeLock(repo, staleOwner);
    const claimPath = await resolveHarnessStatePath(
      repo,
      `migration-execution.reclaim-${staleOwner.ownerId}.json`,
    );
    await link(lockPath, claimPath);
    const old = new Date('2026-10-05T17:30:00.000Z');
    await utimes(claimPath, old, old);

    const lease = await acquireMigrationExecutionLock(
      repo,
      'migration-after-reclaimer-crash',
      'apply',
      dependencies,
    );
    expect(lease.owner.migrationId).toBe('migration-after-reclaimer-crash');
    await lease.release();
  });

  it('fails closed on a corrupt lock record', async () => {
    const { repo } = await repositoryFixture();
    const target = await migrationExecutionLockPath(repo);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{broken json\n', 'utf8');

    await expect(inspectMigrationExecutionLock(repo)).resolves.toMatchObject({
      state: 'corrupt',
      error: { code: 'MIGRATION_LOCK_CORRUPT' },
    });
    await expect(
      acquireMigrationExecutionLock(repo, 'migration-new', 'apply'),
    ).rejects.toMatchObject({ code: 'MIGRATION_LOCK_CORRUPT' });
  });

  it('keeps linked Git worktree execution locks independent', async () => {
    const { base, repo } = await repositoryFixture();
    const worktree = path.join(base, 'worktree');
    await git(repo, ['worktree', 'add', '-b', 'lock-worktree', worktree]);

    const [mainState, worktreeState] = await Promise.all([
      harnessStatePath(repo),
      harnessStatePath(worktree),
    ]);
    expect(mainState).not.toBe(worktreeState);

    const mainLease = await acquireMigrationExecutionLock(repo, 'migration-main', 'apply');
    const worktreeLease = await acquireMigrationExecutionLock(worktree, 'migration-worktree', 'apply');

    await expect(inspectMigrationExecutionLock(repo)).resolves.toMatchObject({
      state: 'active',
      owner: { migrationId: 'migration-main' },
    });
    await expect(inspectMigrationExecutionLock(worktree)).resolves.toMatchObject({
      state: 'active',
      owner: { migrationId: 'migration-worktree' },
    });

    await Promise.all([mainLease.release(), worktreeLease.release()]);
  });
});
