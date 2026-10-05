import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessStatePath, resolveHarnessStatePath } from '../src/core/git.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function repositoryFixture(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-git-boundary-'));
  temporaryRoots.push(base);
  const repo = path.join(base, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  return { base, repo };
}

async function directoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Git-private Harness path boundary', () => {
  it('rejects an ai-harness root redirected outside the Git dir', async () => {
    const { base, repo } = await repositoryFixture();
    const stateRoot = await harnessStatePath(repo);
    const outside = path.join(base, 'outside-state');
    await mkdir(outside);
    await directoryLink(outside, stateRoot);

    await expect(harnessStatePath(repo)).rejects.toMatchObject({
      code: 'PATH_FILESYSTEM_ESCAPE',
    });
    await expect(
      resolveHarnessStatePath(repo, 'migrations/migration-test/plan.json'),
    ).rejects.toMatchObject({
      code: 'PATH_FILESYSTEM_ESCAPE',
    });
  });
});
