import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertAbsolutePathWithinBoundary, resolvePortablePathWithinBoundary } from './path-boundary.js';

const execFileAsync = promisify(execFile);

export async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return realpath(stdout.trim());
  } catch {
    throw new Error('Current directory is not inside a Git repository.');
  }
}

export async function trackedWorkingTreeBlobSha1(
  projectRoot: string,
  portablePath: string,
): Promise<string | null> {
  try {
    const literalPath = `:(literal)${portablePath}`;
    const { stdout: status } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', literalPath],
      { cwd: projectRoot, encoding: 'utf8' },
    );

    if (status.length === 0) {
      const { stdout: index } = await execFileAsync(
        'git',
        ['ls-files', '-s', '-z', '--', literalPath],
        { cwd: projectRoot, encoding: 'utf8' },
      );
      const token = index.split('\0').find(Boolean);
      if (token) {
        const tab = token.indexOf('\t');
        const metadata = (tab >= 0 ? token.slice(0, tab) : token).split(' ');
        const sha = metadata[1] ?? '';
        if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    }

    const { stdout } = await execFileAsync(
      'git',
      ['hash-object', '--no-filters', '--', portablePath],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    const value = stdout.trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function trackedProjectPaths(projectRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return stdout.split('\0').filter(Boolean).sort();
}

async function harnessGitLocations(
  projectRoot: string,
): Promise<{ gitDir: string; statePath: string }> {
  const [{ stdout: gitDirOutput }, { stdout: gitPathOutput }] = await Promise.all([
    execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, encoding: 'utf8' }),
    execFileAsync('git', ['rev-parse', '--git-path', 'ai-harness'], { cwd: projectRoot, encoding: 'utf8' }),
  ]);

  const gitDirValue = gitDirOutput.trim();
  const gitPathValue = gitPathOutput.trim();
  return {
    gitDir: path.isAbsolute(gitDirValue)
      ? gitDirValue
      : path.resolve(projectRoot, gitDirValue),
    statePath: path.isAbsolute(gitPathValue)
      ? gitPathValue
      : path.resolve(projectRoot, gitPathValue),
  };
}

export async function harnessStatePath(projectRoot: string): Promise<string> {
  const { gitDir, statePath } = await harnessGitLocations(projectRoot);
  return assertAbsolutePathWithinBoundary(gitDir, statePath, 'clone-local Harness state');
}

export async function resolveHarnessStatePath(
  projectRoot: string,
  portablePath: string,
  label = 'clone-local Harness state path',
): Promise<string> {
  const { gitDir, statePath } = await harnessGitLocations(projectRoot);

  // First prove the state root itself is still inside the Git-private boundary.
  await assertAbsolutePathWithinBoundary(gitDir, statePath, 'clone-local Harness state');

  // Resolve the child using portable-path semantics, then prove the final
  // lexical target against the outer Git dir again. The second check matters
  // when ai-harness did not exist during the first check and is replaced by a
  // symlink/junction before the child path is resolved.
  const target = await resolvePortablePathWithinBoundary(statePath, portablePath, label);
  return assertAbsolutePathWithinBoundary(gitDir, target, label);
}
