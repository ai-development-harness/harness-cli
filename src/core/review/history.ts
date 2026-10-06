import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ParsedArtifactDocument } from '../artifacts/index.js';
import { parseArtifactDocument } from '../artifacts/index.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { contentHash, isSha256 } from '../planning/hash.js';
import { parseMachineFindings } from './findings.js';
import { repositoryRevision } from './revision.js';
import type { RepositoryRevision, ReviewFinding, ReviewVerdict } from './types.js';

const execFileAsync = promisify(execFile);
const VALID_VERIFICATION = new Set(['PASS','FAIL','MANUAL_REQUIRED','BLOCKED','UNKNOWN','MISSING']);

export interface ReviewReport {
  readonly path: string;
  readonly relativePath: string;
  readonly verdict: ReviewVerdict;
  readonly completionResult: 'PASS' | 'FAIL' | 'BLOCKED' | null;
  readonly document: ParsedArtifactDocument;
  readonly findings: readonly ReviewFinding[];
  readonly contentHash: string;
}

async function reviewRoot(projectRoot: string): Promise<string> {
  const config = await readConfig(projectRoot);
  return resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.reviewDirectory,
    'protocol.reviewDirectory',
  );
}

async function stepRelativePath(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const directory = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.taskDirectory,
    'protocol.taskDirectory',
  );
  return path.relative(projectRoot, path.join(directory, stepId + '.md')).split(path.sep).join('/');
}

function nonEmpty(document: ParsedArtifactDocument, section: string): boolean {
  return typeof document.sections[section] === 'string' && document.sections[section].trim().length > 0;
}

function reviewRevision(value: unknown): RepositoryRevision | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const gitHead = item.gitHead;
  const worktreeHash = item.worktreeHash;
  if (
    gitHead !== null &&
    (typeof gitHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(gitHead))
  ) return null;
  if (worktreeHash !== null && !isSha256(worktreeHash)) return null;
  if (gitHead === null && worktreeHash === null) return null;
  return { gitHead: gitHead as string | null, worktreeHash: worktreeHash as string | null };
}

function parseCompletion(document: ParsedArtifactDocument): Readonly<Record<string, unknown>> | null {
  const section = document.sections['Completion convergence'];
  if (!section) return null;
  const text = section.trim();
  const fence = String.fromCharCode(96).repeat(3);
  const start = fence + 'json\n';
  const end = '\n' + fence;
  if (!text.startsWith(start) || !text.endsWith(end)) return null;
  try {
    const value = JSON.parse(text.slice(start.length, -end.length));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function validateReviewReport(
  projectRoot: string,
  filePath: string,
  options: {
    readonly expectedStepId?: string;
    readonly requireCurrentRevision?: boolean;
  } = {},
): Promise<string[]> {
  const errors: string[] = [];
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    return ['cannot inspect review report: ' + (error as Error).message];
  }
  if (!info.isFile() || info.isSymbolicLink()) return ['durable review report must be a regular non-symlink file'];

  let document: ParsedArtifactDocument;
  try {
    document = await parseArtifactDocument(filePath);
  } catch (error) {
    return [(error as Error).message];
  }
  const meta = document.frontmatter;
  if (meta.schema !== 1) errors.push('schema must be 1');
  if (meta.kind !== 'step_review') errors.push('kind must be step_review');
  if (meta.finding_contract !== 2) errors.push('finding_contract must be 2');
  const stepId = meta.step_id;
  if (typeof stepId !== 'string' || !/^STEP-\d{3,}$/.test(stepId)) {
    errors.push('step_id must be STEP-NNN');
    return errors;
  }
  if (options.expectedStepId && stepId !== options.expectedStepId) errors.push('step_id does not match review directory');

  const verdict = meta.verdict;
  if (!['pass','fail','blocked'].includes(String(verdict))) errors.push('verdict must be pass|fail|blocked');
  if (meta.reviewer_role !== 'reviewer') errors.push('reviewer_role must be reviewer');
  if (typeof meta.created_at !== 'string' || Number.isNaN(Date.parse(meta.created_at))) errors.push('created_at must be ISO-8601');
  if (typeof meta.execution_id !== 'string' || !meta.execution_id.startsWith('exec-')) errors.push('execution_id must bind report to one execution');
  if (!isSha256(meta.contract_basis)) errors.push('contract_basis must be sha256');
  if (!isSha256(meta.verification_basis)) errors.push('verification_basis must be sha256');
  if (!VALID_VERIFICATION.has(String(meta.verification_status))) errors.push('verification_status is invalid');

  for (const section of ['Scope checked','Findings','Machine-readable findings','Verification observations','Verdict rationale']) {
    if (!nonEmpty(document, section)) errors.push("missing or empty section '## " + section + "'");
  }

  let findings: ReviewFinding[] = [];
  try {
    findings = parseMachineFindings(document);
  } catch (error) {
    errors.push((error as Error).message);
  }
  const categories = findings.map((item) => item.category);
  if (verdict === 'pass' && findings.length > 0) errors.push('PASS review must not contain material findings');
  if (verdict === 'fail') {
    if (findings.length === 0) errors.push('FAIL review requires at least one finding');
    if (categories.includes('contract')) errors.push('FAIL cannot contain contract findings; contract defect must BLOCK');
    if (!categories.some((item) => item === 'implementation' || item === 'evidence')) errors.push('FAIL requires implementation/evidence finding');
  }
  if (verdict === 'blocked') {
    if (findings.length === 0) errors.push('BLOCKED review requires at least one finding');
    if (!categories.some((item) => item === 'contract' || item === 'evidence')) errors.push('BLOCKED review requires contract/evidence finding');
  }

  const specialized = meta.specialized_reviews;
  if (typeof specialized !== 'object' || specialized === null || Array.isArray(specialized)) {
    errors.push('specialized_reviews must be a mapping');
  } else {
    const gate = specialized as Record<string, unknown>;
    if (!isSha256(gate.gate_basis)) errors.push('specialized_reviews.gate_basis must be sha256');
    if (!isSha256(gate.changed_paths_hash)) errors.push('specialized_reviews.changed_paths_hash must be sha256');
    if (!['implementation-baseline','clean-tree-fallback'].includes(String(gate.surface_mode))) errors.push('specialized_reviews.surface_mode is invalid');
    if (!['valid','missing','invalid'].includes(String(gate.baseline_status))) errors.push('specialized_reviews.baseline_status is invalid');
    if (!Array.isArray(gate.required) || gate.required.some((item) => item !== 'security' && item !== 'tests')) {
      errors.push('specialized_reviews.required must contain only security/tests');
    } else {
      for (const reviewer of gate.required) {
        const result = gate[reviewer];
        if (typeof result !== 'object' || result === null || Array.isArray(result)) {
          errors.push('required specialized reviewer result is missing: ' + reviewer);
          continue;
        }
        const status = (result as Record<string, unknown>).status;
        if (!['pass','fail','blocked'].includes(String(status))) {
          errors.push('specialized reviewer status is invalid: ' + reviewer);
        }
        if (verdict === 'pass' && status !== 'pass') {
          errors.push('PASS review requires required specialized reviewer PASS: ' + reviewer);
        }
      }
    }
  }

  const completionContract = meta.completion_contract;
  const completionResult = meta.completion_result;
  if (completionContract !== undefined) {
    if (verdict !== 'pass') errors.push('completion_contract is allowed only for PASS review');
    if (completionContract !== 1) errors.push('completion_contract must be 1');
    if (!['pass','fail','blocked'].includes(String(completionResult))) errors.push('completion_result must be pass|fail|blocked');
    const completion = parseCompletion(document);
    if (!completion) errors.push('Completion convergence must contain one JSON object');
    else {
      if (completion.schemaVersion !== 1) errors.push('Completion convergence schemaVersion must be 1');
      const expected = String(completionResult).toUpperCase();
      if (completion.completionResult !== expected) errors.push('Completion convergence result differs from frontmatter');
      const expectedStatus = expected === 'PASS' ? 'PASS' : expected === 'FAIL' ? 'INCOMPLETE' : 'BLOCKED';
      if (completion.status !== expectedStatus) errors.push('Completion convergence status differs from result');
      const values = Array.isArray(completion.findings) ? completion.findings : null;
      if (!values) errors.push('Completion convergence findings must be an array');
      else {
        if (expected === 'PASS' && values.length > 0) errors.push('Completion convergence PASS must not contain findings');
        if (expected !== 'PASS' && values.length === 0) errors.push('Completion convergence FAIL/BLOCKED requires findings');
        const route = expected === 'FAIL' ? 'FIX' : expected === 'BLOCKED' ? 'BLOCKED' : null;
        if (route && values.some((item) =>
          typeof item !== 'object' || item === null || (item as Record<string, unknown>).route !== route
        )) errors.push('Completion convergence finding route differs from result');
        if (expected === 'FAIL' && values.some((item) =>
          typeof item === 'object' && item !== null && (item as Record<string, unknown>).kind === 'contract_gap'
        )) errors.push('Completion convergence contract_gap cannot route to FIX');
      }
    }
  }

  const revision = reviewRevision(meta.reviewed_revision);
  if (!revision) errors.push('reviewed_revision must be a valid mapping');
  else if (options.requireCurrentRevision) {
    const relativeReport = path.relative(projectRoot, filePath).split(path.sep).join('/');
    const stepPath = await stepRelativePath(projectRoot, stepId);
    const current = await repositoryRevision(projectRoot, {
      ignoredPaths: new Set([relativeReport]),
      normalizeStepStatusPaths: new Set([stepPath]),
    });
    if (JSON.stringify(current) !== JSON.stringify(revision)) {
      errors.push('reviewed_revision does not match current repository state');
    }
  }

  return errors;
}

export async function reviewReports(
  projectRoot: string,
  stepId: string,
): Promise<ReviewReport[]> {
  const root = await reviewRoot(projectRoot);
  const directory = path.join(root, stepId);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /^REVIEW-.+\.md$/.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const reports: ReviewReport[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    if ((await validateReviewReport(projectRoot, filePath, { expectedStepId: stepId })).length > 0) continue;
    const document = await parseArtifactDocument(filePath);
    const findings = parseMachineFindings(document);
    reports.push({
      path: filePath,
      relativePath: path.relative(projectRoot, filePath).split(path.sep).join('/'),
      verdict: document.frontmatter.verdict as ReviewVerdict,
      completionResult:
        typeof document.frontmatter.completion_result === 'string'
          ? document.frontmatter.completion_result.toUpperCase() as 'PASS' | 'FAIL' | 'BLOCKED'
          : null,
      document,
      findings,
      contentHash: contentHash(document.text),
    });
  }
  return reports;
}

export async function latestReview(
  projectRoot: string,
  stepId: string,
  options: { readonly requireCurrentRevision?: boolean } = {},
): Promise<ReviewReport | null> {
  const reports = await reviewReports(projectRoot, stepId);
  const report = reports.at(-1) ?? null;
  if (!report || !options.requireCurrentRevision) return report;
  return (await validateReviewReport(projectRoot, report.path, {
    expectedStepId: stepId,
    requireCurrentRevision: true,
  })).length === 0 ? report : null;
}

export async function reportForExecution(
  projectRoot: string,
  stepId: string,
  executionId: string,
): Promise<ReviewReport | null> {
  const reports = await reviewReports(projectRoot, stepId);
  return reports.find((report) => report.document.frontmatter.execution_id === executionId) ?? null;
}

export async function validateReviewImmutability(projectRoot: string): Promise<string[]> {
  const root = await reviewRoot(projectRoot);
  const relative = path.relative(projectRoot, root).split(path.sep).join('/');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', relative], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60_000,
    }));
  } catch (error) {
    return ['cannot inspect immutable review history: ' + (error as Error).message];
  }
  const fields = stdout.split('\0').filter(Boolean);
  const errors: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    const destination = field.slice(3);
    const reportLike = /(?:^|\/)STEP-\d{3,}\/REVIEW-.+\.md$/.test(destination);
    let source: string | null = null;
    if (xy.includes('R') || xy.includes('C')) source = fields[++index] ?? null;
    if (!reportLike && !(source && /(?:^|\/)STEP-\d{3,}\/REVIEW-.+\.md$/.test(source))) continue;
    const newOnly = source === null && (xy === '??' || xy.startsWith('A'));
    if (!newOnly) errors.push('immutable review history changed: ' + destination);
  }
  return errors;
}
