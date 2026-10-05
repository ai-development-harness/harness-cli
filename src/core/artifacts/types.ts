export type ArtifactKind =
  | 'requirement'
  | 'adr'
  | 'step'
  | 'open_question'
  | 'principle'
  | 'step_review'
  | 'planning_review'
  | 'init_review'
  | 'audit'
  | 'release_check'
  | 'skill_search'
  | 'template';

export type ArtifactDiagnosticCode =
  | 'ARTIFACT_PARSE_ERROR'
  | 'ARTIFACT_SYMLINK'
  | 'ARTIFACT_SCHEMA'
  | 'ARTIFACT_ID'
  | 'ARTIFACT_DUPLICATE_ID'
  | 'ARTIFACT_FILENAME'
  | 'ARTIFACT_H1'
  | 'ARTIFACT_STATUS'
  | 'ARTIFACT_FIELD'
  | 'ARTIFACT_SECTION'
  | 'ARTIFACT_DUPLICATE_SECTION'
  | 'ARTIFACT_REFERENCE'
  | 'ARTIFACT_REVERSE_REFERENCE'
  | 'ARTIFACT_CYCLE'
  | 'ARTIFACT_REPORT_IDENTITY'
  | 'ARTIFACT_REPORT_KIND'
  | 'ARTIFACT_REPORT_IMMUTABILITY'
  | 'ARTIFACT_CONFIGURED_PATH'
  | 'ARTIFACT_TEMPLATE';

export interface ArtifactDiagnostic {
  readonly code: ArtifactDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly kind?: ArtifactKind;
  readonly artifactId?: string;
  readonly field?: string;
  readonly reference?: string;
}

export interface ParsedArtifactDocument {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly h1: string | null;
  readonly sections: Readonly<Record<string, string>>;
  readonly duplicateSections: readonly string[];
  readonly text: string;
}

export interface ArtifactValidationSummary {
  readonly schemaVersion: 1;
  readonly status: 'PASS' | 'FAIL';
  readonly projectRoot: string;
  readonly harnessRelease: string;
  readonly projectSchemaVersion: number;
  readonly checked: Readonly<Record<ArtifactKind, number>>;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface ArtifactRecord {
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly document: ParsedArtifactDocument;
}
