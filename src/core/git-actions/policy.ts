import type { GitWorkflowPolicy } from './types.js';

/**
 * Release-owned safety defaults extracted from the v0.10.4
 * repository-embedded .harness/git-policy.toml baseline.
 *
 * Thin projects must not carry a second mutable copy of common Harness policy.
 */
export const DEFAULT_GIT_WORKFLOW_POLICY: GitWorkflowPolicy = Object.freeze({
  protectedBranches: Object.freeze(['main', 'master']),
  branchWhenProtected: 'auto-create',
  allowCommitOnProtected: false,
  allowPushToProtected: false,
  pushRemote: 'origin',
  setUpstream: true,
  syncMode: 'report',
  pullRequestBase: 'main',
  reuseExistingPullRequest: true,
});
