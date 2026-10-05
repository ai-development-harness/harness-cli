import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GitError';
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new GitError(`git ${args.join(' ')} failed in ${cwd}`, error);
  }
}

export async function findGitRoot(cwd = process.cwd()): Promise<string> {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

export async function resolveGitPath(projectRoot: string, path: string): Promise<string> {
  return runGit(['rev-parse', '--path-format=absolute', '--git-path', path], projectRoot);
}

export async function getCurrentBranch(projectRoot: string): Promise<string | null> {
  const branch = await runGit(['branch', '--show-current'], projectRoot);
  return branch || null;
}
