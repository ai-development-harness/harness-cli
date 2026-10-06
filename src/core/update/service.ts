import { acquireCoreWriteLock } from '../write-lock.js';
import { HOST_API_VERSION } from '../host/contract.js';
import { getPackageVersion } from '../package.js';
import { ReleaseStore } from '../releases/store.js';
import { compareSemver, isSemverInRange } from '../releases/semver.js';
import { UpdateError } from './errors.js';
import { FileUpdateProjectState } from './project-state.js';
import { readUpdateCheckpoint, writeUpdateCheckpoint } from './state.js';
import type {
  UpdateApplyResult,
  UpdateBlocker,
  UpdateMigrationCoordinator,
  UpdatePlan,
  UpdateProjectStatePort,
} from './types.js';

export interface UpdateServiceOptions {
  readonly projectRoot: string;
  readonly releaseStore?: ReleaseStore;
  readonly projectState?: UpdateProjectStatePort;
  readonly migration?: UpdateMigrationCoordinator;
  readonly cliVersion?: string;
  readonly hostApiVersion?: number;
}

export class UpdateService {
  private readonly projectRoot: string;
  private readonly releaseStore: ReleaseStore;
  private readonly projectState: UpdateProjectStatePort;
  private readonly migration?: UpdateMigrationCoordinator;
  private readonly cliVersion: string;
  private readonly hostApiVersion: number;

  constructor(options: UpdateServiceOptions) {
    this.projectRoot = options.projectRoot;
    this.releaseStore = options.releaseStore ?? new ReleaseStore();
    this.projectState = options.projectState ?? new FileUpdateProjectState();
    this.migration = options.migration;
    this.cliVersion = options.cliVersion ?? getPackageVersion();
    this.hostApiVersion = options.hostApiVersion ?? HOST_API_VERSION;
  }

  private async chooseTarget(
    currentRelease: string,
    requestedTarget?: string,
  ): Promise<string | null> {
    if (requestedTarget) return requestedTarget;

    const candidates = (await this.releaseStore.list())
      .filter((entry) => entry.status === 'valid' && compareSemver(entry.release, currentRelease) > 0)
      .map((entry) => entry.release)
      .sort(compareSemver);

    return candidates.at(-1) ?? null;
  }

  async check(requestedTarget?: string): Promise<UpdatePlan> {
    const current = await this.projectState.read(this.projectRoot);
    const targetRelease = await this.chooseTarget(current.release, requestedTarget);

    if (targetRelease === null || targetRelease === current.release) {
      return {
        schemaVersion: 1,
        status: 'noop',
        currentRelease: current.release,
        targetRelease: current.release,
        targetDigest: null,
        projectSchemaVersion: current.schemaVersion,
        targetProjectSchemaVersion: current.schemaVersion,
        migrationRequired: false,
        blockers: [],
        mutationPlan: {
          updateReleasePin: false,
          createEmbeddedTools: false,
          genericThreeWayUpdate: false,
        },
      };
    }

    if (compareSemver(targetRelease, current.release) < 0) {
      return {
        schemaVersion: 1,
        status: 'blocked',
        currentRelease: current.release,
        targetRelease,
        targetDigest: null,
        projectSchemaVersion: current.schemaVersion,
        targetProjectSchemaVersion: null,
        migrationRequired: false,
        blockers: [{
          code: 'UPDATE_TARGET_NOT_NEWER',
          message: 'Harness update target must not be older than the current project pin.',
          details: { currentRelease: current.release, targetRelease },
        }],
        mutationPlan: {
          updateReleasePin: false,
          createEmbeddedTools: false,
          genericThreeWayUpdate: false,
        },
      };
    }

    let installed;
    try {
      installed = await this.releaseStore.verify(targetRelease);
    } catch (error) {
      return {
        schemaVersion: 1,
        status: 'blocked',
        currentRelease: current.release,
        targetRelease,
        targetDigest: null,
        projectSchemaVersion: current.schemaVersion,
        targetProjectSchemaVersion: null,
        migrationRequired: false,
        blockers: [{
          code: 'UPDATE_TARGET_UNAVAILABLE',
          message: `Harness release ${targetRelease} is not available as a verified installed release.`,
          details: { cause: (error as Error).message },
        }],
        mutationPlan: {
          updateReleasePin: false,
          createEmbeddedTools: false,
          genericThreeWayUpdate: false,
        },
      };
    }

    const compatibility = installed.manifest.compatibility;
    const blockers: UpdateBlocker[] = [];

    if (!isSemverInRange(
      this.cliVersion,
      compatibility.cli.minVersion,
      compatibility.cli.maxVersionExclusive,
    )) {
      blockers.push({
        code: 'UPDATE_INCOMPATIBLE_CLI',
        message: `Harness release ${targetRelease} is incompatible with CLI ${this.cliVersion}.`,
        details: {
          cliVersion: this.cliVersion,
          minVersion: compatibility.cli.minVersion,
          maxVersionExclusive: compatibility.cli.maxVersionExclusive,
        },
      });
    }

    if (
      this.hostApiVersion < compatibility.hostApi.minVersion ||
      this.hostApiVersion > compatibility.hostApi.maxVersion
    ) {
      blockers.push({
        code: 'UPDATE_INCOMPATIBLE_HOST_API',
        message: `Harness release ${targetRelease} is incompatible with Host API ${this.hostApiVersion}.`,
        details: {
          hostApiVersion: this.hostApiVersion,
          minVersion: compatibility.hostApi.minVersion,
          maxVersion: compatibility.hostApi.maxVersion,
        },
      });
    }

    const schema = compatibility.projectSchema;
    const migrationRequired =
      !schema.supported.includes(current.schemaVersion) &&
      schema.migrateFrom.includes(current.schemaVersion);

    if (!schema.supported.includes(current.schemaVersion) && !migrationRequired) {
      blockers.push({
        code: 'UPDATE_INCOMPATIBLE_PROJECT_SCHEMA',
        message: `Harness release ${targetRelease} does not support project schema ${current.schemaVersion}.`,
        details: {
          projectSchemaVersion: current.schemaVersion,
          supported: schema.supported,
          migrateFrom: schema.migrateFrom,
        },
      });
    }

    return {
      schemaVersion: 1,
      status: blockers.length > 0 ? 'blocked' : 'ready',
      currentRelease: current.release,
      targetRelease,
      targetDigest: installed.digest,
      projectSchemaVersion: current.schemaVersion,
      targetProjectSchemaVersion: migrationRequired ? schema.target : current.schemaVersion,
      migrationRequired,
      blockers,
      mutationPlan: {
        updateReleasePin: blockers.length === 0,
        createEmbeddedTools: false,
        genericThreeWayUpdate: false,
      },
    };
  }

  async apply(requestedTarget?: string): Promise<UpdateApplyResult> {
    const initialState = await this.projectState.read(this.projectRoot);
    const checkpointBeforeLock = await readUpdateCheckpoint(this.projectRoot);

    const recoverable =
      checkpointBeforeLock !== null &&
      checkpointBeforeLock.phase !== 'verified' &&
      (requestedTarget === undefined || requestedTarget === checkpointBeforeLock.targetRelease);

    const chosenTarget = recoverable
      ? checkpointBeforeLock.targetRelease
      : requestedTarget ?? await this.chooseTarget(initialState.release);

    if (chosenTarget === null) {
      const current = await this.releaseStore.verify(initialState.release);
      return {
        status: 'NOOP',
        currentRelease: initialState.release,
        targetRelease: initialState.release,
        targetDigest: current.digest,
        migrated: false,
        recovered: false,
      };
    }

    const operationId = recoverable
      ? checkpointBeforeLock.operationId
      : `update:${initialState.release}->${chosenTarget}`;

    const lease = await acquireCoreWriteLock(
      this.projectRoot,
      'harness-update',
      operationId,
      {
        currentRelease: recoverable ? checkpointBeforeLock.currentRelease : initialState.release,
        targetRelease: chosenTarget,
      },
    );

    try {
      const existing = await readUpdateCheckpoint(this.projectRoot);

      // Crash recovery after the pin write: factual project state is authority.
      if (
        existing &&
        existing.operationId === operationId &&
        (existing.phase === 'pin_written' || existing.phase === 'verified')
      ) {
        const current = await this.projectState.read(this.projectRoot);
        if (
          current.release !== existing.targetRelease ||
          current.schemaVersion !== existing.projectSchemaAfter
        ) {
          throw new UpdateError(
            'UPDATE_POSTCONDITION_FAILED',
            'Update checkpoint says the release pin was written, but project state does not match it.',
            { checkpoint: existing, current },
          );
        }
        const verified = await this.releaseStore.verify(existing.targetRelease);
        if (verified.digest !== existing.targetDigest) {
          throw new UpdateError(
            'UPDATE_POSTCONDITION_FAILED',
            'Verified target release identity changed after update.',
            {
              expectedDigest: existing.targetDigest,
              actualDigest: verified.digest,
              targetRelease: existing.targetRelease,
            },
          );
        }
        if (existing.phase !== 'verified') {
          await writeUpdateCheckpoint(this.projectRoot, {
            operationId,
            phase: 'verified',
            currentRelease: existing.currentRelease,
            targetRelease: existing.targetRelease,
            targetDigest: existing.targetDigest,
            projectSchemaBefore: existing.projectSchemaBefore,
            projectSchemaAfter: existing.projectSchemaAfter,
            migrationRequired: existing.migrationRequired,
          });
        }
        return {
          status: 'SUCCESS',
          currentRelease: existing.currentRelease,
          targetRelease: existing.targetRelease,
          targetDigest: existing.targetDigest,
          migrated: existing.migrationRequired,
          recovered: existing.phase !== 'verified',
        };
      }

      if (!recoverable && chosenTarget === initialState.release) {
        const current = await this.releaseStore.verify(initialState.release);
        return {
          status: 'NOOP',
          currentRelease: initialState.release,
          targetRelease: initialState.release,
          targetDigest: current.digest,
          migrated: false,
          recovered: false,
        };
      }

      const previousPrepared =
        existing &&
        existing.operationId === operationId &&
        (existing.phase === 'prepared' || existing.phase === 'migration_verified')
          ? existing
          : null;

      let plan: UpdatePlan;
      if (previousPrepared?.phase === 'migration_verified') {
        const current = await this.projectState.read(this.projectRoot);
        if (
          current.release !== previousPrepared.currentRelease ||
          current.schemaVersion !== previousPrepared.projectSchemaAfter
        ) {
          throw new UpdateError(
            'UPDATE_POSTCONDITION_FAILED',
            'Migrated project state no longer matches the durable update checkpoint.',
            { checkpoint: previousPrepared, current },
          );
        }
        const verifiedTarget = await this.releaseStore.verify(previousPrepared.targetRelease);
        if (verifiedTarget.digest !== previousPrepared.targetDigest) {
          throw new UpdateError(
            'UPDATE_POSTCONDITION_FAILED',
            'Target release identity changed after migration verification.',
            {
              expectedDigest: previousPrepared.targetDigest,
              actualDigest: verifiedTarget.digest,
              targetRelease: previousPrepared.targetRelease,
            },
          );
        }
        if (!verifiedTarget.manifest.compatibility.projectSchema.supported.includes(current.schemaVersion)) {
          throw new UpdateError(
            'UPDATE_POSTCONDITION_FAILED',
            'Target release does not support the migrated project schema recorded by the checkpoint.',
            {
              targetRelease: previousPrepared.targetRelease,
              projectSchemaVersion: current.schemaVersion,
            },
          );
        }
        plan = {
          schemaVersion: 1,
          status: 'ready',
          currentRelease: previousPrepared.currentRelease,
          targetRelease: previousPrepared.targetRelease,
          targetDigest: previousPrepared.targetDigest,
          projectSchemaVersion: previousPrepared.projectSchemaBefore,
          targetProjectSchemaVersion: previousPrepared.projectSchemaAfter,
          migrationRequired: previousPrepared.migrationRequired,
          blockers: [],
          mutationPlan: {
            updateReleasePin: true,
            createEmbeddedTools: false,
            genericThreeWayUpdate: false,
          },
        };
      } else {
        plan = await this.check(chosenTarget);
        if (plan.status !== 'ready' || !plan.targetDigest || plan.targetProjectSchemaVersion === null) {
          throw new UpdateError(
            'UPDATE_BLOCKED',
            'Harness update is blocked by deterministic compatibility checks.',
            { blockers: plan.blockers, plan },
          );
        }
      }

      if (!previousPrepared) {
        await writeUpdateCheckpoint(this.projectRoot, {
          operationId,
          phase: 'prepared',
          currentRelease: plan.currentRelease,
          targetRelease: plan.targetRelease,
          targetDigest: plan.targetDigest,
          projectSchemaBefore: plan.projectSchemaVersion,
          projectSchemaAfter: plan.projectSchemaVersion,
          migrationRequired: plan.migrationRequired,
        });
      }

      let schemaAfter =
        previousPrepared?.phase === 'migration_verified'
          ? previousPrepared.projectSchemaAfter
          : plan.projectSchemaVersion;

      if (plan.migrationRequired && previousPrepared?.phase !== 'migration_verified') {
        if (!this.migration) {
          throw new UpdateError(
            'UPDATE_MIGRATION_FAILED',
            'Target release requires a project-schema migration, but no migration coordinator is configured.',
            {
              fromProjectSchemaVersion: plan.projectSchemaVersion,
              toProjectSchemaVersion: plan.targetProjectSchemaVersion,
              targetRelease: plan.targetRelease,
            },
          );
        }

        let migrationResult;
        try {
          migrationResult = await this.migration.migrate({
            projectRoot: this.projectRoot,
            currentRelease: plan.currentRelease,
            targetRelease: plan.targetRelease,
            targetReleaseDigest: plan.targetDigest,
            fromProjectSchemaVersion: plan.projectSchemaVersion,
            toProjectSchemaVersion: plan.targetProjectSchemaVersion,
          });
        } catch (error) {
          throw new UpdateError(
            'UPDATE_MIGRATION_FAILED',
            'Project-schema migration failed; Harness release pin remains unchanged.',
            { cause: (error as Error).message, targetRelease: plan.targetRelease },
          );
        }

        schemaAfter = migrationResult.projectSchemaVersion;
        if (schemaAfter !== plan.targetProjectSchemaVersion) {
          throw new UpdateError(
            'UPDATE_MIGRATION_FAILED',
            'Migration coordinator did not reach the target project schema.',
            {
              expectedProjectSchemaVersion: plan.targetProjectSchemaVersion,
              actualProjectSchemaVersion: schemaAfter,
            },
          );
        }
      }

      if (previousPrepared?.phase !== 'migration_verified') {
        await writeUpdateCheckpoint(this.projectRoot, {
          operationId,
          phase: 'migration_verified',
          currentRelease: plan.currentRelease,
          targetRelease: plan.targetRelease,
          targetDigest: plan.targetDigest,
          projectSchemaBefore: plan.projectSchemaVersion,
          projectSchemaAfter: schemaAfter,
          migrationRequired: plan.migrationRequired,
        });
      }

      const beforePin = await this.projectState.read(this.projectRoot);
      if (
        beforePin.release !== plan.currentRelease ||
        beforePin.schemaVersion !== schemaAfter
      ) {
        throw new UpdateError(
          'UPDATE_PIN_CHANGED',
          'Project state changed after update planning or migration.',
          { expectedRelease: plan.currentRelease, expectedSchemaVersion: schemaAfter, actual: beforePin },
        );
      }

      await this.projectState.writeReleasePin(
        this.projectRoot,
        plan.currentRelease,
        plan.targetRelease,
      );

      await writeUpdateCheckpoint(this.projectRoot, {
        operationId,
        phase: 'pin_written',
        currentRelease: plan.currentRelease,
        targetRelease: plan.targetRelease,
        targetDigest: plan.targetDigest,
        projectSchemaBefore: plan.projectSchemaVersion,
        projectSchemaAfter: schemaAfter,
        migrationRequired: plan.migrationRequired,
      });

      const afterState = await this.projectState.read(this.projectRoot);
      if (afterState.release !== plan.targetRelease || afterState.schemaVersion !== schemaAfter) {
        throw new UpdateError(
          'UPDATE_POSTCONDITION_FAILED',
          'Harness release pin mutation did not reach the planned project state.',
          { expectedRelease: plan.targetRelease, expectedSchemaVersion: schemaAfter, actual: afterState },
        );
      }

      const verified = await this.releaseStore.verify(plan.targetRelease);
      if (verified.digest !== plan.targetDigest) {
        throw new UpdateError(
          'UPDATE_POSTCONDITION_FAILED',
          'Target release identity changed after release pin mutation.',
          { expectedDigest: plan.targetDigest, actualDigest: verified.digest },
        );
      }

      await writeUpdateCheckpoint(this.projectRoot, {
        operationId,
        phase: 'verified',
        currentRelease: plan.currentRelease,
        targetRelease: plan.targetRelease,
        targetDigest: plan.targetDigest,
        projectSchemaBefore: plan.projectSchemaVersion,
        projectSchemaAfter: schemaAfter,
        migrationRequired: plan.migrationRequired,
      });

      return {
        status: 'SUCCESS',
        currentRelease: plan.currentRelease,
        targetRelease: plan.targetRelease,
        targetDigest: plan.targetDigest,
        migrated: plan.migrationRequired,
        recovered: false,
      };
    } finally {
      await lease.release();
    }
  }
}
