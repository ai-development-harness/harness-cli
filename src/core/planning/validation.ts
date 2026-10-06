import path from 'node:path';
import { buildArtifactInventory } from '../project/index.js';
import { implementationPlanStepCount, normalizeExecutionGroups } from './execution-groups.js';
import { isSha256 } from './hash.js';
import {
  planContentHash,
  planningContextBasis,
} from './contracts.js';
import {
  initReviewReports,
  latestPlanningReviewFor,
  planningReviewReports,
  validateInitReviewDocument,
  validatePlanningReviewDocument,
} from './reviews.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function unresolvedPlaceholder(value: string): boolean {
  return /(?mi)^\s*(?:[-*]\s*)?(?:TBD|TODO|\?\?\?)\s*$/.test(value);
}

export interface PlanningValidationResult {
  readonly schemaVersion: 1;
  readonly status: 'PASS' | 'FAIL';
  readonly errors: readonly string[];
}

export async function validatePlanningState(projectRoot: string): Promise<PlanningValidationResult> {
  const errors: string[] = [];
  const inventory = await buildArtifactInventory(projectRoot);
  if (inventory.diagnostics.length > 0) {
    errors.push(...inventory.diagnostics.map((item) => `artifact: ${item.path ?? ''}: ${item.message ?? item.code}`));
  }

  for (const step of inventory.byType.STEP) {
    const prefix = `planning: ${step.id}`;
    const meta = step.document.frontmatter;
    const planValue = meta.plan;
    if (typeof planValue !== 'object' || planValue === null || Array.isArray(planValue)) {
      errors.push(`${prefix}: plan must be a mapping`);
      continue;
    }
    const plan = planValue as Record<string, unknown>;

    if (plan.context_components !== undefined) {
      if (!Array.isArray(plan.context_components)) {
        errors.push(`${prefix}: plan.context_components must be a string array`);
      } else {
        const keys = new Set<string>();
        plan.context_components.forEach((component, index) => {
          if (typeof component !== 'string' || !component.includes('=')) {
            errors.push(`${prefix}: plan.context_components[${index}] must be COMPONENT=sha256`);
            return;
          }
          const cut = component.lastIndexOf('=');
          const key = component.slice(0, cut);
          const digest = component.slice(cut + 1);
          if (!/^(?:STEP|REQ|ADR|ARCH|OQ|PRN)@/.test(key)) {
            errors.push(`${prefix}: plan.context_components[${index}] has unsupported component key`);
          }
          if (!isSha256(digest)) {
            errors.push(`${prefix}: plan.context_components[${index}] must end with sha256`);
          }
          if (keys.has(key)) errors.push(`${prefix}: duplicate plan.context_components key ${key}`);
          keys.add(key);
        });
      }
    }

    if (plan.execution_groups !== undefined) {
      try {
        normalizeExecutionGroups(
          plan.execution_groups,
          implementationPlanStepCount(step.document.sections['Implementation plan'] ?? ''),
        );
      } catch (error) {
        errors.push(`${prefix}: ${(error as Error).message}`);
      }
    }

    if (plan.status !== 'ready') continue;

    for (const section of [
      'Goal',
      'Context',
      'Scope',
      'Mutation policy',
      'Out of scope',
      'Acceptance criteria',
      'Verification',
      'Deliverables',
      'Implementation plan',
    ]) {
      const value = step.document.sections[section] ?? '';
      if (!value.trim()) errors.push(`${prefix}: empty section '## ${section}'`);
      if (unresolvedPlaceholder(value)) errors.push(`${prefix}: unresolved placeholder in '## ${section}'`);
    }
    if (String(meta.phase).toUpperCase() === 'TBD') errors.push(`${prefix}: ready plan has phase=TBD`);

    const relevant = new Set([step.id, ...strings(meta.requirements), ...strings(meta.adrs)]);
    for (const oq of inventory.byType.OQ) {
      if (
        oq.document.frontmatter.status === 'open' &&
        strings(oq.document.frontmatter.affects).some((target) => relevant.has(target))
      ) {
        errors.push(`${prefix}: ready plan is blocked by ${oq.id}`);
      }
    }

    for (const adrId of strings(meta.adrs)) {
      const adr = inventory.byId.get(adrId);
      if (!adr || adr.type !== 'ADR') {
        errors.push(`${prefix}: canonical ADR missing: ${adrId}`);
        continue;
      }
      const status = adr.document.frontmatter.status;
      if (status !== 'accepted' && !(meta.type === 'adr' && status === 'proposed')) {
        errors.push(`${prefix}: ready plan references non-accepted ${adrId}`);
      }
    }

    let basis: string | null = null;
    let content: string | null = null;
    try {
      basis = await planningContextBasis(projectRoot, step.id);
    } catch (error) {
      errors.push(`${prefix}: cannot compute context basis: ${(error as Error).message}`);
    }
    try {
      content = await planContentHash(projectRoot, step.id);
    } catch (error) {
      errors.push(`${prefix}: cannot compute plan content hash: ${(error as Error).message}`);
    }

    if (basis !== null && plan.context_basis !== basis) errors.push(`${prefix}: ready plan context_basis is stale`);
    if (content !== null && plan.content_hash !== content) errors.push(`${prefix}: ready plan content_hash is stale`);
    if (!isSha256(plan.context_basis)) errors.push(`${prefix}: ready plan context_basis must be sha256`);
    if (!isSha256(plan.content_hash)) errors.push(`${prefix}: ready plan content_hash must be sha256`);
    if (typeof plan.reviewed_report !== 'string' || !plan.reviewed_report) {
      errors.push(`${prefix}: ready plan missing reviewed_report`);
    }
    if (typeof plan.planned_at !== 'string' || Number.isNaN(Date.parse(plan.planned_at))) {
      errors.push(`${prefix}: ready plan planned_at must be ISO-8601`);
    }

    if (isSha256(plan.context_basis) && isSha256(plan.content_hash)) {
      const matched = await latestPlanningReviewFor(
        projectRoot,
        step.id,
        plan.context_basis,
        plan.content_hash,
      );
      if (!matched) {
        errors.push(`${prefix}: ready plan has no PASS planning-review for stored basis/content`);
      } else {
        const relative = path.relative(projectRoot, matched.path).split(path.sep).join('/');
        if (plan.reviewed_report !== relative) {
          errors.push(`${prefix}: plan.reviewed_report does not point to matching PASS report`);
        }
      }
    }
  }

  for (const step of inventory.byType.STEP) {
    for (const report of await planningReviewReports(projectRoot, step.id)) {
      for (const issue of validatePlanningReviewDocument(report.document, step.id)) {
        errors.push(`planning-review: ${path.relative(projectRoot, report.path).split(path.sep).join('/')}: ${issue}`);
      }
    }
  }
  for (const report of await initReviewReports(projectRoot)) {
    for (const issue of validateInitReviewDocument(report.document)) {
      errors.push(`init-review: ${path.relative(projectRoot, report.path).split(path.sep).join('/')}: ${issue}`);
    }
  }

  return { schemaVersion: 1, status: errors.length > 0 ? 'FAIL' : 'PASS', errors };
}
