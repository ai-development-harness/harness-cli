import { acquireCoreWriteLock } from '../write-lock.js';
import {
  readSideEffectCheckpoint,
  writeSideEffectCheckpoint,
} from './checkpoint.js';
import { GitActionError, providerFailure } from './errors.js';
import type {
  GitActionPort,
  GitActionResult,
  GitMutationPlan,
  GitRemoteRelation,
  GitRepositorySnapshot,
  GitWorkflowPolicy,
  PullRequestProviderPort,
  PullRequestRecord,
  SideEffectCheckpoint,
} from './types.js';

export interface GitActionServiceOptions {
  readonly projectRoot: string;
  readonly git: GitActionPort;
  readonly pullRequests?: PullRequestProviderPort;
  readonly policy: GitWorkflowPolicy;
}

function requireAttached(snapshot: GitRepositorySnapshot): string {
  if (!snapshot.branch) {
    throw new GitActionError('DETACHED_HEAD', 'Git mutation requires an attached branch.');
  }
  return snapshot.branch;
}

function isProtected(branch: string, policy: GitWorkflowPolicy): boolean {
  return policy.protectedBranches.includes(branch);
}

function dirty(snapshot: GitRepositorySnapshot): boolean {
  return snapshot.staged.length > 0 || snapshot.unstaged.length > 0 || snapshot.untracked.length > 0;
}

function requireHead(snapshot: GitRepositorySnapshot): string {
  if (!snapshot.head) {
    throw new GitActionError('POSTCONDITION_FAILED', 'Git action requires an existing HEAD.');
  }
  return snapshot.head;
}

function samePr(
  item: PullRequestRecord,
  branch: string,
  head: string,
  base: string,
): boolean {
  return (
    item.state === 'OPEN' &&
    item.headBranch === branch &&
    item.headOid === head &&
    item.baseBranch === base
  );
}

function requireUniquePullRequest(
  items: readonly PullRequestRecord[],
  branch: string,
  head: string,
  base: string,
): PullRequestRecord | null {
  const matches = items.filter((item) => samePr(item, branch, head, base));
  if (matches.length > 1) {
    throw new GitActionError(
      'PR_STATE_INVALID',
      'Multiple open Pull Requests match the exact head/base/revision identity.',
      { branch, base, head, ids: matches.map((item) => item.id) },
    );
  }
  return matches[0] ?? null;
}

function checkpointProof(checkpoint: SideEffectCheckpoint): Record<string, unknown> {
  return { ...checkpoint.proof };
}

export class GitActionService {
  private readonly projectRoot: string;
  private readonly git: GitActionPort;
  private readonly pullRequests?: PullRequestProviderPort;
  private readonly policy: GitWorkflowPolicy;

  constructor(options: GitActionServiceOptions) {
    this.projectRoot = options.projectRoot;
    this.git = options.git;
    this.pullRequests = options.pullRequests;
    this.policy = options.policy;
  }

  async preflightCommit(input: {
    readonly branchName?: string;
  } = {}): Promise<GitMutationPlan> {
    const snapshot = await this.git.snapshot();
    const branch = requireAttached(snapshot);
    if (snapshot.staged.length === 0) {
      throw new GitActionError('NOTHING_TO_COMMIT', 'No staged changes are available for commit.');
    }

    let createBranch: string | undefined;
    if (isProtected(branch, this.policy) && !this.policy.allowCommitOnProtected) {
      if (this.policy.branchWhenProtected === 'block' || this.policy.branchWhenProtected === 'stay') {
        throw new GitActionError('PROTECTED_BRANCH', `Commit on protected branch ${branch} is blocked by policy.`, {
          branch,
        });
      }
      const candidate = input.branchName?.trim();
      if (!candidate || this.policy.protectedBranches.includes(candidate)) {
        throw new GitActionError(
          'PROTECTED_BRANCH',
          'Protected branch requires an explicit safe target branch.',
          { branch },
        );
      }
      createBranch = candidate;
    }

    return {
      schemaVersion: 1,
      action: 'commit',
      branch: createBranch ?? branch,
      expectedHead: snapshot.head,
      ...(createBranch ? { createBranch } : {}),
    };
  }

  async preflightPush(): Promise<GitMutationPlan> {
    const snapshot = await this.git.snapshot();
    const branch = requireAttached(snapshot);
    const head = requireHead(snapshot);

    if (isProtected(branch, this.policy) && !this.policy.allowPushToProtected) {
      throw new GitActionError('PROTECTED_BRANCH', `Push to protected branch ${branch} is blocked by policy.`, {
        branch,
      });
    }

    const relation = await this.git.relation(this.policy.pushRemote, branch);
    if (relation.behind > 0) {
      const code = relation.ahead > 0 ? 'DIVERGED' : 'REMOTE_AHEAD';
      throw new GitActionError(
        code,
        relation.ahead > 0
          ? `Local and remote branch ${branch} have diverged.`
          : `Remote branch ${branch} is ahead of local HEAD.`,
        { relation },
      );
    }

    return {
      schemaVersion: 1,
      action: 'push',
      branch,
      expectedHead: head,
      expectedRemoteHead: relation.remoteHead,
      remote: this.policy.pushRemote,
      setUpstream: relation.upstream === null && this.policy.setUpstream,
    };
  }

  async preflightPullRequest(): Promise<GitMutationPlan> {
    const snapshot = await this.git.snapshot();
    const branch = requireAttached(snapshot);
    const head = requireHead(snapshot);
    if (branch === this.policy.pullRequestBase) {
      throw new GitActionError('PROTECTED_BRANCH', 'Pull Request head must not equal its configured base branch.', {
        branch,
        base: this.policy.pullRequestBase,
      });
    }

    const relation = await this.git.relation(this.policy.pushRemote, branch);
    if (relation.remoteHead === null) {
      throw new GitActionError('UNPUBLISHED_BRANCH', 'Pull Request head branch must be published first.', {
        branch,
        remote: this.policy.pushRemote,
      });
    }
    if (relation.remoteHead !== head) {
      throw new GitActionError('REMOTE_HEAD_MISMATCH', 'Published head revision does not match local HEAD.', {
        branch,
        localHead: head,
        remoteHead: relation.remoteHead,
      });
    }

    return {
      schemaVersion: 1,
      action: 'pull-request',
      branch,
      expectedHead: head,
      expectedRemoteHead: relation.remoteHead,
      remote: this.policy.pushRemote,
      base: this.policy.pullRequestBase,
    };
  }

  async preflightSync(): Promise<GitMutationPlan> {
    const snapshot = await this.git.snapshot();
    const branch = requireAttached(snapshot);
    const relation = await this.git.relation(this.policy.pushRemote, branch);

    if (relation.remoteHead === null) {
      throw new GitActionError('UNPUBLISHED_BRANCH', 'Cannot sync a branch without a remote counterpart.', {
        branch,
        remote: this.policy.pushRemote,
      });
    }
    if (relation.ahead > 0 && relation.behind > 0) {
      throw new GitActionError('DIVERGED', `Local and remote branch ${branch} have diverged.`, { relation });
    }
    if (this.policy.syncMode === 'ff-only' && relation.behind > 0 && dirty(snapshot)) {
      throw new GitActionError('DIRTY_WORKTREE', 'Fast-forward sync requires a clean worktree.', {
        staged: snapshot.staged,
        unstaged: snapshot.unstaged,
        untracked: snapshot.untracked,
      });
    }

    return {
      schemaVersion: 1,
      action: 'sync',
      branch,
      expectedHead: snapshot.head,
      expectedRemoteHead: relation.remoteHead,
      remote: this.policy.pushRemote,
    };
  }

  private async relationForPlan(plan: GitMutationPlan): Promise<GitRemoteRelation> {
    if (!plan.remote) throw new GitActionError('POSTCONDITION_FAILED', 'Mutation plan has no remote.');
    return this.git.relation(plan.remote, plan.branch);
  }

  async executeCommit(input: {
    readonly operationId: string;
    readonly message: string;
    readonly branchName?: string;
  }): Promise<GitActionResult> {
    const lease = await acquireCoreWriteLock(this.projectRoot, 'git-action', input.operationId);
    try {
      const existing = await readSideEffectCheckpoint(this.projectRoot, input.operationId);
      if (existing && existing.kind !== 'git_commit') {
        throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Operation checkpoint kind does not match commit.');
      }

      if (existing && existing.phase !== 'prepared') {
        const proof = checkpointProof(existing);
        const expectedCreated = typeof proof.createdHead === 'string' ? proof.createdHead : null;
        const beforeHead = typeof proof.beforeHead === 'string' ? proof.beforeHead : null;
        const branch = typeof proof.branch === 'string' ? proof.branch : null;
        const current = await this.git.snapshot();
        if (expectedCreated && current.head === expectedCreated && current.branch === branch) {
          await writeSideEffectCheckpoint(this.projectRoot, {
            operationId: input.operationId,
            kind: 'git_commit',
            phase: 'postconditions_verified',
            proof: { ...proof, recovered: true },
          });
          return {
            status: 'SUCCESS',
            action: 'commit',
            recovered: true,
            plan: {
              schemaVersion: 1,
              action: 'commit',
              branch: branch!,
              expectedHead: beforeHead,
            },
          };
        }
        if (current.head !== beforeHead) {
          throw new GitActionError(
            'SIDE_EFFECT_RECOVERY_AMBIGUOUS',
            'Interrupted commit cannot be reconciled against current repository state.',
            { checkpoint: proof, current },
          );
        }
      }

      const plan = await this.preflightCommit({ branchName: input.branchName });
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_commit',
        phase: 'prepared',
        proof: { beforeHead: plan.expectedHead, branch: plan.branch },
      });

      if (plan.createBranch) {
        await this.git.createBranch(plan.createBranch, plan.expectedHead);
      }

      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_commit',
        phase: 'side_effect_started',
        proof: { beforeHead: plan.expectedHead, branch: plan.branch },
      });

      const created = await this.git.commit({
        branch: plan.branch,
        message: input.message,
        expectedHead: plan.expectedHead,
      });
      const proof = { beforeHead: plan.expectedHead, branch: plan.branch, createdHead: created.head };
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_commit',
        phase: 'side_effect_observed',
        proof,
      });

      const after = await this.git.snapshot();
      if (after.branch !== plan.branch || after.head !== created.head) {
        const compensated = await this.git.compensateCommit({
          branch: plan.branch,
          createdHead: created.head,
          restoreHead: plan.expectedHead,
        });
        throw new GitActionError('POSTCONDITION_FAILED', 'Commit postcondition did not match the exact mutation plan.', {
          expectedBranch: plan.branch,
          expectedHead: created.head,
          actualBranch: after.branch,
          actualHead: after.head,
          compensated,
        });
      }

      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_commit',
        phase: 'postconditions_verified',
        proof,
      });
      return { status: 'SUCCESS', action: 'commit', plan };
    } finally {
      await lease.release();
    }
  }

  async executePush(input: { readonly operationId: string }): Promise<GitActionResult> {
    const lease = await acquireCoreWriteLock(this.projectRoot, 'git-action', input.operationId);
    try {
      const existing = await readSideEffectCheckpoint(this.projectRoot, input.operationId);
      if (existing && existing.kind !== 'git_push') {
        throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Operation checkpoint kind does not match push.');
      }

      if (existing && existing.phase !== 'prepared') {
        const proof = checkpointProof(existing);
        const branch = String(proof.branch ?? '');
        const remote = String(proof.remote ?? '');
        const expectedHead = typeof proof.expectedHead === 'string' ? proof.expectedHead : null;
        const remoteBefore = typeof proof.remoteBefore === 'string' ? proof.remoteBefore : null;
        if (!branch || !remote || !expectedHead) {
          throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Push checkpoint proof is incomplete.');
        }
        const observed = await this.git.relation(remote, branch);
        if (observed.remoteHead === expectedHead) {
          await writeSideEffectCheckpoint(this.projectRoot, {
            operationId: input.operationId,
            kind: 'git_push',
            phase: 'postconditions_verified',
            proof: { ...proof, observedRemoteHead: observed.remoteHead, recovered: true },
          });
          return {
            status: 'SUCCESS',
            action: 'push',
            recovered: true,
            plan: {
              schemaVersion: 1,
              action: 'push',
              branch,
              remote,
              expectedHead,
              expectedRemoteHead: remoteBefore,
            },
          };
        }
        if (observed.remoteHead !== remoteBefore) {
          throw new GitActionError(
            'SIDE_EFFECT_RECOVERY_AMBIGUOUS',
            'Interrupted push observed a remote revision that is neither baseline nor expected result.',
            { checkpoint: proof, observedRemoteHead: observed.remoteHead },
          );
        }
      }

      const plan = await this.preflightPush();
      const proof = {
        branch: plan.branch,
        remote: plan.remote!,
        expectedHead: plan.expectedHead!,
        remoteBefore: plan.expectedRemoteHead ?? null,
      };
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_push',
        phase: 'prepared',
        proof,
      });
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_push',
        phase: 'side_effect_started',
        proof,
      });

      let failure: unknown;
      try {
        await this.git.push({
          remote: plan.remote!,
          branch: plan.branch,
          expectedRemoteHead: plan.expectedRemoteHead ?? null,
          expectedLocalHead: plan.expectedHead!,
          setUpstream: Boolean(plan.setUpstream),
        });
      } catch (error) {
        failure = error;
      }

      const relation = await this.relationForPlan(plan);
      if (relation.remoteHead !== plan.expectedHead) {
        if (failure) throw failure;
        throw new GitActionError('POSTCONDITION_FAILED', 'Push completed without the expected remote revision.', {
          expectedRemoteHead: plan.expectedHead,
          observedRemoteHead: relation.remoteHead,
        });
      }

      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_push',
        phase: 'side_effect_observed',
        proof: { ...proof, observedRemoteHead: relation.remoteHead },
      });
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'git_push',
        phase: 'postconditions_verified',
        proof: { ...proof, observedRemoteHead: relation.remoteHead },
      });
      return { status: 'SUCCESS', action: 'push', plan, ...(failure ? { recovered: true } : {}) };
    } finally {
      await lease.release();
    }
  }

  async executePullRequest(input: {
    readonly operationId: string;
    readonly title: string;
    readonly body: string;
    readonly draft?: boolean;
  }): Promise<GitActionResult> {
    if (!this.pullRequests) {
      throw providerFailure('Pull Request provider adapter is not configured.');
    }

    const lease = await acquireCoreWriteLock(this.projectRoot, 'git-action', input.operationId);
    try {
      const existing = await readSideEffectCheckpoint(this.projectRoot, input.operationId);
      if (existing && existing.kind !== 'provider_pr') {
        throw new GitActionError('SIDE_EFFECT_CHECKPOINT_INVALID', 'Operation checkpoint kind does not match Pull Request.');
      }

      const plan = await this.preflightPullRequest();
      const observe = async (): Promise<PullRequestRecord | null> => {
        let items: readonly PullRequestRecord[];
        try {
          items = await this.pullRequests!.findOpen({
            headBranch: plan.branch,
            headOid: plan.expectedHead!,
            baseBranch: plan.base!,
          });
        } catch (error) {
          throw providerFailure((error as Error).message);
        }
        return requireUniquePullRequest(items, plan.branch, plan.expectedHead!, plan.base!);
      };

      const already = await observe();
      if (already) {
        if (!this.policy.reuseExistingPullRequest && !existing) {
          throw new GitActionError('PR_STATE_INVALID', 'An open Pull Request already exists and reuse is disabled.', {
            pullRequestId: already.id,
          });
        }
        await writeSideEffectCheckpoint(this.projectRoot, {
          operationId: input.operationId,
          kind: 'provider_pr',
          phase: existing ? 'postconditions_verified' : 'prepared',
          proof: {
            branch: plan.branch,
            head: plan.expectedHead!,
            base: plan.base!,
            pullRequestId: already.id,
            pullRequestUrl: already.url,
            reused: true,
          },
        });
        if (!existing) {
          await writeSideEffectCheckpoint(this.projectRoot, {
            operationId: input.operationId,
            kind: 'provider_pr',
            phase: 'postconditions_verified',
            proof: {
              branch: plan.branch,
              head: plan.expectedHead!,
              base: plan.base!,
              pullRequestId: already.id,
              pullRequestUrl: already.url,
              reused: true,
            },
          });
        }
        return { status: 'SUCCESS', action: 'pull-request', plan, pullRequest: already, recovered: Boolean(existing) };
      }

      if (existing && existing.phase !== 'prepared') {
        throw new GitActionError(
          'SIDE_EFFECT_RECOVERY_AMBIGUOUS',
          'Pull Request checkpoint indicates a started side effect, but no exact open Pull Request can be observed.',
          { checkpoint: existing.proof },
        );
      }

      const proof = { branch: plan.branch, head: plan.expectedHead!, base: plan.base! };
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'provider_pr',
        phase: 'prepared',
        proof,
      });
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'provider_pr',
        phase: 'side_effect_started',
        proof,
      });

      let failure: unknown;
      try {
        await this.pullRequests.create({
          headBranch: plan.branch,
          headOid: plan.expectedHead!,
          baseBranch: plan.base!,
          title: input.title,
          body: input.body,
          draft: Boolean(input.draft),
        });
      } catch (error) {
        failure = error;
      }

      const created = await observe();
      if (!created) {
        if (failure) throw providerFailure((failure as Error).message);
        throw new GitActionError('POSTCONDITION_FAILED', 'Provider returned without an observable exact Pull Request.');
      }

      const verifiedProof = {
        ...proof,
        pullRequestId: created.id,
        pullRequestUrl: created.url,
      };
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'provider_pr',
        phase: 'side_effect_observed',
        proof: verifiedProof,
      });
      await writeSideEffectCheckpoint(this.projectRoot, {
        operationId: input.operationId,
        kind: 'provider_pr',
        phase: 'postconditions_verified',
        proof: verifiedProof,
      });
      return {
        status: 'SUCCESS',
        action: 'pull-request',
        plan,
        pullRequest: created,
        ...(failure ? { recovered: true } : {}),
      };
    } finally {
      await lease.release();
    }
  }

  async executeSync(input: { readonly operationId: string }): Promise<GitActionResult> {
    const lease = await acquireCoreWriteLock(this.projectRoot, 'git-action', input.operationId);
    try {
      const plan = await this.preflightSync();
      const relation = await this.relationForPlan(plan);
      if (relation.behind === 0 || this.policy.syncMode === 'report') {
        return { status: 'NOOP', action: 'sync', plan };
      }
      if (!plan.expectedHead || !plan.expectedRemoteHead) {
        throw new GitActionError('POSTCONDITION_FAILED', 'Fast-forward plan is missing exact object identities.');
      }
      await this.git.fastForward({
        remote: plan.remote!,
        branch: plan.branch,
        expectedLocalHead: plan.expectedHead,
        expectedRemoteHead: plan.expectedRemoteHead,
      });
      const after = await this.git.snapshot();
      if (after.branch !== plan.branch || after.head !== plan.expectedRemoteHead) {
        throw new GitActionError('POSTCONDITION_FAILED', 'Fast-forward sync did not reach the planned remote revision.', {
          expectedHead: plan.expectedRemoteHead,
          actualHead: after.head,
          actualBranch: after.branch,
        });
      }
      return { status: 'SUCCESS', action: 'sync', plan };
    } finally {
      await lease.release();
    }
  }
}
