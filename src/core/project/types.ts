import type { ParsedArtifactDocument } from '../artifacts/index.js';

export type ProjectArtifactType = 'REQ' | 'ADR' | 'STEP' | 'OQ' | 'PRN';

export interface CanonicalProjectArtifact {
  readonly id: string;
  readonly type: ProjectArtifactType;
  readonly title: string;
  readonly path: string;
  readonly document: ParsedArtifactDocument;
}

export interface ProjectStateNode {
  readonly id: string;
  readonly artifactId: string;
  readonly type: ProjectArtifactType | 'PROJECT' | 'MISSING';
  readonly title: string;
  readonly status: string;
  readonly path: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ProjectStateEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: 'implemented_by' | 'addresses' | 'governs' | 'depends_on' | 'affects';
  readonly declaredBy: readonly string[];
}

export interface ProjectStateDiagnostic {
  readonly code:
    | 'MISSING_REFERENCE'
    | 'INVALID_CANONICAL_ARTIFACT'
    | 'DEPENDENCY_CYCLE'
    | 'TRACEABILITY_MISMATCH';
  readonly source?: string;
  readonly target?: string;
  readonly relation?: string;
  readonly path?: string;
  readonly message?: string;
}

export interface CompletionProofFact {
  readonly complete: boolean;
  readonly proofHash?: string;
  readonly reasons: readonly string[];
}

export interface PlanFreshnessFact {
  readonly status: 'not_ready' | 'fresh' | 'stale' | 'invalid' | 'blocked';
  readonly causes: readonly Readonly<{ component: string; change: string }>[];
  readonly action: string | null;
  readonly storedBasis?: string | null;
  readonly currentBasis?: string | null;
}

export interface UnresolvedExecutionFact {
  readonly executionId: string;
  readonly status: 'RESUME' | 'NEXT';
  readonly command: string;
  readonly rootCommand?: string;
}

export interface ProjectReadModelProviders {
  readonly completion?: (stepId: string) => Promise<CompletionProofFact>;
  readonly planFreshness?: (stepId: string) => Promise<PlanFreshnessFact>;
  readonly unresolvedExecutions?: () => Promise<readonly UnresolvedExecutionFact[]>;
  readonly implementationPrerequisites?: (stepId: string) => Promise<readonly string[]>;
}

export interface ArtifactInventory {
  readonly projectRoot: string;
  readonly artifacts: readonly CanonicalProjectArtifact[];
  readonly byId: ReadonlyMap<string, CanonicalProjectArtifact>;
  readonly byType: Readonly<Record<ProjectArtifactType, readonly CanonicalProjectArtifact[]>>;
  readonly diagnostics: readonly ProjectStateDiagnostic[];
}
