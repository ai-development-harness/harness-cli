import path from 'node:path';
import { parseArtifactDocument } from '../artifacts/index.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { implementationPrerequisiteFailures } from '../planning/index.js';
import { stableHash, contentHash } from '../planning/hash.js';
import { buildArtifactInventory, writeProjections } from '../project/index.js';
import type { CompletionProofFact } from '../project/index.js';
import { ReviewCoreError } from './errors.js';
import { atomicWriteText, renderDocument } from './document-write.js';
import { latestReview } from './history.js';
import { verificationFreshness } from './verification.js';

const ASSERTION_KEYS = [
  'requirementObligations',
  'plannedScope',
  'specializedObligations',
] as const;
const FINDING_KINDS = new Set([
  'missing_acceptance_coverage',
  'missing_requirement_obligation',
  'missing_planned_scope',
  'missing_specialized_obligation',
  'contract_gap',
  'evidence_gap',
]);

async function taskPath(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const directory = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.taskDirectory,
    'protocol.taskDirectory',
  );
  return path.join(directory, stepId + '.md');
}

export async function acceptanceCriteria(projectRoot: string, stepId: string): Promise<string[]> {
  const document = await parseArtifactDocument(await taskPath(projectRoot, stepId));
  const text = document.sections['Acceptance criteria'] ?? '';
  const result: string[] = [];
  for (const raw of text.split('\n')) {
    const match = /^\s*[-*]\s+(.+?)\s*$/.exec(raw);
    if (match?.[1]?.trim()) result.push(match[1].trim());
  }
  return result;
}

export async function deterministicCompletionPrecheck(
  projectRoot: string,
  stepId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const [criteria, freshness] = await Promise.all([
    acceptanceCriteria(projectRoot, stepId),
    verificationFreshness(projectRoot, stepId),
  ]);
  const findings: Array<{ code: string; kind: 'contract' | 'evidence'; message: string }> = [];
  if (criteria.length === 0) {
    findings.push({
      code: 'ACCEPTANCE_MISSING',
      kind: 'contract',
      message: 'STEP has no machine-discoverable Acceptance criteria',
    });
  }
  if (freshness.status !== 'PASS' || freshness.fresh !== true) {
    findings.push({
      code: freshness.reasonCode ?? 'VERIFICATION_NOT_PASS',
      kind: 'evidence',
      message: 'Generated Verification evidence is missing, stale or not PASS.',
    });
  }
  const prerequisites = await implementationPrerequisiteFailures(projectRoot, stepId, {
    completion: (dependencyId) => stepCompletionProof(projectRoot, dependencyId),
  });
  for (const reason of prerequisites) {
    findings.push({
      code: 'CURRENT_CONTRACT_NOT_EXECUTABLE',
      kind: 'contract',
      message: reason,
    });
  }
  return {
    schemaVersion: 1,
    status: findings.length === 0 ? 'PASS' : 'BLOCKED',
    stepId,
    acceptanceCriteria: criteria,
    verificationFreshness: freshness,
    findings,
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', label + ' must be a non-empty string');
  }
  return value.trim();
}

function assertion(value: unknown, label: string): Readonly<{ status: string; evidence: readonly string[] }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', label + ' must be an object');
  }
  const item = value as Record<string, unknown>;
  const unknown = Object.keys(item).filter((key) => !['status','evidence'].includes(key));
  if (unknown.length > 0) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', label + ' has unsupported keys: ' + unknown.sort().join(', '));
  }
  const status = item.status;
  if (!['covered','missing','not_applicable'].includes(String(status))) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', label + '.status must be covered|missing|not_applicable');
  }
  if (!Array.isArray(item.evidence) || item.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', label + '.evidence must be string array');
  }
  const evidence = (item.evidence as string[]).map((entry) => entry.trim());
  if ((status === 'covered' || status === 'not_applicable') && evidence.length === 0) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', label + ' ' + status + ' requires evidence/rationale');
  }
  return { status: String(status), evidence };
}

export function normalizeSemanticCompletion(
  value: unknown,
  criteria: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion must be an object');
  }
  const payload = value as Record<string, unknown>;
  const unknown = Object.keys(payload).filter((key) =>
    !['disposition','coverage','assertions','findings','rationale'].includes(key)
  );
  if (unknown.length > 0) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion has unsupported keys: ' + unknown.sort().join(', '));
  }

  const disposition = payload.disposition;
  if (!['pass','fix','blocked'].includes(String(disposition))) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.disposition must be pass|fix|blocked');
  }
  if (!Array.isArray(payload.coverage)) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.coverage must be an array');
  }

  const observed = new Set<string>();
  const coverage = payload.coverage.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'coverage[' + index + '] must be an object');
    }
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !['criterion','status','evidence'].includes(key))) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'coverage[' + index + '] has unsupported keys');
    }
    const criterion = text(item.criterion, 'coverage[' + index + '].criterion');
    if (!criteria.includes(criterion)) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'coverage[' + index + '] references out-of-scope criterion');
    }
    if (observed.has(criterion)) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'duplicate coverage criterion: ' + criterion);
    }
    observed.add(criterion);
    if (item.status !== 'covered' && item.status !== 'missing') {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'coverage[' + index + '].status must be covered|missing');
    }
    if (!Array.isArray(item.evidence) || item.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'coverage[' + index + '].evidence must be string array');
    }
    const evidence = (item.evidence as string[]).map((entry) => entry.trim());
    if (item.status === 'covered' && evidence.length === 0) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'covered criterion requires evidence: ' + criterion);
    }
    return { criterion, status: item.status, evidence };
  });

  const missingCriteria = criteria.filter((criterion) => !observed.has(criterion));
  const missingCoverage = coverage.filter((item) => item.status === 'missing').map((item) => item.criterion);

  if (typeof payload.assertions !== 'object' || payload.assertions === null || Array.isArray(payload.assertions)) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.assertions must be an object');
  }
  const assertionObject = payload.assertions as Record<string, unknown>;
  if (Object.keys(assertionObject).sort().join(',') !== [...ASSERTION_KEYS].sort().join(',')) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.assertions must contain exactly: ' + ASSERTION_KEYS.join(', '));
  }
  const assertions = Object.fromEntries(
    ASSERTION_KEYS.map((key) => [key, assertion(assertionObject[key], 'completion.assertions.' + key)]),
  );

  if (!Array.isArray(payload.findings)) {
    throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.findings must be an array');
  }
  const route = disposition === 'fix' ? 'FIX' : disposition === 'blocked' ? 'BLOCKED' : null;
  const findings = payload.findings.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.findings[' + index + '] must be an object');
    }
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !['kind','criterion','message'].includes(key))) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.findings[' + index + '] has unsupported keys');
    }
    if (!FINDING_KINDS.has(String(item.kind))) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.findings[' + index + '].kind is invalid');
    }
    if (item.criterion !== null && item.criterion !== undefined && (
      typeof item.criterion !== 'string' || !criteria.includes(item.criterion)
    )) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion.findings[' + index + '].criterion must reference Acceptance');
    }
    if (item.kind === 'missing_acceptance_coverage' && item.criterion == null) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'missing_acceptance_coverage finding requires criterion');
    }
    return {
      id: 'COMP-' + String(index + 1).padStart(3, '0'),
      kind: String(item.kind),
      criterion: item.criterion ?? null,
      route,
      message: text(item.message, 'completion.findings[' + index + '].message'),
    };
  });

  const missingAssertions = Object.entries(assertions)
    .filter(([, item]) => item.status === 'missing')
    .map(([key]) => key);
  const materialGap = missingCriteria.length > 0 || missingCoverage.length > 0 || missingAssertions.length > 0 || findings.length > 0;
  const contractFindings = findings.filter((item) => item.kind === 'contract_gap');
  const missingWithoutFinding = missingCoverage.filter((criterion) =>
    !findings.some((item) => item.criterion === criterion)
  );

  if (disposition === 'pass') {
    if (materialGap) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion PASS requires complete coverage/assertions and no findings');
    }
  } else {
    if (!materialGap || findings.length === 0) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion ' + String(disposition).toUpperCase() + ' requires structured material findings');
    }
    if (missingWithoutFinding.length > 0) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'missing Acceptance coverage requires matching structured finding: ' + missingWithoutFinding.join(', '));
    }
    if (disposition === 'fix' && contractFindings.length > 0) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion FIX cannot contain contract_gap; contract gaps must BLOCK');
    }
    if (disposition === 'blocked' && contractFindings.length === 0) {
      throw new ReviewCoreError('COMPLETION_CONTRACT_INVALID', 'completion BLOCKED requires a contract_gap finding');
    }
  }

  return {
    disposition,
    coverage,
    assertions,
    missingCriteria,
    missingAssertions,
    findings,
    rationale: text(payload.rationale, 'completion.rationale'),
  };
}

export async function evaluateCompletion(
  projectRoot: string,
  stepId: string,
  payload: unknown | null,
): Promise<Readonly<Record<string, unknown>>> {
  const precheck = await deterministicCompletionPrecheck(projectRoot, stepId);
  if (precheck.status !== 'PASS') {
    const precheckFindings = precheck.findings as Array<Record<string, unknown>>;
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      completionResult: 'BLOCKED',
      stepId,
      reasonCode: 'COMPLETION_PRECHECK_BLOCKED',
      precheck,
      findings: precheckFindings.map((item, index) => ({
        id: 'COMP-' + String(index + 1).padStart(3, '0'),
        kind: item.kind === 'evidence' ? 'evidence_gap' : 'contract_gap',
        criterion: null,
        route: 'BLOCKED',
        message: item.message,
      })),
    };
  }
  if (payload === null) {
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      completionResult: 'BLOCKED',
      stepId,
      reasonCode: 'COMPLETION_PAYLOAD_MISSING',
      precheck,
      findings: [{
        id: 'COMP-001',
        kind: 'contract_gap',
        criterion: null,
        route: 'BLOCKED',
        message: 'Semantic completion payload was not supplied.',
      }],
    };
  }
  const semantic = normalizeSemanticCompletion(payload, precheck.acceptanceCriteria as string[]);
  const disposition = semantic.disposition;
  const status = disposition === 'pass' ? 'PASS' : disposition === 'fix' ? 'INCOMPLETE' : 'BLOCKED';
  const completionResult = disposition === 'pass' ? 'PASS' : disposition === 'fix' ? 'FAIL' : 'BLOCKED';
  return {
    schemaVersion: 1,
    status,
    completionResult,
    stepId,
    reasonCode:
      disposition === 'pass'
        ? null
        : disposition === 'fix'
          ? 'COMPLETION_IN_SCOPE_WORK_MISSING'
          : 'COMPLETION_CONTRACT_BLOCKED',
    precheck,
    semantic,
    findings: semantic.findings,
  };
}

function evidencePresent(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed && trimmed !== '—' && trimmed !== '-');
}

export async function stepCompletionProof(
  projectRoot: string,
  stepId: string,
): Promise<CompletionProofFact & Readonly<{ snapshot: Readonly<Record<string, unknown>> }>> {
  const inventory = await buildArtifactInventory(projectRoot);
  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') {
    return {
      complete: false,
      reasons: ['canonical STEP is missing'],
      snapshot: { stepId, missing: true },
      proofHash: stableHash({ stepId, missing: true }),
    };
  }

  const meta = step.document.frontmatter;
  const type = String(meta.type ?? '');
  const reasons: string[] = [];
  if (meta.status !== 'completed') reasons.push('status is not completed');
  const evidence = evidencePresent(step.document.sections['Evidence'] ?? '');
  let reviewSnapshot: Readonly<Record<string, unknown>> | null = null;

  if (type === 'research') {
    if (!evidence) reasons.push('research step has no durable Evidence');
    if (!(step.document.sections['Deliverables'] ?? '').trim()) reasons.push('research step has no Deliverables');
  } else if (type === 'adr') {
    if (!evidence) reasons.push('ADR step has no durable Evidence');
    const adrs = Array.isArray(meta.adrs) ? meta.adrs.filter((item): item is string => typeof item === 'string') : [];
    for (const adrId of adrs) {
      const adr = inventory.byId.get(adrId);
      if (!adr || adr.type !== 'ADR' || adr.document.frontmatter.status !== 'accepted') {
        reasons.push(adrId + ' is not accepted');
      }
    }
  } else if (type === 'audit' || type === 'review') {
    if (!evidence) reasons.push(type + ' step has no durable Evidence');
  } else {
    const review = await latestReview(projectRoot, stepId, { requireCurrentRevision: true });
    if (!review) reasons.push('trusted current PASS review is missing');
    else if (review.verdict !== 'pass') reasons.push('latest trusted review verdict is not PASS');
    else if (review.completionResult !== 'PASS') reasons.push('latest trusted PASS review has no completion PASS');
    else {
      reviewSnapshot = {
        path: review.relativePath,
        verdict: review.verdict,
        completionResult: review.completionResult,
        contentHash: review.contentHash,
      };
    }
    if (!evidence) reasons.push('step has no durable Evidence');
  }

  const snapshot = {
    stepId,
    type,
    status: meta.status,
    review: reviewSnapshot,
    evidenceHash: contentHash(step.document.sections['Evidence'] ?? ''),
    reasons,
  };
  return {
    complete: reasons.length === 0,
    reasons,
    snapshot,
    proofHash: stableHash(snapshot),
  };
}

export async function finalizeStepCompletion(
  projectRoot: string,
  stepId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const target = await taskPath(projectRoot, stepId);
  const document = await parseArtifactDocument(target);
  const previousStatus = document.frontmatter.status;
  const changed = previousStatus !== 'completed';
  if (changed) {
    await atomicWriteText(
      target,
      renderDocument({ ...document.frontmatter, status: 'completed' }, document.text.slice(document.text.indexOf('\n---\n', 4) + 5)),
    );
  }

  const proof = await stepCompletionProof(projectRoot, stepId);
  if (!proof.complete) {
    if (changed) {
      await atomicWriteText(target, document.text);
    }
    return {
      completed: false,
      previousStatus,
      reasonCode: 'STEP_COMPLETION_PROOF_INCOMPLETE',
      proof,
    };
  }

  try {
    const projections = await writeProjections(projectRoot, {
      completion: (id) => stepCompletionProof(projectRoot, id),
    });
    return { completed: true, previousStatus, proof, projections };
  } catch (error) {
    if (changed) {
      await atomicWriteText(target, document.text);
      try {
        await writeProjections(projectRoot, {
          completion: (id) => stepCompletionProof(projectRoot, id),
        });
      } catch {
        // Best-effort projection rollback; canonical STEP was restored.
      }
    }
    return {
      completed: false,
      previousStatus,
      reasonCode: 'STEP_COMPLETION_PROJECTION_FAILED',
      message: (error as Error).message,
      proof,
    };
  }
}
