import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessStatePath } from '../src/core/git.js';
import {
  executeMigration,
  inspectMigrationCheckpoint,
  resumeMigration,
} from '../src/core/migration/executor.js';
import { MigrationExecutionError, type MigrationOperationHandler } from '../src/core/migration/executor-types.js';
import type { MigrationPlan, MigrationPlanOperation } from '../src/core/migration/plan-types.js';
import { ReleaseStore } from '../src/core/releases/store.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function createRepository(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-executor-'));
  temporaryRoots.push(base);
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.email', 'test@example.com']);
  await runGit(repo, ['config', 'user.name', 'Harness Test']);
  await writeText(repo, 'a.txt', 'before\n');
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', 'fixture']);
  return { base, repo };
}

async function createReleaseTree(root: string): Promise<string> {
  const releaseRoot = path.join(root, 'release');
  const payload: Record<string, string> = {
    'core/index.mjs': "export const release = '0.10.4';\n",
    'protocol/commands.json': '{}\n',
    'schemas/project.schema.json': '{"type":"object"}\n',
    'skills/run-step/SKILL.md': '# Run\n',
    'docs/PROTOCOL.md': '# Protocol\n',
  };
  for (const [relativePath, data] of Object.entries(payload)) await writeText(releaseRoot, relativePath, data);
  const files = Object.entries(payload)
    .map(([relativePath, data]) => ({
      path: relativePath,
      size: Buffer.byteLength(data),
      sha256: sha256(data),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    formatVersion: 1,
    release: '0.10.4',
    createdAt: '2026-10-05T10:00:00Z',
    compatibility: {
      cli: { minVersion: '0.1.0', maxVersionExclusive: null },
      hostApi: { minVersion: 1, maxVersion: 1 },
      projectSchema: { supported: [1], target: 1, migrateFrom: [] },
    },
    entrypoints: { core: 'core/index.mjs' },
    components: [
      { id: 'core', path: 'core', required: true },
      { id: 'protocol', path: 'protocol', required: true },
      { id: 'schemas', path: 'schemas', required: true },
      { id: 'skills', path: 'skills', required: true },
      { id: 'docs', path: 'docs', required: true },
    ],
    files,
  };
  await writeText(releaseRoot, 'release.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return releaseRoot;
}

async function installedStore(base: string): Promise<{ store: ReleaseStore; digest: string }> {
  const store = new ReleaseStore(path.join(base, 'store'));
  const tree = await createReleaseTree(base);
  const installed = await store.installFromDirectory(tree);
  return { store, digest: installed.digest };
}

async function gitBlobSha(repo: string, relativePath: string): Promise<string> {
  return runGit(repo, ['hash-object', '--no-filters', '--', relativePath]);
}

function operation(
  id: string,
  kind: MigrationPlanOperation['kind'],
  relativePath: string,
  precondition: MigrationPlanOperation['precondition'],
): MigrationPlanOperation {
  return {
    id,
    phase: kind === 'CREATE' ? 'finalize' : 'project-contract',
    kind,
    path: relativePath,
    mutates: true,
    precondition,
    strategy: `test-${kind.toLowerCase()}`,
    reason: 'test operation',
  };
}

async function makePlan(
  repo: string,
  releaseDigest: string,
  operations?: MigrationPlanOperation[],
): Promise<MigrationPlan> {
  const headSha = await runGit(repo, ['rev-parse', 'HEAD']);
  const sourceSha = await gitBlobSha(repo, 'a.txt');
  return {
    schemaVersion: 1,
    migrationId: 'migration-executor-test',
    status: 'ready',
    source: {
      projectRoot: repo,
      headSha,
      legacyRelease: '0.10.4',
      legacyHarnessVersion: '1',
      baseline: {
        repository: 'ai-development-harness/ai-development-harness-template',
        ref: 'v0.10.4',
        commit: '6832c41ad6a0cae4fceffbadf7a4258a441d1001',
        resolvedBy: 'lock',
      },
    },
    target: { harnessRelease: '0.10.4', projectSchemaVersion: 1, releaseDigest },
    preconditions: {
      inspectionState: 'legacy-harness-supported',
      expectedHeadSha: headSha,
      relevantUntrackedPaths: [],
      migrationCheckpointAbsent: true,
    },
    operations:
      operations ?? [
        operation('op-0001', 'TRANSFORM', 'a.txt', { kind: 'git-blob-sha1', value: sourceSha }),
        operation('op-0002', 'CREATE', 'b.txt', { kind: 'absent' }),
      ],
    blockers: [],
    warnings: [],
    verification: [],
  };
}

function fileHandler(content: string, counters: Map<string, number>): MigrationOperationHandler {
  return {
    async apply(context) {
      counters.set(context.operation.id, (counters.get(context.operation.id) ?? 0) + 1);
      await writeText(context.projectRoot, context.operation.path, content);
      return { sha256: sha256(content) };
    },
    async verify(context, postcondition) {
      try {
        const bytes = await readFile(path.join(context.projectRoot, ...context.operation.path.split('/')));
        return postcondition.sha256 === sha256(bytes);
      } catch {
        return false;
      }
    },
  };
}

function handlers(counters: Map<string, number>) {
  return {
    TRANSFORM: fileHandler('after\n', counters),
    CREATE: fileHandler('created\n', counters),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MigrationExecutor', () => {
  it('keeps an interrupted checkpoint in Git-private state and resumes without replaying verified operations', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest);
    const counters = new Map<string, number>();
    let interrupted = false;

    await expect(
      executeMigration(plan, {
        releaseStore: store,
        handlers: handlers(counters),
        hooks: {
          afterOperationVerified(operation) {
            if (!interrupted && operation.id === 'op-0001') {
              interrupted = true;
              throw new Error('simulated process interruption');
            }
          },
        },
      }),
    ).rejects.toThrow('simulated process interruption');

    const checkpoint = await inspectMigrationCheckpoint(repo, plan.migrationId);
    expect(checkpoint.journal.operations[0].status).toBe('verified');
    expect(checkpoint.journal.operations[1].status).toBe('pending');
    expect(checkpoint.paths.root.startsWith(await harnessStatePath(repo))).toBe(true);
    expect(await runGit(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).not.toContain('ai-harness');

    const result = await resumeMigration(repo, plan.migrationId, {
      releaseStore: store,
      handlers: handlers(counters),
    });

    expect(result).toMatchObject({ status: 'completed', verifiedOperations: 2, checkpointRemoved: true });
    expect(counters.get('op-0001')).toBe(1);
    expect(counters.get('op-0002')).toBe(1);
    await expect(inspectMigrationCheckpoint(repo, plan.migrationId)).rejects.toMatchObject({
      code: 'MIGRATION_CHECKPOINT_MISSING',
    });
  });

  it('resumes an applied operation by verifying its saved postcondition instead of applying it twice', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest, [
      operation('op-0001', 'TRANSFORM', 'a.txt', { kind: 'git-blob-sha1', value: await gitBlobSha(repo, 'a.txt') }),
    ]);
    const counters = new Map<string, number>();

    await expect(
      executeMigration(plan, {
        releaseStore: store,
        handlers: handlers(counters),
        hooks: { afterOperationApplied: () => { throw new Error('crash-after-apply'); } },
      }),
    ).rejects.toThrow('crash-after-apply');

    const checkpoint = await inspectMigrationCheckpoint(repo, plan.migrationId);
    expect(checkpoint.journal.operations[0].status).toBe('applied');

    await resumeMigration(repo, plan.migrationId, { releaseStore: store, handlers: handlers(counters) });
    expect(counters.get('op-0001')).toBe(1);
  });

  it('blocks automatic recovery when an applied operation postcondition was externally broken', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest, [
      operation('op-0001', 'TRANSFORM', 'a.txt', { kind: 'git-blob-sha1', value: await gitBlobSha(repo, 'a.txt') }),
    ]);
    const counters = new Map<string, number>();

    await expect(
      executeMigration(plan, {
        releaseStore: store,
        handlers: handlers(counters),
        hooks: { afterOperationApplied: () => { throw new Error('crash-after-apply'); } },
      }),
    ).rejects.toThrow('crash-after-apply');
    await writeText(repo, 'a.txt', 'external change\n');

    await expect(
      resumeMigration(repo, plan.migrationId, { releaseStore: store, handlers: handlers(counters) }),
    ).rejects.toMatchObject({ code: 'POSTCONDITION_FAILED' });

    const checkpoint = await inspectMigrationCheckpoint(repo, plan.migrationId);
    expect(checkpoint.journal.state).toBe('recovery-required');
    expect(checkpoint.journal.recovery?.operationId).toBe('op-0001');
  });

  it('marks a handler failure in applying state as indeterminate and never retries it automatically', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest, [
      operation('op-0001', 'TRANSFORM', 'a.txt', { kind: 'git-blob-sha1', value: await gitBlobSha(repo, 'a.txt') }),
    ]);
    let applyCount = 0;
    const badHandler: MigrationOperationHandler = {
      async apply(context) {
        applyCount += 1;
        await writeText(context.projectRoot, context.operation.path, 'maybe-applied\n');
        throw new Error('handler crashed');
      },
      async verify() { return false; },
    };

    await expect(
      executeMigration(plan, { releaseStore: store, handlers: { TRANSFORM: badHandler } }),
    ).rejects.toMatchObject({ code: 'OPERATION_INDETERMINATE' });

    await expect(
      resumeMigration(repo, plan.migrationId, { releaseStore: store, handlers: { TRANSFORM: badHandler } }),
    ).rejects.toMatchObject({ code: 'OPERATION_INDETERMINATE' });
    expect(applyCount).toBe(1);
  });

  it('rejects a stale plan before creating a checkpoint or mutating files', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest);
    const counters = new Map<string, number>();
    await writeText(repo, 'a.txt', 'changed after planning\n');

    await expect(
      executeMigration(plan, { releaseStore: store, handlers: handlers(counters) }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(counters.size).toBe(0);
    await expect(inspectMigrationCheckpoint(repo, plan.migrationId)).rejects.toMatchObject({
      code: 'MIGRATION_CHECKPOINT_MISSING',
    });
  });

  it('rejects missing operation handlers before checkpoint creation', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest);

    await expect(executeMigration(plan, { releaseStore: store, handlers: {} })).rejects.toMatchObject({
      code: 'OPERATION_HANDLER_MISSING',
    });
    await expect(inspectMigrationCheckpoint(repo, plan.migrationId)).rejects.toMatchObject({
      code: 'MIGRATION_CHECKPOINT_MISSING',
    });
  });

  it('fails closed on a corrupted journal', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest);
    const counters = new Map<string, number>();

    await expect(
      executeMigration(plan, {
        releaseStore: store,
        handlers: handlers(counters),
        hooks: { afterOperationVerified: () => { throw new Error('interrupt'); } },
      }),
    ).rejects.toThrow('interrupt');
    const checkpoint = await inspectMigrationCheckpoint(repo, plan.migrationId);
    await writeFile(checkpoint.paths.journal, '{broken json\n', 'utf8');

    await expect(
      resumeMigration(repo, plan.migrationId, { releaseStore: store, handlers: handlers(counters) }),
    ).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT' });
  });

  it('fails closed when journal operations no longer match the immutable saved plan', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest);
    const counters = new Map<string, number>();

    await expect(
      executeMigration(plan, {
        releaseStore: store,
        handlers: handlers(counters),
        hooks: { afterOperationVerified: () => { throw new Error('interrupt'); } },
      }),
    ).rejects.toThrow('interrupt');
    const checkpoint = await inspectMigrationCheckpoint(repo, plan.migrationId);
    const journal = JSON.parse(await readFile(checkpoint.paths.journal, 'utf8')) as { operations: Array<{ id: string }> };
    journal.operations[0].id = 'tampered-op';
    await writeFile(checkpoint.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');

    await expect(
      resumeMigration(repo, plan.migrationId, { releaseStore: store, handlers: handlers(counters) }),
    ).rejects.toMatchObject({ code: 'JOURNAL_INCONSISTENT' });
  });

  it('executes only operations present in the immutable plan', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest, [
      operation('op-0001', 'TRANSFORM', 'a.txt', { kind: 'git-blob-sha1', value: await gitBlobSha(repo, 'a.txt') }),
    ]);
    const counters = new Map<string, number>();

    await executeMigration(plan, { releaseStore: store, handlers: handlers(counters) });
    expect(counters.get('op-0001')).toBe(1);
    expect(counters.has('op-0002')).toBe(false);
    await expect(readFile(path.join(repo, 'b.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a second execute call when an interrupted checkpoint already exists', async () => {
    const { base, repo } = await createRepository();
    const { store, digest } = await installedStore(base);
    const plan = await makePlan(repo, digest);
    const counters = new Map<string, number>();

    await expect(
      executeMigration(plan, {
        releaseStore: store,
        handlers: handlers(counters),
        hooks: { afterOperationVerified: () => { throw new Error('interrupt'); } },
      }),
    ).rejects.toThrow('interrupt');

    await expect(
      executeMigration(plan, { releaseStore: store, handlers: handlers(counters) }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    // The first operation changed working-tree bytes, so fresh execute is stale;
    // resume is the only safe continuation path.
  });
});
