export type MigrationOperationKind =
  | 'PRESERVE'
  | 'CREATE'
  | 'REPLACE_GENERATED_BLOCK'
  | 'TRANSFORM'
  | 'MOVE'
  | 'DELETE_HARNESS_OWNED_CLEAN'
  | 'MIGRATE_LOCAL_STATE'
  | 'REGENERATE_PROJECTION'
  | 'BLOCK_CONFLICT';

export type MigrationOperationPhase =
  | 'prepare'
  | 'local-state'
  | 'project-contract'
  | 'bootstrap'
  | 'preserve'
  | 'cleanup'
  | 'finalize';

export type MigrationPlanBlockerCode =
  | 'NOT_LEGACY_PROJECT'
  | 'BASELINE_REQUIRED'
  | 'BASELINE_MISMATCH'
  | 'UNSUPPORTED_LEGACY_RELEASE'
  | 'INVALID_LEGACY_MANIFEST'
  | 'INVALID_LEGACY_LOCK'
  | 'LEGACY_AND_THIN_STATE'
  | 'BASELINE_FILE_UNVERIFIED'
  | 'HARNESS_OWNED_MODIFIED'
  | 'DIRTY_PATH_CONFLICT'
  | 'UNTRACKED_COLLISION'
  | 'UNSAFE_SHARED_MERGE'
  | 'ACTIVE_EXECUTION'
  | 'UNKNOWN_ACTIVE_STATE'
  | 'TARGET_RELEASE_UNAVAILABLE'
  | 'TARGET_INCOMPATIBLE'
  | 'PROJECT_SCHEMA_CONFLICT'
  | 'MIGRATION_IN_PROGRESS';

export interface MigrationPlanMessage {
  code: MigrationPlanBlockerCode | string;
  message: string;
  paths?: readonly string[];
  details?: Readonly<Record<string, unknown>>;
}

export type MigrationPrecondition =
  | { kind: 'git-blob-sha1'; value: string }
  | { kind: 'sha256'; value: string }
  | { kind: 'absent' }
  | { kind: 'none' };

export interface MigrationPlanOperation {
  id: string;
  phase: MigrationOperationPhase;
  kind: MigrationOperationKind;
  path: string;
  targetPath?: string;
  mutates: boolean;
  classification?: string;
  precondition: MigrationPrecondition;
  baselineBlobSha1?: string | null;
  strategy: string;
  targetDescriptor?: Readonly<Record<string, unknown>>;
  reason: string;
}

export interface MigrationVerificationStep {
  id: string;
  description: string;
  required: boolean;
}

export interface MigrationPlan {
  schemaVersion: 1;
  migrationId: string;
  status: 'ready' | 'blocked';
  source: {
    projectRoot: string | null;
    headSha: string | null;
    legacyRelease: string | null;
    legacyHarnessVersion: string | null;
    baseline: {
      repository: string;
      ref: string;
      commit: string;
      resolvedBy: 'lock' | 'explicit';
    } | null;
  };
  target: {
    harnessRelease: string | null;
    projectSchemaVersion: number;
    releaseDigest: string | null;
  };
  preconditions: {
    inspectionState: string;
    expectedHeadSha: string | null;
    relevantUntrackedPaths: readonly string[];
    migrationCheckpointAbsent: boolean;
  };
  operations: readonly MigrationPlanOperation[];
  blockers: readonly MigrationPlanMessage[];
  warnings: readonly MigrationPlanMessage[];
  verification: readonly MigrationVerificationStep[];
}

export interface MigrationPlannerOptions {
  fromRelease?: string;
  targetRelease?: string;
  targetProjectSchemaVersion?: number;
}
