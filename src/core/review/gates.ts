import { readConfig } from '../config.js';
import { buildArtifactInventory } from '../project/index.js';
import { stableHash } from '../planning/hash.js';
import { reviewSurface } from './revision.js';
import type { ReviewGate } from './types.js';

const SECURITY_FLAGS = new Set([
  'security-sensitive',
  'data-migration',
  'destructive',
  'public-api',
  'external-integration',
]);
const TEST_TYPES = new Set(['implementation', 'bugfix', 'refactor', 'hardening']);
const SECURITY_PATH_RE = /(auth|security|crypto|permission|session|token|secret|migration|iam|oauth)/i;
const TEST_SURFACE_RE = /(\.(py|ts|tsx|js|jsx|go|rs|java|kt|cs|rb|php)$|(^|\/)(src|lib|app|tests?|spec)(\/|$))/i;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export async function requiredReviewers(
  projectRoot: string,
  stepId: string,
  implementationBaseline: string | null,
): Promise<ReviewGate> {
  const [config, inventory, surface] = await Promise.all([
    readConfig(projectRoot),
    buildArtifactInventory(projectRoot),
    reviewSurface(projectRoot, implementationBaseline),
  ]);
  if (inventory.diagnostics.length > 0) {
    throw new Error(
      'canonical artifact inventory is invalid: ' +
        inventory.diagnostics.map((item) => item.message ?? item.code).join('; '),
    );
  }
  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') throw new Error(stepId + ': canonical STEP is missing');

  const flags = new Set(strings(step.document.frontmatter.risk_flags));
  const stepType = String(step.document.frontmatter.type ?? '');
  const required = new Set<'security' | 'tests'>();
  const reasons: Record<'security' | 'tests', string[]> = {
    security: [],
    tests: [],
  };

  if (surface.surfaceMode === 'clean-tree-fallback') {
    required.add('security');
    required.add('tests');
    const reason = surface.baselineReason ?? 'exact implementation baseline is unavailable';
    reasons.security.push(reason);
    reasons.tests.push(reason);
  }

  if (config.review.security === 'always') {
    required.add('security');
    reasons.security.push('review.security=always');
  } else {
    const matched = [...flags].filter((item) => SECURITY_FLAGS.has(item)).sort();
    if (matched.length > 0) {
      required.add('security');
      reasons.security.push('risk_flags=' + matched.join(','));
    }
    if (surface.changedPaths.some((item) => SECURITY_PATH_RE.test(item))) {
      required.add('security');
      reasons.security.push('security-relevant changed paths');
    }
  }

  if (config.review.tests === 'always') {
    required.add('tests');
    reasons.tests.push('review.tests=always');
  } else {
    if (TEST_TYPES.has(stepType)) {
      required.add('tests');
      reasons.tests.push('step type=' + stepType);
    }
    if (surface.changedPaths.some((item) => TEST_SURFACE_RE.test(item))) {
      required.add('tests');
      reasons.tests.push('code/test surface changed');
    }
  }

  const basisPayload = {
    schema: 2,
    stepId,
    stepType,
    riskFlags: [...flags].sort(),
    securityPolicy: config.review.security,
    testsPolicy: config.review.tests,
    changedPaths: surface.changedPaths,
    changedPathsHash: surface.changedPathsHash,
    surfaceMode: surface.surfaceMode,
    implementationBaseline: surface.implementationBaseline,
    baselineStatus: surface.baselineStatus,
    baselineReason: surface.baselineReason,
  };

  return {
    stepId,
    required: [...required].sort(),
    reasons,
    changedPaths: surface.changedPaths,
    changedPathsHash: surface.changedPathsHash,
    surfaceMode: surface.surfaceMode,
    implementationBaseline: surface.implementationBaseline,
    baselineStatus: surface.baselineStatus,
    baselineReason: surface.baselineReason,
    basis: stableHash(basisPayload),
  };
}
