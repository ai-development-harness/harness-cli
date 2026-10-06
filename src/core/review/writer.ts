import { rm } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../config.js';
import {
  completeCurrent,
  readExecutionState,
} from '../execution/index.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { normalizeFindings, machineFindingPayload } from './findings.js';
import { evaluateCompletion, finalizeStepCompletion } from './completion.js';
import { ReviewCoreError } from './errors.js';
import { captureReviewExpectation } from './expectation.js';
import { requiredReviewers } from './gates.js';
import {
  reportForExecution,
  validateReviewReport,
} from './history.js';
import { createTimestampedReport, renderDocument } from './document-write.js';
import { verificationFreshness } from './verification.js';
import type {
  ReviewFinding,
  ReviewVerdict,
} from './types.js';

interface SpecializedReviewResult {
  readonly status: 'pass' | 'fail' | 'blocked';
  readonly summary: string;
}

interface NormalizedProposal {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewFinding[];
  readonly verificationObservations: string;
  readonly rationale: string;
  readonly specializedReviews: Readonly<Record<string, SpecializedReviewResult>>;
  readonly completion: unknown | null;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', label + ' must be a non-empty string');
  }
  return value.trim();
}

function normalizeProposal(value: unknown): NormalizedProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'review proposal must be an object');
  }
  const payload = value as Record<string, unknown>;
  const allowed = new Set([
    'verdict',
    'findings',
    'verificationObservations',
    'rationale',
    'specializedReviews',
    'completion',
  ]);
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ReviewCoreError(
      'SEMANTIC_PAYLOAD_INVALID',
      'review proposal has unsupported keys: ' + unknown.sort().join(', '),
    );
  }
  if (!['pass','fail','blocked'].includes(String(payload.verdict))) {
    throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'review verdict must be pass|fail|blocked');
  }
  const findings = normalizeFindings(payload.findings);
  const categories = findings.map((item) => item.category);
  if (payload.verdict === 'pass' && findings.length > 0) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'PASS review must not contain material findings');
  }
  if (payload.verdict === 'fail') {
    if (findings.length === 0) throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'FAIL review requires findings');
    if (categories.includes('contract')) {
      throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'contract finding must route to BLOCKED');
    }
  }
  if (payload.verdict === 'blocked') {
    if (!categories.some((item) => item === 'contract' || item === 'evidence')) {
      throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'BLOCKED review requires contract/evidence finding');
    }
  }

  const specialized: Record<string, SpecializedReviewResult> = {};
  if (payload.specializedReviews !== undefined) {
    if (
      typeof payload.specializedReviews !== 'object' ||
      payload.specializedReviews === null ||
      Array.isArray(payload.specializedReviews)
    ) {
      throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'specializedReviews must be an object');
    }
    for (const [name, raw] of Object.entries(payload.specializedReviews as Record<string, unknown>)) {
      if (name !== 'security' && name !== 'tests') {
        throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'unknown specialized reviewer: ' + name);
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'specialized reviewer result must be an object');
      }
      const item = raw as Record<string, unknown>;
      if (Object.keys(item).some((key) => !['status','summary'].includes(key))) {
        throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'specialized reviewer result has unsupported keys');
      }
      if (!['pass','fail','blocked'].includes(String(item.status))) {
        throw new ReviewCoreError('SEMANTIC_PAYLOAD_INVALID', 'specialized reviewer status must be pass|fail|blocked');
      }
      specialized[name] = {
        status: item.status as SpecializedReviewResult['status'],
        summary: text(item.summary, 'specializedReviews.' + name + '.summary'),
      };
    }
  }

  return {
    verdict: payload.verdict as ReviewVerdict,
    findings,
    verificationObservations: text(payload.verificationObservations, 'verificationObservations'),
    rationale: text(payload.rationale, 'rationale'),
    specializedReviews: specialized,
    completion: payload.completion ?? null,
  };
}

function renderHumanFindings(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return 'No material findings.';
  return findings.map((finding) => {
    const location = finding.location.path + (finding.location.line ? ':' + finding.location.line : '');
    return [
      '### ' + finding.id + ' — ' + finding.title,
      '',
      '- Severity: ' + finding.severity,
      '- Category: ' + finding.category,
      '- Location: ' + location,
      '- Scenario: GIVEN ' + finding.scenario.given + ' WHEN ' + finding.scenario.when + ' THEN ' + finding.scenario.then,
      '- Expected: ' + finding.expected,
      '- Observed: ' + finding.observed,
      '- Impact: ' + finding.impact,
      '- Fix direction: ' + finding.repair.direction,
      '- Fingerprint: ' + finding.fingerprint,
    ].join('\n');
  }).join('\n\n');
}

async function reviewDirectory(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const root = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.reviewDirectory,
    'protocol.reviewDirectory',
  );
  return path.join(root, stepId);
}

function sameExpectation(
  stored: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify({
    stepId: stored.stepId,
    repositoryRevision: stored.repositoryRevision,
    gateBasis: stored.gateBasis,
    contextBasis: stored.contextBasis,
    verificationBasis: stored.verificationBasis,
    requiredReviewers: stored.requiredReviewers,
  }) === JSON.stringify({
    stepId: current.stepId,
    repositoryRevision: current.repositoryRevision,
    gateBasis: current.gateBasis,
    contextBasis: current.contextBasis,
    verificationBasis: current.verificationBasis,
    requiredReviewers: current.requiredReviewers,
  });
}

async function executionContext(
  projectRoot: string,
  rootCommand: string,
  stepId: string,
  executionId: string,
) {
  const state = await readExecutionState(projectRoot);
  const active = state.executions.find((item) => item.executionId === executionId);
  if (!active) {
    const terminal = state.recentTerminals.find((item) => item.executionId === executionId);
    return { state, active: null, terminal };
  }
  if (
    active.rootCommand !== rootCommand ||
    active.status !== 'running' ||
    active.current.status !== 'running' ||
    active.current.command !== 'STEP REVIEW ' + stepId
  ) {
    throw new ReviewCoreError(
      'REVIEW_EXECUTION_MISMATCH',
      'review proposal does not own the current STEP REVIEW command',
      {
        executionId,
        rootCommand,
        currentCommand: active.current.command,
        currentStatus: active.current.status,
      },
    );
  }
  return { state, active, terminal: null };
}

async function completeFromExistingReport(
  projectRoot: string,
  rootCommand: string,
  stepId: string,
  executionId: string,
  existing: NonNullable<Awaited<ReturnType<typeof reportForExecution>>>,
): Promise<Readonly<Record<string, unknown>>> {
  const result = existing.completionResult ??
    (existing.verdict === 'pass' ? 'PASS' : existing.verdict === 'fail' ? 'FAIL' : 'BLOCKED');
  let completion: Readonly<Record<string, unknown>> | null = null;
  if (existing.verdict === 'pass' && result === 'PASS') {
    completion = await finalizeStepCompletion(projectRoot, stepId);
  }

  const context = await executionContext(projectRoot, rootCommand, stepId, executionId);
  if (context.active) {
    await completeCurrent(
      projectRoot,
      rootCommand,
      result === 'PASS' ? 'PASS' : result === 'FAIL' ? 'FAIL' : 'BLOCKED',
      {
        expectedExecutionId: executionId,
        command: 'STEP REVIEW ' + stepId,
        details: {
          report: existing.relativePath,
          completionResult: result,
          recovered: true,
        },
      },
    );
  }

  return {
    schemaVersion: 1,
    status: result,
    stepId,
    verdict: existing.verdict,
    report: existing.relativePath,
    completionResult: result,
    recovered: true,
    ...(completion ? { stepCompletion: completion } : {}),
  };
}

export async function commitStepReview(
  projectRoot: string,
  options: {
    readonly rootCommand: string;
    readonly stepId: string;
    readonly executionId: string;
    readonly proposal: unknown;
    readonly now?: Date;
  },
): Promise<Readonly<Record<string, unknown>>> {
  const existing = await reportForExecution(projectRoot, options.stepId, options.executionId);
  if (existing) {
    return completeFromExistingReport(
      projectRoot,
      options.rootCommand,
      options.stepId,
      options.executionId,
      existing,
    );
  }

  const execution = await executionContext(
    projectRoot,
    options.rootCommand,
    options.stepId,
    options.executionId,
  );
  if (!execution.active) {
    throw new ReviewCoreError(
      'REVIEW_EXECUTION_MISMATCH',
      'review execution is no longer active and has no durable report',
      { executionId: options.executionId },
    );
  }

  const expectation = execution.active.current.context.reviewExpectation;
  if (!expectation) {
    throw new ReviewCoreError(
      'REVIEW_EXPECTATION_MISSING',
      execution.active.current.context.reviewExpectationError?.message ??
        'STEP REVIEW has no stamped Core expectation',
      { executionId: options.executionId },
    );
  }
  const baseline = execution.active.current.context.implementationBaseline?.gitHead ?? null;
  const currentExpectation = await captureReviewExpectation(
    projectRoot,
    options.stepId,
    baseline,
  );
  if (!sameExpectation(expectation, currentExpectation)) {
    throw new ReviewCoreError(
      'REVIEW_STALE_BASIS',
      'STEP REVIEW repository/gate/context/verification basis changed after semantic handoff',
      {
        stored: expectation,
        current: currentExpectation,
        remediation: 'STEP REVIEW ' + options.stepId,
      },
    );
  }

  const proposal = normalizeProposal(options.proposal);
  for (const reviewer of expectation.requiredReviewers) {
    const result = proposal.specializedReviews[reviewer];
    if (!result) {
      throw new ReviewCoreError(
        'REVIEW_CONTRACT_INVALID',
        'required specialized reviewer result is missing: ' + reviewer,
      );
    }
    if (proposal.verdict === 'pass' && result.status !== 'pass') {
      throw new ReviewCoreError(
        'REVIEW_CONTRACT_INVALID',
        'PASS review requires specialized ' + reviewer + ' PASS',
      );
    }
  }

  const verification = await verificationFreshness(projectRoot, options.stepId);
  let convergence: Readonly<Record<string, unknown>> | null = null;
  if (proposal.verdict === 'pass') {
    convergence = await evaluateCompletion(projectRoot, options.stepId, proposal.completion);
  }

  const now = options.now ?? new Date();
  const directory = await reviewDirectory(projectRoot, options.stepId);
  const gate = await requiredReviewers(projectRoot, options.stepId, baseline);
  const specialized = {
    gate_basis: currentExpectation.gateBasis,
    required: currentExpectation.requiredReviewers,
    implementation_baseline: baseline,
    surface_mode: gate.surfaceMode,
    changed_paths_hash: gate.changedPathsHash,
    baseline_status: gate.baselineStatus,
    baseline_reason: gate.baselineReason,
    ...proposal.specializedReviews,
  };

  const report = await createTimestampedReport(
    projectRoot,
    directory,
    'REVIEW-',
    (createdAt) => {
      const frontmatter: Record<string, unknown> = {
        schema: 1,
        kind: 'step_review',
        finding_contract: 2,
        step_id: options.stepId,
        execution_id: options.executionId,
        verdict: proposal.verdict,
        reviewer_role: 'reviewer',
        created_at: createdAt,
        reviewed_revision: currentExpectation.repositoryRevision,
        contract_basis: currentExpectation.contextBasis,
        verification_basis: currentExpectation.verificationBasis,
        verification_status: verification.status,
        specialized_reviews: specialized,
      };
      if (convergence) {
        frontmatter.completion_contract = 1;
        frontmatter.completion_result = String(convergence.completionResult).toLowerCase();
      }

      const fence = String.fromCharCode(96).repeat(3);
      const completionSection = convergence
        ? '\n## Completion convergence\n\n' + fence + 'json\n' +
          JSON.stringify(convergence, null, 2) + '\n' + fence + '\n'
        : '';
      const body = [
        '# STEP REVIEW ' + options.stepId + ' — ' + createdAt.replace('T', ' ').slice(0, 16),
        '',
        '## Scope checked',
        '',
        '- Task contract',
        '- REQ/ADR/OQ/architecture refs',
        '- Implementation plan',
        '- Diff/current code',
        '- Tests/verification',
        '',
        '## Findings',
        '',
        renderHumanFindings(proposal.findings),
        '',
        '## Machine-readable findings',
        '',
        fence + 'json',
        JSON.stringify(machineFindingPayload(proposal.findings), null, 2),
        fence,
        '',
        '## Verification observations',
        '',
        proposal.verificationObservations,
        '',
        '## Verdict rationale',
        '',
        proposal.rationale,
        completionSection,
      ].join('\n');
      return renderDocument(frontmatter, body);
    },
    now,
  );
  const filePath = report.path;
  const relative = path.relative(projectRoot, filePath).split(path.sep).join('/');
  const errors = await validateReviewReport(projectRoot, filePath, {
    expectedStepId: options.stepId,
    requireCurrentRevision: true,
  });
  if (errors.length > 0) {
    // This file was created by the current Core transaction and has not been
    // accepted as durable history yet. Remove the invalid candidate rather than
    // leaving an immutable-looking artifact that future recovery cannot trust.
    await rm(filePath, { force: true });
    throw new ReviewCoreError(
      'REVIEW_CONTRACT_INVALID',
      'generated STEP review failed canonical validation: ' + errors.join('; '),
      { report: relative },
    );
  }

  let commandResult: 'PASS' | 'FAIL' | 'BLOCKED';
  let stepCompletion: Readonly<Record<string, unknown>> | null = null;
  if (proposal.verdict === 'blocked') {
    commandResult = 'BLOCKED';
  } else if (proposal.verdict === 'fail') {
    commandResult = 'FAIL';
  } else {
    commandResult = String(convergence?.completionResult) as 'PASS' | 'FAIL' | 'BLOCKED';
    if (commandResult === 'PASS') {
      stepCompletion = await finalizeStepCompletion(projectRoot, options.stepId);
      if (stepCompletion.completed !== true) commandResult = 'BLOCKED';
    }
  }

  await completeCurrent(projectRoot, options.rootCommand, commandResult, {
    expectedExecutionId: options.executionId,
    command: 'STEP REVIEW ' + options.stepId,
    details: {
      report: relative,
      reviewVerdict: proposal.verdict,
      completionResult: convergence?.completionResult ?? commandResult,
    },
  });

  return {
    schemaVersion: 1,
    status: commandResult,
    stepId: options.stepId,
    verdict: proposal.verdict,
    report: relative,
    reviewedRevision: currentExpectation.repositoryRevision,
    specializedReviewGate: {
      basis: currentExpectation.gateBasis,
      required: currentExpectation.requiredReviewers,
      implementationBaseline: baseline,
    },
    ...(convergence ? { completionGate: convergence } : {}),
    ...(stepCompletion ? { stepCompletion } : {}),
  };
}
