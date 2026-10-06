export type UpdatePlanStatus = 'ready' | 'noop' | 'blocked';

export type UpdateBlockerCode =
  | 'UPDATE_TARGET_UNAVAILABLE'
  | 'UPDATE_TARGET_NOT_NEWER'
  | 'UPDATE_INCOMPATIBLE_CLI'
  | 'UPDATE_INCOMPATIBLE_HOST_API'
  | 'UPDATE_INCOMPATIBLE_PROJECT_SCHEMA'
  | 'UPDATE_MIGRATION_REQUIRED';

export interface UpdateBlocker {
  readonly code: UpdateBlockerCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface UpdatePlan {
  readonly schemaVersion: 1;
  readonly status: UpdatePlanStatus;
  readonly currentRelease: string;
  readonly targetRelease: string;
  readonly targetDigest: string | null;
  readonly projectSchemaVersion: number;
  readonly targetProjectSchemaVersion: number | null;
  readonly migrationRequired: boolean;
  readonly blockers: readonly UpdateBlocker[];
  readonly mutationPlan: {
    readonly updateReleasePin: boolean;
    readonly createEmbeddedTools: false;
    readonly genericThreeWayUpdate: false;
  };
}

export type UpdatePhase =
  | 'prepared'
  | 'migration_verified'
  | 'pin_written'
  | 'verified';

export interface UpdateCheckpoint {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly phase: UpdatePhase;
  readonly currentRelease: string;
  readonly targetRelease: string;
  readonly targetDigest: string;
  readonly projectSchemaBefore: number;
  readonly projectSchemaAfter: number;
  readonly migrationRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateApplyResult {
  readonly status: 'SUCCESS' | 'NOOP';
  readonly currentRelease: string;
  readonly targetRelease: string;
  readonly targetDigest: string;
  readonly migrated: boolean;
  readonly recovered: boolean;
}

export interface UpdateProjectState {
  readonly release: string;
  readonly schemaVersion: number;
}

export interface UpdateProjectStatePort {
  read(projectRoot: string): Promise<UpdateProjectState>;
  writeReleasePin(
    projectRoot: string,
    expectedCurrentRelease: string,
    targetRelease: string,
  ): Promise<void>;
}

export interface UpdateMigrationCoordinator {
  migrate(input: {
    readonly projectRoot: string;
    readonly currentRelease: string;
    readonly targetRelease: string;
    readonly targetReleaseDigest: string;
    readonly fromProjectSchemaVersion: number;
    readonly toProjectSchemaVersion: number;
  }): Promise<{ readonly projectSchemaVersion: number }>;
}
