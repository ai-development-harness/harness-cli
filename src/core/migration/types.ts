export type ProjectInspectionState =
  | 'not-git'
  | 'git-non-harness'
  | 'legacy-harness-supported'
  | 'legacy-harness-baseline-required'
  | 'legacy-harness-unsupported'
  | 'migration-in-progress'
  | 'thin-harness-current'
  | 'thin-harness-invalid';

export type LegacyOwnershipClass =
  | 'project-owned'
  | 'harness-owned-clean'
  | 'harness-owned-modified'
  | 'shared-customized'
  | 'unknown';

export type LegacyInspectionDiagnosticCode =
  | 'BASELINE_REQUIRED'
  | 'BASELINE_MISMATCH'
  | 'UNSUPPORTED_LEGACY_RELEASE'
  | 'INVALID_LEGACY_MANIFEST'
  | 'INVALID_LEGACY_LOCK'
  | 'LEGACY_AND_THIN_STATE'
  | 'BASELINE_FILE_UNVERIFIED'
  | 'HARNESS_OWNED_MODIFIED'
  | 'DIRTY_MANAGED_PATH'
  | 'UNTRACKED_MANAGED_PATH'
  | 'INVALID_THIN_CONFIG';

export interface LegacyInspectionDiagnostic {
  code: LegacyInspectionDiagnosticCode;
  severity: 'blocker' | 'warning';
  message: string;
  paths?: readonly string[];
  details?: Readonly<Record<string, unknown>>;
}

export interface LegacyBaselineResolution {
  release: string;
  sourceRepository: string;
  sourceRef: string;
  sourceCommit: string;
  resolvedBy: 'lock' | 'explicit';
}

export interface LegacyFileOwnership {
  path: string;
  classification: LegacyOwnershipClass;
  expectedBlobSha1: string | null;
  actualBlobSha1: string | null;
  dirty: boolean;
}

export interface LegacyMetadataSummary {
  manifestPath: string;
  release: string | null;
  harnessVersion: string | null;
  lockPath: string;
  lockPresent: boolean;
  updatePolicyPath: string;
  updatePolicyPresent: boolean;
}

export interface ProjectInspectionResult {
  state: ProjectInspectionState;
  projectRoot: string | null;
  headSha: string | null;
  gitDir: string | null;
  commonGitDir: string | null;
  cloneLocalHarnessPath: string | null;
  trackedFiles: readonly string[];
  dirtyTrackedPaths: readonly string[];
  untrackedPaths: readonly string[];
  relevantUntrackedCollisions: readonly string[];
  legacy: LegacyMetadataSummary | null;
  baseline: LegacyBaselineResolution | null;
  ownership: readonly LegacyFileOwnership[];
  diagnostics: readonly LegacyInspectionDiagnostic[];
}

export interface ProjectInspectorOptions {
  fromRelease?: string;
}
