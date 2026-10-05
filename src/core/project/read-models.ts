import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { parseArtifactDocument } from '../artifacts/index.js';
import { buildTraceabilityCoverage } from './coverage.js';
import { buildProjectGraph } from './graph.js';
import { buildArtifactInventory } from './inventory.js';
import type {
  ArtifactInventory,
  CanonicalProjectArtifact,
  CompletionProofFact,
  PlanFreshnessFact,
  ProjectReadModelProviders,
} from './types.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numericId(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function completionFact(
  step: CanonicalProjectArtifact,
  providers: ProjectReadModelProviders,
): Promise<CompletionProofFact> {
  if (providers.completion) return providers.completion(step.id);
  const completed = step.document.frontmatter.status === 'completed';
  return {
    complete: completed,
    reasons: completed ? ['lifecycle-status-fallback'] : ['step-not-completed'],
  };
}

async function freshnessFact(
  step: CanonicalProjectArtifact,
  providers: ProjectReadModelProviders,
): Promise<PlanFreshnessFact> {
  if (providers.planFreshness) return providers.planFreshness(step.id);
  const plan = step.document.frontmatter.plan;
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    return {
      status: 'invalid',
      causes: [{ component: `STEP@${step.id}`, change: 'invalid-plan' }],
      action: `STEP PLAN ${step.id}`,
    };
  }
  if ((plan as Record<string, unknown>).status !== 'ready') {
    return { status: 'not_ready', causes: [], action: `STEP PLAN ${step.id}` };
  }
  return {
    status: 'blocked',
    causes: [{ component: 'PLANNING_CONTEXT', change: 'freshness-provider-unavailable' }],
    action: `STEP PLAN ${step.id}`,
  };
}

async function latestReview(
  projectRoot: string,
  config: HarnessConfig,
  stepId: string,
): Promise<{ verdict: unknown; path: string } | null> {
  const reviewRoot = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.reviewDirectory,
    'protocol.reviewDirectory',
  );
  const directory = path.join(reviewRoot, stepId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('REVIEW-') && entry.name.endsWith('.md'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  const target = candidates.at(-1);
  if (!target) return null;
  const document = await parseArtifactDocument(target);
  return {
    verdict: document.frontmatter.verdict,
    path: path.relative(projectRoot, target).split(path.sep).join('/'),
  };
}

export async function buildProjectState(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
  providedConfig?: HarnessConfig,
): Promise<Readonly<Record<string, unknown>>> {
  const config = providedConfig ?? (await readConfig(projectRoot));
  const inventory = await buildArtifactInventory(projectRoot, config);
  const graph = buildProjectGraph(inventory);
  const coverage = await buildTraceabilityCoverage(inventory, providers);

  const projectNode = {
    id: 'PROJECT',
    artifactId: 'PROJECT',
    type: 'PROJECT',
    title: config.project.name ?? 'Project',
    status: config.project.initialized ? 'initialized' : 'not_initialized',
    path: 'harness.yaml',
    metadata: { initializedAt: config.project.initializedAt },
  };

  const stepFreshness = new Map<string, PlanFreshnessFact>();
  const reqStatus = new Map<string, string>();
  const reqEvidence = new Map<string, string[]>();

  for (const step of inventory.byType.STEP) {
    stepFreshness.set(step.id, await freshnessFact(step, providers));
  }

  for (const req of inventory.byType.REQ) {
    const linked = strings(req.document.frontmatter.steps);
    if (linked.length === 0) {
      reqStatus.set(req.id, 'planned');
      reqEvidence.set(req.id, []);
      continue;
    }
    let completed = 0;
    let deferred = 0;
    let cancelled = 0;
    const evidence: string[] = [];
    for (const stepId of linked) {
      const step = inventory.byId.get(stepId);
      if (!step || step.type !== 'STEP') continue;
      if (step.document.frontmatter.status === 'deferred') deferred += 1;
      if (step.document.frontmatter.status === 'cancelled') cancelled += 1;
      const proof = await completionFact(step, providers);
      if (proof.complete) {
        completed += 1;
        if (proof.proofHash) evidence.push(proof.proofHash);
      }
    }
    const total = linked.filter((id) => inventory.byId.get(id)?.type === 'STEP').length;
    const status =
      total > 0 && completed === total
        ? 'completed'
        : completed > 0
          ? 'partial'
          : total > 0 && deferred === total
            ? 'deferred'
            : total > 0 && cancelled === total
              ? 'cancelled'
              : 'planned';
    reqStatus.set(req.id, status);
    reqEvidence.set(req.id, evidence);
  }

  const nodes = [
    projectNode,
    ...graph.nodes.map((node) => {
      if (node.type === 'REQ') {
        return {
          ...node,
          status: reqStatus.get(node.id) ?? 'planned',
          metadata: { ...node.metadata, evidence: reqEvidence.get(node.id) ?? [] },
        };
      }
      if (node.type === 'STEP') {
        const freshness = stepFreshness.get(node.id);
        return {
          ...node,
          metadata: {
            ...node.metadata,
            planFreshness: freshness?.status,
            planStaleCauses: freshness?.causes ?? [],
            planRemediation: freshness?.action ?? null,
          },
        };
      }
      return node;
    }),
  ];

  const coreNodes = nodes.filter((node) => ['REQ', 'ADR', 'STEP', 'OQ', 'PRN'].includes(node.type));
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.source.startsWith('MISSING:') && !edge.target.startsWith('MISSING:')) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
  }

  const blockers = [
    ...inventory.byType.STEP
      .filter((step) => step.document.frontmatter.status === 'blocked')
      .map((step) => {
        const affects = graph.dependency.downstreamImpact[step.id] ?? [];
        return { nodeId: step.id, kind: 'blocked_step', affects, impactCount: affects.length };
      }),
    ...inventory.byType.OQ
      .filter((oq) => oq.document.frontmatter.status === 'open')
      .map((oq) => {
        const affects = strings(oq.document.frontmatter.affects);
        return { nodeId: oq.id, kind: 'open_question', affects, impactCount: affects.length };
      }),
  ];

  const missingReferences = nodes.filter((node) => node.type === 'MISSING').length;
  const relationshipCoveragePercent =
    coreNodes.length === 0
      ? 100
      : Math.round(
          (1000 * coreNodes.filter((node) => (degree.get(node.id) ?? 0) > 0).length) / coreNodes.length,
        ) / 10;

  const hardDiagnostics = graph.diagnostics.filter((item) =>
    item.code === 'INVALID_CANONICAL_ARTIFACT' || item.code === 'DEPENDENCY_CYCLE'
  );
  const integrity = graph.diagnostics.length > 0 ? 'degraded' : 'ok';
  const byType = Object.fromEntries(
    ['REQ', 'ADR', 'STEP', 'OQ', 'PRN'].map((type) => [
      type,
      coreNodes.filter((node) => node.type === type).length,
    ]).filter(([, count]) => count !== 0),
  );
  const byStatus = Object.fromEntries(
    [...new Set(coreNodes.map((node) => node.status))]
      .sort()
      .map((status) => [status, coreNodes.filter((node) => node.status === status).length]),
  );

  return {
    schemaVersion: 1,
    status: hardDiagnostics.length > 0 ? 'BLOCKED' : 'PASS',
    integrity,
    project: {
      name: config.project.name,
      initialized: config.project.initialized,
      initializedAt: config.project.initializedAt,
      harnessRelease: config.harness.release,
    },
    summary: {
      artifacts: coreNodes.length,
      relationships: graph.edges.length,
      byType,
      byStatus,
      blockers: blockers.length,
      missingReferences,
      relationshipCoveragePercent,
      traceabilityCoverage: coverage.metrics,
    },
    graph: {
      rootNodeId: 'PROJECT',
      nodes,
      edges: graph.edges,
    },
    insights: {
      blockers,
      uncoveredRequirements: coverage.requirements
        .filter((item) => item.status === 'uncovered')
        .map((item) => String(item.id)),
      traceabilityCoverage: {
        requirements: coverage.requirements,
        orphanSteps: coverage.orphanSteps,
        invalidReferences: coverage.invalidReferences,
        blockingOpenQuestions: coverage.blockingOpenQuestions,
      },
      isolatedArtifacts: coreNodes
        .filter((node) => (degree.get(node.id) ?? 0) === 0)
        .map((node) => node.id)
        .sort(),
      dependency: {
        longestChain: graph.dependency.longestChain,
        cycles: graph.dependency.cycles,
      },
    },
    diagnostics: graph.diagnostics,
    sources: {
      requirements: config.sources.requirements,
      adrs: config.sources.adrDirectory,
      steps: config.protocol.taskDirectory,
      openQuestions: config.sources.openQuestions,
      principles: config.sources.principles,
      reviews: config.protocol.reviewDirectory,
    },
  };
}

export async function stepList(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
  providedInventory?: ArtifactInventory,
): Promise<Readonly<Record<string, unknown>>> {
  const inventory = providedInventory ?? (await buildArtifactInventory(projectRoot));
  const errors = inventory.diagnostics.map((item) => item.message ?? item.code);
  const steps = [];
  for (const step of [...inventory.byType.STEP].sort((a, b) => numericId(a.id) - numericId(b.id))) {
    const meta = step.document.frontmatter;
    const plan =
      typeof meta.plan === 'object' && meta.plan !== null && !Array.isArray(meta.plan)
        ? (meta.plan as Record<string, unknown>)
        : {};
    const freshness = await freshnessFact(step, providers);
    steps.push({
      id: step.id,
      title: step.title,
      status: meta.status,
      priority: meta.priority,
      type: meta.type,
      phase: meta.phase,
      planStatus: plan.status ?? null,
      planFreshness: freshness.status,
      planStaleCauses: freshness.causes,
      planRemediation: freshness.action,
      path: step.path,
    });
  }
  return { status: errors.length > 0 ? 'BLOCKED' : 'PASS', steps, errors };
}

export async function stepShow(
  projectRoot: string,
  rawStepId: string,
  providers: ProjectReadModelProviders = {},
  providedConfig?: HarnessConfig,
): Promise<Readonly<Record<string, unknown>>> {
  const stepId = /^\d{3,}$/.test(rawStepId) ? `STEP-${rawStepId}` : rawStepId;
  const config = providedConfig ?? (await readConfig(projectRoot));
  const inventory = await buildArtifactInventory(projectRoot, config);
  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') {
    return {
      status: 'BLOCKED',
      reasonCode: 'STEP_NOT_FOUND',
      stepId,
    };
  }
  const meta = step.document.frontmatter;
  const dependencies = strings(meta.depends_on).map((dependency) => ({
    id: dependency,
    status: inventory.byId.get(dependency)?.document.frontmatter.status ?? 'unknown',
  }));
  const executions = providers.unresolvedExecutions
    ? (await providers.unresolvedExecutions()).filter((item) =>
        item.command.includes(stepId) || item.rootCommand?.includes(stepId)
      )
    : [];
  const review = await latestReview(projectRoot, config, stepId);
  const freshness = await freshnessFact(step, providers);

  return {
    status: 'PASS',
    step: {
      id: stepId,
      title: step.title,
      status: meta.status,
      type: meta.type,
      priority: meta.priority,
      phase: meta.phase,
      plan: meta.plan,
      planFreshness: freshness,
      dependencies,
      requirements: strings(meta.requirements),
      adrs: strings(meta.adrs),
      riskFlags: strings(meta.risk_flags),
      latestReview: review,
      executions,
      path: step.path,
    },
  };
}

export async function affectedSteps(
  projectRoot: string,
  changed: readonly string[],
  providers: ProjectReadModelProviders = {},
): Promise<Readonly<Record<string, unknown>>> {
  if (changed.length === 0 || changed.some((item) => !item.trim())) {
    throw new Error('changed artifacts must be a non-empty array of strings');
  }
  const inventory = await buildArtifactInventory(projectRoot);
  const normalized = [...new Set(changed.map((item) => item.trim()))].sort();
  const affected: Array<Record<string, unknown>> = [];

  for (const step of inventory.byType.STEP) {
    const meta = step.document.frontmatter;
    const linked = new Set([
      step.id,
      ...strings(meta.requirements),
      ...strings(meta.adrs),
      ...strings(meta.depends_on),
    ]);
    const relevantOq = inventory.byType.OQ
      .filter((oq) =>
        strings(oq.document.frontmatter.affects).some((target) =>
          target === 'PROJECT' || target === step.id || strings(meta.requirements).includes(target) || strings(meta.adrs).includes(target)
        )
      )
      .map((oq) => oq.id);
    for (const id of relevantOq) linked.add(id);

    const reasons = normalized
      .filter((id) => linked.has(id))
      .map((id) => {
        const prefix = id.split('-', 1)[0];
        const label: Record<string, string> = {
          REQ: 'linked requirement changed',
          ADR: 'linked architecture decision changed',
          STEP: 'STEP/dependency contract changed',
          OQ: 'relevant open question changed',
          PRN: 'project principle changed',
        };
        return `${label[prefix] ?? 'planning component changed'}: ${id}`;
      });
    if (reasons.length === 0) continue;
    const freshness = await freshnessFact(step, providers);
    affected.push({
      step: step.id,
      reasons: [...new Set(reasons)].sort(),
      plan: freshness.status,
      causes: freshness.causes,
      action: freshness.action,
    });
  }

  return { schemaVersion: 1, status: 'PASS', changed: normalized, affected };
}

export async function projectStatus(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
): Promise<Readonly<Record<string, unknown>>> {
  const inventory = await buildArtifactInventory(projectRoot);
  if (inventory.diagnostics.length > 0) {
    return {
      status: 'BLOCKED',
      reasonCode: 'PROJECT_STATUS_INTEGRITY_FAILED',
      errors: inventory.diagnostics,
    };
  }
  const listed = await stepList(projectRoot, providers, inventory);
  if (listed.status !== 'PASS') {
    return {
      status: 'BLOCKED',
      reasonCode: 'PROJECT_STATUS_STEP_LIST_FAILED',
      errors: listed.errors,
    };
  }
  const steps = listed.steps as Array<Record<string, unknown>>;
  const byStatus: Record<string, number> = {};
  for (const item of steps) {
    const status = String(item.status);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    status: 'PASS',
    summary: {
      total: steps.length,
      byStatus: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b))),
      stalePlans: steps.filter((item) => item.planFreshness === 'stale').length,
    },
    inProgress: steps.filter((item) => item.status === 'in_progress'),
    blocked: steps.filter((item) => item.status === 'blocked'),
    stalePlans: steps.filter((item) => item.planFreshness === 'stale'),
    completed: steps.filter((item) => item.status === 'completed').map((item) => String(item.id)),
    validation: 'PASS',
  };
}
