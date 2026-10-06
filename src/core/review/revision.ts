import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stableHash } from '../planning/hash.js';
import type { RepositoryRevision } from './types.js';

const execFileAsync = promisify(execFile);

async function git(
  projectRoot: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: projectRoot,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    return { code: 0, stdout: stdout as Buffer, stderr: stderr as Buffer };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer; code?: number | string };
    if (options.allowFailure) {
      return {
        code: typeof value.code === 'number' ? value.code : 1,
        stdout: Buffer.isBuffer(value.stdout) ? value.stdout : Buffer.alloc(0),
        stderr: Buffer.isBuffer(value.stderr) ? value.stderr : Buffer.from(value.message ?? ''),
      };
    }
    throw new Error('git ' + (args[0] ?? '') + ' failed: ' + (Buffer.isBuffer(value.stderr) ? value.stderr.toString('utf8').trim() : value.message));
  }
}

function portable(value: string): string {
  return value.split(path.sep).join('/');
}

interface StatusEntry {
  readonly xy: string;
  readonly path: string;
  readonly sourcePath: string | null;
}

function parseStatus(raw: Buffer): StatusEntry[] {
  const fields = raw.toString('utf8').split('\0').filter(Boolean);
  const result: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    const destination = field.slice(3);
    let sourcePath: string | null = null;
    if (xy.includes('R') || xy.includes('C')) {
      sourcePath = fields[++index] ?? null;
      if (sourcePath === null) throw new Error('malformed git status rename/copy entry');
    }
    result.push({ xy, path: destination, sourcePath });
  }
  return result;
}

function parseNameStatus(raw: Buffer): string[] {
  const fields = raw.toString('utf8').split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const source = fields[index++];
      const destination = fields[index++];
      if (!source || !destination) throw new Error('malformed git --name-status -z output');
      paths.push(source, destination);
    } else {
      const value = fields[index++];
      if (!value) throw new Error('malformed git --name-status -z output');
      paths.push(value);
    }
  }
  return paths;
}

async function worktreeIdentity(projectRoot: string, relativePath: string): Promise<Readonly<Record<string, unknown>>> {
  const target = path.join(projectRoot, ...relativePath.split('/'));
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return { kind: 'symlink', target: await readlink(target) };
    if (info.isFile()) {
      return {
        kind: 'file',
        mode: (info.mode & 0o111) !== 0 ? '100755' : '100644',
        bytes: (await readFile(target)).toString('base64'),
      };
    }
    if (info.isDirectory()) return { kind: 'directory' };
    return { kind: 'other', mode: info.mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
}

async function indexIdentity(projectRoot: string, relativePath: string): Promise<string | null> {
  const result = await git(projectRoot, ['ls-files', '-s', '-z', '--', ':(literal)' + relativePath], { allowFailure: true });
  if (result.code !== 0) return null;
  const first = result.stdout.toString('utf8').split('\0').find(Boolean);
  if (!first) return null;
  const tab = first.indexOf('\t');
  return tab >= 0 ? first.slice(0, tab) : first;
}

export async function repositoryRevision(
  projectRoot: string,
  options: { readonly ignoredPaths?: ReadonlySet<string> } = {},
): Promise<RepositoryRevision> {
  const head = await git(projectRoot, ['rev-parse', 'HEAD'], { allowFailure: true });
  const gitHead = head.code === 0 ? head.stdout.toString('utf8').trim() || null : null;
  const status = await git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const ignored = new Set([...(options.ignoredPaths ?? [])].map((item) => portable(item)));
  const entries = parseStatus(status.stdout).filter((entry) => {
    const destinationIgnored = ignored.has(portable(entry.path));
    const sourceIgnored = entry.sourcePath === null || ignored.has(portable(entry.sourcePath));
    return !(destinationIgnored && sourceIgnored);
  });

  if (entries.length === 0) return { gitHead, worktreeHash: null };

  const material: unknown[] = [];
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path) || String(a.sourcePath).localeCompare(String(b.sourcePath)))) {
    const rel = portable(entry.path);
    material.push({
      xy: entry.xy,
      path: rel,
      sourcePath: entry.sourcePath ? portable(entry.sourcePath) : null,
      index: await indexIdentity(projectRoot, rel),
      worktree: await worktreeIdentity(projectRoot, rel),
    });
  }
  return { gitHead, worktreeHash: stableHash(material) };
}

async function worktreePaths(projectRoot: string): Promise<Set<string>> {
  const status = await git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const result = new Set<string>();
  for (const entry of parseStatus(status.stdout)) {
    result.add(portable(entry.path));
    if (entry.sourcePath) result.add(portable(entry.sourcePath));
  }
  return result;
}

async function diagnosticLastCommitPaths(projectRoot: string): Promise<Set<string>> {
  const head = await git(projectRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
  if (head.code !== 0) return new Set();
  const parent = await git(projectRoot, ['rev-parse', '--verify', 'HEAD^'], { allowFailure: true });
  const range = parent.code === 0 ? 'HEAD^..HEAD' : 'HEAD';
  const diff = await git(projectRoot, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', '-C', '--find-copies-harder', range, '--'], { allowFailure: true });
  return diff.code === 0 ? new Set(parseNameStatus(diff.stdout).map(portable)) : new Set();
}

async function commitAvailable(projectRoot: string, revision: string): Promise<boolean> {
  return (await git(projectRoot, ['rev-parse', '--verify', revision + '^{commit}'], { allowFailure: true })).code === 0;
}

async function ancestor(projectRoot: string, baseline: string): Promise<boolean> {
  return (await git(projectRoot, ['merge-base', '--is-ancestor', baseline, 'HEAD'], { allowFailure: true })).code === 0;
}

export interface ReviewSurface {
  readonly changedPaths: readonly string[];
  readonly changedPathsHash: string;
  readonly surfaceMode: 'implementation-baseline' | 'clean-tree-fallback';
  readonly implementationBaseline: string | null;
  readonly baselineStatus: 'valid' | 'missing' | 'invalid';
  readonly baselineReason: string | null;
}

export async function reviewSurface(
  projectRoot: string,
  implementationBaseline: string | null,
): Promise<ReviewSurface> {
  const worktree = await worktreePaths(projectRoot);
  let reason: string | null = null;
  if (implementationBaseline === null) reason = 'implementation baseline is missing';
  else if (!(await commitAvailable(projectRoot, implementationBaseline))) reason = 'implementation baseline commit is unavailable';
  else if (!(await commitAvailable(projectRoot, 'HEAD'))) reason = 'current HEAD commit is unavailable';
  else if (!(await ancestor(projectRoot, implementationBaseline))) reason = 'implementation baseline is not an ancestor of HEAD';

  if (reason === null && implementationBaseline !== null) {
    const diff = await git(projectRoot, [
      'diff','--name-status','-z','-M','-C','--find-copies-harder',implementationBaseline + '..HEAD','--',
    ]);
    const paths = [...new Set([...parseNameStatus(diff.stdout).map(portable), ...worktree])].sort();
    return {
      changedPaths: paths,
      changedPathsHash: stableHash({ paths }),
      surfaceMode: 'implementation-baseline',
      implementationBaseline,
      baselineStatus: 'valid',
      baselineReason: null,
    };
  }

  const paths = [...new Set([...worktree, ...(await diagnosticLastCommitPaths(projectRoot))])].sort();
  return {
    changedPaths: paths,
    changedPathsHash: stableHash({ paths }),
    surfaceMode: 'clean-tree-fallback',
    implementationBaseline,
    baselineStatus: implementationBaseline === null ? 'missing' : 'invalid',
    baselineReason: reason,
  };
}

export async function repositoryActivityFingerprint(
  projectRoot: string,
  includedPaths?: ReadonlySet<string> | null,
): Promise<string> {
  const revision = await repositoryRevision(projectRoot);
  if (!includedPaths || includedPaths.size === 0) return stableHash(revision);
  const paths = await worktreePaths(projectRoot);
  const prefixes = [...includedPaths].map((item) => item.replace(/\/$/, ''));
  return stableHash({
    gitHead: revision.gitHead,
    paths: [...paths].filter((item) => prefixes.some((prefix) => item === prefix || item.startsWith(prefix + '/'))).sort(),
  });
}
