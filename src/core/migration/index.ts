export { inspectProject } from './legacy/inspector.js';
export { getLegacyBaselineDescriptor, supportedLegacyReleases } from './legacy/baselines.js';
export { planMigration, serializeMigrationPlan } from './planner.js';
export {
  executeMigration,
  inspectMigrationCheckpoint,
  resumeMigration,
} from './executor.js';
export {
  acquireMigrationExecutionLock,
  inspectMigrationExecutionLock,
  migrationExecutionLockPath,
} from './execution-lock.js';
export { listMigrationCheckpointIds } from './checkpoint.js';
export {
  executeLegacyThinMigration,
  legacyThinOperationHandlers,
  prepareLegacyThinMigration,
  resumeLegacyThinMigration,
} from './legacy-thin.js';
export type {
  LegacyThinMigrationDependencies,
  LegacyThinMigrationExecution,
  LegacyThinPreparation,
} from './legacy-thin.js';
export {
  isMigrationExecutionError,
  MigrationExecutionError,
} from './executor-types.js';
export type { MigrationPlannerDependencies } from './planner.js';
export type {
  MigrationOperationKind,
  MigrationOperationPhase,
  MigrationPlan,
  MigrationPlanBlockerCode,
  MigrationPlanMessage,
  MigrationPlanOperation,
  MigrationPlannerOptions,
  MigrationPrecondition,
  MigrationVerificationStep,
} from './plan-types.js';
export type {
  MigrationCheckpointPaths,
  MigrationCheckpointStatus,
  MigrationExecutionErrorCode,
  MigrationExecutionResult,
  MigrationExecutorDependencies,
  MigrationExecutorHooks,
  MigrationJournal,
  MigrationJournalOperation,
  MigrationJournalOperationStatus,
  MigrationJournalState,
  MigrationOperationContext,
  MigrationOperationHandler,
  MigrationOperationHandlers,
  MigrationOperationPostcondition,
} from './executor-types.js';
export type {
  LegacyBaselineResolution,
  LegacyFileOwnership,
  LegacyInspectionDiagnostic,
  LegacyInspectionDiagnosticCode,
  LegacyMetadataSummary,
  LegacyOwnershipClass,
  ProjectInspectionResult,
  ProjectInspectionState,
  ProjectInspectorOptions,
} from './types.js';

export type {
  MigrationExecutionLockDependencies,
  MigrationExecutionLockLease,
  MigrationExecutionLockMode,
  MigrationExecutionLockOwner,
  MigrationExecutionLockStatus,
} from './execution-lock.js';
