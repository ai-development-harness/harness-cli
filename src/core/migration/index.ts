export { inspectProject } from './legacy/inspector.js';
export { getLegacyBaselineDescriptor, supportedLegacyReleases } from './legacy/baselines.js';
export { planMigration, serializeMigrationPlan } from './planner.js';
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
