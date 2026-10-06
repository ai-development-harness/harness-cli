# Thin Harness Update Service

Issue #39 replaces the repository-embedded Harness updater with a thin release-pin update contract.

Reference baseline:

`ai-development-harness/ai-development-harness-template@9f4aa325154253ab72a8c5940e988046ae872c99`

Parity target: `PARITY-UPDATE-010`.

## Decision

The legacy three-way updater is **not** moved into Core.

In the thin architecture:

- Harness executable semantics live in an installed, verified Harness release;
- the project stores only the explicit `harness.release` pin;
- project schema migration is delegated to the existing Migration Engine boundary;
- UPDATE CHECK is read-only;
- UPDATE APPLY performs one controlled project mutation: changing the release pin after all prerequisites are proven.

The service must never repopulate `.harness/tools/**`, copy Core back into the repository, or use `latest` / `main` as an implicit target.

## UPDATE CHECK

`UpdateService.check(target?)`:

1. reads the current project release pin and project schema;
2. resolves the requested target, or the newest **verified installed** release from Release Store;
3. verifies the exact target release tree and digest;
4. checks CLI compatibility;
5. checks Host API compatibility;
6. determines whether the current project schema is directly supported, migratable, or incompatible;
7. returns a deterministic dry-run plan.

When no newer verified installed release exists, CHECK returns `noop`.

An explicit unavailable target returns a blocker. It is never replaced by another release.

## UPDATE APPLY

APPLY is serialized by the shared Git-private `CoreWriteLock`.

The mutation order is:

1. persist `prepared` update checkpoint;
2. if required, invoke the migration coordinator;
3. persist `migration_verified`;
4. re-read project state and verify exact expected release/schema;
5. mutate only `harness.release`;
6. persist `pin_written`;
7. re-read the project and re-verify the exact release digest;
8. persist `verified`.

The release pin is never advanced before a required migration has completed successfully.

## Crash recovery

Clone-local update state is stored under:

`git rev-parse --git-path ai-harness/update/update-status.json`

Phases:

- `prepared`
- `migration_verified`
- `pin_written`
- `verified`

Recovery rules:

- after `migration_verified`, APPLY resumes from the durable migration result and does not re-run migration;
- after `pin_written`, factual project state plus exact release digest prove whether the update completed;
- mismatched project state or release identity fails closed;
- a new update may replace an older checkpoint only after the older checkpoint reached `verified`.

## Project schema migration boundary

UpdateService does not implement project transformations.

It calls an injected `UpdateMigrationCoordinator` with:

- project root;
- current and target releases;
- exact target release digest;
- source project schema;
- target project schema.

The coordinator must return only after the target schema is durably reached. A failed migration leaves the release pin unchanged.

This boundary is intentionally compatible with the existing Migration Engine and avoids creating a second journal/recovery implementation.

## Project config mutation

The default project-state adapter edits only `harness.release` in `harness.yaml` and preserves all unrelated keys.

The write is guarded by an expected-current-pin check. If the pin changes after planning, APPLY fails with `UPDATE_PIN_CHANGED`.

## Source-of-truth rule

After Stage 4 cutover, the legacy repository-embedded updater remains historical compatibility evidence only.

It is not an active implementation and must not be called by thin UPDATE CHECK/APPLY.
