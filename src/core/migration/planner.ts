import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import { isReleaseError } from '../releases/errors.js';
import { resolvePinnedRelease } from '../releases/resolver.js';
import { ReleaseStore } from '../releases/store.js';
import { inspectProject } from './legacy/inspector.js';
import type { LegacyFileOwnership, ProjectInspectionResult } from './types.js';
import type {
  MigrationPlan,
  MigrationPlanBlockerCode,
  MigrationPlanMessage,
  MigrationPlanOperation,
  MigrationPlannerOptions,
  MigrationVerificationStep,
} from './plan-types.js';

export interface MigrationPlannerDependencies {
  releaseStore?: ReleaseStore;
}

interface LegacyExecutionStateInspection {
  exists: boolean;
  sha256: string | null;
  active: boolean;
  unknown: boolean;
  details?: Readonly<Record<string, unknown>>;
}

const PHASE_ORDER: Readonly<Record<MigrationPlanOperation['phase'], number>> = {
  prepare: 0,
  'local-state': 1,
  'project-contract': 2,
  bootstrap: 3,
  preserve: 4,
  cleanup: 5,
  finalize: 6,
};

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function blocker(
  code: MigrationPlanBlockerCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  paths?: readonly string[],
): MigrationPlanMessage {
  return { code, message, ...(paths ? { paths } : {}), ...(details ? { details } : {}) };
}

function dedupeMessages(messages: readonly MigrationPlanMessage[]): MigrationPlanMessage[] {
  const seen = new Set<string>();
  const result: MigrationPlanMessage[] = [];
  for (const message of messages) {
    const key = JSON.stringify([message.code, message.message, message.paths ?? [], message.details ?? {}]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
}

function mapInspectionBlockers(inspection: ProjectInspectionResult): MigrationPlanMessage[] {
  const result: MigrationPlanMessage[] = [];

  if (inspection.state === 'migration-in-progress') {
    result.push(blocker('MIGRATION_IN_PROGRESS', 'A migration checkpoint already exists for this clone/worktree.'));
  } else if (inspection.state !== 'legacy-harness-supported') {
    if (inspection.state === 'legacy-harness-baseline-required') {
      // Specific baseline diagnostics below are more useful than a generic state error.
    } else if (inspection.state === 'legacy-harness-unsupported') {
      // Specific unsupported/invalid legacy diagnostics below are more useful.
    } else {
      result.push(
        blocker('NOT_LEGACY_PROJECT', `Project state ${inspection.state} cannot be planned as a legacy migration.`),
      );
    }
  }

  for (const diagnostic of inspection.diagnostics) {
    if (diagnostic.severity !== 'blocker') continue;
    switch (diagnostic.code) {
      case 'BASELINE_REQUIRED':
      case 'BASELINE_MISMATCH':
      case 'UNSUPPORTED_LEGACY_RELEASE':
      case 'INVALID_LEGACY_MANIFEST':
      case 'INVALID_LEGACY_LOCK':
      case 'LEGACY_AND_THIN_STATE':
      case 'BASELINE_FILE_UNVERIFIED':
      case 'HARNESS_OWNED_MODIFIED':
        result.push({
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.paths ? { paths: diagnostic.paths } : {}),
          ...(diagnostic.details ? { details: diagnostic.details } : {}),
        });
        break;
      default:
        result.push(blocker('NOT_LEGACY_PROJECT', diagnostic.message, diagnostic.details, diagnostic.paths));
        break;
    }
  }

  if (inspection.relevantUntrackedCollisions.length > 0) {
    result.push(
      blocker(
        'UNTRACKED_COLLISION',
        'Untracked files intersect the migration surface.',
        undefined,
        inspection.relevantUntrackedCollisions,
      ),
    );
  }

  return result;
}

function mapInspectionWarnings(inspection: ProjectInspectionResult): MigrationPlanMessage[] {
  return inspection.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning' && diagnostic.code !== 'UNTRACKED_MANAGED_PATH')
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.paths ? { paths: diagnostic.paths } : {}),
      ...(diagnostic.details ? { details: diagnostic.details } : {}),
    }));
}

async function inspectLegacyExecutionState(projectRoot: string): Promise<LegacyExecutionStateInspection> {
  const target = path.join(projectRoot, '.harness', 'local', 'execution', 'execution-status.json');
  if (!(await exists(target))) {
    return { exists: false, sha256: null, active: false, unknown: false };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (error) {
    return {
      exists: true,
      sha256: null,
      active: false,
      unknown: true,
      details: { cause: (error as Error).message },
    };
  }

  const digest = sha256(bytes);
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null) {
      return { exists: true, sha256: digest, active: false, unknown: true };
    }
    const record = value as Record<string, unknown>;
    if ((record.schemaVersion !== 1 && record.schemaVersion !== 2) || !Array.isArray(record.executions)) {
      return {
        exists: true,
        sha256: digest,
        active: false,
        unknown: true,
        details: { schemaVersion: record.schemaVersion ?? null },
      };
    }
    return {
      exists: true,
      sha256: digest,
      active: record.executions.length > 0,
      unknown: false,
      details: { schemaVersion: record.schemaVersion, executionCount: record.executions.length },
    };
  } catch (error) {
    return {
      exists: true,
      sha256: digest,
      active: false,
      unknown: true,
      details: { cause: (error as Error).message },
    };
  }
}

function trackedPrecondition(entry: LegacyFileOwnership): MigrationPlanOperation['precondition'] {
  if (entry.actualBlobSha1) {
    return { kind: 'git-blob-sha1', value: entry.actualBlobSha1 };
  }
  if (entry.dirty) {
    return { kind: 'absent' };
  }
  return { kind: 'none' };
}

function sharedOperation(entry: LegacyFileOwnership): MigrationPlanOperation {
  if (entry.path === '.harness/manifest.yaml') {
    return {
      id: '',
      phase: 'project-contract',
      kind: 'TRANSFORM',
      path: entry.path,
      targetPath: 'harness.yaml',
      mutates: true,
      classification: entry.classification,
      precondition: trackedPrecondition(entry),
      baselineBlobSha1: entry.expectedBlobSha1,
      strategy: 'legacy-manifest-to-thin-config',
      targetDescriptor: { retireSourceAfterVerification: true },
      reason: 'Create the thin project contract from legacy project-owned settings.',
    };
  }

  if (entry.path === 'AGENTS.md') {
    return {
      id: '',
      phase: 'bootstrap',
      kind: 'REPLACE_GENERATED_BLOCK',
      path: entry.path,
      mutates: true,
      classification: entry.classification,
      precondition: trackedPrecondition(entry),
      baselineBlobSha1: entry.expectedBlobSha1,
      strategy: 'thin-agents-bootstrap-preserve-project-blocks',
      reason: 'Replace only Harness-owned bootstrap sections while preserving project instructions.',
    };
  }

  if (entry.path === 'CLAUDE.md') {
    return {
      id: '',
      phase: 'bootstrap',
      kind: 'REPLACE_GENERATED_BLOCK',
      path: entry.path,
      mutates: true,
      classification: entry.classification,
      precondition: trackedPrecondition(entry),
      baselineBlobSha1: entry.expectedBlobSha1,
      strategy: 'thin-claude-adapter-preserve-project-content',
      reason: 'Convert the Claude bootstrap without replacing project-specific content.',
    };
  }

  return {
    id: '',
    phase: 'preserve',
    kind: 'PRESERVE',
    path: entry.path,
    mutates: false,
    classification: entry.classification,
    precondition: trackedPrecondition(entry),
    baselineBlobSha1: entry.expectedBlobSha1,
    strategy: 'preserve-shared-customization',
    reason: 'Shared/customized path is preserved until a path-specific safe transformation exists.',
  };
}

function ownershipOperation(entry: LegacyFileOwnership): MigrationPlanOperation {
  switch (entry.classification) {
    case 'harness-owned-clean':
      return {
        id: '',
        phase: 'cleanup',
        kind: 'DELETE_HARNESS_OWNED_CLEAN',
        path: entry.path,
        mutates: true,
        classification: entry.classification,
        precondition: trackedPrecondition(entry),
        baselineBlobSha1: entry.expectedBlobSha1,
        strategy: 'retire-proven-legacy-core',
        reason: 'The file is proven byte-identical to the immutable legacy Harness baseline.',
      };
    case 'harness-owned-modified':
      return {
        id: '',
        phase: 'prepare',
        kind: 'BLOCK_CONFLICT',
        path: entry.path,
        mutates: false,
        classification: entry.classification,
        precondition: trackedPrecondition(entry),
        baselineBlobSha1: entry.expectedBlobSha1,
        strategy: 'manual-resolution-required',
        reason: 'Harness-owned path differs from its proven historical baseline.',
      };
    case 'shared-customized':
      return sharedOperation(entry);
    case 'project-owned':
      return {
        id: '',
        phase: 'preserve',
        kind: 'PRESERVE',
        path: entry.path,
        mutates: false,
        classification: entry.classification,
        precondition: trackedPrecondition(entry),
        baselineBlobSha1: null,
        strategy: 'preserve-project-owned',
        reason: 'Project-owned data remains canonical in the repository.',
      };
    case 'unknown':
      return {
        id: '',
        phase: 'preserve',
        kind: 'PRESERVE',
        path: entry.path,
        mutates: false,
        classification: entry.classification,
        precondition: trackedPrecondition(entry),
        baselineBlobSha1: null,
        strategy: 'preserve-unknown',
        reason: 'Unknown paths are preserved by default.',
      };
  }
}

function sortAndNumberOperations(operations: MigrationPlanOperation[]): MigrationPlanOperation[] {
  return [...operations]
    .sort((left, right) => {
      const phase = PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase];
      if (phase !== 0) return phase;
      const pathOrder = left.path.localeCompare(right.path);
      if (pathOrder !== 0) return pathOrder;
      return left.kind.localeCompare(right.kind);
    })
    .map((operation, index) => ({ ...operation, id: `op-${String(index + 1).padStart(4, '0')}` }));
}

function verificationSteps(): MigrationVerificationStep[] {
  return [
    { id: 'verify-target-config', description: 'Validate target harness.yaml against the target project schema.', required: true },
    { id: 'verify-release', description: 'Resolve and integrity-check the target Harness release.', required: true },
    { id: 'verify-path-boundaries', description: 'Verify all configured project paths remain inside the repository.', required: true },
    { id: 'verify-project-artifacts', description: 'Verify the project-owned artifact inventory was preserved.', required: true },
    { id: 'verify-operation-postconditions', description: 'Verify every applied operation postcondition.', required: true },
    { id: 'verify-local-state', description: 'Validate migrated clone-local operational state.', required: true },
    { id: 'verify-doctor', description: 'Run Harness doctor with no blocking diagnostics.', required: true },
  ];
}

function planSeed(
  inspection: ProjectInspectionResult,
  targetRelease: string | null,
  targetProjectSchemaVersion: number,
  releaseDigest: string | null,
  operations: readonly MigrationPlanOperation[],
  executionState: LegacyExecutionStateInspection,
): string {
  return JSON.stringify({
    projectRoot: inspection.projectRoot,
    headSha: inspection.headSha,
    inspectionState: inspection.state,
    legacyRelease: inspection.legacy?.release ?? null,
    baseline: inspection.baseline,
    ownership: inspection.ownership.map((entry) => ({
      path: entry.path,
      classification: entry.classification,
      expectedBlobSha1: entry.expectedBlobSha1,
      actualBlobSha1: entry.actualBlobSha1,
      dirty: entry.dirty,
    })),
    relevantUntrackedCollisions: inspection.relevantUntrackedCollisions,
    targetRelease,
    targetProjectSchemaVersion,
    releaseDigest,
    executionState: {
      exists: executionState.exists,
      sha256: executionState.sha256,
      active: executionState.active,
      unknown: executionState.unknown,
    },
    operations: operations.map((operation) => ({
      phase: operation.phase,
      kind: operation.kind,
      path: operation.path,
      targetPath: operation.targetPath ?? null,
      mutates: operation.mutates,
      precondition: operation.precondition,
      strategy: operation.strategy,
      targetDescriptor: operation.targetDescriptor ?? null,
    })),
  });
}

function addDirtyMutationBlockers(
  operations: readonly MigrationPlanOperation[],
  inspection: ProjectInspectionResult,
  blockers: MigrationPlanMessage[],
): void {
  const byPath = new Map(inspection.ownership.map((entry) => [entry.path, entry]));
  const dirtyMutations = operations
    .filter((operation) => operation.mutates && byPath.get(operation.path)?.dirty)
    .map((operation) => operation.path);
  if (dirtyMutations.length > 0) {
    blockers.push(
      blocker(
        'DIRTY_PATH_CONFLICT',
        'Paths that the migration would mutate have uncommitted changes.',
        undefined,
        [...new Set(dirtyMutations)].sort(),
      ),
    );
  }
}

async function resolveTarget(
  store: ReleaseStore,
  release: string,
  projectSchemaVersion: number,
): Promise<{ digest: string | null; blocker: MigrationPlanMessage | null }> {
  try {
    const resolved = await resolvePinnedRelease(store, release, projectSchemaVersion);
    return { digest: resolved.digest, blocker: null };
  } catch (error) {
    if (!isReleaseError(error)) throw error;
    if (error.code === 'RELEASE_MISSING' || error.code === 'RELEASE_CORRUPT' || error.code === 'RELEASE_IDENTITY_CONFLICT') {
      return {
        digest: null,
        blocker: blocker('TARGET_RELEASE_UNAVAILABLE', error.message, { releaseErrorCode: error.code, ...error.details }),
      };
    }
    if (error.code === 'RELEASE_INCOMPATIBLE_PROJECT_SCHEMA' || error.code === 'PROJECT_SCHEMA_MIGRATION_REQUIRED') {
      return {
        digest: null,
        blocker: blocker('PROJECT_SCHEMA_CONFLICT', error.message, { releaseErrorCode: error.code, ...error.details }),
      };
    }
    return {
      digest: null,
      blocker: blocker('TARGET_INCOMPATIBLE', error.message, { releaseErrorCode: error.code, ...error.details }),
    };
  }
}

export async function planMigration(
  cwd: string,
  options: MigrationPlannerOptions = {},
  dependencies: MigrationPlannerDependencies = {},
): Promise<MigrationPlan> {
  const inspection = await inspectProject(cwd, { fromRelease: options.fromRelease });
  const blockers = mapInspectionBlockers(inspection);
  const warnings = mapInspectionWarnings(inspection);
  const targetProjectSchemaVersion = options.targetProjectSchemaVersion ?? DEFAULT_CONFIG.schemaVersion;
  const targetRelease = options.targetRelease ?? inspection.baseline?.release ?? inspection.legacy?.release ?? null;
  const executionState = inspection.projectRoot
    ? await inspectLegacyExecutionState(inspection.projectRoot)
    : { exists: false, sha256: null, active: false, unknown: false };

  if (executionState.unknown) {
    blockers.push(blocker('UNKNOWN_ACTIVE_STATE', 'Legacy execution state cannot be interpreted safely.', executionState.details));
  } else if (executionState.active) {
    blockers.push(blocker('ACTIVE_EXECUTION', 'Legacy Harness has active/recoverable executions.', executionState.details));
  }

  let releaseDigest: string | null = null;
  if (targetRelease !== null && inspection.projectRoot !== null && inspection.baseline !== null) {
    const target = await resolveTarget(dependencies.releaseStore ?? new ReleaseStore(), targetRelease, targetProjectSchemaVersion);
    releaseDigest = target.digest;
    if (target.blocker) blockers.push(target.blocker);
  }

  const migratedOperationalPaths = new Set<string>();
  if (executionState.exists && !executionState.active && !executionState.unknown) {
    migratedOperationalPaths.add('.harness/local/execution/execution-status.json');
  }

  const operations = inspection.ownership
    .filter((entry) => !migratedOperationalPaths.has(entry.path))
    .map(ownershipOperation);

  if (executionState.exists && !executionState.active && !executionState.unknown && executionState.sha256) {
    operations.push({
      id: '',
      phase: 'local-state',
      kind: 'MIGRATE_LOCAL_STATE',
      path: '.harness/local/execution/execution-status.json',
      targetPath: 'ai-harness/execution/execution-status.json',
      mutates: true,
      precondition: { kind: 'sha256', value: executionState.sha256 },
      strategy: 'legacy-execution-state-to-clone-local',
      targetDescriptor: { storage: 'git-private-ai-harness' },
      reason: 'Operational execution state must leave the tracked/project-local legacy control plane.',
    });
  }

  let numberedOperations = sortAndNumberOperations(operations);
  addDirtyMutationBlockers(numberedOperations, inspection, blockers);

  const unsafeSharedMutations = numberedOperations
    .filter(
      (operation) =>
        operation.mutates &&
        operation.classification === 'shared-customized' &&
        operation.precondition.kind === 'none',
    )
    .map((operation) => operation.path);
  if (unsafeSharedMutations.length > 0) {
    blockers.push(
      blocker(
        'UNSAFE_SHARED_MERGE',
        'A shared/customized path cannot be transformed because its current content identity is unavailable.',
        undefined,
        unsafeSharedMutations,
      ),
    );
  }

  const provisionalSeed = planSeed(
    inspection,
    targetRelease,
    targetProjectSchemaVersion,
    releaseDigest,
    numberedOperations,
    executionState,
  );
  const migrationId = `migration-${sha256(provisionalSeed).slice(0, 16)}`;

  if (inspection.projectRoot !== null && inspection.baseline !== null) {
    numberedOperations = sortAndNumberOperations([
      ...numberedOperations,
      {
        id: '',
        phase: 'finalize',
        kind: 'CREATE',
        path: `planning/audits/MIGRATION-${migrationId.replace(/^migration-/, '')}.md`,
        mutates: true,
        precondition: { kind: 'absent' },
        strategy: 'write-final-migration-report-after-verification',
        targetDescriptor: { migrationId },
        reason: 'Persist factual migration evidence only after deterministic verification.',
      },
    ]);
  }

  const finalBlockers = dedupeMessages(blockers);
  const finalWarnings = dedupeMessages(warnings);

  return {
    schemaVersion: 1,
    migrationId,
    status: finalBlockers.length === 0 ? 'ready' : 'blocked',
    source: {
      projectRoot: inspection.projectRoot,
      headSha: inspection.headSha,
      legacyRelease: inspection.legacy?.release ?? null,
      legacyHarnessVersion: inspection.legacy?.harnessVersion ?? null,
      baseline: inspection.baseline
        ? {
            repository: inspection.baseline.sourceRepository,
            ref: inspection.baseline.sourceRef,
            commit: inspection.baseline.sourceCommit,
            resolvedBy: inspection.baseline.resolvedBy,
          }
        : null,
    },
    target: {
      harnessRelease: targetRelease,
      projectSchemaVersion: targetProjectSchemaVersion,
      releaseDigest,
    },
    preconditions: {
      inspectionState: inspection.state,
      expectedHeadSha: inspection.headSha,
      relevantUntrackedPaths: inspection.relevantUntrackedCollisions,
      migrationCheckpointAbsent: inspection.state !== 'migration-in-progress',
    },
    operations: numberedOperations,
    blockers: finalBlockers,
    warnings: finalWarnings,
    verification: verificationSteps(),
  };
}

export function serializeMigrationPlan(plan: MigrationPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
