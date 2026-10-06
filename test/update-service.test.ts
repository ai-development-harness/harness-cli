import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ReleaseStore } from '../src/core/releases/store.js';
import {
  FileUpdateProjectState,
  UpdateService,
  readUpdateCheckpoint,
  type UpdateMigrationCoordinator,
  type UpdateProjectState,
  type UpdateProjectStatePort,
} from '../src/core/update/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-update-'));
  roots.push(root);
  await git(root, 'init');
  return root;
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function releaseFixture(
  root: string,
  release: string,
  options: {
    supported?: number[];
    migrateFrom?: number[];
    targetSchema?: number;
    cliMin?: string;
    hostMin?: number;
    hostMax?: number;
  } = {},
): Promise<string> {
  const releaseRoot = path.join(root, `release-${release}`);
  const payload: Record<string, string> = {
    'core/index.mjs': 'export const harnessCore = { hostApiVersion: 1, execute() {} };\n',
    'protocol/commands.json': '{}\n',
    'schemas/project.schema.json': '{}\n',
    'skills/run/SKILL.md': '# Run\n',
    'docs/PROTOCOL.md': '# Protocol\n',
  };
  for (const [relativePath, data] of Object.entries(payload)) {
    await writeText(releaseRoot, relativePath, data);
  }

  const files = Object.entries(payload)
    .map(([relativePath, data]) => ({
      path: relativePath,
      size: Buffer.byteLength(data),
      sha256: sha256(data),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    formatVersion: 1,
    release,
    createdAt: '2026-10-06T00:00:00Z',
    compatibility: {
      cli: {
        minVersion: options.cliMin ?? '0.1.0',
        maxVersionExclusive: null,
      },
      hostApi: {
        minVersion: options.hostMin ?? 1,
        maxVersion: options.hostMax ?? 1,
      },
      projectSchema: {
        supported: options.supported ?? [1],
        target: options.targetSchema ?? 1,
        migrateFrom: options.migrateFrom ?? [],
      },
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

async function project(root: string, release = '1.0.0', schemaVersion = 1): Promise<string> {
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  await git(projectRoot, 'init');
  await writeFile(
    path.join(projectRoot, 'harness.yaml'),
    YAML.stringify({
      schemaVersion,
      harness: { release },
      project: { initialized: true, name: 'fixture', initializedAt: '2026-10-06T00:00:00Z' },
    }),
    'utf8',
  );
  return projectRoot;
}

class MemoryProjectState implements UpdateProjectStatePort {
  constructor(public state: UpdateProjectState) {}

  async read(): Promise<UpdateProjectState> {
    return { ...this.state };
  }

  async writeReleasePin(
    _projectRoot: string,
    expectedCurrentRelease: string,
    targetRelease: string,
  ): Promise<void> {
    if (this.state.release !== expectedCurrentRelease) throw new Error('pin changed');
    this.state = { ...this.state, release: targetRelease };
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ),
  );
});

describe('thin Harness UpdateService', () => {
  it('CHECK is read-only and selects only the newest verified installed release', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    await store.installFromDirectory(await releaseFixture(root, '1.1.0'));
    await store.installFromDirectory(await releaseFixture(root, '1.2.0'));
    const projectRoot = await project(root);

    const before = await readFile(path.join(projectRoot, 'harness.yaml'), 'utf8');
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      currentRelease: '1.0.0',
      targetRelease: '1.2.0',
      migrationRequired: false,
      mutationPlan: {
        updateReleasePin: true,
        createEmbeddedTools: false,
        genericThreeWayUpdate: false,
      },
    });
    expect(await readFile(path.join(projectRoot, 'harness.yaml'), 'utf8')).toBe(before);
    await expect(readUpdateCheckpoint(projectRoot)).resolves.toBeNull();
  });

  it('never falls back to latest/main or an uninstalled requested release', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    const projectRoot = await project(root);
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.check()).resolves.toMatchObject({
      status: 'noop',
      targetRelease: '1.0.0',
    });
    await expect(service.check('9.9.9')).resolves.toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'UPDATE_TARGET_UNAVAILABLE' }],
    });
  });

  it('does not change the pin when target verification/compatibility fails', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    await store.installFromDirectory(
      await releaseFixture(root, '2.0.0', { cliMin: '9.0.0' }),
    );
    const projectRoot = await project(root);
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.check('2.0.0')).resolves.toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'UPDATE_INCOMPATIBLE_CLI' }],
    });
    await expect(service.apply('2.0.0')).rejects.toMatchObject({ code: 'UPDATE_BLOCKED' });
    await expect(new FileUpdateProjectState().read(projectRoot)).resolves.toEqual({
      release: '1.0.0',
      schemaVersion: 1,
    });
  });

  it('coordinates project-schema migration before changing the release pin', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    await store.installFromDirectory(
      await releaseFixture(root, '2.0.0', {
        supported: [2],
        migrateFrom: [1],
        targetSchema: 2,
      }),
    );
    const projectRoot = await project(root);
    const state = new MemoryProjectState({ release: '1.0.0', schemaVersion: 1 });
    const calls: string[] = [];
    const migration: UpdateMigrationCoordinator = {
      async migrate(input) {
        calls.push(`migrate:${input.fromProjectSchemaVersion}->${input.toProjectSchemaVersion}`);
        expect(state.state.release).toBe('1.0.0');
        state.state = { ...state.state, schemaVersion: 2 };
        return { projectSchemaVersion: 2 };
      },
    };
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      projectState: state,
      migration,
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.apply('2.0.0')).resolves.toMatchObject({
      status: 'SUCCESS',
      currentRelease: '1.0.0',
      targetRelease: '2.0.0',
      migrated: true,
      recovered: false,
    });
    expect(calls).toEqual(['migrate:1->2']);
    expect(state.state).toEqual({ release: '2.0.0', schemaVersion: 2 });
    await expect(readUpdateCheckpoint(projectRoot)).resolves.toMatchObject({
      phase: 'verified',
      projectSchemaBefore: 1,
      projectSchemaAfter: 2,
      migrationRequired: true,
    });
  });

  it('resumes from migration_verified without re-running migration', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    const target = await store.installFromDirectory(
      await releaseFixture(root, '2.0.0', {
        supported: [2],
        migrateFrom: [1],
        targetSchema: 2,
      }),
    );
    const projectRoot = await project(root);
    const state = new MemoryProjectState({ release: '1.0.0', schemaVersion: 2 });
    const { writeUpdateCheckpoint } = await import('../src/core/update/state.js');
    await writeUpdateCheckpoint(projectRoot, {
      operationId: 'update:1.0.0->2.0.0',
      phase: 'prepared',
      currentRelease: '1.0.0',
      targetRelease: '2.0.0',
      targetDigest: target.digest,
      projectSchemaBefore: 1,
      projectSchemaAfter: 1,
      migrationRequired: true,
    });
    await writeUpdateCheckpoint(projectRoot, {
      operationId: 'update:1.0.0->2.0.0',
      phase: 'migration_verified',
      currentRelease: '1.0.0',
      targetRelease: '2.0.0',
      targetDigest: target.digest,
      projectSchemaBefore: 1,
      projectSchemaAfter: 2,
      migrationRequired: true,
    });

    let migrationCalls = 0;
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      projectState: state,
      migration: {
        async migrate() {
          migrationCalls += 1;
          return { projectSchemaVersion: 2 };
        },
      },
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.apply('2.0.0')).resolves.toMatchObject({
      status: 'SUCCESS',
      targetRelease: '2.0.0',
      migrated: true,
    });
    expect(migrationCalls).toBe(0);
    expect(state.state).toEqual({ release: '2.0.0', schemaVersion: 2 });
  });

  it('leaves the release pin unchanged when required migration fails', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    await store.installFromDirectory(
      await releaseFixture(root, '2.0.0', {
        supported: [2],
        migrateFrom: [1],
        targetSchema: 2,
      }),
    );
    const projectRoot = await project(root);
    const state = new MemoryProjectState({ release: '1.0.0', schemaVersion: 1 });
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      projectState: state,
      migration: {
        async migrate() {
          throw new Error('migration fixture failed');
        },
      },
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.apply('2.0.0')).rejects.toMatchObject({
      code: 'UPDATE_MIGRATION_FAILED',
    });
    expect(state.state.release).toBe('1.0.0');
    await expect(readUpdateCheckpoint(projectRoot)).resolves.toMatchObject({
      phase: 'prepared',
      targetRelease: '2.0.0',
    });
  });

  it('recovers an interrupted update after the release pin was durably written', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    const target = await store.installFromDirectory(await releaseFixture(root, '1.1.0'));
    const projectRoot = await project(root);
    const state = new MemoryProjectState({ release: '1.1.0', schemaVersion: 1 });

    const operationId = 'update:1.0.0->1.1.0';
    const { writeUpdateCheckpoint } = await import('../src/core/update/state.js');
    await writeUpdateCheckpoint(projectRoot, {
      operationId,
      phase: 'prepared',
      currentRelease: '1.0.0',
      targetRelease: '1.1.0',
      targetDigest: target.digest,
      projectSchemaBefore: 1,
      projectSchemaAfter: 1,
      migrationRequired: false,
    });
    await writeUpdateCheckpoint(projectRoot, {
      operationId,
      phase: 'migration_verified',
      currentRelease: '1.0.0',
      targetRelease: '1.1.0',
      targetDigest: target.digest,
      projectSchemaBefore: 1,
      projectSchemaAfter: 1,
      migrationRequired: false,
    });
    await writeUpdateCheckpoint(projectRoot, {
      operationId,
      phase: 'pin_written',
      currentRelease: '1.0.0',
      targetRelease: '1.1.0',
      targetDigest: target.digest,
      projectSchemaBefore: 1,
      projectSchemaAfter: 1,
      migrationRequired: false,
    });

    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      projectState: state,
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.apply('1.1.0')).resolves.toMatchObject({
      status: 'SUCCESS',
      recovered: true,
      targetRelease: '1.1.0',
    });
    await expect(readUpdateCheckpoint(projectRoot)).resolves.toMatchObject({
      phase: 'verified',
    });
  });

  it('APPLY mutates only harness.release and never creates repository-embedded tools', async () => {
    const root = await tempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(await releaseFixture(root, '1.0.0'));
    await store.installFromDirectory(await releaseFixture(root, '1.1.0'));
    const projectRoot = await project(root);
    const service = new UpdateService({
      projectRoot,
      releaseStore: store,
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    await expect(service.apply('1.1.0')).resolves.toMatchObject({
      status: 'SUCCESS',
      targetRelease: '1.1.0',
    });

    const raw = YAML.parse(await readFile(path.join(projectRoot, 'harness.yaml'), 'utf8'));
    expect(raw.harness.release).toBe('1.1.0');
    await expect(readFile(path.join(projectRoot, '.harness', 'tools', 'harness_update.py'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
