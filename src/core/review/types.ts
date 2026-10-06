export type ReviewVerdict = 'pass' | 'fail' | 'blocked';
export type VerificationStatus = 'PASS' | 'FAIL' | 'MANUAL_REQUIRED' | 'BLOCKED' | 'MISSING' | 'UNKNOWN';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingCategory = 'implementation' | 'evidence' | 'contract';

export interface RepositoryRevision {
  readonly gitHead: string | null;
  readonly worktreeHash: string | null;
}

export interface ReviewFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly category: FindingCategory;
  readonly location: Readonly<{ path: string; line: number | null }>;
  readonly scenario: Readonly<{ given: string; when: string; then: string }>;
  readonly expected: string;
  readonly observed: string;
  readonly impact: string;
  readonly repair: Readonly<{
    direction: string;
    admissibleAlternatives: readonly string[];
  }>;
  readonly constraints: readonly string[];
  readonly evidence: readonly string[];
  readonly fingerprint: string;
}

export interface ReviewGate {
  readonly stepId: string;
  readonly required: readonly ('security' | 'tests')[];
  readonly reasons: Readonly<Record<'security' | 'tests', readonly string[]>>;
  readonly changedPaths: readonly string[];
  readonly changedPathsHash: string;
  readonly surfaceMode: 'implementation-baseline' | 'clean-tree-fallback';
  readonly implementationBaseline: string | null;
  readonly baselineStatus: 'valid' | 'missing' | 'invalid';
  readonly baselineReason: string | null;
  readonly basis: string;
}

export interface ReviewExpectationV1 {
  readonly schemaVersion: 1;
  readonly stepId: string;
  readonly repositoryRevision: RepositoryRevision;
  readonly gateBasis: string;
  readonly contextBasis: string;
  readonly verificationBasis: string;
  readonly requiredReviewers: readonly ('security' | 'tests')[];
  readonly capturedAt: string;
}

export interface VerificationEntry {
  readonly kind: 'command' | 'manual';
  readonly value: string;
}

export interface VerificationFreshness {
  readonly status: VerificationStatus;
  readonly fresh: boolean;
  readonly reasonCode: string | null;
  readonly contractBasis?: string;
  readonly subjectRevision?: RepositoryRevision;
  readonly storedContractBasis?: string;
  readonly currentContractBasis?: string;
  readonly storedSubjectRevision?: RepositoryRevision;
  readonly currentSubjectRevision?: RepositoryRevision;
}

export interface ProgressSample {
  readonly schemaVersion: 1;
  readonly stepId: string;
  readonly command: string;
  readonly operation: 'PLAN' | 'IMPLEMENT' | 'REVIEW' | 'FIX';
  readonly materialFingerprint: string;
  readonly activityFingerprint: string;
  readonly fingerprint: string;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

export interface ProgressTelemetry {
  readonly schemaVersion: 1;
  readonly samples: readonly ProgressSample[];
  readonly unchangedResumes: number;
  readonly driftStreak: number;
  readonly lastDelta: Readonly<Record<string, unknown>> | null;
  readonly stopDecision: string;
}
