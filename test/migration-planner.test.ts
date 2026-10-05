import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { planMigration, serializeMigrationPlan } from '../src/core/migration/index.js';
import { ReleaseStore } from '../src/core/releases/store.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const BASELINE_UPDATE_REPORT_README = `# Harness update reports

Этот каталог хранит durable evidence применения \`HARNESS UPDATE APPLY\` к конкретному проекту.

- \`README.md\` принадлежит Harness protocol layer.
- \`UPDATE-<UTC timestamp>.md\` принадлежит конкретному проекту и создаётся updater-ом после успешной mutation; report фиксирует initial release, requested final target, фактически пройденный route/hops и возможную \`reloadRequired\` boundary.
- Reports не являются STEP и не меняют product roadmap/status.
- \`HARNESS UPDATE CHECK\` ничего сюда не пишет.
- Report не означает commit/push/PR: после него требуется обычный \`GIT CHECK\` → \`GIT COMMIT\`.

При конфликте report не создаётся, потому что updater обязан остановиться до mutation.
`;

const LEGACY_MANIFEST = `harness:
  version: "1"
  release: "0.10.4"
sources:
  requirements: docs/requirements
  adrDirectory: docs/adr
  projectOverview: docs/PROJECT.md
  roadmap: planning/PLAN.md
  status: planning/STATUS.md
protocol:
  file: .harness/docs/EXECUTION_PROTOCOL.md
  taskDirectory: planning/tasks
  reviewDirectory: planning/reviews
  auditDirectory: planning/audits
  skillRegistry: docs/skills/REGISTRY.md
`;

function legacyLock(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      harnessVersion: '1',
      release: '0.10.4',
      source: {
        repository: 'ai-development-harness/ai-development-harness-template',
        ref: 'v0.10.4',
      },
      updatedAt: null,
    },
    null,
    2,
  )}\n`;
}

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function createRepository(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-planner-'));
  temporaryRoots.push(base);
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.email', 'test@example.com']);
  await runGit(repo, ['config', 'user.name', 'Harness Test']);
  return { base, repo };
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function commitAll(repo: string): Promise<void> {
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', 'fixture']);
}

async function createLegacyRepository(options: { withLock?: boolean } = {}): Promise<{ base: string; repo: string }> {
  const fixture = await createRepository();
  await writeText(fixture.repo, '.harness/manifest.yaml', LEGACY_MANIFEST);
  if (options.withLock !== false) await writeText(fixture.repo, '.harness/harness.lock.json', legacyLock());
  await writeText(fixture.repo, 'planning/harness-updates/README.md', BASELINE_UPDATE_REPORT_README);
  await writeText(fixture.repo, 'planning/PLAN.md', '# Plan\n');
  await writeText(fixture.repo, 'planning/STATUS.md', '# Status\n');
  await writeText(fixture.repo, 'AGENTS.md', '# Instructions\n\n<!-- PROJECT-CONTEXT:START -->\nProject\n<!-- PROJECT-CONTEXT:END -->\n');
  await writeText(fixture.repo, 'CLAUDE.md', '@AGENTS.md\n\nProject Claude note.\n');
  await writeText(fixture.repo, '.agents/skills/custom/SKILL.md', '# Custom\n');
  await writeText(fixture.repo, 'src/index.ts', 'export const value = 1;\n');
  await commitAll(fixture.repo);
  return fixture;
}

async function createReleaseTree(
  root: string,
  options: { supportedSchemas?: number[]; migrateFrom?: number[] } = {},
): Promise<string> {
  const releaseRoot = path.join(root, 'release-0.10.4');
  const payload: Record<string, string> = {
    'core/index.mjs': "export const release = '0.10.4';\n",
    'protocol/commands.json': '{}\n',
    'schemas/project.schema.json': '{"type":"object"}\n',
    'skills/run-step/SKILL.md': '# Run\n',
    'docs/PROTOCOL.md': '# Protocol\n',
  };

  for (const [relativePath, data] of Object.entries(payload)) {
    await writeText(releaseRoot, relativePath, data);
  }

  const files = Object.entries(payload)
    .map(([relativePath, data]) => ({
      path: relativePath,
      size: Buffer.byteLength(data),
      sha256: hash(data),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    formatVersion: 1,
    release: '0.10.4',
    createdAt: '2026-10-05T10:00:00Z',
    compatibility: {
      cli: { minVersion: '0.1.0', maxVersionExclusive: null },
      hostApi: { minVersion: 1, maxVersion: 1 },
      projectSchema: {
        supported: options.supportedSchemas ?? [1],
        target: 1,
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

async function createInstalledStore(base: string, options: { supportedSchemas?: number[]; migrateFrom?: number[] } = {}): Promise<ReleaseStore> {
  const store = new ReleaseStore(path.join(base, 'store'));
  const release = await createReleaseTree(base, options);
  await store.installFromDirectory(release);
  return store;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('planMigration', () => {
  it('builds a deterministic full dry-run plan without mutating the project', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    const statusBefore = await runGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']);

    const first = await planMigration(repo, {}, { releaseStore: store });
    const second = await planMigration(repo, {}, { releaseStore: store });
    const statusAfter = await runGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']);

    expect(first.status).toBe('ready');
    expect(first.blockers).toEqual([]);
    expect(serializeMigrationPlan(first)).toBe(serializeMigrationPlan(second));
    expect(first.migrationId).toBe(second.migrationId);
    expect(statusAfter).toBe(statusBefore);
    await expect(readFile(path.join(repo, 'harness.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const byPath = new Map(first.operations.map((operation) => [operation.path, operation]));
    expect(byPath.get('.harness/manifest.yaml')).toMatchObject({
      kind: 'TRANSFORM',
      targetPath: 'harness.yaml',
      strategy: 'legacy-manifest-to-thin-config',
    });
    expect(byPath.get('planning/harness-updates/README.md')).toMatchObject({
      kind: 'DELETE_HARNESS_OWNED_CLEAN',
      precondition: { kind: 'git-blob-sha1', value: '38b6e1350954857d0daace09faa939c5cb8534f2' },
    });
    expect(byPath.get('AGENTS.md')?.kind).toBe('REPLACE_GENERATED_BLOCK');
    expect(byPath.get('CLAUDE.md')?.kind).toBe('REPLACE_GENERATED_BLOCK');
    expect(byPath.get('.agents/skills/custom/SKILL.md')?.kind).toBe('PRESERVE');
    expect(byPath.get('planning/PLAN.md')?.kind).toBe('REGENERATE_PROJECTION');
    expect(byPath.get('planning/STATUS.md')?.kind).toBe('REGENERATE_PROJECTION');
    expect(first.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CREATE', strategy: 'write-final-migration-report-after-verification' }),
      ]),
    );
    expect(first.target).toMatchObject({ harnessRelease: '0.10.4', projectSchemaVersion: 1 });
    expect(first.target.releaseDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks when the proven target release is not installed', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = new ReleaseStore(path.join(base, 'empty-store'));
    const plan = await planMigration(repo, {}, { releaseStore: store });

    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TARGET_RELEASE_UNAVAILABLE' })]),
    );
  });

  it('blocks modified Harness-owned files and emits BLOCK_CONFLICT', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    await writeText(repo, 'planning/harness-updates/README.md', `${BASELINE_UPDATE_REPORT_README}\nmodified\n`);

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HARNESS_OWNED_MODIFIED' })]),
    );
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'planning/harness-updates/README.md',
          kind: 'BLOCK_CONFLICT',
        }),
      ]),
    );
  });

  it('blocks dirty paths that would be mutated but preserves unrelated dirty product files', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    await writeText(repo, 'AGENTS.md', '# Dirty shared instructions\n');
    await writeText(repo, 'src/index.ts', 'export const value = 2;\n');

    const plan = await planMigration(repo, {}, { releaseStore: store });
    const dirty = plan.blockers.find((entry) => entry.code === 'DIRTY_PATH_CONFLICT');
    expect(dirty?.paths).toContain('AGENTS.md');
    expect(dirty?.paths).not.toContain('src/index.ts');
  });

  it('blocks relevant untracked collisions before any apply', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    await writeText(repo, 'harness.yaml', 'untracked collision\n');

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNTRACKED_COLLISION' })]),
    );
  });

  it('blocks active legacy execution state', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    await writeText(
      repo,
      '.harness/local/execution/execution-status.json',
      `${JSON.stringify({ schemaVersion: 2, executions: [{ executionId: 'exec-1' }], stepRecovery: {}, recentTerminals: [], nextOrdinal: 2 })}\n`,
    );

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ACTIVE_EXECUTION' })]),
    );
  });

  it('plans migration of known idle execution state with a SHA-256 precondition', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    await writeText(
      repo,
      '.harness/local/execution/execution-status.json',
      `${JSON.stringify({ schemaVersion: 2, executions: [], stepRecovery: {}, recentTerminals: [], nextOrdinal: 1 })}\n`,
    );

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'MIGRATE_LOCAL_STATE',
          path: '.harness/local/execution/execution-status.json',
          precondition: expect.objectContaining({ kind: 'sha256' }),
        }),
      ]),
    );
  });

  it('fails closed on unknown legacy execution state', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base);
    await writeText(repo, '.harness/local/execution/execution-status.json', '{broken json\n');

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_ACTIVE_STATE' })]),
    );
  });

  it('blocks an incompatible target project schema', async () => {
    const { base, repo } = await createLegacyRepository();
    const store = await createInstalledStore(base, { supportedSchemas: [2] });

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_SCHEMA_CONFLICT' })]),
    );
  });

  it('returns baseline blockers without adding unrelated target-release noise', async () => {
    const { base, repo } = await createLegacyRepository({ withLock: false });
    const store = new ReleaseStore(path.join(base, 'empty-store'));

    const plan = await planMigration(repo, {}, { releaseStore: store });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'BASELINE_REQUIRED' })]),
    );
    expect(plan.blockers.some((entry) => entry.code === 'TARGET_RELEASE_UNAVAILABLE')).toBe(false);
  });
});
