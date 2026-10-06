import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArtifactDocument } from '../artifacts/index.js';
import type { ParsedArtifactDocument } from '../artifacts/index.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { isSha256 } from './hash.js';
import { initReviewBasis, planContentHash, planningContextBasis } from './contracts.js';

function nonEmpty(document: ParsedArtifactDocument, name: string): boolean {
  const value = document.sections[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function semanticReviewErrors(
  document: ParsedArtifactDocument,
  verdict: unknown,
): string[] {
  const errors: string[] = [];
  for (const section of ['Scope checked', 'Findings', 'Verdict rationale']) {
    if (!nonEmpty(document, section)) errors.push(`missing or empty section '## ${section}'`);
  }
  const count = document.frontmatter.finding_count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    errors.push('finding_count must be a non-negative integer');
  } else if (verdict === 'pass' && count !== 0) {
    errors.push('PASS semantic review requires finding_count=0');
  } else if (verdict === 'blocked' && (count as number) < 1) {
    errors.push('BLOCKED semantic review requires finding_count>=1');
  }
  return errors;
}

export function validatePlanningReviewDocument(
  document: ParsedArtifactDocument,
  expectedStepId?: string,
): string[] {
  const errors: string[] = [];
  const meta = document.frontmatter;
  const stepId = meta.step_id;
  if (typeof stepId !== 'string' || !/^STEP-\d{3,}$/.test(stepId)) {
    errors.push('step_id must be STEP-NNN');
  } else if (expectedStepId && stepId !== expectedStepId) {
    errors.push(`step_id must match review directory ${expectedStepId}`);
  }
  if (!['pass', 'blocked'].includes(String(meta.verdict))) errors.push('verdict must be pass|blocked');
  if (meta.reviewer_role !== 'reviewer') errors.push('reviewer_role must be reviewer (independent from planner)');
  if (!isSha256(meta.context_basis)) errors.push('context_basis must be sha256');
  if (!isSha256(meta.plan_content_hash)) errors.push('plan_content_hash must be sha256');
  errors.push(...semanticReviewErrors(document, meta.verdict));
  return errors;
}

export function validateInitReviewDocument(
  document: ParsedArtifactDocument,
  expectedStage?: 'requirements' | 'roadmap',
): string[] {
  const errors: string[] = [];
  const meta = document.frontmatter;
  if (!['requirements', 'roadmap'].includes(String(meta.stage))) {
    errors.push('stage must be requirements|roadmap');
  } else if (expectedStage && meta.stage !== expectedStage) {
    errors.push(`stage must be ${expectedStage}`);
  }
  if (!['pass', 'blocked'].includes(String(meta.verdict))) errors.push('verdict must be pass|blocked');
  if (meta.reviewer_role !== 'reviewer') errors.push('reviewer_role must be reviewer (independent from initializer)');
  if (!isSha256(meta.basis)) errors.push('basis must be sha256');
  errors.push(...semanticReviewErrors(document, meta.verdict));
  return errors;
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
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export async function planningReviewReports(
  projectRoot: string,
  stepId: string,
): Promise<readonly Readonly<{ path: string; document: ParsedArtifactDocument }>[]> {
  const config = await readConfig(projectRoot);
  const root = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.planningReviewDirectory,
    'protocol.planningReviewDirectory',
  );
  const directory = path.join(root, stepId);
  const result: Array<{ path: string; document: ParsedArtifactDocument }> = [];
  for (const file of await markdownFiles(directory, 'PLAN-REVIEW-')) {
    const document = await parseArtifactDocument(file);
    if (validatePlanningReviewDocument(document, stepId).length === 0) {
      result.push({ path: file, document });
    }
  }
  return result;
}

export async function latestPlanningReviewFor(
  projectRoot: string,
  stepId: string,
  basis: string,
  planHash: string,
): Promise<Readonly<{ path: string; document: ParsedArtifactDocument }> | null> {
  const reports = await planningReviewReports(projectRoot, stepId);
  for (const report of [...reports].reverse()) {
    const meta = report.document.frontmatter;
    if (meta.context_basis === basis && meta.plan_content_hash === planHash) {
      return meta.verdict === 'pass' ? report : null;
    }
  }
  return null;
}

export async function latestMatchingPlanningReview(
  projectRoot: string,
  stepId: string,
): Promise<Readonly<{ path: string; document: ParsedArtifactDocument }> | null> {
  return latestPlanningReviewFor(
    projectRoot,
    stepId,
    await planningContextBasis(projectRoot, stepId),
    await planContentHash(projectRoot, stepId),
  );
}

export async function initReviewReports(
  projectRoot: string,
): Promise<readonly Readonly<{ path: string; document: ParsedArtifactDocument }>[]> {
  const config = await readConfig(projectRoot);
  const directory = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.initReviewDirectory,
    'protocol.initReviewDirectory',
  );
  const result: Array<{ path: string; document: ParsedArtifactDocument }> = [];
  for (const file of await markdownFiles(directory, 'INIT-REVIEW-')) {
    const document = await parseArtifactDocument(file);
    if (validateInitReviewDocument(document).length === 0) result.push({ path: file, document });
  }
  return result;
}

export async function latestMatchingInitReview(
  projectRoot: string,
  stage: 'requirements' | 'roadmap',
): Promise<string | null> {
  const basis = await initReviewBasis(projectRoot, stage);
  const reports = await initReviewReports(projectRoot);
  for (const report of [...reports].reverse()) {
    const meta = report.document.frontmatter;
    if (meta.stage === stage && meta.basis === basis) {
      return meta.verdict === 'pass' ? report.path : null;
    }
  }
  return null;
}
