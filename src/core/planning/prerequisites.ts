import path from 'node:path';
import { buildArtifactInventory } from '../project/index.js';
import type {
  CompletionProofFact,
  ProjectReadModelProviders,
} from '../project/index.js';
import {
  planContentHash,
  planStaleness,
  planningContextBasis,
} from './contracts.js';
import { isSha256 } from './hash.js';
import { latestPlanningReviewFor } from './reviews.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface PlanningPrerequisiteOptions {
  readonly completion?: (stepId: string) => Promise<CompletionProofFact>;
}

export async function implementationPrerequisiteFailures(
  projectRoot: string,
  stepId: string,
  options: PlanningPrerequisiteOptions = {},
): Promise<string[]> {
  const failures: string[] = [];
  const inventory = await buildArtifactInventory(projectRoot);
  if (inventory.diagnostics.length > 0) {
    return inventory.diagnostics.map((item) => `artifact-integrity:${item.message ?? item.code}`);
  }

  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') return [`step-unavailable:${stepId}`];
  const meta = step.document.frontmatter;
  const planValue = meta.plan;

  if (typeof planValue !== 'object' || planValue === null || Array.isArray(planValue) || (planValue as Record<string, unknown>).status !== 'ready') {
    failures.push('plan-is-not-ready');
  } else {
    const plan = planValue as Record<string, unknown>;
    let currentBasis: string | null = null;
    try {
      currentBasis = await planningContextBasis(projectRoot, stepId);
    } catch (error) {
      failures.push(`context-basis-unavailable:${(error as Error).message}`);
    }

    let currentContent: string | null = null;
    try {
      currentContent = await planContentHash(projectRoot, stepId);
    } catch (error) {
      failures.push(`plan-content-unavailable:${(error as Error).message}`);
    }

    const storedBasis = plan.context_basis;
    const storedContent = plan.content_hash;
    if (currentBasis !== null && storedBasis !== currentBasis) failures.push('plan-context-basis-is-stale');
    if (currentContent !== null && storedContent !== currentContent) failures.push('plan-content-hash-is-stale');

    if (isSha256(storedBasis) && isSha256(storedContent)) {
      const matched = await latestPlanningReviewFor(projectRoot, stepId, storedBasis, storedContent);
      if (!matched) {
        failures.push('matching-planning-review-pass-is-missing');
      } else {
        const report = path.relative(projectRoot, matched.path).split(path.sep).join('/');
        if (plan.reviewed_report !== report) failures.push('reviewed-report-does-not-match-pass');
      }
    } else {
      failures.push('plan-fingerprints-are-invalid');
    }
  }

  if (String(meta.phase).toUpperCase() === 'TBD') failures.push('phase-is-tbd');

  for (const adrId of strings(meta.adrs)) {
    const adr = inventory.byId.get(adrId);
    if (!adr || adr.type !== 'ADR') {
      failures.push(`adr-unavailable:${adrId}`);
      continue;
    }
    const status = adr.document.frontmatter.status;
    const allowed = status === 'accepted' || (meta.type === 'adr' && status === 'proposed');
    if (!allowed) failures.push(`adr-not-accepted:${adrId}`);
  }

  const relevant = new Set([stepId, ...strings(meta.requirements), ...strings(meta.adrs)]);
  for (const oq of inventory.byType.OQ) {
    if (
      oq.document.frontmatter.status === 'open' &&
      strings(oq.document.frontmatter.affects).some((target) => relevant.has(target))
    ) {
      failures.push(`open-question:${oq.id}`);
    }
  }

  for (const dependencyId of strings(meta.depends_on)) {
    const dependency = inventory.byId.get(dependencyId);
    if (!dependency || dependency.type !== 'STEP') {
      failures.push(`dependency-unprovable:${dependencyId}:missing canonical STEP`);
      continue;
    }
    if (!options.completion) {
      failures.push(`dependency-unprovable:${dependencyId}:completion-proof-provider-unavailable`);
      continue;
    }
    try {
      const proof = await options.completion(dependencyId);
      if (!proof.complete) {
        failures.push(`dependency-incomplete:${dependencyId}:${proof.reasons.join('; ')}`);
      }
    } catch (error) {
      failures.push(`dependency-unprovable:${dependencyId}:${(error as Error).message}`);
    }
  }

  return failures;
}

export function createPlanningProjectProviders(
  projectRoot: string,
  options: PlanningPrerequisiteOptions = {},
): ProjectReadModelProviders {
  return {
    completion: options.completion,
    planFreshness: (stepId) => planStaleness(projectRoot, stepId),
    implementationPrerequisites: (stepId) =>
      implementationPrerequisiteFailures(projectRoot, stepId, options),
  };
}
