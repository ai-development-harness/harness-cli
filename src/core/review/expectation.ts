import path from 'node:path';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { planningContextBasis } from '../planning/index.js';
import { requiredReviewers } from './gates.js';
import { repositoryRevision } from './revision.js';
import type { ReviewExpectationV1 } from './types.js';
import { verificationBasis } from './verification.js';

async function stepRelativePath(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const directory = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.taskDirectory,
    'protocol.taskDirectory',
  );
  return path.relative(projectRoot, path.join(directory, stepId + '.md')).split(path.sep).join('/');
}

export async function captureReviewExpectation(
  projectRoot: string,
  stepId: string,
  implementationBaseline: string | null,
  capturedAt = new Date().toISOString(),
): Promise<ReviewExpectationV1> {
  const stepPath = await stepRelativePath(projectRoot, stepId);
  const [gate, contextBasis, verification] = await Promise.all([
    requiredReviewers(projectRoot, stepId, implementationBaseline),
    planningContextBasis(projectRoot, stepId),
    verificationBasis(projectRoot, stepId),
  ]);
  const revision = await repositoryRevision(projectRoot, {
    normalizeStepStatusPaths: new Set([stepPath]),
  });
  return {
    schemaVersion: 1,
    stepId,
    repositoryRevision: revision,
    gateBasis: gate.basis,
    contextBasis,
    verificationBasis: verification,
    requiredReviewers: gate.required,
    capturedAt,
  };
}
