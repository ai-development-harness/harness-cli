import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitActionError,
  GitActionService,
  readSideEffectCheckpoint,
  redactProviderMessage,
  writeSideEffectCheckpoint,
  type GitActionPort,
  type GitRemoteRelation,
  type GitRepositorySnapshot,
  type GitWorkflowPolicy,
  type PullRequestProviderPort,
  type PullRequestRecord,
} from '../src/core/git-actions/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const policy: GitWorkflowPolicy = {
  protectedBranches: ['main', 'master'],
  branchWhenProtected: 'auto-create',
  allowCommitOnProtected: false,
  allowPushToProtected: false,
  pushRemote: 'origin',
  setUpstream: true,
  syncMode: 'ff-only',
  pullRequestBase: 'main',
  reuseExistingPullRequest: true,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-git-actions-'));
  roots.push(root);
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'harness@example.invalid');
  await git(root, 'config', 'user.name', 'Harness Tests');
  await git(root, 'commit', '--allow-empty', '-m', 'chore: initialize fixture');
  return root;
}

class FakeGit implements GitActionPort {
  snapshotValue: GitRepositorySnapshot = {
    branch: 'feature/example',
    head: 'a'.repeat(40),
    staged: [],
    unstaged: [],
    untracked: [],
  };

  relationValue: GitRemoteRelation = {
    remote: 'origin',
    branch: 'feature/example',
    remoteHead: null,
    ahead: 1,
    behind: 0,
    upstream: null,
  };

  pushFailureAfterMutation = false;
  compensateCalls = 0;

  async snapshot(): Promise<GitRepositorySnapshot> {
    return this.snapshotValue;
  }

  async relation(remote: string, branch: string): Promise<GitRemoteRelation> {
    return { ...this.relationValue, remote, branch };
  }

  async localBranch(branch: string): Promise<string | null> {
    if (branch === this.snapshotValue.branch) return this.snapshotValue.head;
    if (branch === 'main') return 'e'.repeat(40);
    return null;
  }

  async createBranch(branch: string): Promise<void> {
    this.snapshotValue = { ...this.snapshotValue, branch };
  }

  async commit(input: { readonly branch: string; readonly message: string; readonly expectedHead: string | null }): Promise<{ readonly head: string }> {
    const head = 'c'.repeat(40);
    this.snapshotValue = { ...this.snapshotValue, branch: input.branch, head, staged: [] };
    return { head };
  }

  async compensateCommit(): Promise<boolean> {
    this.compensateCalls += 1;
    return true;
  }

  async push(input: { readonly remote: string; readonly branch: string; readonly expectedRemoteHead: string | null; readonly expectedLocalHead: string; readonly setUpstream: boolean }): Promise<void> {
    this.relationValue = {
      remote: input.remote,
      branch: input.branch,
      remoteHead: input.expectedLocalHead,
      ahead: 0,
      behind: 0,
      upstream: input.setUpstream ? `${input.remote}/${input.branch}` : this.relationValue.upstream,
    };
    if (this.pushFailureAfterMutation) throw new Error('transport disconnected after update');
  }

  async fastForward(input: { readonly remote: string; readonly branch: string; readonly expectedLocalHead: string; readonly expectedRemoteHead: string }): Promise<void> {
    this.snapshotValue = { ...this.snapshotValue, branch: input.branch, head: input.expectedRemoteHead };
    this.relationValue = { ...this.relationValue, remote: input.remote, branch: input.branch, ahead: 0, behind: 0 };
  }
}

class FakeProvider implements PullRequestProviderPort {
  records: PullRequestRecord[] = [];
  failAfterCreate = false;

  async findOpen(input: { readonly headBranch: string; readonly headOid: string; readonly baseBranch: string }): Promise<readonly PullRequestRecord[]> {
    return this.records.filter(
      (item) =>
        item.state === 'OPEN' &&
        item.headBranch === input.headBranch &&
        item.headOid === input.headOid &&
        item.baseBranch === input.baseBranch,
    );
  }

  async view(selector: string): Promise<PullRequestRecord> {
    const item = this.records.find((record) => record.id === selector || record.headBranch === selector);
    if (!item) throw new Error('Pull Request not found');
    return item;
  }

  async create(input: { readonly headBranch: string; readonly headOid: string; readonly baseBranch: string; readonly title: string; readonly body: string; readonly draft: boolean }): Promise<void> {
    this.records.push({
      id: '42',
      url: 'https://example.invalid/pull/42',
      state: 'OPEN',
      headBranch: input.headBranch,
      headOid: input.headOid,
      baseBranch: input.baseBranch,
      draft: input.draft,
      title: input.title,
    });
    if (this.failAfterCreate) throw new Error('provider returned 502 after create');
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })));
});

describe('Git action Core', () => {
  it('reports deterministic Git check facts without mutation', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    const service = new GitActionService({ projectRoot: root, git: port, policy });

    await expect(service.check()).resolves.toMatchObject({
      branch: 'feature/example',
      protected: false,
      head: 'a'.repeat(40),
      relation: {
        remote: 'origin',
        branch: 'feature/example',
      },
    });
  });

  it('builds a resumable PR finish plan only from provider-verified merged state', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    port.snapshotValue = {
      ...port.snapshotValue,
      branch: 'feature/example',
      head: 'a'.repeat(40),
    };
    port.relationValue = {
      remote: 'origin',
      branch: 'main',
      remoteHead: 'f'.repeat(40),
      ahead: 0,
      behind: 1,
      upstream: 'origin/main',
    };
    const provider = new FakeProvider();
    provider.records.push({
      id: '77',
      url: 'https://example.invalid/pull/77',
      state: 'MERGED',
      headBranch: 'feature/example',
      headOid: 'a'.repeat(40),
      baseBranch: 'main',
      draft: false,
      mergedAt: '2026-10-06T08:00:00Z',
    });
    const service = new GitActionService({
      projectRoot: root,
      git: port,
      pullRequests: provider,
      policy,
    });

    await expect(service.preflightPullRequestFinish('77')).resolves.toMatchObject({
      action: 'pr-finish',
      pullRequestId: '77',
      headBranch: 'feature/example',
      returnBranch: 'main',
      resumed: false,
      forceDeleteForbidden: true,
      steps: [
        { operation: 'switch-return-branch', branch: 'main' },
        { operation: 'sync-return-branch', expectedRemoteHead: 'f'.repeat(40) },
        { operation: 'delete-local-pr-branch', expectedHead: 'a'.repeat(40) },
      ],
    });
  });

  it('requires an explicit safe branch before committing from a protected branch', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    port.snapshotValue = {
      ...port.snapshotValue,
      branch: 'main',
      staged: ['src/change.ts'],
    };
    const service = new GitActionService({ projectRoot: root, git: port, policy });

    await expect(service.preflightCommit()).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    await expect(service.preflightCommit({ branchName: 'feature/safe-change' })).resolves.toMatchObject({
      action: 'commit',
      branch: 'feature/safe-change',
      createBranch: 'feature/safe-change',
      expectedHead: 'a'.repeat(40),
    });
  });

  it('blocks remote-ahead and diverged pushes but permits an unpublished branch plan', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    const service = new GitActionService({ projectRoot: root, git: port, policy });

    port.relationValue = { ...port.relationValue, remoteHead: 'b'.repeat(40), ahead: 0, behind: 1 };
    await expect(service.preflightPush()).rejects.toMatchObject({ code: 'REMOTE_AHEAD' });

    port.relationValue = { ...port.relationValue, ahead: 1, behind: 1 };
    await expect(service.preflightPush()).rejects.toMatchObject({ code: 'DIVERGED' });

    port.relationValue = { ...port.relationValue, remoteHead: null, ahead: 1, behind: 0, upstream: null };
    await expect(service.preflightPush()).resolves.toMatchObject({
      action: 'push',
      expectedRemoteHead: null,
      setUpstream: true,
    });
  });

  it('blocks dirty ff-only sync and never hides divergence behind worktree state', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    const service = new GitActionService({ projectRoot: root, git: port, policy });

    port.snapshotValue = { ...port.snapshotValue, unstaged: ['src/local.ts'] };
    port.relationValue = { ...port.relationValue, remoteHead: 'b'.repeat(40), ahead: 0, behind: 1 };
    await expect(service.preflightSync()).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });

    port.relationValue = { ...port.relationValue, ahead: 1, behind: 1 };
    await expect(service.preflightSync()).rejects.toMatchObject({ code: 'DIVERGED' });
  });

  it('reconciles a push when transport fails after the remote side effect', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    port.pushFailureAfterMutation = true;
    const service = new GitActionService({ projectRoot: root, git: port, policy });

    await expect(service.executePush({ operationId: 'push-1' })).resolves.toMatchObject({
      status: 'SUCCESS',
      action: 'push',
      recovered: true,
    });
    await expect(readSideEffectCheckpoint(root, 'push-1')).resolves.toMatchObject({
      kind: 'git_push',
      phase: 'postconditions_verified',
      proof: { observedRemoteHead: 'a'.repeat(40) },
    });
  });

  it('fails closed when interrupted push recovery observes an unrelated remote revision', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    await writeSideEffectCheckpoint(root, {
      operationId: 'push-ambiguous',
      kind: 'git_push',
      phase: 'prepared',
      proof: {
        branch: 'feature/example',
        remote: 'origin',
        expectedHead: 'a'.repeat(40),
        remoteBefore: 'b'.repeat(40),
      },
    });
    await writeSideEffectCheckpoint(root, {
      operationId: 'push-ambiguous',
      kind: 'git_push',
      phase: 'side_effect_started',
      proof: {
        branch: 'feature/example',
        remote: 'origin',
        expectedHead: 'a'.repeat(40),
        remoteBefore: 'b'.repeat(40),
      },
    });
    port.relationValue = { ...port.relationValue, remoteHead: 'd'.repeat(40), ahead: 1, behind: 1 };

    const service = new GitActionService({ projectRoot: root, git: port, policy });
    await expect(service.executePush({ operationId: 'push-ambiguous' })).rejects.toMatchObject({
      code: 'SIDE_EFFECT_RECOVERY_AMBIGUOUS',
    });
  });

  it('treats provider observation, not provider output, as Pull Request completion proof', async () => {
    const root = await temporaryRepository();
    const port = new FakeGit();
    port.relationValue = { ...port.relationValue, remoteHead: 'a'.repeat(40), ahead: 0, behind: 0 };
    const provider = new FakeProvider();
    provider.failAfterCreate = true;
    const service = new GitActionService({
      projectRoot: root,
      git: port,
      pullRequests: provider,
      policy,
    });

    await expect(
      service.executePullRequest({
        operationId: 'pr-1',
        title: 'feat: example',
        body: 'Body',
      }),
    ).resolves.toMatchObject({
      status: 'SUCCESS',
      recovered: true,
      pullRequest: { id: '42', headOid: 'a'.repeat(40), baseBranch: 'main' },
    });

    await expect(
      service.executePullRequest({
        operationId: 'pr-1',
        title: 'feat: example',
        body: 'Body',
      }),
    ).resolves.toMatchObject({
      status: 'SUCCESS',
      recovered: true,
      pullRequest: { id: '42' },
    });
    expect(provider.records).toHaveLength(1);
  });

  it('redacts common provider credential forms from typed provider diagnostics', () => {
    const value = redactProviderMessage(
      'Authorization: Bearer abc123 token=my-secret access_token=query-secret password=p4ss secret=s3cr3t ghp_ABC123 github_pat_LONGVALUE',
    );
    for (const secret of [
      'abc123',
      'my-secret',
      'query-secret',
      'p4ss',
      's3cr3t',
      'ghp_ABC123',
      'github_pat_LONGVALUE',
    ]) {
      expect(value).not.toContain(secret);
    }
    expect(value).toContain('[REDACTED]');
  });

  it('keeps side-effect checkpoints isolated between linked Git worktrees', async () => {
    const root = await temporaryRepository();
    const worktree = `${root}-linked`;
    roots.push(worktree);
    await git(root, 'worktree', 'add', '-b', 'feature/worktree', worktree);

    await writeSideEffectCheckpoint(root, {
      operationId: 'same-operation',
      kind: 'git_push',
      phase: 'prepared',
      proof: { branch: 'master-or-main-root' },
    });
    await writeSideEffectCheckpoint(worktree, {
      operationId: 'same-operation',
      kind: 'git_push',
      phase: 'prepared',
      proof: { branch: 'feature/worktree' },
    });

    await expect(readSideEffectCheckpoint(root, 'same-operation')).resolves.toMatchObject({
      proof: { branch: 'master-or-main-root' },
    });
    await expect(readSideEffectCheckpoint(worktree, 'same-operation')).resolves.toMatchObject({
      proof: { branch: 'feature/worktree' },
    });
  });
});
