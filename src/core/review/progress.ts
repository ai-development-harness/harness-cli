import { buildArtifactInventory } from '../project/index.js';
import { planContentHash, planningContextBasis, stableHash, contentHash } from '../planning/index.js';
import { acceptanceCriteria, deterministicCompletionPrecheck, stepCompletionProof } from './completion.js';
import { latestReview } from './history.js';
import { repositoryActivityFingerprint } from './revision.js';
import { verificationFreshness } from './verification.js';
import type { ProgressSample, ProgressTelemetry } from './types.js';

export const PROGRESS_SCHEMA_VERSION = 1 as const;
export const PROGRESS_TELEMETRY_VERSION = 1 as const;
export const MAX_PROGRESS_SAMPLES = 8;
export const STAGNATION_RESUME_LIMIT = 2;
export const DRIFT_LIMIT = 2;

const VERIFICATION_RANK: Record<string, number> = {
  UNKNOWN: 0,
  MISSING: 0,
  BLOCKED: 0,
  FAIL: 1,
  MANUAL_REQUIRED: 2,
  PASS: 3,
};
const STEP_STATUS_RANK: Record<string, number> = {
  planned: 0,
  blocked: 0,
  in_progress: 1,
  completed: 3,
  cancelled: 3,
  deferred: 3,
};

function completionFindingFingerprints(review: Awaited<ReturnType<typeof latestReview>>): string[] {
  if (!review) return [];
  const section = review.document.sections['Completion convergence'];
  if (!section) return [];
  const fence = String.fromCharCode(96).repeat(3);
  const text = section.trim();
  if (!text.startsWith(fence + 'json\n') || !text.endsWith('\n' + fence)) return [];
  try {
    const payload = JSON.parse(text.slice((fence + 'json\n').length, -('\n' + fence).length));
    if (!Array.isArray(payload.findings)) return [];
    return payload.findings.map((item: any) => stableHash({
      kind: item?.kind ?? null,
      criterion: item?.criterion ?? null,
      route: item?.route ?? null,
    })).sort();
  } catch {
    return [];
  }
}

export async function captureProgress(
  projectRoot: string,
  stepId: string,
  command: string,
  operation: 'PLAN' | 'IMPLEMENT' | 'REVIEW' | 'FIX',
): Promise<ProgressSample> {
  const inventory = await buildArtifactInventory(projectRoot);
  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') throw new Error(stepId + ': canonical STEP is missing');

  const [proof, review, verification, precheck, criteria, contextBasis, planHash, activity] = await Promise.all([
    stepCompletionProof(projectRoot, stepId),
    latestReview(projectRoot, stepId),
    verificationFreshness(projectRoot, stepId),
    deterministicCompletionPrecheck(projectRoot, stepId),
    acceptanceCriteria(projectRoot, stepId),
    planningContextBasis(projectRoot, stepId),
    planContentHash(projectRoot, stepId),
    repositoryActivityFingerprint(projectRoot),
  ]);

  const reviewFingerprints = review?.findings.map((item) => item.fingerprint).sort() ?? [];
  const completionFindings = completionFindingFingerprints(review);
  const planValue =
    typeof step.document.frontmatter.plan === 'object' &&
    step.document.frontmatter.plan !== null &&
    !Array.isArray(step.document.frontmatter.plan)
      ? step.document.frontmatter.plan as Record<string, unknown>
      : {};
  const executionGroupsHash = planValue.execution_groups == null
    ? null
    : stableHash(planValue.execution_groups);

  const precheckFindings = Array.isArray(precheck.findings) ? precheck.findings : [];
  const material = {
    stepStatus: step.document.frontmatter.status,
    contextBasis,
    planContentHash: planHash,
    planRevision: planValue.revision ?? null,
    executionGroupsHash,
    acceptanceHash: stableHash(criteria),
    evidenceHash: contentHash(step.document.sections['Evidence'] ?? ''),
    completionComplete: proof.complete,
    completionProofHash: proof.proofHash ?? null,
    completionReasons: [...proof.reasons].sort(),
    verification: {
      status: verification.status,
      fresh: verification.fresh,
      reasonCode: verification.reasonCode,
    },
    completionPrecheck: {
      status: precheck.status,
      findingKeys: precheckFindings.map((item: any) => String(item?.code ?? '') + ':' + String(item?.kind ?? '')).sort(),
    },
    reviewVerdict: review?.verdict ?? null,
    reviewCompletionResult: review?.completionResult ?? null,
    reviewFindings: reviewFingerprints,
    completionFindings,
  };
  const metrics = {
    stepStatus: material.stepStatus,
    completionComplete: material.completionComplete,
    completionReasonCount: material.completionReasons.length,
    completionPrecheckFindingCount: material.completionPrecheck.findingKeys.length,
    reviewFindingCount: reviewFingerprints.length,
    completionFindingCount: completionFindings.length,
    verificationStatus: verification.status,
    evidenceHash: material.evidenceHash,
    executionGroupsHash,
  };
  const materialFingerprint = stableHash(material);
  const activityFingerprint = stableHash({ repositoryActivity: activity });

  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    stepId,
    command,
    operation,
    materialFingerprint,
    activityFingerprint,
    fingerprint: stableHash({ material: materialFingerprint, activity: activityFingerprint }),
    metrics,
    capturedAt: new Date().toISOString(),
  };
}

export function compareProgress(
  before: ProgressSample,
  after: ProgressSample,
): Readonly<Record<string, unknown>> {
  const left = before.metrics;
  const right = after.metrics;
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const changed = names.filter((name) => left[name] !== right[name]);
  const unchanged = names.filter((name) => left[name] === right[name]);
  if (before.activityFingerprint !== after.activityFingerprint) changed.push('repositoryActivity');
  else unchanged.push('repositoryActivity');

  const improvements: string[] = [];
  const regressions: string[] = [];
  const leftStatus = String(left.stepStatus ?? '');
  const rightStatus = String(right.stepStatus ?? '');
  if ((STEP_STATUS_RANK[rightStatus] ?? 0) > (STEP_STATUS_RANK[leftStatus] ?? 0)) improvements.push('stepStatus');
  if ((STEP_STATUS_RANK[rightStatus] ?? 0) < (STEP_STATUS_RANK[leftStatus] ?? 0)) regressions.push('stepStatus');

  if (right.completionComplete === true && left.completionComplete !== true) improvements.push('completionComplete');
  if (left.completionComplete === true && right.completionComplete !== true) regressions.push('completionComplete');

  for (const key of ['completionReasonCount','completionPrecheckFindingCount','reviewFindingCount','completionFindingCount'] as const) {
    const l = Number(left[key] ?? 0);
    const r = Number(right[key] ?? 0);
    if (r < l) improvements.push(key);
    else if (r > l) regressions.push(key);
  }

  const lv = VERIFICATION_RANK[String(left.verificationStatus ?? 'UNKNOWN')] ?? 0;
  const rv = VERIFICATION_RANK[String(right.verificationStatus ?? 'UNKNOWN')] ?? 0;
  if (rv > lv) improvements.push('verification');
  if (rv < lv) regressions.push('verification');

  const materialChanged = before.materialFingerprint !== after.materialFingerprint;
  const activityChanged = before.activityFingerprint !== after.activityFingerprint;
  const classification =
    !materialChanged && !activityChanged
      ? 'NO_CHANGE'
      : !materialChanged && activityChanged
        ? 'ACTIVITY_ONLY'
        : regressions.length > 0 && improvements.length === 0
          ? 'WORSENED'
          : 'PROGRESS';

  return {
    classification,
    materialChanged,
    activityChanged,
    changed: [...new Set(changed)].sort(),
    unchanged: [...new Set(unchanged)].sort(),
    improvements: [...new Set(improvements)].sort(),
    regressions: [...new Set(regressions)].sort(),
  };
}

export function newTelemetry(sample: ProgressSample): ProgressTelemetry {
  return {
    schemaVersion: PROGRESS_TELEMETRY_VERSION,
    samples: [sample],
    unchangedResumes: 0,
    driftStreak: 0,
    lastDelta: null,
    stopDecision: 'continue',
  };
}

function appendSample(telemetry: ProgressTelemetry, sample: ProgressSample): ProgressSample[] {
  return [...telemetry.samples, sample].slice(-MAX_PROGRESS_SAMPLES);
}

function cycleBlocker(telemetry: ProgressTelemetry, sample: ProgressSample): Readonly<Record<string, unknown>> | null {
  const samples = telemetry.samples;
  if (samples.length < 2) return null;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const prior = samples[index];
    if (prior.command !== sample.command || prior.fingerprint !== sample.fingerprint) continue;
    const between = samples.slice(index + 1);
    if (between.length === 0) continue;
    const operations = new Set([prior, ...between, sample].map((item) => item.operation));
    if ([...operations].every((item) => item === 'FIX' || item === 'REVIEW')) continue;
    return {
      reasonCode: 'EXECUTION_CYCLE',
      message: 'execution returned to an equivalent authoritative progress state',
      stepId: sample.stepId,
      command: sample.command,
      cycleFromSample: index,
      cycleLength: samples.length - index,
      operations: [...operations].sort(),
      remediation: 'STEP PLAN ' + sample.stepId,
    };
  }
  return null;
}

export function observeTransition(
  telemetry: ProgressTelemetry | undefined,
  sample: ProgressSample,
  options: { readonly suppressStop?: boolean } = {},
): Readonly<{ telemetry: ProgressTelemetry; blocker: Readonly<Record<string, unknown>> | null; delta: Readonly<Record<string, unknown>> | null }> {
  if (!telemetry) return { telemetry: newTelemetry(sample), blocker: null, delta: null };
  const blocker = options.suppressStop ? null : cycleBlocker(telemetry, sample);
  const before = telemetry.samples.at(-1);
  const delta = before ? compareProgress(before, sample) : null;
  return {
    telemetry: {
      schemaVersion: 1,
      samples: appendSample(telemetry, sample),
      unchangedResumes: 0,
      driftStreak: 0,
      lastDelta: delta,
      stopDecision: String(blocker?.reasonCode ?? 'continue'),
    },
    blocker,
    delta,
  };
}

export function observeResume(
  telemetry: ProgressTelemetry | undefined,
  sample: ProgressSample,
  options: { readonly suppressStop?: boolean } = {},
): Readonly<{ telemetry: ProgressTelemetry; blocker: Readonly<Record<string, unknown>> | null; delta: Readonly<Record<string, unknown>> | null }> {
  if (!telemetry || telemetry.samples.length === 0) return { telemetry: newTelemetry(sample), blocker: null, delta: null };
  const before = telemetry.samples.at(-1)!;
  const delta = compareProgress(before, sample);
  let unchangedResumes = telemetry.unchangedResumes;
  let driftStreak = telemetry.driftStreak;
  let blocker: Readonly<Record<string, unknown>> | null = null;

  if (delta.classification === 'NO_CHANGE') {
    unchangedResumes += 1;
    driftStreak = 0;
    if (!options.suppressStop && unchangedResumes >= STAGNATION_RESUME_LIMIT) {
      blocker = {
        reasonCode: 'EXECUTION_STAGNATION',
        message: 'repeated semantic resume made no material or repository progress',
        stepId: sample.stepId,
        command: sample.command,
        unchangedAttempts: unchangedResumes,
        changed: delta.changed,
        unchanged: delta.unchanged,
        remediation: 'STEP PLAN ' + sample.stepId,
      };
    }
  } else if (delta.classification === 'WORSENED') {
    unchangedResumes = 0;
    driftStreak += 1;
    if (!options.suppressStop && driftStreak >= DRIFT_LIMIT) {
      blocker = {
        reasonCode: 'EXECUTION_DRIFT',
        message: 'canonical completion/progress facts worsened across repeated semantic resumes',
        stepId: sample.stepId,
        command: sample.command,
        driftStreak,
        changed: delta.changed,
        improvements: delta.improvements,
        regressions: delta.regressions,
        remediation: 'STEP PLAN ' + sample.stepId,
      };
    }
  } else {
    unchangedResumes = 0;
    driftStreak = 0;
  }

  return {
    telemetry: {
      schemaVersion: 1,
      samples: appendSample(telemetry, sample),
      unchangedResumes,
      driftStreak,
      lastDelta: delta,
      stopDecision: String(blocker?.reasonCode ?? 'continue'),
    },
    blocker,
    delta,
  };
}
