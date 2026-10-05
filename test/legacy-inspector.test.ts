import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import { harnessStatePath } from '../src/core/git.js';
import { inspectProject } from '../src/core/migration/legacy/inspector.js';

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
protocol:
  file: .harness/docs/EXECUTION_PROTOCOL.md
  taskDirectory: planning/tasks
  reviewDirectory: planning/reviews
  skillRegistry: docs/skills/REGISTRY.md
`;

function legacyLock(release = '0.10.4', ref = 'v0.10.4'): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      harnessVersion: '1',
      release,
      source: {
        repository: 'ai-development-harness/ai-development-harness-template',
        ref,
      },
      updatedAt: null,
    },
    null,
    2,
  )}\n`;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function createRepository(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-inspector-'));
  temporaryRoots.push(base);
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.email', 'test@example.com']);
  await runGit(repo, ['config', 'user.name', 'Harness Test']);
  return { base, repo };
}

async function writeText(repo: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(repo, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function commitAll(repo: string, message = 'fixture'): Promise<void> {
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', message]);
}

async function createLegacyRepository(options: { withLock?: boolean } = {}): Promise<{ base: string; repo: string }> {
  const fixture = await createRepository();
  await writeText(fixture.repo, '.harness/manifest.yaml', LEGACY_MANIFEST);
  if (options.withLock !== false) {
    await writeText(fixture.repo, '.harness/harness.lock.json', legacyLock());
  }
  await writeText(fixture.repo, 'planning/harness-updates/README.md', BASELINE_UPDATE_REPORT_README);
  await writeText(fixture.repo, 'AGENTS.md', '# Project instructions\n\nCustom project text.\n');
  await writeText(fixture.repo, '.agents/skills/custom/SKILL.md', '# Custom skill\n');
  await writeText(fixture.repo, 'src/index.ts', 'export const answer = 42;\n');
  await commitAll(fixture.repo);
  return fixture;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('inspectProject', () => {
  it('classifies a path outside Git as not-git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-not-git-'));
    temporaryRoots.push(root);
    const result = await inspectProject(root);
    expect(result.state).toBe('not-git');
    expect(result.projectRoot).toBeNull();
  });

  it('classifies an ordinary Git repository as git-non-harness', async () => {
    const { repo } = await createRepository();
    await writeText(repo, 'README.md', '# Plain repository\n');
    await commitAll(repo);
    const result = await inspectProject(repo);
    expect(result.state).toBe('git-non-harness');
  });

  it('resolves a supported v0.10.4 baseline from the legacy lock', async () => {
    const { repo } = await createLegacyRepository();
    const result = await inspectProject(repo);

    expect(result.state).toBe('legacy-harness-supported');
    expect(result.baseline).toMatchObject({
      release: '0.10.4',
      sourceRef: 'v0.10.4',
      sourceCommit: '6832c41ad6a0cae4fceffbadf7a4258a441d1001',
      resolvedBy: 'lock',
    });
    expect(result.diagnostics.filter((entry) => entry.severity === 'blocker')).toEqual([]);
  });

  it('requires an explicit baseline when the legacy lock is absent', async () => {
    const { repo } = await createLegacyRepository({ withLock: false });
    const result = await inspectProject(repo);
    expect(result.state).toBe('legacy-harness-baseline-required');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'BASELINE_REQUIRED', severity: 'blocker' })]),
    );
  });

  it('accepts an explicit immutable baseline when the lock is absent', async () => {
    const { repo } = await createLegacyRepository({ withLock: false });
    const result = await inspectProject(repo, { fromRelease: 'v0.10.4' });
    expect(result.state).toBe('legacy-harness-supported');
    expect(result.baseline?.resolvedBy).toBe('explicit');
  });

  it('rejects a lock that disagrees with the legacy manifest', async () => {
    const { repo } = await createLegacyRepository();
    await writeText(repo, '.harness/harness.lock.json', legacyLock('0.10.3', 'v0.10.3'));
    const result = await inspectProject(repo);
    expect(result.state).toBe('legacy-harness-baseline-required');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'BASELINE_MISMATCH' })]),
    );
  });

  it('reports an unsupported explicit historical release without guessing', async () => {
    const { repo } = await createLegacyRepository({ withLock: false });
    await writeText(repo, '.harness/manifest.yaml', LEGACY_MANIFEST.replace('0.10.4', '0.9.0'));
    const result = await inspectProject(repo, { fromRelease: 'v0.9.0' });
    expect(result.state).toBe('legacy-harness-unsupported');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_RELEASE' })]),
    );
  });

  it('classifies clean, shared and project-owned baseline-relative paths', async () => {
    const { repo } = await createLegacyRepository();
    const result = await inspectProject(repo);
    const byPath = new Map(result.ownership.map((entry) => [entry.path, entry]));

    expect(byPath.get('planning/harness-updates/README.md')).toMatchObject({
      classification: 'harness-owned-clean',
      expectedBlobSha1: '38b6e1350954857d0daace09faa939c5cb8534f2',
      dirty: false,
    });
    expect(byPath.get('AGENTS.md')?.classification).toBe('shared-customized');
    expect(byPath.get('.harness/manifest.yaml')?.classification).toBe('shared-customized');
    expect(byPath.get('.agents/skills/custom/SKILL.md')?.classification).toBe('project-owned');
    expect(byPath.get('src/index.ts')?.classification).toBe('project-owned');
  });

  it('detects a locally modified Harness-owned file from working tree bytes', async () => {
    const { repo } = await createLegacyRepository();
    await writeText(repo, 'planning/harness-updates/README.md', `${BASELINE_UPDATE_REPORT_README}\nlocal edit\n`);
    const result = await inspectProject(repo);
    const entry = result.ownership.find((item) => item.path === 'planning/harness-updates/README.md');

    expect(entry).toMatchObject({ classification: 'harness-owned-modified', dirty: true });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HARNESS_OWNED_MODIFIED', severity: 'blocker' })]),
    );
  });

  it('reports dirty managed paths without treating project files as managed conflicts', async () => {
    const { repo } = await createLegacyRepository();
    await writeText(repo, 'AGENTS.md', '# Changed shared instructions\n');
    await writeText(repo, 'src/index.ts', 'export const answer = 43;\n');
    const result = await inspectProject(repo);
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'DIRTY_MANAGED_PATH');

    expect(diagnostic?.paths).toContain('AGENTS.md');
    expect(diagnostic?.paths).not.toContain('src/index.ts');
    expect(result.dirtyTrackedPaths).toEqual(expect.arrayContaining(['AGENTS.md', 'src/index.ts']));
  });

  it('reports relevant untracked collisions on the migration surface', async () => {
    const { repo } = await createLegacyRepository();
    await writeText(repo, '.harness/tools/local-extra.py', 'print("local")\n');
    await writeText(repo, 'notes.txt', 'unrelated\n');
    const result = await inspectProject(repo);

    expect(result.relevantUntrackedCollisions).toContain('.harness/tools/local-extra.py');
    expect(result.relevantUntrackedCollisions).not.toContain('notes.txt');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNTRACKED_MANAGED_PATH' })]),
    );
  });

  it('recognizes valid and invalid thin projects', async () => {
    const valid = await createRepository();
    await writeConfig(valid.repo, DEFAULT_CONFIG);
    const validResult = await inspectProject(valid.repo);
    expect(validResult.state).toBe('thin-harness-current');

    const invalid = await createRepository();
    await writeText(invalid.repo, 'harness.yaml', 'schemaVersion: 999\n');
    const invalidResult = await inspectProject(invalid.repo);
    expect(invalidResult.state).toBe('thin-harness-invalid');
    expect(invalidResult.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INVALID_THIN_CONFIG' })]),
    );
  });

  it('uses Git-private state correctly in a linked worktree', async () => {
    const { base, repo } = await createLegacyRepository();
    const worktree = path.join(base, 'worktree');
    await runGit(repo, ['worktree', 'add', '-b', 'inspect-worktree', worktree]);

    const result = await inspectProject(path.join(worktree, 'src'));
    expect(result.state).toBe('legacy-harness-supported');
    expect(result.projectRoot).toBe(worktree);
    expect(result.gitDir).not.toBe(result.commonGitDir);
    expect(result.cloneLocalHarnessPath).toContain('ai-harness');
  });

  it('detects an in-progress migration checkpoint without mutating it', async () => {
    const { repo } = await createLegacyRepository();
    const statePath = await harnessStatePath(repo);
    await mkdir(path.join(statePath, 'migrations', 'migration-1'), { recursive: true });
    const result = await inspectProject(repo);
    expect(result.state).toBe('migration-in-progress');
  });
});
