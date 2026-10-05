import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import {
  ADR_STATUSES,
  DURABLE_REPORT_PREFIX,
  ID_PATTERNS,
  OQ_STATUSES,
  PLAN_STATUSES,
  PRIORITIES,
  PRN_SEVERITIES,
  PRN_STATUSES,
  REQUIRED_SECTIONS,
  REVIEW_VERDICTS,
  RISK_FLAGS,
  STEP_STATUSES,
  STEP_TYPES,
  TEMPLATE_CONTRACTS,
} from './contracts.js';
import {
  ArtifactDocumentError,
  exactArtifactH1,
  isNonEmptySection,
  parseArtifactDocument,
} from './document.js';
import type {
  ArtifactDiagnostic,
  ArtifactKind,
  ArtifactRecord,
  ArtifactValidationSummary,
  ParsedArtifactDocument,
} from './types.js';

type MutableCounts = Record<ArtifactKind, number>;

interface ArtifactCollections {
  requirements: Map<string, ArtifactRecord>;
  adrs: Map<string, ArtifactRecord>;
  steps: Map<string, ArtifactRecord>;
  openQuestions: Map<string, ArtifactRecord>;
  principles: Map<string, ArtifactRecord>;
}

function emptyCounts(): MutableCounts {
  return {
    requirement: 0,
    adr: 0,
    step: 0,
    open_question: 0,
    principle: 0,
    step_review: 0,
    planning_review: 0,
    init_review: 0,
    audit: 0,
    release_check: 0,
    skill_search: 0,
    template: 0,
  };
}

function relative(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function diagnostic(
  projectRoot: string,
  filePath: string,
  code: ArtifactDiagnostic['code'],
  message: string,
  extra: Partial<Omit<ArtifactDiagnostic, 'code' | 'path' | 'message'>> = {},
): ArtifactDiagnostic {
  return {
    code,
    path: relative(projectRoot, filePath),
    message,
    ...extra,
  };
}

function stringList(
  projectRoot: string,
  filePath: string,
  value: unknown,
  field: string,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
  artifactId?: string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', `${field} must be a string array`, {
        kind,
        artifactId,
        field,
      }),
    );
    return [];
  }
  return value as string[];
}

function requireSchema(
  projectRoot: string,
  filePath: string,
  document: ParsedArtifactDocument,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
  artifactId?: string,
  reportKind?: string,
): void {
  if (document.frontmatter.schema !== 1) {
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_SCHEMA', 'schema must be 1', {
        kind,
        artifactId,
        field: 'schema',
      }),
    );
  }
  if (reportKind !== undefined && document.frontmatter.kind !== reportKind) {
    diagnostics.push(
      diagnostic(
        projectRoot,
        filePath,
        'ARTIFACT_REPORT_KIND',
        `kind must be ${reportKind}`,
        { kind, artifactId, field: 'kind' },
      ),
    );
  }
}

function requireSections(
  projectRoot: string,
  filePath: string,
  document: ParsedArtifactDocument,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
  sections: readonly string[],
  artifactId?: string,
  allowEmpty: ReadonlySet<string> = new Set(),
): void {
  for (const section of sections) {
    if (!(section in document.sections)) {
      diagnostics.push(
        diagnostic(
          projectRoot,
          filePath,
          'ARTIFACT_SECTION',
          `missing section '## ${section}'`,
          { kind, artifactId, field: section },
        ),
      );
    } else if (!allowEmpty.has(section) && !isNonEmptySection(document, section)) {
      diagnostics.push(
        diagnostic(
          projectRoot,
          filePath,
          'ARTIFACT_SECTION',
          `empty section '## ${section}'`,
          { kind, artifactId, field: section },
        ),
      );
    }
  }

  for (const duplicate of document.duplicateSections) {
    diagnostics.push(
      diagnostic(
        projectRoot,
        filePath,
        'ARTIFACT_DUPLICATE_SECTION',
        `duplicate section '## ${duplicate}'`,
        { kind, artifactId, field: duplicate },
      ),
    );
  }
}

async function safeParse(
  projectRoot: string,
  filePath: string,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
): Promise<ParsedArtifactDocument | null> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      diagnostics.push(
        diagnostic(projectRoot, filePath, 'ARTIFACT_SYMLINK', 'canonical artifact must not be a symlink', {
          kind,
        }),
      );
      return null;
    }
    return await parseArtifactDocument(filePath);
  } catch (error) {
    const message =
      error instanceof ArtifactDocumentError ? error.message : (error as Error).message;
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_PARSE_ERROR', message, { kind }),
    );
    return null;
  }
}

function validateCanonicalIdentity(
  projectRoot: string,
  filePath: string,
  document: ParsedArtifactDocument,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
  idPattern: RegExp,
  filePattern: (id: string) => boolean,
): string | null {
  requireSchema(projectRoot, filePath, document, diagnostics, kind);

  const id = document.frontmatter.id;
  if (typeof id !== 'string' || !idPattern.test(id)) {
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_ID', 'invalid canonical id', {
        kind,
        field: 'id',
      }),
    );
    return null;
  }

  if (!filePattern(id)) {
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_FILENAME', 'filename/id mismatch', {
        kind,
        artifactId: id,
      }),
    );
  }
  if (!exactArtifactH1(document, id)) {
    diagnostics.push(
      diagnostic(
        projectRoot,
        filePath,
        'ARTIFACT_H1',
        `H1 must be '# ${id} — <title>'`,
        { kind, artifactId: id },
      ),
    );
  }
  return id;
}

function addUnique(
  projectRoot: string,
  record: ArtifactRecord,
  target: Map<string, ArtifactRecord>,
  diagnostics: ArtifactDiagnostic[],
): void {
  const existing = target.get(record.id);
  if (existing) {
    diagnostics.push(
      diagnostic(
        projectRoot,
        record.document.path,
        'ARTIFACT_DUPLICATE_ID',
        `duplicate canonical id ${record.id}; first seen at ${relative(projectRoot, existing.document.path)}`,
        { kind: record.kind, artifactId: record.id },
      ),
    );
    return;
  }
  target.set(record.id, record);
}

async function markdownFiles(directory: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.md'))
    .filter((entry) => entry.name !== 'TEMPLATE.md')
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function validSha256(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-fA-F]{64}$/.test(value);
}

function validateIso(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  return !Number.isNaN(Date.parse(value));
}

function artifactRef(
  projectRoot: string,
  filePath: string,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
  artifactId: string | undefined,
  field: string,
  ref: string,
  pattern: RegExp,
  exists: boolean,
): void {
  if (!pattern.test(ref)) {
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_REFERENCE', `invalid ${field} reference ${ref}`, {
        kind,
        artifactId,
        field,
        reference: ref,
      }),
    );
  } else if (!exists) {
    diagnostics.push(
      diagnostic(projectRoot, filePath, 'ARTIFACT_REFERENCE', `referenced artifact does not exist: ${ref}`, {
        kind,
        artifactId,
        field,
        reference: ref,
      }),
    );
  }
}

async function collectCanonicalArtifacts(
  projectRoot: string,
  config: HarnessConfig,
  diagnostics: ArtifactDiagnostic[],
  checked: MutableCounts,
): Promise<ArtifactCollections> {
  const requirements = new Map<string, ArtifactRecord>();
  const adrs = new Map<string, ArtifactRecord>();
  const steps = new Map<string, ArtifactRecord>();
  const openQuestions = new Map<string, ArtifactRecord>();
  const principles = new Map<string, ArtifactRecord>();

  const reqDir = await resolvePortablePathWithinBoundary(projectRoot, config.sources.requirements, 'sources.requirements');
  const adrDir = await resolvePortablePathWithinBoundary(projectRoot, config.sources.adrDirectory, 'sources.adrDirectory');
  const stepDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.taskDirectory, 'protocol.taskDirectory');
  const oqDir = await resolvePortablePathWithinBoundary(projectRoot, config.sources.openQuestions, 'sources.openQuestions');
  const prnDir = await resolvePortablePathWithinBoundary(projectRoot, config.sources.principles, 'sources.principles');

  for (const filePath of await markdownFiles(reqDir, 'REQ-')) {
    checked.requirement += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'requirement');
    if (!document) continue;
    const id = validateCanonicalIdentity(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'requirement',
      ID_PATTERNS.requirement,
      (value) => path.basename(filePath).startsWith(`${value}-`),
    );
    if (!id) continue;

    if (!isOneOf(document.frontmatter.priority, PRIORITIES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'invalid priority', {
        kind: 'requirement', artifactId: id, field: 'priority',
      }));
    }
    if (typeof document.frontmatter.source !== 'string' || !document.frontmatter.source.trim()) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'source must be non-empty', {
        kind: 'requirement', artifactId: id, field: 'source',
      }));
    }
    stringList(projectRoot, filePath, document.frontmatter.steps, 'steps', diagnostics, 'requirement', id);
    stringList(projectRoot, filePath, document.frontmatter.adrs, 'adrs', diagnostics, 'requirement', id);
    requireSections(projectRoot, filePath, document, diagnostics, 'requirement', REQUIRED_SECTIONS.requirement, id);
    addUnique(projectRoot, { kind: 'requirement', id, document }, requirements, diagnostics);
  }

  for (const filePath of await markdownFiles(adrDir, 'ADR-')) {
    checked.adr += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'adr');
    if (!document) continue;
    const id = validateCanonicalIdentity(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'adr',
      ID_PATTERNS.adr,
      (value) => {
        const name = path.basename(filePath);
        return name === `${value}.md` || name.startsWith(`${value}-`);
      },
    );
    if (!id) continue;

    if (!isOneOf(document.frontmatter.status, ADR_STATUSES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_STATUS', 'invalid ADR status', {
        kind: 'adr', artifactId: id, field: 'status',
      }));
    }
    for (const field of ['deciders', 'supersedes', 'superseded_by', 'requirements', 'steps']) {
      stringList(projectRoot, filePath, document.frontmatter[field], field, diagnostics, 'adr', id);
    }
    requireSections(projectRoot, filePath, document, diagnostics, 'adr', REQUIRED_SECTIONS.adr, id);
    addUnique(projectRoot, { kind: 'adr', id, document }, adrs, diagnostics);
  }

  for (const filePath of await markdownFiles(stepDir, 'STEP-')) {
    checked.step += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'step');
    if (!document) continue;
    const id = validateCanonicalIdentity(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'step',
      ID_PATTERNS.step,
      (value) => path.basename(filePath) === `${value}.md`,
    );
    if (!id) continue;

    if (!isOneOf(document.frontmatter.status, STEP_STATUSES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_STATUS', 'invalid STEP status', {
        kind: 'step', artifactId: id, field: 'status',
      }));
    }
    if (!isOneOf(document.frontmatter.type, STEP_TYPES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'invalid STEP type', {
        kind: 'step', artifactId: id, field: 'type',
      }));
    }
    if (!isOneOf(document.frontmatter.priority, PRIORITIES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'invalid priority', {
        kind: 'step', artifactId: id, field: 'priority',
      }));
    }
    if (typeof document.frontmatter.phase !== 'string' || !document.frontmatter.phase.trim()) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'phase must be a non-empty string', {
        kind: 'step', artifactId: id, field: 'phase',
      }));
    }
    for (const field of ['depends_on', 'requirements', 'adrs', 'architecture_refs', 'risk_flags']) {
      stringList(projectRoot, filePath, document.frontmatter[field], field, diagnostics, 'step', id);
    }
    const risks = Array.isArray(document.frontmatter.risk_flags)
      ? document.frontmatter.risk_flags.filter((item): item is string => typeof item === 'string')
      : [];
    if (risks.length === 0) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'risk_flags must not be empty', {
        kind: 'step', artifactId: id, field: 'risk_flags',
      }));
    }
    for (const risk of risks) {
      if (!RISK_FLAGS.includes(risk as (typeof RISK_FLAGS)[number])) {
        diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', `unknown risk flag ${risk}`, {
          kind: 'step', artifactId: id, field: 'risk_flags',
        }));
      }
    }
    if (risks.includes('none') && risks.length > 1) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', "risk flag 'none' is mutually exclusive", {
        kind: 'step', artifactId: id, field: 'risk_flags',
      }));
    }
    const plan = document.frontmatter.plan;
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'plan must be a mapping', {
        kind: 'step', artifactId: id, field: 'plan',
      }));
    } else {
      const p = plan as Record<string, unknown>;
      if (!isOneOf(p.status, PLAN_STATUSES)) {
        diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'invalid plan.status', {
          kind: 'step', artifactId: id, field: 'plan.status',
        }));
      }
      if (typeof p.revision !== 'number' || !Number.isInteger(p.revision) || p.revision < 0) {
        diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'plan.revision must be a non-negative integer', {
          kind: 'step', artifactId: id, field: 'plan.revision',
        }));
      }
    }
    requireSections(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'step',
      REQUIRED_SECTIONS.step,
      id,
      new Set(['Evidence', 'Blocker / Failure reason']),
    );
    const mutation = document.sections['Mutation policy'] ?? '';
    for (const heading of ['Allowed', 'Conditional', 'Forbidden']) {
      const matches = mutation.match(new RegExp(`^### ${heading}\\s*$`, 'gm')) ?? [];
      if (matches.length !== 1) {
        diagnostics.push(diagnostic(
          projectRoot,
          filePath,
          'ARTIFACT_SECTION',
          `Mutation policy requires exactly one '### ${heading}'`,
          { kind: 'step', artifactId: id, field: 'Mutation policy' },
        ));
      }
    }
    addUnique(projectRoot, { kind: 'step', id, document }, steps, diagnostics);
  }

  for (const filePath of await markdownFiles(oqDir, 'OQ-')) {
    checked.open_question += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'open_question');
    if (!document) continue;
    const id = validateCanonicalIdentity(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'open_question',
      ID_PATTERNS.openQuestion,
      (value) => path.basename(filePath).startsWith(`${value}-`),
    );
    if (!id) continue;
    if (!isOneOf(document.frontmatter.status, OQ_STATUSES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_STATUS', 'invalid Open Question status', {
        kind: 'open_question', artifactId: id, field: 'status',
      }));
    }
    const affects = stringList(projectRoot, filePath, document.frontmatter.affects, 'affects', diagnostics, 'open_question', id);
    if (affects.length === 0) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'affects must not be empty', {
        kind: 'open_question', artifactId: id, field: 'affects',
      }));
    }
    if (!validateIso(document.frontmatter.created_at)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'created_at must be ISO-8601', {
        kind: 'open_question', artifactId: id, field: 'created_at',
      }));
    }
    const resolvedAt = document.frontmatter.resolved_at;
    if (resolvedAt !== null && resolvedAt !== undefined && !validateIso(resolvedAt)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'resolved_at must be null or ISO-8601', {
        kind: 'open_question', artifactId: id, field: 'resolved_at',
      }));
    }
    requireSections(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'open_question',
      REQUIRED_SECTIONS.openQuestion,
      id,
    );
    addUnique(projectRoot, { kind: 'open_question', id, document }, openQuestions, diagnostics);
  }

  for (const filePath of await markdownFiles(prnDir, 'PRN-')) {
    checked.principle += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'principle');
    if (!document) continue;
    const id = validateCanonicalIdentity(
      projectRoot,
      filePath,
      document,
      diagnostics,
      'principle',
      ID_PATTERNS.principle,
      (value) => path.basename(filePath).startsWith(`${value}-`),
    );
    if (!id) continue;
    if (!isOneOf(document.frontmatter.status, PRN_STATUSES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_STATUS', 'status must be active|superseded|deprecated', {
        kind: 'principle', artifactId: id, field: 'status',
      }));
    }
    if (!isOneOf(document.frontmatter.severity, PRN_SEVERITIES)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'severity must be blocking|advisory', {
        kind: 'principle', artifactId: id, field: 'severity',
      }));
    }
    if (document.frontmatter.scope !== 'project') {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'scope must be project', {
        kind: 'principle', artifactId: id, field: 'scope',
      }));
    }
    stringList(projectRoot, filePath, document.frontmatter.requirements, 'requirements', diagnostics, 'principle', id);
    stringList(projectRoot, filePath, document.frontmatter.adrs, 'adrs', diagnostics, 'principle', id);
    requireSections(projectRoot, filePath, document, diagnostics, 'principle', REQUIRED_SECTIONS.principle, id);
    addUnique(projectRoot, { kind: 'principle', id, document }, principles, diagnostics);
  }

  return { requirements, adrs, steps, openQuestions, principles };
}

function validateCrossReferences(
  projectRoot: string,
  collections: ArtifactCollections,
  diagnostics: ArtifactDiagnostic[],
): void {
  const { requirements, adrs, steps, openQuestions, principles } = collections;

  for (const [id, record] of requirements) {
    const meta = record.document.frontmatter;
    const stepRefs = Array.isArray(meta.steps) ? meta.steps.filter((x): x is string => typeof x === 'string') : [];
    const adrRefs = Array.isArray(meta.adrs) ? meta.adrs.filter((x): x is string => typeof x === 'string') : [];
    for (const ref of stepRefs) {
      artifactRef(projectRoot, record.document.path, diagnostics, 'requirement', id, 'steps', ref, ID_PATTERNS.step, steps.has(ref));
      const step = steps.get(ref);
      const reverse = step?.document.frontmatter.requirements;
      if (step && (!Array.isArray(reverse) || !reverse.includes(id))) {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `reverse STEP traceability mismatch with ${ref}`, {
          kind: 'requirement', artifactId: id, field: 'steps', reference: ref,
        }));
      }
    }
    for (const ref of adrRefs) {
      artifactRef(projectRoot, record.document.path, diagnostics, 'requirement', id, 'adrs', ref, ID_PATTERNS.adr, adrs.has(ref));
      const adr = adrs.get(ref);
      const reverse = adr?.document.frontmatter.requirements;
      if (adr && (!Array.isArray(reverse) || !reverse.includes(id))) {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `reverse ADR traceability mismatch with ${ref}`, {
          kind: 'requirement', artifactId: id, field: 'adrs', reference: ref,
        }));
      }
    }
  }

  for (const [id, record] of adrs) {
    const meta = record.document.frontmatter;
    for (const field of ['requirements', 'steps', 'supersedes', 'superseded_by'] as const) {
      const refs = Array.isArray(meta[field]) ? meta[field].filter((x): x is string => typeof x === 'string') : [];
      for (const ref of refs) {
        if (field === 'requirements') {
          artifactRef(projectRoot, record.document.path, diagnostics, 'adr', id, field, ref, ID_PATTERNS.requirement, requirements.has(ref));
          const req = requirements.get(ref);
          if (req && (!Array.isArray(req.document.frontmatter.adrs) || !req.document.frontmatter.adrs.includes(id))) {
            diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `reverse REQ traceability mismatch with ${ref}`, {
              kind: 'adr', artifactId: id, field, reference: ref,
            }));
          }
        } else if (field === 'steps') {
          artifactRef(projectRoot, record.document.path, diagnostics, 'adr', id, field, ref, ID_PATTERNS.step, steps.has(ref));
          const step = steps.get(ref);
          if (step && (!Array.isArray(step.document.frontmatter.adrs) || !step.document.frontmatter.adrs.includes(id))) {
            diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `reverse STEP traceability mismatch with ${ref}`, {
              kind: 'adr', artifactId: id, field, reference: ref,
            }));
          }
        } else {
          artifactRef(projectRoot, record.document.path, diagnostics, 'adr', id, field, ref, ID_PATTERNS.adr, adrs.has(ref));
          if (ref === id) {
            diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REFERENCE', 'ADR cannot supersede/reference itself', {
              kind: 'adr', artifactId: id, field, reference: ref,
            }));
          }
        }
      }
    }

    const status = meta.status;
    const supersededBy = Array.isArray(meta.superseded_by) ? meta.superseded_by.filter((x): x is string => typeof x === 'string') : [];
    if (status === 'superseded' && supersededBy.length === 0) {
      diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_STATUS', 'superseded ADR requires superseded_by', {
        kind: 'adr', artifactId: id, field: 'superseded_by',
      }));
    }
    if (supersededBy.length > 0 && status !== 'superseded') {
      diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_STATUS', 'ADR with superseded_by must have status=superseded', {
        kind: 'adr', artifactId: id, field: 'status',
      }));
    }

    const supersedes = Array.isArray(meta.supersedes) ? meta.supersedes.filter((x): x is string => typeof x === 'string') : [];
    for (const targetId of supersedes) {
      const reverse = adrs.get(targetId)?.document.frontmatter.superseded_by;
      if (adrs.has(targetId) && (!Array.isArray(reverse) || !reverse.includes(id))) {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `supersedes relation is not reciprocal with ${targetId}`, {
          kind: 'adr', artifactId: id, field: 'supersedes', reference: targetId,
        }));
      }
    }
    for (const targetId of supersededBy) {
      const reverse = adrs.get(targetId)?.document.frontmatter.supersedes;
      if (adrs.has(targetId) && (!Array.isArray(reverse) || !reverse.includes(id))) {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `superseded_by relation is not reciprocal with ${targetId}`, {
          kind: 'adr', artifactId: id, field: 'superseded_by', reference: targetId,
        }));
      }
    }
  }

  for (const [id, record] of steps) {
    const meta = record.document.frontmatter;
    for (const field of ['depends_on', 'requirements', 'adrs'] as const) {
      const refs = Array.isArray(meta[field]) ? meta[field].filter((x): x is string => typeof x === 'string') : [];
      for (const ref of refs) {
        if (field === 'depends_on') {
          artifactRef(projectRoot, record.document.path, diagnostics, 'step', id, field, ref, ID_PATTERNS.step, steps.has(ref));
          if (ref === id) {
            diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REFERENCE', 'STEP cannot depend on itself', {
              kind: 'step', artifactId: id, field, reference: ref,
            }));
          }
        } else if (field === 'requirements') {
          artifactRef(projectRoot, record.document.path, diagnostics, 'step', id, field, ref, ID_PATTERNS.requirement, requirements.has(ref));
          const reverse = requirements.get(ref)?.document.frontmatter.steps;
          if (requirements.has(ref) && (!Array.isArray(reverse) || !reverse.includes(id))) {
            diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `${id} links ${ref}, but canonical REQ does not link back`, {
              kind: 'step', artifactId: id, field, reference: ref,
            }));
          }
        } else {
          artifactRef(projectRoot, record.document.path, diagnostics, 'step', id, field, ref, ID_PATTERNS.adr, adrs.has(ref));
          const reverse = adrs.get(ref)?.document.frontmatter.steps;
          if (adrs.has(ref) && (!Array.isArray(reverse) || !reverse.includes(id))) {
            diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REVERSE_REFERENCE', `${id} links ${ref}, but canonical ADR does not link back`, {
              kind: 'step', artifactId: id, field, reference: ref,
            }));
          }
        }
      }
    }
  }

  for (const [id, record] of openQuestions) {
    const affects = Array.isArray(record.document.frontmatter.affects)
      ? record.document.frontmatter.affects.filter((x): x is string => typeof x === 'string')
      : [];
    for (const ref of affects) {
      if (ref === 'PROJECT') continue;
      if (ID_PATTERNS.step.test(ref)) {
        artifactRef(projectRoot, record.document.path, diagnostics, 'open_question', id, 'affects', ref, ID_PATTERNS.step, steps.has(ref));
      } else if (ID_PATTERNS.requirement.test(ref)) {
        artifactRef(projectRoot, record.document.path, diagnostics, 'open_question', id, 'affects', ref, ID_PATTERNS.requirement, requirements.has(ref));
      } else if (ID_PATTERNS.adr.test(ref)) {
        artifactRef(projectRoot, record.document.path, diagnostics, 'open_question', id, 'affects', ref, ID_PATTERNS.adr, adrs.has(ref));
      } else {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REFERENCE', `invalid affects target ${ref}`, {
          kind: 'open_question', artifactId: id, field: 'affects', reference: ref,
        }));
      }
    }
  }

  for (const [id, record] of principles) {
    const meta = record.document.frontmatter;
    for (const field of ['requirements', 'adrs'] as const) {
      const refs = Array.isArray(meta[field]) ? meta[field].filter((x): x is string => typeof x === 'string') : [];
      for (const ref of refs) {
        if (field === 'requirements') {
          artifactRef(projectRoot, record.document.path, diagnostics, 'principle', id, field, ref, ID_PATTERNS.requirement, requirements.has(ref));
        } else {
          artifactRef(projectRoot, record.document.path, diagnostics, 'principle', id, field, ref, ID_PATTERNS.adr, adrs.has(ref));
        }
      }
    }
    const supersededBy = meta.superseded_by;
    if (
      supersededBy !== null &&
      supersededBy !== undefined &&
      (typeof supersededBy !== 'string' || !ID_PATTERNS.principle.test(supersededBy))
    ) {
      diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REFERENCE', 'superseded_by must be null or PRN-NNN', {
        kind: 'principle', artifactId: id, field: 'superseded_by',
      }));
    } else if (typeof supersededBy === 'string') {
      if (supersededBy === id) {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REFERENCE', 'principle cannot supersede itself', {
          kind: 'principle', artifactId: id, field: 'superseded_by', reference: supersededBy,
        }));
      } else if (!principles.has(supersededBy)) {
        diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_REFERENCE', `superseding principle does not exist: ${supersededBy}`, {
          kind: 'principle', artifactId: id, field: 'superseded_by', reference: supersededBy,
        }));
      }
    }
    if (meta.status === 'superseded' && typeof supersededBy !== 'string') {
      diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_STATUS', 'superseded principle requires superseded_by', {
        kind: 'principle', artifactId: id, field: 'superseded_by',
      }));
    } else if (meta.status !== 'superseded' && supersededBy != null) {
      diagnostics.push(diagnostic(projectRoot, record.document.path, 'ARTIFACT_STATUS', 'only superseded principle may set superseded_by', {
        kind: 'principle', artifactId: id, field: 'superseded_by',
      }));
    }
  }

  detectCycles(projectRoot, steps, 'step', 'depends_on', diagnostics);
  detectCycles(projectRoot, adrs, 'adr', 'supersedes', diagnostics);
}

function detectCycles(
  projectRoot: string,
  records: Map<string, ArtifactRecord>,
  kind: 'step' | 'adr',
  field: 'depends_on' | 'supersedes',
  diagnostics: ArtifactDiagnostic[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, trail: string[]) => {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      const cycle = [...trail.slice(start >= 0 ? start : 0), id];
      diagnostics.push(
        diagnostic(
          projectRoot,
          records.get(id)?.document.path ?? projectRoot,
          'ARTIFACT_CYCLE',
          `${kind === 'adr' ? 'ADR supersession' : 'STEP dependency'} cycle: ${cycle.join(' -> ')}`,
          { kind, artifactId: id, field },
        ),
      );
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const value = records.get(id)?.document.frontmatter[field];
    const refs = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && records.has(x)) : [];
    for (const ref of refs) visit(ref, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of [...records.keys()].sort()) visit(id, []);
}

function validateReportTimestamp(
  projectRoot: string,
  filePath: string,
  document: ParsedArtifactDocument,
  diagnostics: ArtifactDiagnostic[],
  kind: ArtifactKind,
  prefix: string,
): void {
  const match = new RegExp(`^${prefix}(\\d{8}T\\d{6}Z)\\.md$`).exec(path.basename(filePath));
  if (!match) {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_REPORT_IDENTITY', `filename must match ${prefix}YYYYMMDDTHHMMSSZ.md`, {
      kind,
    }));
    return;
  }
  const createdAt = document.frontmatter.created_at;
  if (!validateIso(createdAt)) {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_REPORT_IDENTITY', 'created_at must be ISO-8601', {
      kind, field: 'created_at',
    }));
    return;
  }
  const stamp = match[1];
  const expected = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  ).getTime();
  const actual = new Date(createdAt as string).getTime();
  if (Number.isNaN(expected) || Number.isNaN(actual) || expected !== actual) {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_REPORT_IDENTITY', 'filename timestamp and created_at must identify the same UTC second', {
      kind, field: 'created_at',
    }));
  }
}

async function flatReports(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
    .filter((entry) => !['README.md', 'TEMPLATE.md'].includes(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function nestedStepReports(directory: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(directory, entry.name);
    for (const report of await markdownFiles(child, prefix)) result.push(report);
  }
  return result.sort();
}

function semanticReviewFields(
  projectRoot: string,
  filePath: string,
  document: ParsedArtifactDocument,
  diagnostics: ArtifactDiagnostic[],
  kind: 'planning_review' | 'init_review',
): void {
  const verdict = document.frontmatter.verdict;
  if (verdict !== 'pass' && verdict !== 'blocked') {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'verdict must be pass|blocked', {
      kind, field: 'verdict',
    }));
  }
  if (document.frontmatter.reviewer_role !== 'reviewer') {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'reviewer_role must be reviewer', {
      kind, field: 'reviewer_role',
    }));
  }
  const count = document.frontmatter.finding_count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'finding_count must be a non-negative integer', {
      kind, field: 'finding_count',
    }));
  } else if (verdict === 'pass' && count !== 0) {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'PASS semantic review requires finding_count=0', {
      kind, field: 'finding_count',
    }));
  } else if (verdict === 'blocked' && count < 1) {
    diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'BLOCKED semantic review requires finding_count>=1', {
      kind, field: 'finding_count',
    }));
  }
  requireSections(projectRoot, filePath, document, diagnostics, kind, REQUIRED_SECTIONS.semanticReview);
}

async function validateReports(
  projectRoot: string,
  config: HarnessConfig,
  collections: ArtifactCollections,
  diagnostics: ArtifactDiagnostic[],
  checked: MutableCounts,
): Promise<void> {
  const reviewDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.reviewDirectory, 'protocol.reviewDirectory');
  const planningDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.planningReviewDirectory, 'protocol.planningReviewDirectory');
  const initDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.initReviewDirectory, 'protocol.initReviewDirectory');
  const auditDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.auditDirectory, 'protocol.auditDirectory');
  const releaseDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.releaseDirectory, 'protocol.releaseDirectory');
  const skillDir = await resolvePortablePathWithinBoundary(projectRoot, config.protocol.skillSearchDirectory, 'protocol.skillSearchDirectory');

  for (const filePath of await nestedStepReports(reviewDir, 'REVIEW-')) {
    checked.step_review += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'step_review');
    if (!document) continue;
    requireSchema(projectRoot, filePath, document, diagnostics, 'step_review', undefined, 'step_review');
    const stepId = document.frontmatter.step_id;
    if (typeof stepId !== 'string' || !ID_PATTERNS.step.test(stepId)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_ID', 'step_id must be STEP-NNN', {
        kind: 'step_review', field: 'step_id',
      }));
    } else {
      artifactRef(projectRoot, filePath, diagnostics, 'step_review', undefined, 'step_id', stepId, ID_PATTERNS.step, collections.steps.has(stepId));
      if (path.basename(path.dirname(filePath)) !== stepId) {
        diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FILENAME', `step_id must match review directory ${path.basename(path.dirname(filePath))}`, {
          kind: 'step_review', field: 'step_id', reference: stepId,
        }));
      }
    }
    if (!isOneOf(document.frontmatter.verdict, REVIEW_VERDICTS)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'verdict must be pass|fail|blocked', {
        kind: 'step_review', field: 'verdict',
      }));
    }
    if (document.frontmatter.reviewer_role !== 'reviewer') {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'reviewer_role must be reviewer', {
        kind: 'step_review', field: 'reviewer_role',
      }));
    }
    validateReportTimestamp(projectRoot, filePath, document, diagnostics, 'step_review', DURABLE_REPORT_PREFIX.step_review);
    requireSections(projectRoot, filePath, document, diagnostics, 'step_review', REQUIRED_SECTIONS.semanticReview);
  }

  for (const filePath of await nestedStepReports(planningDir, 'PLAN-REVIEW-')) {
    checked.planning_review += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'planning_review');
    if (!document) continue;
    requireSchema(projectRoot, filePath, document, diagnostics, 'planning_review', undefined, 'planning_review');
    const stepId = document.frontmatter.step_id;
    if (typeof stepId !== 'string' || !ID_PATTERNS.step.test(stepId)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_ID', 'step_id must be STEP-NNN', {
        kind: 'planning_review', field: 'step_id',
      }));
    } else {
      artifactRef(projectRoot, filePath, diagnostics, 'planning_review', undefined, 'step_id', stepId, ID_PATTERNS.step, collections.steps.has(stepId));
      if (path.basename(path.dirname(filePath)) !== stepId) {
        diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FILENAME', `step_id must match review directory ${path.basename(path.dirname(filePath))}`, {
          kind: 'planning_review', field: 'step_id', reference: stepId,
        }));
      }
    }
    if (!validSha256(document.frontmatter.context_basis)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'context_basis must be sha256', {
        kind: 'planning_review', field: 'context_basis',
      }));
    }
    if (!validSha256(document.frontmatter.plan_content_hash)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'plan_content_hash must be sha256', {
        kind: 'planning_review', field: 'plan_content_hash',
      }));
    }
    validateReportTimestamp(projectRoot, filePath, document, diagnostics, 'planning_review', DURABLE_REPORT_PREFIX.planning_review);
    semanticReviewFields(projectRoot, filePath, document, diagnostics, 'planning_review');
  }

  for (const filePath of (await flatReports(initDir)).filter((item) => path.basename(item).startsWith('INIT-REVIEW-'))) {
    checked.init_review += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'init_review');
    if (!document) continue;
    requireSchema(projectRoot, filePath, document, diagnostics, 'init_review', undefined, 'init_review');
    if (!['requirements', 'roadmap'].includes(String(document.frontmatter.stage))) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'stage must be requirements|roadmap', {
        kind: 'init_review', field: 'stage',
      }));
    }
    if (!validSha256(document.frontmatter.basis)) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'basis must be sha256', {
        kind: 'init_review', field: 'basis',
      }));
    }
    validateReportTimestamp(projectRoot, filePath, document, diagnostics, 'init_review', DURABLE_REPORT_PREFIX.init_review);
    semanticReviewFields(projectRoot, filePath, document, diagnostics, 'init_review');
  }

  for (const filePath of await flatReports(auditDir)) {
    if (!path.basename(filePath).startsWith('AUDIT-')) continue;
    checked.audit += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'audit');
    if (!document) continue;
    requireSchema(projectRoot, filePath, document, diagnostics, 'audit', undefined, 'audit');
    if (typeof document.frontmatter.scope !== 'string' || !document.frontmatter.scope.trim()) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'scope must be non-empty string', { kind: 'audit', field: 'scope' }));
    }
    if (document.frontmatter.mode !== 'audit') {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'mode must be audit', { kind: 'audit', field: 'mode' }));
    }
    if (document.frontmatter.result !== 'complete') {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'result must be complete', { kind: 'audit', field: 'result' }));
    }
    if (document.h1?.startsWith('# Audit — ') !== true) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_H1', "H1 must start with '# Audit — '", { kind: 'audit' }));
    }
    validateReportTimestamp(projectRoot, filePath, document, diagnostics, 'audit', DURABLE_REPORT_PREFIX.audit);
    requireSections(projectRoot, filePath, document, diagnostics, 'audit', REQUIRED_SECTIONS.audit);
  }

  for (const filePath of await flatReports(releaseDir)) {
    if (!path.basename(filePath).startsWith('RELEASE-')) continue;
    checked.release_check += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'release_check');
    if (!document) continue;
    requireSchema(projectRoot, filePath, document, diagnostics, 'release_check', undefined, 'release_check');
    if (typeof document.frontmatter.target !== 'string' || !document.frontmatter.target.trim()) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'target must be non-empty string', { kind: 'release_check', field: 'target' }));
    }
    if (!['ready', 'blocked'].includes(String(document.frontmatter.verdict))) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'verdict must be ready|blocked', { kind: 'release_check', field: 'verdict' }));
    }
    if (document.h1?.startsWith('# Release Check — ') !== true) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_H1', "H1 must start with '# Release Check — '", { kind: 'release_check' }));
    }
    validateReportTimestamp(projectRoot, filePath, document, diagnostics, 'release_check', DURABLE_REPORT_PREFIX.release_check);
    requireSections(projectRoot, filePath, document, diagnostics, 'release_check', REQUIRED_SECTIONS.release);
  }

  for (const filePath of await flatReports(skillDir)) {
    if (!path.basename(filePath).startsWith('SKILL-SEARCH-')) continue;
    checked.skill_search += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'skill_search');
    if (!document) continue;
    requireSchema(projectRoot, filePath, document, diagnostics, 'skill_search', undefined, 'skill_search');
    if (typeof document.frontmatter.query !== 'string' || !document.frontmatter.query.trim()) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'query must be non-empty string', { kind: 'skill_search', field: 'query' }));
    }
    if (document.frontmatter.status !== 'complete') {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_STATUS', 'status must be complete', { kind: 'skill_search', field: 'status' }));
    }
    const count = document.frontmatter.candidate_count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', 'candidate_count must be a non-negative integer', { kind: 'skill_search', field: 'candidate_count' }));
    } else if (count > config.skills.search.maxResults) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_FIELD', `candidate_count exceeds skills.search.maxResults (${config.skills.search.maxResults})`, { kind: 'skill_search', field: 'candidate_count' }));
    }
    if (document.h1?.startsWith('# SKILL SEARCH — ') !== true) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_H1', "H1 must start with '# SKILL SEARCH — '", { kind: 'skill_search' }));
    }
    validateReportTimestamp(projectRoot, filePath, document, diagnostics, 'skill_search', DURABLE_REPORT_PREFIX.skill_search);
    requireSections(projectRoot, filePath, document, diagnostics, 'skill_search', REQUIRED_SECTIONS.skillSearch);
  }
}

async function validateTemplates(
  projectRoot: string,
  config: HarnessConfig,
  diagnostics: ArtifactDiagnostic[],
  checked: MutableCounts,
): Promise<void> {
  const targets = [
    ['requirement', config.sources.requirements, TEMPLATE_CONTRACTS.requirement],
    ['adr', config.sources.adrDirectory, TEMPLATE_CONTRACTS.adr],
    ['step', config.protocol.taskDirectory, TEMPLATE_CONTRACTS.step],
    ['open_question', config.sources.openQuestions, TEMPLATE_CONTRACTS.openQuestion],
    ['principle', config.sources.principles, TEMPLATE_CONTRACTS.principle],
  ] as const;

  for (const [, portableDirectory, contract] of targets) {
    const directory = await resolvePortablePathWithinBoundary(projectRoot, portableDirectory, 'configured template directory');
    const filePath = path.join(directory, contract.file);
    checked.template += 1;
    const document = await safeParse(projectRoot, filePath, diagnostics, 'template');
    if (!document) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_TEMPLATE', 'configured artifact template is missing or invalid', { kind: 'template' }));
      continue;
    }
    if (document.frontmatter.schema !== contract.schema) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_TEMPLATE', 'template schema must be 1', { kind: 'template', field: 'schema' }));
    }
    if (document.frontmatter.id !== contract.id) {
      diagnostics.push(diagnostic(projectRoot, filePath, 'ARTIFACT_TEMPLATE', `template id must be ${contract.id}`, { kind: 'template', field: 'id' }));
    }
    requireSections(projectRoot, filePath, document, diagnostics, 'template', contract.sections, contract.id, new Set(['Resolution', 'Evidence', 'Blocker / Failure reason']));
  }
}

export async function validateProjectArtifacts(
  projectRoot: string,
  providedConfig?: HarnessConfig,
): Promise<ArtifactValidationSummary> {
  const config = providedConfig ?? (await readConfig(projectRoot));
  const diagnostics: ArtifactDiagnostic[] = [];
  const checked = emptyCounts();

  const collections = await collectCanonicalArtifacts(projectRoot, config, diagnostics, checked);
  validateCrossReferences(projectRoot, collections, diagnostics);
  await validateReports(projectRoot, config, collections, diagnostics, checked);
  await validateTemplates(projectRoot, config, diagnostics, checked);

  return {
    schemaVersion: 1,
    status: diagnostics.length === 0 ? 'PASS' : 'FAIL',
    projectRoot,
    harnessRelease: config.harness.release,
    projectSchemaVersion: config.schemaVersion,
    checked,
    diagnostics,
  };
}
