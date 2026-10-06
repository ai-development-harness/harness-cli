export type GitOid = string;

export interface GitRepositorySnapshot {
  readonly branch: string | null;
  readonly head: GitOid | null;
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface GitRemoteRelation {
  readonly remote: string;
  readonly branch: string;
  readonly remoteHead: GitOid | null;
  readonly ahead: number;
  readonly behind: number;
  readonly upstream: string | null;
}

export interface GitWorkflowPolicy {
  readonly protectedBranches: readonly string[];
  readonly branchWhenProtected: 'auto-create' | 'stay' | 'block';
  readonly allowCommitOnProtected: boolean;
  readonly allowPushToProtected: boolean;
  readonly pushRemote: string;
  readonly setUpstream: boolean;
  readonly syncMode: 'report' | 'ff-only';
  readonly pullRequestBase: string;
  readonly reuseExistingPullRequest: boolean;
}

export interface GitMutationPlan {
  readonly schemaVersion: 1;
  readonly action: 'commit' | 'push' | 'pull-request' | 'sync';
  readonly branch: string;
  readonly expectedHead: GitOid | null;
  readonly expectedRemoteHead?: GitOid | null;
  readonly remote?: string;
  readonly base?: string;
  readonly createBranch?: string;
  readonly setUpstream?: boolean;
}

export interface PullRequestRecord {
  readonly id: string;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headBranch: string;
  readonly headOid: GitOid;
  readonly baseBranch: string;
  readonly draft: boolean;
  readonly title?: string;
  readonly mergedAt?: string;
}

export interface GitCheckResult {
  readonly branch: string;
  readonly protected: boolean;
  readonly head: GitOid | null;
  readonly worktree: GitRepositorySnapshot;
  readonly relation: GitRemoteRelation;
}

export interface PullRequestFinishPlan {
  readonly schemaVersion: 1;
  readonly action: 'pr-finish';
  readonly pullRequestId: string;
  readonly headBranch: string;
  readonly mergedHeadOid: GitOid;
  readonly returnBranch: string;
  readonly currentBranch: string;
  readonly remote: string;
  readonly resumed: boolean;
  readonly steps: readonly (
    | { readonly operation: 'switch-return-branch'; readonly branch: string }
    | { readonly operation: 'sync-return-branch'; readonly expectedRemoteHead: GitOid }
    | { readonly operation: 'delete-local-pr-branch'; readonly expectedHead: GitOid }
  )[];
  readonly forceDeleteForbidden: true;
}

export interface GitActionPort {
  snapshot(): Promise<GitRepositorySnapshot>;
  relation(remote: string, branch: string): Promise<GitRemoteRelation>;
  localBranch(branch: string): Promise<GitOid | null>;
  createBranch(branch: string, expectedHead: GitOid | null): Promise<void>;
  commit(input: {
    readonly branch: string;
    readonly message: string;
    readonly expectedHead: GitOid | null;
  }): Promise<{ readonly head: GitOid }>;
  compensateCommit(input: {
    readonly branch: string;
    readonly createdHead: GitOid;
    readonly restoreHead: GitOid | null;
  }): Promise<boolean>;
  push(input: {
    readonly remote: string;
    readonly branch: string;
    readonly expectedRemoteHead: GitOid | null;
    readonly expectedLocalHead: GitOid;
    readonly setUpstream: boolean;
  }): Promise<void>;
  fastForward(input: {
    readonly remote: string;
    readonly branch: string;
    readonly expectedLocalHead: GitOid;
    readonly expectedRemoteHead: GitOid;
  }): Promise<void>;
}

export interface PullRequestProviderPort {
  findOpen(input: {
    readonly headBranch: string;
    readonly headOid: GitOid;
    readonly baseBranch: string;
  }): Promise<readonly PullRequestRecord[]>;
  view(selector: string): Promise<PullRequestRecord>;
  create(input: {
    readonly headBranch: string;
    readonly headOid: GitOid;
    readonly baseBranch: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
  }): Promise<void>;
}

export type SideEffectKind = 'git_commit' | 'git_push' | 'provider_pr';
export type SideEffectPhase =
  | 'prepared'
  | 'side_effect_started'
  | 'side_effect_observed'
  | 'postconditions_verified';

export interface SideEffectCheckpoint {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly kind: SideEffectKind;
  readonly phase: SideEffectPhase;
  readonly attempt: number;
  readonly preparedAt: string;
  readonly updatedAt: string;
  readonly proof: Readonly<Record<string, unknown>>;
}

export interface GitActionResult {
  readonly status: 'SUCCESS' | 'NOOP';
  readonly action: GitMutationPlan['action'];
  readonly plan: GitMutationPlan;
  readonly recovered?: boolean;
  readonly pullRequest?: PullRequestRecord;
}
