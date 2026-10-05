import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeLegacyThinMigration,
  inspectMigrationCheckpoint,
  prepareLegacyThinMigration,
} from '../src/core/migration/index.js';
import { ReleaseStore } from '../src/core/releases/store.js';
import {
  BASELINE_UPDATE_REPORT_README,
  createLegacyFixture,
  createReleaseTree,
  git,
  writeText,
} from './fixtures/legacy-project.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalEnv = {
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
};

const cliPath = path.resolve('src/cli.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function setHarnessEnvironment(base: string): NodeJS.ProcessEnv {
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const local = path.join(base, 'localappdata');
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = data;
  process.env.LOCALAPPDATA = local;
  process.env.APPDATA = path.join(base, 'appdata');
  return { ...process.env };
}

async function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxPath, cliPath, ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof value.code === 'number' ? value.code : 1,
      stdout: value.stdout ?? '',
      stderr: value.stderr ?? '',
    };
  }
}

function jsonOutput(result: CliResult): any {
  expect(result.stdout.trim()).not.toBe('');
  return JSON.parse(result.stdout);
}

async function fixture(options: Parameters<typeof createLegacyFixture>[0] = {}) {
  const created = await createLegacyFixture(options);
  roots.push(created.base);
  const env = setHarnessEnvironment(created.base);
  await mkdir(process.env.HOME!, { recursive: true });
  const releaseRoot = await createReleaseTree(created.base);
  const install = await runCli(created.repo, ['release', 'install', releaseRoot, '--json'], env);
  expect(install.code, install.stderr || install.stdout).toBe(0);
  const installed = jsonOutput(install);
  expect(installed.ok).toBe(true);
  const releaseStore = new ReleaseStore(path.dirname(path.dirname(installed.root)));
  return { ...created, env, releaseStore };
}

async function createInterruptedMigration(repo: string, releaseStore: ReleaseStore): Promise<string> {
  const preparation = await prepareLegacyThinMigration(repo, {}, { releaseStore });
  expect(preparation.status).toBe('ready');
  if (preparation.status !== 'ready') throw new Error('expected ready migration');

  let interrupted = false;
  await expect(
    executeLegacyThinMigration(preparation, {
      releaseStore,
      hooks: {
        afterOperationVerified() {
          if (!interrupted) {
            interrupted = true;
            throw new Error('simulated interruption');
          }
        },
      },
    }),
  ).rejects.toThrow('simulated interruption');
  return preparation.plan.migrationId;
}

afterEach(async () => {
  process.env.HOME = originalEnv.HOME;
  process.env.XDG_DATA_HOME = originalEnv.XDG_DATA_HOME;
  process.env.LOCALAPPDATA = originalEnv.LOCALAPPDATA;
  process.env.APPDATA = originalEnv.APPDATA;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migration CLI end-to-end', () => {
  it('inspects, dry-runs, saves an exact plan, applies it and is idempotent', async () => {
    const { base, repo, env } = await fixture();
    const statusBefore = await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);

    const inspect = await runCli(repo, ['migrate', 'inspect', '--json'], env);
    expect(inspect.code).toBe(0);
    expect(jsonOutput(inspect).inspection.state).toBe('legacy-harness-supported');

    const dryRun = await runCli(repo, ['migrate', 'plan', '--json'], env);
    expect(dryRun.code).toBe(0);
    expect(jsonOutput(dryRun)).toMatchObject({ ok: true, status: 'ready', savedPlan: null });
    expect(await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusBefore);

    const planPath = path.join(base, 'migration-plan.json');
    const plan = await runCli(repo, ['migrate', 'plan', '--out', planPath, '--json'], env);
    expect(plan.code).toBe(0);
    const planned = jsonOutput(plan);
    expect(planned.status).toBe('ready');
    expect(planned.savedPlan).toBe(planPath);

    const apply = await runCli(repo, ['migrate', 'apply', '--plan', planPath, '--json'], env);
    expect(apply.code, apply.stderr || apply.stdout).toBe(0);
    expect(jsonOutput(apply).status).toBe('completed');

    expect(await readFile(path.join(repo, '.agents/skills/custom-backend/SKILL.md'), 'utf8'))
      .toBe('# Custom backend skill\n');
    expect(await readFile(path.join(repo, '.codex/config.toml'), 'utf8'))
      .toContain('name = "acme"');
    await expect(readFile(path.join(repo, 'planning/harness-updates/README.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(repo, 'harness.yaml'), 'utf8')).toContain('release: 0.10.4');

    const repeated = await runCli(repo, ['migrate', 'plan', '--json'], env);
    expect(repeated.code).toBe(0);
    expect(jsonOutput(repeated)).toMatchObject({
      ok: true,
      status: 'already-migrated',
      mutations: 0,
    });
  }, 15_000);

  it('supports explicit baseline adoption when the legacy lock is absent', async () => {
    const { base, repo, env } = await fixture({ withLock: false });

    const blocked = await runCli(repo, ['migrate', 'plan', '--json'], env);
    expect(blocked.code).toBe(2);
    expect(jsonOutput(blocked).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'BASELINE_REQUIRED' })]),
    );

    const planPath = path.join(base, 'explicit-plan.json');
    const adopted = await runCli(
      repo,
      ['migrate', 'plan', '--from', 'v0.10.4', '--out', planPath, '--json'],
      env,
    );
    expect(adopted.code).toBe(0);
    expect(jsonOutput(adopted)).toMatchObject({ ok: true, status: 'ready' });
  });

  it('reports baseline mismatch deterministically', async () => {
    const { repo, env } = await fixture();
    const result = await runCli(repo, ['migrate', 'plan', '--from', 'v0.10.3', '--json'], env);
    expect(result.code).toBe(2);
    expect(jsonOutput(result).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'BASELINE_MISMATCH' })]),
    );
  });

  it('blocks modified Harness-owned files and unsafe shared bootstrap', async () => {
    const modified = await fixture();
    await writeText(
      modified.repo,
      'planning/harness-updates/README.md',
      `${BASELINE_UPDATE_REPORT_README}\nlocal change\n`,
    );
    const modifiedPlan = await runCli(modified.repo, ['migrate', 'plan', '--json'], modified.env);
    expect(modifiedPlan.code).toBe(2);
    expect(jsonOutput(modifiedPlan).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HARNESS_OWNED_MODIFIED' })]),
    );

    await rm(modified.base, { recursive: true, force: true });
    roots.splice(roots.indexOf(modified.base), 1);

    const shared = await fixture();
    await writeText(
      shared.repo,
      'AGENTS.md',
      `${await readFile(path.join(shared.repo, 'AGENTS.md'), 'utf8')}\n## Unsafe customization\nkeep me\n`,
    );
    await git(shared.repo, ['add', 'AGENTS.md']);
    await git(shared.repo, ['commit', '-m', 'customize shared bootstrap']);
    const sharedPlan = await runCli(shared.repo, ['migrate', 'plan', '--json'], shared.env);
    expect(sharedPlan.code).toBe(2);
    expect(jsonOutput(sharedPlan).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNSAFE_SHARED_MERGE' })]),
    );
  });

  it('blocks dirty tracked mutations and untracked target collisions', async () => {
    const dirty = await fixture();
    const agentsPath = path.join(dirty.repo, 'AGENTS.md');
    await writeFile(
      agentsPath,
      (await readFile(agentsPath, 'utf8')).replace(
        'Проект Acme инициализирован.',
        'Проект Acme локально изменён.',
      ),
      'utf8',
    );
    const dirtyPlan = await runCli(dirty.repo, ['migrate', 'plan', '--json'], dirty.env);
    expect(dirtyPlan.code).toBe(2);
    expect(jsonOutput(dirtyPlan).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DIRTY_PATH_CONFLICT' })]),
    );

    await rm(dirty.base, { recursive: true, force: true });
    roots.splice(roots.indexOf(dirty.base), 1);

    const collision = await fixture();
    await writeText(collision.repo, 'harness.yaml', 'untracked: collision\n');
    const collisionPlan = await runCli(collision.repo, ['migrate', 'plan', '--json'], collision.env);
    expect(collisionPlan.code).toBe(2);
    expect(jsonOutput(collisionPlan).plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringMatching(/UNTRACKED_COLLISION|LEGACY_AND_THIN_STATE/) }),
      ]),
    );
  });

  it('rejects stale saved plans without creating a checkpoint', async () => {
    const { base, repo, env } = await fixture();
    const planPath = path.join(base, 'stale-plan.json');
    expect((await runCli(repo, ['migrate', 'plan', '--out', planPath, '--json'], env)).code).toBe(0);

    const agentsPath = path.join(repo, 'AGENTS.md');
    await writeFile(agentsPath, `${await readFile(agentsPath, 'utf8')}\nexternal change\n`, 'utf8');

    const apply = await runCli(repo, ['migrate', 'apply', '--plan', planPath, '--json'], env);
    expect(apply.code).toBe(1);
    expect(jsonOutput(apply).error.code).toBe('PLAN_STALE');

    const status = await runCli(repo, ['migrate', 'status', '--json'], env);
    expect(status.code).toBe(0);
    expect(jsonOutput(status).checkpoints).toEqual([]);
  });

  it('surfaces interruption status and resumes through the public CLI', async () => {
    const { repo, env, releaseStore } = await fixture();
    const migrationId = await createInterruptedMigration(repo, releaseStore);

    const status = await runCli(repo, ['migrate', 'status', migrationId, '--json'], env);
    expect(status.code).toBe(0);
    expect(jsonOutput(status).checkpoints[0]).toMatchObject({
      migrationId,
      ok: true,
      state: 'running',
    });

    const resume = await runCli(repo, ['migrate', 'resume', migrationId, '--json'], env);
    expect(resume.code, resume.stderr || resume.stdout).toBe(0);
    expect(jsonOutput(resume).status).toBe('completed');

    const after = await runCli(repo, ['migrate', 'status', '--json'], env);
    expect(jsonOutput(after).checkpoints).toEqual([]);
  }, 15_000);

  it('reports a corrupted checkpoint and refuses automatic resume', async () => {
    const { repo, env, releaseStore } = await fixture();
    const migrationId = await createInterruptedMigration(repo, releaseStore);
    const checkpoint = await inspectMigrationCheckpoint(repo, migrationId);
    await writeFile(checkpoint.paths.journal, '{broken json\n', 'utf8');

    const status = await runCli(repo, ['migrate', 'status', migrationId, '--json'], env);
    expect(status.code).toBe(0);
    expect(jsonOutput(status).checkpoints[0]).toMatchObject({
      migrationId,
      ok: false,
      error: { code: 'JOURNAL_CORRUPT' },
    });

    const resume = await runCli(repo, ['migrate', 'resume', migrationId, '--json'], env);
    expect(resume.code).toBe(1);
    expect(jsonOutput(resume).error.code).toBe('JOURNAL_CORRUPT');
  });

  it('blocks active legacy execution state', async () => {
    const { repo, env } = await fixture({ activeExecution: true });
    const result = await runCli(repo, ['migrate', 'plan', '--json'], env);
    expect(result.code).toBe(2);
    expect(jsonOutput(result).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ACTIVE_EXECUTION' })]),
    );
  });

  it('migrates correctly from a linked Git worktree', async () => {
    const { base, repo, env } = await fixture();
    const worktree = path.join(base, 'worktree');
    await git(repo, ['worktree', 'add', '-b', 'migration-worktree', worktree]);

    const dryRun = await runCli(worktree, ['migrate', 'plan', '--json'], env);
    expect(dryRun.code, dryRun.stderr || dryRun.stdout).toBe(0);
    expect(jsonOutput(dryRun)).toMatchObject({ ok: true, status: 'ready' });

    const planPath = path.join(base, 'worktree-plan.json');
    const plan = await runCli(worktree, ['migrate', 'plan', '--out', planPath, '--json'], env);
    expect(plan.code, plan.stderr || plan.stdout).toBe(0);

    const apply = await runCli(worktree, ['migrate', 'apply', '--plan', planPath, '--json'], env);
    expect(apply.code, apply.stderr || apply.stdout).toBe(0);
    expect(jsonOutput(apply).status).toBe('completed');
    expect(await readFile(path.join(worktree, 'harness.yaml'), 'utf8')).toContain('release: 0.10.4');
  }, 15_000);

  it('rejects Windows-style separators in portable project paths on every host OS', async () => {
    const { repo, env } = await fixture({ windowsStyleRequirementsPath: true });
    const result = await runCli(repo, ['migrate', 'plan', '--json'], env);
    expect(result.code).toBe(2);
    expect(jsonOutput(result).plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_SCHEMA_CONFLICT' })]),
    );
  });
});
