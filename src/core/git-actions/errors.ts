export type GitActionErrorCode =
  | 'DETACHED_HEAD'
  | 'REMOTE_MISSING'
  | 'PR_BASE_MISSING'
  | 'READ_ONLY_ADAPTER'
  | 'PROTECTED_BRANCH'
  | 'DIRTY_WORKTREE'
  | 'NOTHING_TO_COMMIT'
  | 'REMOTE_AHEAD'
  | 'DIVERGED'
  | 'UNPUBLISHED_BRANCH'
  | 'REMOTE_HEAD_MISMATCH'
  | 'PR_STATE_INVALID'
  | 'PR_NOT_MERGED'
  | 'PR_HEAD_MISMATCH'
  | 'PR_FINISH_DIRTY_WORKTREE'
  | 'RETURN_BRANCH_MISSING'
  | 'RETURN_BRANCH_REMOTE_MISSING'
  | 'RETURN_BRANCH_DIVERGED'
  | 'RETURN_BRANCH_LOCAL_AHEAD'
  | 'SIDE_EFFECT_CHECKPOINT_INVALID'
  | 'SIDE_EFFECT_RECOVERY_AMBIGUOUS'
  | 'POSTCONDITION_FAILED'
  | 'PROVIDER_ERROR';

export class GitActionError extends Error {
  constructor(
    readonly code: GitActionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'GitActionError';
  }
}

export function redactProviderMessage(message: string): string {
  return message
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:access_)?token|secret|password)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]+\b/g, '[REDACTED]');
}

export function providerFailure(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): GitActionError {
  return new GitActionError('PROVIDER_ERROR', redactProviderMessage(message), details);
}
