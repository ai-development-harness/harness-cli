import type { ReleaseStore } from '../releases/store.js';
import type { MigrationOperationKind, MigrationPlan, MigrationPlanOperation } from './plan-types.js';

export type MigrationJournalOperationStatus = 'pending' | 'applying' | 'applied' | 'verified';

export type MigrationJournalState =
  | 'prepared'
  | 'running'
  | 'recovery-required'
  | 'completed';

export type MigrationExecutionErrorCode =
  | 'PLAN_BLOCKED'
  | 'PLAN_INVALID'
  | 'PLAN_STALE'
  | 'MIGRATION_CHECKPOINT_EXISTS'
  | 'MIGRATION_CHECKPOINT_MISSING'
  | 'CHECKPOINT_PLAN_CORRUPT'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_INCONSISTENT'
  | 'OPERATION_HANDLER_MISSING'
  | 'OPERATION_INDETERMINATE'
  | 'POSTCONDITION_FAILED'
  | 'PROJECT_IDENTITY_MISMATCH';

export class MigrationExecutionError extends Error {
  constructor(
    public readonly code: MigrationExecutionErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'MigrationExecutionError';
  }
}

export function isMigrationExecutionError(error: unknown): error is MigrationExecutionError {
  return error instanceof MigrationExecutionError;
}

export type MigrationOperationPostcondition = Readonly<Record<string, unknown>>;

export interface MigrationJournalOperation {
  id: string;
  kind: MigrationOperationKind;
  path: string;
  status: MigrationJournalOperationStatus;
  postcondition: MigrationOperationPostcondition | null;
  appliedAt: string | null;
  verifiedAt: string | null;
}

export interface MigrationJournal {
  schemaVersion: 1;
  migrationId: string;
  planSha256: string;
  state: MigrationJournalState;
  createdAt: string;
  updatedAt: string;
  operations: MigrationJournalOperation[];
  recovery: {
    code: MigrationExecutionErrorCode;
    message: string;
    operationId: string | null;
    details: Readonly<Record<string, unknown>>;
  } | null;
}

export interface MigrationCheckpointPaths {
  root: string;
  plan: string;
  journal: string;
  backups: string;
  partialReport: string;
}

export interface MigrationOperationContext {
  plan: MigrationPlan;
  operation: MigrationPlanOperation;
  projectRoot: string;
  checkpoint: MigrationCheckpointPaths;
}

export interface MigrationOperationHandler {
  preflight?(context: MigrationOperationContext): Promise<void>;
  apply(context: MigrationOperationContext): Promise<MigrationOperationPostcondition>;
  verify(
    context: MigrationOperationContext,
    postcondition: MigrationOperationPostcondition,
  ): Promise<boolean>;
}

export type MigrationOperationHandlers = Partial<Record<MigrationOperationKind, MigrationOperationHandler>>;

export interface MigrationExecutorHooks {
  afterOperationApplied?(operation: MigrationPlanOperation): Promise<void> | void;
  afterOperationVerified?(operation: MigrationPlanOperation): Promise<void> | void;
}

export interface MigrationExecutorDependencies {
  handlers?: MigrationOperationHandlers;
  hooks?: MigrationExecutorHooks;
  now?: () => Date;
  releaseStore?: ReleaseStore;
}

export interface MigrationExecutionResult {
  migrationId: string;
  status: 'completed';
  verifiedOperations: number;
  checkpointRemoved: boolean;
}

export interface MigrationCheckpointStatus {
  plan: MigrationPlan;
  journal: MigrationJournal;
  paths: MigrationCheckpointPaths;
}
