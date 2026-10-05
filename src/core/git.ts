import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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

export async function harnessStatePath(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'ai-harness'], { cwd: projectRoot });
  const gitPath = stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(projectRoot, gitPath);
}
