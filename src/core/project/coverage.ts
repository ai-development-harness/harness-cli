import type {
  ArtifactInventory,
  CompletionProofFact,
  ProjectReadModelProviders,
} from './types.js';

const NON_PRODUCT_ORPHAN_EXEMPT_TYPES = new Set([
  'bugfix',
  'refactor',
  'research',
  'adr',
  'audit',
  'review',
  'hardening',
  'documentation',
  'release',
]);

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function proofFor(
  stepId: string,
  stepStatus: unknown,
  providers: ProjectReadModelProviders,
): Promise<CompletionProofFact> {
  if (providers.completion) {
    try {
      return await providers.completion(stepId);
    } catch (error) {
      return { complete: false, reasons: [`completion-proof-error:${(error as Error).message}`] };
    }
  }
  return {
    complete: false,
    reasons: stepStatus === 'completed'
      ? ['completion-proof-provider-unavailable']
      : ['step-not-completed'],
  };
}

export interface TraceabilityCoverage {
  readonly schemaVersion: 1;
  readonly status: 'PASS' | 'WARN';
  readonly metrics: Readonly<Record<
    | 'requirements'
    | 'coveredByStep'
    | 'verified'
    | 'uncovered'
    | 'staleEvidence'
    | 'openBlockingQuestions'
    | 'orphanSteps'
    | 'invalidReferences',
    number
  >>;
  readonly requirements: readonly Readonly<Record<string, unknown>>[];
  readonly orphanSteps: readonly Readonly<Record<string, unknown>>[];
  readonly invalidReferences: readonly Readonly<Record<string, string>>[];
  readonly blockingOpenQuestions: readonly Readonly<{ id: string; affects: readonly string[] }>[];
}

export async function buildTraceabilityCoverage(
  inventory: ArtifactInventory,
  providers: ProjectReadModelProviders = {},
): Promise<TraceabilityCoverage> {
  const reqs = new Map(inventory.byType.REQ.map((item) => [item.id, item]));
  const adrs = new Map(inventory.byType.ADR.map((item) => [item.id, item]));
  const steps = new Map(inventory.byType.STEP.map((item) => [item.id, item]));
  const reqToSteps = new Map<string, Set<string>>([...reqs.keys()].map((id) => [id, new Set<string>()]));
  const invalidReferences: Array<Record<string, string>> = [];

  for (const [reqId, req] of reqs) {
    for (const stepId of strings(req.document.frontmatter.steps)) {
      const step = steps.get(stepId);
      if (!step) {
        invalidReferences.push({ code: 'UNKNOWN_STEP_REFERENCE', source: reqId, target: stepId });
        continue;
      }
      if (!strings(step.document.frontmatter.requirements).includes(reqId)) {
        invalidReferences.push({ code: 'REVERSE_TRACEABILITY_MISMATCH', source: reqId, target: stepId });
        continue;
      }
      reqToSteps.get(reqId)!.add(stepId);
    }
  }

  const orphanSteps: Array<Record<string, unknown>> = [];
  for (const [stepId, step] of steps) {
    const linkedReqs = strings(step.document.frontmatter.requirements);
    const linkedAdrs = strings(step.document.frontmatter.adrs);
    for (const reqId of linkedReqs) {
      const req = reqs.get(reqId);
      if (!req) invalidReferences.push({ code: 'UNKNOWN_REQ_REFERENCE', source: stepId, target: reqId });
      else {
        reqToSteps.get(reqId)!.add(stepId);
        if (!strings(req.document.frontmatter.steps).includes(stepId)) {
          invalidReferences.push({ code: 'REVERSE_TRACEABILITY_MISMATCH', source: stepId, target: reqId });
        }
      }
    }
    for (const adrId of linkedAdrs) {
      if (!adrs.has(adrId)) invalidReferences.push({ code: 'UNKNOWN_ADR_REFERENCE', source: stepId, target: adrId });
    }
    const stepType = String(step.document.frontmatter.type ?? '');
    if (linkedReqs.length === 0 && linkedAdrs.length === 0 && !NON_PRODUCT_ORPHAN_EXEMPT_TYPES.has(stepType)) {
      orphanSteps.push({ stepId, type: stepType, reason: 'no REQ, ADR or typed non-product rationale' });
    }
  }

  const knownTargets = new Set(['PROJECT', ...reqs.keys(), ...adrs.keys(), ...steps.keys()]);
  const blockingOpenQuestions: Array<{ id: string; affects: readonly string[] }> = [];
  for (const oq of inventory.byType.OQ) {
    const affects = strings(oq.document.frontmatter.affects);
    if (oq.document.frontmatter.status === 'open') blockingOpenQuestions.push({ id: oq.id, affects });
    for (const target of affects) {
      if (!knownTargets.has(target)) {
        invalidReferences.push({ code: 'UNKNOWN_OQ_TARGET', source: oq.id, target });
      }
    }
  }

  const proofByStep = new Map<string, CompletionProofFact>();
  for (const [stepId, step] of steps) {
    proofByStep.set(stepId, await proofFor(stepId, step.document.frontmatter.status, providers));
  }

  const metrics = {
    requirements: reqs.size,
    coveredByStep: 0,
    verified: 0,
    uncovered: 0,
    staleEvidence: 0,
    openBlockingQuestions: blockingOpenQuestions.length,
    orphanSteps: orphanSteps.length,
    invalidReferences: invalidReferences.length,
  };
  const requirements: Array<Record<string, unknown>> = [];

  for (const [reqId, req] of [...reqs].sort(([a], [b]) => a.localeCompare(b))) {
    const linked = [...(reqToSteps.get(reqId) ?? [])].sort();
    const executable = linked.filter((stepId) => {
      const status = steps.get(stepId)?.document.frontmatter.status;
      return status !== 'deferred' && status !== 'cancelled';
    });
    const evidence = executable.filter((stepId) => proofByStep.get(stepId)?.complete === true);
    const stale = executable
      .filter((stepId) =>
        steps.get(stepId)?.document.frontmatter.status === 'completed' &&
        proofByStep.get(stepId)?.complete !== true
      )
      .map((stepId) => ({ stepId, reasons: proofByStep.get(stepId)?.reasons ?? [] }));

    const executableAdrs = new Set(
      executable.flatMap((stepId) => strings(steps.get(stepId)?.document.frontmatter.adrs)),
    );
    const affectedOq = blockingOpenQuestions
      .filter((oq) =>
        oq.affects.includes('PROJECT') ||
        oq.affects.includes(reqId) ||
        executable.some((stepId) => oq.affects.includes(stepId)) ||
        [...executableAdrs].some((adrId) => oq.affects.includes(adrId))
      )
      .map((oq) => oq.id)
      .sort();

    let status: string;
    if (executable.length === 0) {
      status = 'uncovered';
      metrics.uncovered += 1;
    } else {
      metrics.coveredByStep += 1;
      if (affectedOq.length > 0) status = 'blocked';
      else if (stale.length > 0) {
        status = 'stale_evidence';
        metrics.staleEvidence += 1;
      } else if (evidence.length === executable.length) {
        status = 'verified';
        metrics.verified += 1;
      } else status = 'covered';
    }

    requirements.push({
      id: reqId,
      priority: req.document.frontmatter.priority,
      status,
      stepCoverage: linked,
      executableSteps: executable,
      evidenceCoverage: evidence,
      staleEvidence: stale,
      blockingOpenQuestions: affectedOq,
      releaseRelevant: ['critical', 'high'].includes(String(req.document.frontmatter.priority)),
    });
  }

  const findings =
    metrics.uncovered > 0 ||
    metrics.staleEvidence > 0 ||
    orphanSteps.length > 0 ||
    invalidReferences.length > 0 ||
    blockingOpenQuestions.length > 0;

  return {
    schemaVersion: 1,
    status: findings ? 'WARN' : 'PASS',
    metrics,
    requirements,
    orphanSteps,
    invalidReferences,
    blockingOpenQuestions,
  };
}
