import { buildArtifactInventory } from '../project/index.js';
import {
  compareComponentSets,
  planContentHash,
  planningContextFingerprints,
} from '../planning/index.js';
import { parseCanonicalCommand } from '../protocol/index.js';
import { ExecutionStateError } from './errors.js';
import {
  INTENT_BASIS_SCHEMA_VERSION,
  MAX_INTENT_BASIS_BYTES,
  type ExecutionRecord,
  type IntentBasisV1,
} from './types.js';

const INTENT_AWARE = new Set(['PLAN', 'IMPLEMENT', 'REVIEW', 'FIX']);
const PLAN_BOUND = new Set(['IMPLEMENT', 'REVIEW', 'FIX']);

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export async function captureIntentBasis(
  projectRoot: string,
  command: string,
  capturedAt = new Date().toISOString(),
): Promise<IntentBasisV1 | null> {
  const parsed = parseCanonicalCommand(command);
  if (
    !parsed.valid ||
    parsed.domain !== 'STEP' ||
    !INTENT_AWARE.has(parsed.operation) ||
    typeof parsed.target !== 'string'
  ) {
    return null;
  }

  const stepId = parsed.target;
  const fingerprints = await planningContextFingerprints(projectRoot, stepId);
  const inventory = await buildArtifactInventory(projectRoot);
  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') throw new Error(`${stepId}: canonical STEP is missing`);
  const plan =
    typeof step.document.frontmatter.plan === 'object' &&
    step.document.frontmatter.plan !== null &&
    !Array.isArray(step.document.frontmatter.plan)
      ? (step.document.frontmatter.plan as Record<string, unknown>)
      : {};
  const planContentRequired = PLAN_BOUND.has(parsed.operation);

  const basis: IntentBasisV1 = {
    schemaVersion: INTENT_BASIS_SCHEMA_VERSION,
    stepId,
    command: parsed.normalized,
    operation: parsed.operation as IntentBasisV1['operation'],
    contextBasis: fingerprints.basis,
    contextComponents: fingerprints.components,
    planContentRequired,
    planContentHash: planContentRequired ? await planContentHash(projectRoot, stepId) : null,
    planRevision: Number.isInteger(plan.revision) ? (plan.revision as number) : null,
    capturedAt,
  };
  if (jsonBytes(basis) > MAX_INTENT_BASIS_BYTES) {
    throw new Error(`Intent Basis exceeds ${MAX_INTENT_BASIS_BYTES} UTF-8 JSON bytes`);
  }
  return basis;
}

function reasonForComponents(causes: readonly Readonly<{ component: string; change: string }>[]): string {
  const components = new Set(causes.map((item) => item.component));
  if ([...components].some((item) => item.startsWith('ADR@') || item.startsWith('ARCH@'))) {
    return 'ARCHITECTURE_BASIS_CHANGED';
  }
  if ([...components].some((item) => item.startsWith('STEP@'))) {
    return 'TASK_CONTRACT_CHANGED';
  }
  return 'INTENT_BASIS_STALE';
}

export async function intentResumeBlocker(
  projectRoot: string,
  execution: ExecutionRecord,
): Promise<Readonly<Record<string, unknown>> | null> {
  if (execution.status !== 'running' || execution.current.status !== 'running') return null;
  const parsed = parseCanonicalCommand(execution.current.command);
  if (
    !parsed.valid ||
    parsed.domain !== 'STEP' ||
    !INTENT_AWARE.has(parsed.operation) ||
    typeof parsed.target !== 'string'
  ) {
    return null;
  }

  const stepId = parsed.target;
  const remediation = `STEP PLAN ${stepId}`;
  const stored = execution.current.context.intentBasis;
  if (!stored) {
    const captureError = execution.current.context.intentBasisError;
    return captureError
      ? {
          reasonCode: 'INTENT_BASIS_UNAVAILABLE',
          message: captureError.message,
          remediation,
          stepId,
          captureError,
        }
      : {
          reasonCode: 'INTENT_BASIS_MISSING',
          message: 'interrupted semantic STEP execution has no durable Intent Basis',
          remediation,
          stepId,
        };
  }

  if (stored.schemaVersion !== INTENT_BASIS_SCHEMA_VERSION) {
    return {
      reasonCode: 'INTENT_BASIS_SCHEMA_UNSUPPORTED',
      message: `unsupported Intent Basis schemaVersion ${stored.schemaVersion}`,
      remediation,
      stepId,
      storedSchemaVersion: stored.schemaVersion,
      supportedSchemaVersion: INTENT_BASIS_SCHEMA_VERSION,
    };
  }

  let current: IntentBasisV1 | null;
  try {
    current = await captureIntentBasis(projectRoot, execution.current.command);
  } catch (error) {
    return {
      reasonCode: 'INTENT_BASIS_UNAVAILABLE',
      message: (error as Error).message,
      remediation,
      stepId,
    };
  }
  if (!current) {
    return {
      reasonCode: 'INTENT_BASIS_UNAVAILABLE',
      message: 'current command no longer resolves to an intent-aware STEP command',
      remediation,
      stepId,
    };
  }

  if (stored.contextBasis !== current.contextBasis) {
    let causes: readonly Readonly<{ component: string; change: string }>[] = [];
    try {
      causes = compareComponentSets(stored.contextComponents, current.contextComponents);
    } catch {
      causes = [{ component: 'PLANNING_CONTEXT', change: 'changed' }];
    }
    if (causes.length === 0) causes = [{ component: 'PLANNING_CONTEXT', change: 'changed' }];
    return {
      reasonCode: reasonForComponents(causes),
      message: 'semantic intent changed after the execution started',
      remediation,
      stepId,
      causes,
      storedContextBasis: stored.contextBasis,
      currentContextBasis: current.contextBasis,
    };
  }

  if (
    stored.planContentRequired &&
    stored.planContentHash !== current.planContentHash
  ) {
    return {
      reasonCode: 'PLAN_BASIS_STALE',
      message: 'Ready Implementation plan or execution-group graph changed after execution start',
      remediation,
      stepId,
      storedPlanContentHash: stored.planContentHash,
      currentPlanContentHash: current.planContentHash,
    };
  }

  return null;
}

export function throwIntentBlocker(blocker: Readonly<Record<string, unknown>>): never {
  const code = String(blocker.reasonCode) as ExecutionStateError['code'];
  throw new ExecutionStateError(
    code,
    String(blocker.message ?? 'Intent-aware resume blocked.'),
    blocker,
  );
}
