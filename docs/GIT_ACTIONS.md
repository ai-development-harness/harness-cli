# Git actions and side-effect recovery

Issue #38 extracts Git workflow safety from the Harness v0.10.4 reference into runtime-neutral Core contracts.

Reference baseline:

`ai-development-harness/ai-development-harness-template@9f4aa325154253ab72a8c5940e988046ae872c99`

Parity target: `PARITY-GIT-009`.

## Authority boundary

Core owns:

- factual preflight decisions for commit, push, Pull Request and sync;
- protected-branch policy enforcement;
- exact mutation plans bound to local/remote object identities;
- postcondition verification;
- crash/retry reconciliation;
- Git-private side-effect checkpoints;
- provider-neutral Pull Request identity and reuse rules;
- fail-closed ambiguity handling.

Infrastructure adapters own:

- concrete Git process invocation;
- network transport;
- GitHub/Gitea CLI or API mechanics;
- authentication.

Model output is never completion proof for an external side effect.

## Git-private state

Side-effect checkpoints are stored below:

`git rev-parse --git-path ai-harness`

at:

`git/side-effects.json`

The state is worktree-scoped, bounded, schema-versioned, and rejects proof payloads containing secret-like keys.

Phases are monotonic within an attempt:

1. `prepared`
2. `side_effect_started`
3. `side_effect_observed`
4. `postconditions_verified`

A crash after the external mutation but before local completion is reconciled by observing repository/provider facts before any retry.

## Push recovery

A push checkpoint binds:

- branch;
- remote;
- exact local HEAD expected to be published;
- exact remote HEAD observed before the mutation.

On resume:

- remote == expected local HEAD -> already applied;
- remote == baseline -> safe to retry;
- any other remote identity -> `SIDE_EFFECT_RECOVERY_AMBIGUOUS`.

No implicit force update exists.

## Pull Request recovery

Pull Request completion is proven only by an exact provider observation matching:

- head branch;
- head object ID;
- base branch.

An adapter error after creation can still converge to success if the exact PR is observable. Multiple matching PRs fail closed.

## Commit compensation

Commit postconditions must match the planned branch and the object identity returned by the Git adapter. If they do not, Core requests an exact compensation operation from the adapter rather than performing a destructive reset itself.

## Sync

`ff-only` sync:

- blocks divergence;
- blocks dirty worktrees when a fast-forward is required;
- performs only an exact planned fast-forward;
- verifies the resulting HEAD.

`report` mode remains non-mutating.

## Concurrency

All mutating operations use the shared Git-private `CoreWriteLock`, so Git actions serialize with other Core writers in the same worktree.


## Stage 5 read-only Git check

`harness git check` exposes the Core Git safety/preflight model without crossing a mutation boundary.

The command:

- reads the attached branch, exact HEAD, staged/unstaged/untracked paths and locally known remote-tracking relation;
- reports the release-owned policy inputs used by Core (protected branches, push remote, PR base and sync mode);
- evaluates Core preconditions for commit, push, Pull Request and sync, returning `READY` or typed `BLOCKED` diagnostics;
- reports factual observations such as dirty worktree, unpublished branch, divergence and execution from the configured PR base branch;
- does **not** fetch remotes, create/switch branches, commit, push, merge, create PRs or write side-effect checkpoints.

The infrastructure adapter passed to `GitActionService` is deliberately read-only: all mutation methods fail closed with `READ_ONLY_ADAPTER`. This prevents accidental side effects even if the CLI wrapper is changed incorrectly later.

The release-owned default policy is extracted from the v0.10.4 `.harness/git-policy.toml` baseline. Thin projects therefore do not need to carry a second repository-owned copy of common Git safety policy.
