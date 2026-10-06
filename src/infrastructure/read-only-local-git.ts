import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitActionError,
  type GitActionPort,
  type GitRemoteRelation,
  type GitRepositorySnapshot,
} from '../core/git-actions/index.js';

const execFileAsync = promisify(execFile);

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const value = error as Error & {
      readonly code?: string | number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    const exitCode = typeof value.code === 'number' ? value.code : 1;
    if (options.allowFailure) {
      return {
        code: exitCode,
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? value.message,
      };
    }
    throw new GitActionError(
      'POSTCONDITION_FAILED',
      value.stderr?.trim() || value.message || `git ${args[0] ?? '<command>'} failed`,
      { argv: ['git', ...args], exitCode },
    );
  }
}

function nulPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function oid(value: string): string | null {
  const trimmed = value.trim();
  return /^[0-9a-f]{40,64}$/i.test(trimmed) ? trimmed : null;
}

/**
 * Local Git adapter intentionally exposes only read semantics.
 *
 * It satisfies GitActionPort so the existing GitActionService/preflight policy
 * remains the single Core authority, but every mutation method fails closed.
 */
export class ReadOnlyLocalGitPort implements GitActionPort {
  constructor(private readonly projectRoot: string) {}

  async snapshot(): Promise<GitRepositorySnapshot> {
    const [branchResult, headResult, staged, unstaged, untracked] = await Promise.all([
      runGit(this.projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
      runGit(this.projectRoot, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
      runGit(this.projectRoot, ['diff', '--cached', '--name-only', '-z']),
      runGit(this.projectRoot, ['diff', '--name-only', '-z']),
      runGit(this.projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);

    return {
      branch: branchResult.code === 0 ? branchResult.stdout.trim() || null : null,
      head: headResult.code === 0 ? oid(headResult.stdout) : null,
      staged: nulPaths(staged.stdout),
      unstaged: nulPaths(unstaged.stdout),
      untracked: nulPaths(untracked.stdout),
    };
  }

  async relation(remote: string, branch: string): Promise<GitRemoteRelation> {
    const remoteProbe = await runGit(
      this.projectRoot,
      ['remote', 'get-url', remote],
      { allowFailure: true },
    );
    const upstreamProbe = await runGit(
      this.projectRoot,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { allowFailure: true },
    );

    if (remoteProbe.code !== 0) {
      return {
        remote,
        branch,
        remoteExists: false,
        remoteHead: null,
        ahead: 0,
        behind: 0,
        upstream: upstreamProbe.code === 0 ? upstreamProbe.stdout.trim() || null : null,
      };
    }

    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const remoteHeadProbe = await runGit(
      this.projectRoot,
      ['rev-parse', '--verify', remoteRef],
      { allowFailure: true },
    );
    const remoteHead = remoteHeadProbe.code === 0 ? oid(remoteHeadProbe.stdout) : null;

    let ahead = 0;
    let behind = 0;
    if (remoteHead !== null) {
      const relation = await runGit(
        this.projectRoot,
        ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`],
        { allowFailure: true },
      );
      if (relation.code === 0) {
        const [left, right] = relation.stdout.trim().split(/\s+/);
        ahead = Number(left ?? 0);
        behind = Number(right ?? 0);
      }
    }

    return {
      remote,
      branch,
      remoteExists: true,
      remoteHead,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      upstream: upstreamProbe.code === 0 ? upstreamProbe.stdout.trim() || null : null,
    };
  }

  async localBranch(branch: string): Promise<string | null> {
    const result = await runGit(
      this.projectRoot,
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      { allowFailure: true },
    );
    return result.code === 0 ? oid(result.stdout) : null;
  }

  private mutationForbidden(operation: string): never {
    throw new GitActionError(
      'READ_ONLY_ADAPTER',
      `Read-only Git adapter cannot execute mutation: ${operation}.`,
      { operation },
    );
  }

  async createBranch(): Promise<void> {
    this.mutationForbidden('create-branch');
  }

  async commit(): Promise<{ readonly head: string }> {
    return this.mutationForbidden('commit');
  }

  async compensateCommit(): Promise<boolean> {
    return this.mutationForbidden('compensate-commit');
  }

  async push(): Promise<void> {
    this.mutationForbidden('push');
  }

  async fastForward(): Promise<void> {
    this.mutationForbidden('fast-forward');
  }
}
