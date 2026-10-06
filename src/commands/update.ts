import { findGitRoot } from '../core/git.js';
import { isReleaseError } from '../core/releases/errors.js';
import { parseSemver } from '../core/releases/semver.js';
import {
  UpdateError,
  UpdateService,
  type UpdateApplyResult,
  type UpdatePlan,
} from '../core/update/index.js';
import {
  CliPresentationError,
  jsonFailure,
  jsonSuccess,
  setCliExitCode,
  writeJson,
  type CliFailureKind,
} from './presentation.js';

export interface UpdateCommandOptions {
  readonly json?: boolean;
  readonly targetRelease?: string;
}

export interface UpdateServicePort {
  check(requestedTarget?: string): Promise<UpdatePlan>;
  apply(requestedTarget?: string): Promise<UpdateApplyResult>;
}

export type UpdateServiceFactory = (projectRoot: string) => UpdateServicePort;

const defaultUpdateServiceFactory: UpdateServiceFactory = (projectRoot) =>
  new UpdateService({ projectRoot });

function validateTargetRelease(targetRelease: string | undefined): void {
  if (targetRelease === undefined) return;

  try {
    parseSemver(targetRelease);
  } catch {
    throw new CliPresentationError(
      'UPDATE_TARGET_INVALID',
      'input',
      `Unsupported Harness release version: ${targetRelease}. Expected X.Y.Z.`,
      { targetRelease },
    );
  }
}

async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    return await findGitRoot(cwd);
  } catch (error) {
    throw new CliPresentationError(
      'PROJECT_NOT_GIT_REPOSITORY',
      'environment',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeUpdateError(error: unknown): CliPresentationError {
  if (error instanceof CliPresentationError) return error;

  if (error instanceof UpdateError) {
    const category: CliFailureKind =
      error.code === 'UPDATE_BLOCKED'
        ? 'blocked'
        : error.code === 'UPDATE_PROJECT_CONFIG_INVALID'
          ? 'input'
          : 'failure';

    return new CliPresentationError(
      error.code,
      category,
      error.message,
      error.details,
    );
  }

  if (isReleaseError(error)) {
    return new CliPresentationError(
      error.code,
      'failure',
      error.message,
      error.details,
    );
  }

  return new CliPresentationError(
    'UPDATE_FAILED',
    'internal',
    error instanceof Error ? error.message : String(error),
  );
}

function renderBlockers(plan: UpdatePlan): string[] {
  if (plan.blockers.length === 0) return [];

  return [
    'Blockers:',
    ...plan.blockers.map((blocker) => `- ${blocker.code}: ${blocker.message}`),
  ];
}

export function renderUpdatePlanHuman(plan: UpdatePlan): string {
  return [
    `Status: ${plan.status}`,
    `Current release: ${plan.currentRelease}`,
    `Target release: ${plan.targetRelease}`,
    `Target digest: ${plan.targetDigest ?? '-'}`,
    `Project schema: ${plan.projectSchemaVersion} -> ${plan.targetProjectSchemaVersion ?? '-'}`,
    `Migration required: ${plan.migrationRequired ? 'yes' : 'no'}`,
    `Update release pin: ${plan.mutationPlan.updateReleasePin ? 'yes' : 'no'}`,
    ...renderBlockers(plan),
  ].join('\n');
}

export function renderUpdateApplyHuman(result: UpdateApplyResult): string {
  return [
    `Status: ${result.status}`,
    `Current release: ${result.currentRelease}`,
    `Target release: ${result.targetRelease}`,
    `Target digest: ${result.targetDigest}`,
    `Migrated: ${result.migrated ? 'yes' : 'no'}`,
    `Recovered: ${result.recovered ? 'yes' : 'no'}`,
  ].join('\n');
}

function renderCommandError(error: CliPresentationError, json: boolean): void {
  if (json) {
    writeJson(jsonFailure(error.category, error));
  } else {
    console.error(`${error.code}: ${error.message}`);
  }
  setCliExitCode(error.category);
}

export async function updateCheckCommand(
  cwd: string,
  options: UpdateCommandOptions = {},
  createService: UpdateServiceFactory = defaultUpdateServiceFactory,
): Promise<void> {
  try {
    validateTargetRelease(options.targetRelease);
    const projectRoot = await resolveProjectRoot(cwd);
    const plan = await createService(projectRoot).check(options.targetRelease);

    if (plan.status === 'blocked') {
      const error = new CliPresentationError(
        'UPDATE_BLOCKED',
        'blocked',
        'Harness update is blocked by deterministic compatibility checks.',
        { blockers: plan.blockers },
      );

      if (options.json) {
        writeJson(jsonFailure('blocked', error, { fields: { ...plan } }));
      } else {
        console.log(renderUpdatePlanHuman(plan));
      }
      setCliExitCode('blocked');
      return;
    }

    if (options.json) {
      writeJson(jsonSuccess(plan));
      return;
    }

    console.log(renderUpdatePlanHuman(plan));
  } catch (error) {
    renderCommandError(normalizeUpdateError(error), options.json ?? false);
  }
}

export async function updateApplyCommand(
  cwd: string,
  options: UpdateCommandOptions = {},
  createService: UpdateServiceFactory = defaultUpdateServiceFactory,
): Promise<void> {
  try {
    validateTargetRelease(options.targetRelease);
    const projectRoot = await resolveProjectRoot(cwd);
    const result = await createService(projectRoot).apply(options.targetRelease);

    if (options.json) {
      writeJson(jsonSuccess(result));
      return;
    }

    console.log(renderUpdateApplyHuman(result));
  } catch (error) {
    renderCommandError(normalizeUpdateError(error), options.json ?? false);
  }
}
