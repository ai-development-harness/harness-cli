import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_EXIT_CODES } from '../src/commands/presentation.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const cliPath = path.resolve('src/cli.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function runCli(cwd: string, args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxPath, cliPath, ...args],
      { cwd, encoding: 'utf8' },
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

async function fixture(): Promise<{ root: string; remote: string }> {
  const createdRoot = await mkdtemp(path.join(tmpdir(), 'harness-cli-git-check-'));
  const createdRemote = await mkdtemp(path.join(tmpdir(), 'harness-cli-git-check-remote-'));
  roots.push(createdRoot, createdRemote);

  await git(createdRoot, 'init');
  await git(createdRoot, 'config', 'user.email', 'harness@example.invalid');
  await git(createdRoot, 'config', 'user.name', 'Harness Tests');
  await writeFile(path.join(createdRoot, 'tracked.txt'), 'initial\n', 'utf8');
  await git(createdRoot, 'add', 'tracked.txt');
  await git(createdRoot, 'commit', '-m', 'chore: initialize fixture');
  await git(createdRoot, 'branch', '-M', 'main');

  await git(createdRemote, 'init', '--bare');
  await git(createdRoot, 'remote', 'add', 'origin', createdRemote);
  await git(createdRoot, 'push', '-u', 'origin', 'main');

  return {
    root: await realpath(createdRoot),
    remote: await realpath(createdRemote),
  };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  return {
    head: await git(root, 'rev-parse', 'HEAD'),
    branch: await git(root, 'branch', '--show-current'),
    status: await git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    heads: await git(root, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'),
    remotes: await git(root, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/remotes'),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ),
  );
});

describe('harness git check CLI', () => {
  it('reports dirty and unpublished feature-branch diagnostics without any Git mutation', async () => {
    const { root } = await fixture();
    await git(root, 'switch', '-c', 'feature/check');
    await writeFile(path.join(root, 'local.txt'), 'untracked\n', 'utf8');

    const before = await snapshot(root);
    const result = await runCli(root, ['git', 'check', '--json']);
    const after = await snapshot(root);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'PASS',
      branch: 'feature/check',
      protected: false,
      configured: {
        pushRemote: 'origin',
        pullRequestBase: 'main',
        syncMode: 'report',
      },
      relation: {
        remote: 'origin',
        branch: 'feature/check',
        remoteExists: true,
        remoteHead: null,
      },
    });
    expect(output.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DIRTY_WORKTREE' }),
      expect.objectContaining({ code: 'UNPUBLISHED_BRANCH' }),
    ]));
    expect(output.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'commit', status: 'BLOCKED', reasonCode: 'NOTHING_TO_COMMIT' }),
      expect.objectContaining({ action: 'push', status: 'READY' }),
      expect.objectContaining({ action: 'pull-request', status: 'BLOCKED', reasonCode: 'UNPUBLISHED_BRANCH' }),
      expect.objectContaining({ action: 'sync', status: 'BLOCKED', reasonCode: 'UNPUBLISHED_BRANCH' }),
    ]));
    expect(after).toEqual(before);

    await expect(access(path.join(root, '.git', 'ai-harness'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports protected/base-branch policy diagnostics on main without treating overview as failure', async () => {
    const { root } = await fixture();
    const result = await runCli(root, ['git', 'check', '--json']);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      status: 'PASS',
      branch: 'main',
      protected: true,
      relation: {
        remoteExists: true,
        ahead: 0,
        behind: 0,
      },
    });
    expect(output.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROTECTED_BRANCH' }),
      expect.objectContaining({ code: 'PULL_REQUEST_BASE_BRANCH' }),
    ]));
    expect(output.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'push', status: 'BLOCKED', reasonCode: 'PROTECTED_BRANCH' }),
      expect.objectContaining({ action: 'pull-request', status: 'BLOCKED', reasonCode: 'PROTECTED_BRANCH' }),
    ]));
  });

  it('returns an environment error outside Git repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-git-check-nonrepo-'));
    roots.push(root);

    const result = await runCli(root, ['git', 'check', '--json']);

    expect(result.code).toBe(CLI_EXIT_CODES.environment);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      category: 'environment',
      error: { code: 'PROJECT_NOT_GIT_REPOSITORY' },
    });
  });
});
