import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch {
    throw new Error('Current directory is not inside a Git repository.');
  }
}

export async function harnessStatePath(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'ai-harness'], { cwd: projectRoot });
  const gitPath = stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(projectRoot, gitPath);
}
