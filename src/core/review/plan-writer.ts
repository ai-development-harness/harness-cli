import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArtifactDocument } from '../artifacts/index.js';
import { readConfig } from '../config.js';
import {
  captureIntentBasis,
  completeCurrent,
  readExecutionState,
} from '../execution/index.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import {
  executionGroupsToStorage,
  normalizeExecutionGroups,
  planContentHash,
  planningContextFingerprints,
  validatePlanningReviewDocument,
} from '../planning/index.js';
import { ReviewCoreError } from './errors.js';
import {
  atomicWriteText,
  createTimestampedReport,
  renderDocument,
  replaceH2Section,
} from './document-write.js';
import {
  renderVerificationEntries,
  validateVerificationEntries,
} from './verification.js';

interface PlanStep {
  readonly title: string;
  readonly actions: readonly string[];
  readonly files: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly string[];
}

function text(value: unknown, label: string, singleLine = false): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', label + ' must be a non-empty string');
  }
  const result = value.trim();
  if (singleLine && /[\r\n]/.test(result)) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', label + ' must be a single line');
  }
  return result;
}

function stringList(value: unknown, label: string, required = false): string[] {
  if (value === undefined || value === null) {
    if (required) throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', label + ' must not be empty');
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', label + ' must be an array');
  }
  const result = value.map((item, index) => text(item, label + '[' + index + ']', true));
  if (required && result.length === 0) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', label + ' must not be empty');
  }
  return result;
}

function normalizeImplementationPlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'implementationPlan must be a non-empty array');
  }
  const allowed = new Set(['title','actions','files','tests','risks']);
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'implementationPlan[' + index + '] must be an object');
    }
    const item = raw as Record<string, unknown>;
    const unknown = Object.keys(item).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new ReviewCoreError(
        'SEMANTIC_PAYLOAD_INVALID',
        'implementationPlan[' + index + '] has unsupported keys: ' + unknown.sort().join(', '),
      );
    }
    return {
      title: text(item.title, 'implementationPlan[' + index + '].title', true),
      actions: stringList(item.actions, 'implementationPlan[' + index + '].actions', true),
      files: stringList(item.files, 'implementationPlan[' + index + '].files'),
      tests: stringList(item.tests, 'implementationPlan[' + index + '].tests'),
      risks: stringList(item.risks, 'implementationPlan[' + index + '].risks'),
    };
  });
}

function renderImplementationPlan(steps: readonly PlanStep[]): string {
  const lines: string[] = [];
  for (const [index, step] of steps.entries()) {
    lines.push('### ' + (index + 1) + '. ' + step.title, '');
    lines.push('**Actions**', ...step.actions.map((item) => '- ' + item), '');
    lines.push('**Files**', ...(step.files.length ? step.files.map((item) => '- ' + item) : ['- none']), '');
    lines.push('**Tests**', ...(step.tests.length ? step.tests.map((item) => '- ' + item) : ['- none']), '');
    lines.push('**Risks**', ...(step.risks.length ? step.risks.map((item) => '- ' + item) : ['- none']), '');
  }
  return lines.join('\n').trim();
}

function bodyOf(documentText: string): string {
  const end = documentText.indexOf('\n---\n', 4);
  if (end < 0) throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'STEP frontmatter is malformed');
  return documentText.slice(end + 5);
}

async function taskPath(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const directory = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.taskDirectory,
    'protocol.taskDirectory',
  );
  return path.join(directory, stepId + '.md');
}

async function planningReviewDirectory(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const root = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.planningReviewDirectory,
    'protocol.planningReviewDirectory',
  );
  return path.join(root, stepId);
}

async function activePlanExecution(
  projectRoot: string,
  rootCommand: string,
  stepId: string,
  executionId: string,
) {
  const state = await readExecutionState(projectRoot);
  const execution = state.executions.find((item) => item.executionId === executionId);
  if (
    !execution ||
    execution.rootCommand !== rootCommand ||
    execution.status !== 'running' ||
    execution.current.status !== 'running' ||
    execution.current.command !== 'STEP PLAN ' + stepId
  ) {
    throw new ReviewCoreError(
      'REVIEW_EXECUTION_MISMATCH',
      'plan proposal does not own the current STEP PLAN command',
      { executionId, rootCommand, stepId },
    );
  }
  return execution;
}

async function assertPlanIntentFresh(
  projectRoot: string,
  rootCommand: string,
  stepId: string,
  executionId: string,
): Promise<void> {
  const execution = await activePlanExecution(projectRoot, rootCommand, stepId, executionId);
  const stored = execution.current.context.intentBasis;
  if (!stored) {
    throw new ReviewCoreError(
      'REVIEW_EXPECTATION_MISSING',
      execution.current.context.intentBasisError?.message ?? 'STEP PLAN has no stamped Intent Basis',
    );
  }
  const current = await captureIntentBasis(projectRoot, 'STEP PLAN ' + stepId);
  if (!current || current.contextBasis !== stored.contextBasis) {
    throw new ReviewCoreError(
      'REVIEW_STALE_BASIS',
      'STEP PLAN context changed after semantic handoff',
      {
        storedContextBasis: stored.contextBasis,
        currentContextBasis: current?.contextBasis ?? null,
        remediation: 'STEP PLAN ' + stepId,
      },
    );
  }
}

function normalizePlanningReview(value: unknown): Readonly<{
  verdict: 'pass' | 'blocked';
  findings: readonly string[];
  rationale: string;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'planning review proposal must be an object');
  }
  const item = value as Record<string, unknown>;
  const unknown = Object.keys(item).filter((key) => !['verdict','findings','rationale'].includes(key));
  if (unknown.length > 0) {
    throw new ReviewCoreError(
      'SEMANTIC_PAYLOAD_INVALID',
      'planning review proposal has unsupported keys: ' + unknown.sort().join(', '),
    );
  }
  if (item.verdict !== 'pass' && item.verdict !== 'blocked') {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'planning review verdict must be pass|blocked');
  }
  if (!Array.isArray(item.findings)) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'planning review findings must be an array');
  }
  const findings = item.findings.map((entry, index) => text(entry, 'planningReview.findings[' + index + ']'));
  if (item.verdict === 'pass' && findings.length > 0) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'PASS planning review must have no findings');
  }
  if (item.verdict === 'blocked' && findings.length === 0) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'BLOCKED planning review requires findings');
  }
  return {
    verdict: item.verdict,
    findings,
    rationale: text(item.rationale, 'planningReview.rationale'),
  };
}

export async function commitStepPlan(
  projectRoot: string,
  options: {
    readonly rootCommand: string;
    readonly stepId: string;
    readonly executionId: string;
    readonly plannerProposal: unknown;
    readonly reviewProposal: unknown;
    readonly now?: Date;
  },
): Promise<Readonly<Record<string, unknown>>> {
  await assertPlanIntentFresh(
    projectRoot,
    options.rootCommand,
    options.stepId,
    options.executionId,
  );

  if (
    typeof options.plannerProposal !== 'object' ||
    options.plannerProposal === null ||
    Array.isArray(options.plannerProposal)
  ) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'plan payload must be an object');
  }
  const planner = options.plannerProposal as Record<string, unknown>;
  const unknown = Object.keys(planner).filter((key) =>
    !['implementationPlan','verification','executionGroups'].includes(key)
  );
  if (unknown.length > 0) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'plan payload has unsupported keys: ' + unknown.sort().join(', '));
  }

  const implementationPlan = normalizeImplementationPlan(planner.implementationPlan);
  const verification = validateVerificationEntries(planner.verification);
  const groups = normalizeExecutionGroups(planner.executionGroups, implementationPlan.length);
  const review = normalizePlanningReview(options.reviewProposal);

  const target = await taskPath(projectRoot, options.stepId);
  const original = await parseArtifactDocument(target);
  const planValue = original.frontmatter.plan;
  if (typeof planValue !== 'object' || planValue === null || Array.isArray(planValue)) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'STEP frontmatter.plan must be an object');
  }
  const currentPlan = planValue as Record<string, unknown>;
  const revision = currentPlan.revision;
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'STEP plan.revision must be a non-negative integer');
  }

  let body = bodyOf(original.text);
  body = replaceH2Section(body, 'Verification', renderVerificationEntries(verification));
  body = replaceH2Section(body, 'Implementation plan', renderImplementationPlan(implementationPlan));
  const draftMeta = {
    ...original.frontmatter,
    plan: {
      status: 'draft',
      revision,
      context_basis: null,
      content_hash: null,
      reviewed_report: null,
      planned_at: null,
      execution_groups: executionGroupsToStorage(groups),
      context_components: [],
    },
  };
  await atomicWriteText(target, renderDocument(draftMeta, body));

  const fingerprints = await planningContextFingerprints(projectRoot, options.stepId);
  const planHash = await planContentHash(projectRoot, options.stepId);
  const directory = await planningReviewDirectory(projectRoot, options.stepId);
  const report = await createTimestampedReport(
    projectRoot,
    directory,
    'PLAN-REVIEW-',
    (createdAt) => {
      const frontmatter = {
        schema: 1,
        kind: 'planning_review',
        step_id: options.stepId,
        execution_id: options.executionId,
        verdict: review.verdict,
        reviewer_role: 'reviewer',
        finding_count: review.findings.length,
        context_basis: fingerprints.basis,
        plan_content_hash: planHash,
        created_at: createdAt,
      };
      const findingsText = review.findings.length
        ? review.findings.map((item) => '- ' + item).join('\n')
        : '- Material semantic contradictions не обнаружены.';
      const reportBody = [
        '# Planning Review ' + options.stepId + ' — ' + createdAt.replace('T', ' ').slice(0, 16),
        '',
        '## Scope checked',
        '',
        '- STEP contract',
        '- Semantic dependency contracts',
        '- Linked REQ/Accepted ADR/Open Questions',
        '- Architecture refs',
        '- Proposed Implementation plan',
        '- Verification feasibility',
        '',
        '## Findings',
        '',
        findingsText,
        '',
        '## Verdict rationale',
        '',
        review.rationale,
      ].join('\n');
      return renderDocument(frontmatter, reportBody);
    },
    options.now ?? new Date(),
  );

  const reportDocument = await parseArtifactDocument(report.path);
  const reportErrors = validatePlanningReviewDocument(reportDocument, options.stepId);
  if (reportErrors.length > 0) {
    await rm(report.path, { force: true });
    await atomicWriteText(target, original.text);
    throw new ReviewCoreError(
      'REVIEW_CONTRACT_INVALID',
      'generated planning review failed canonical validation: ' + reportErrors.join('; '),
    );
  }

  const relativeReport = path.relative(projectRoot, report.path).split(path.sep).join('/');
  if (review.verdict === 'blocked') {
    await completeCurrent(projectRoot, options.rootCommand, 'BLOCKED', {
      expectedExecutionId: options.executionId,
      command: 'STEP PLAN ' + options.stepId,
      details: { report: relativeReport, planStatus: 'draft' },
    });
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      completionResult: 'BLOCKED',
      stepId: options.stepId,
      verdict: review.verdict,
      report: relativeReport,
      contextBasis: fingerprints.basis,
      planContentHash: planHash,
    };
  }

  // Fail closed if project context or plan output changed between immutable
  // review creation and Ready stamp.
  const currentFingerprints = await planningContextFingerprints(projectRoot, options.stepId);
  const currentPlanHash = await planContentHash(projectRoot, options.stepId);
  if (currentFingerprints.basis !== fingerprints.basis || currentPlanHash !== planHash) {
    await completeCurrent(projectRoot, options.rootCommand, 'BLOCKED', {
      expectedExecutionId: options.executionId,
      command: 'STEP PLAN ' + options.stepId,
      details: {
        report: relativeReport,
        reasonCode: 'PLAN_REVIEW_BASIS_STALE',
      },
    });
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      completionResult: 'BLOCKED',
      stepId: options.stepId,
      verdict: review.verdict,
      report: relativeReport,
      reasonCode: 'PLAN_REVIEW_BASIS_STALE',
    };
  }

  const current = await parseArtifactDocument(target);
  const currentBody = bodyOf(current.text);
  const currentPlanValue = current.frontmatter.plan as Record<string, unknown>;
  const readyMeta = {
    ...current.frontmatter,
    plan: {
      ...currentPlanValue,
      status: 'ready',
      revision: (revision as number) + 1,
      context_basis: fingerprints.basis,
      content_hash: planHash,
      reviewed_report: relativeReport,
      planned_at: new Date().toISOString(),
      execution_groups: executionGroupsToStorage(groups),
      context_components: fingerprints.components,
    },
  };
  await atomicWriteText(target, renderDocument(readyMeta, currentBody));

  await completeCurrent(projectRoot, options.rootCommand, 'SUCCESS', {
    expectedExecutionId: options.executionId,
    command: 'STEP PLAN ' + options.stepId,
    details: {
      report: relativeReport,
      planStatus: 'ready',
      planRevision: (revision as number) + 1,
    },
  });

  return {
    schemaVersion: 1,
    status: 'PASS',
    completionResult: 'SUCCESS',
    stepId: options.stepId,
    verdict: review.verdict,
    report: relativeReport,
    contextBasis: fingerprints.basis,
    planContentHash: planHash,
    planRevision: (revision as number) + 1,
    implementationPlan,
    executionGroups: groups,
    verification,
  };
}
