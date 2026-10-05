import { buildProjectGraph } from './graph.js';
import { buildArtifactInventory } from './inventory.js';
import type {
  CanonicalProjectArtifact,
  ProjectReadModelProviders,
  UnresolvedExecutionFact,
} from './types.js';

const PRIORITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});
const ACTIVE_STATUSES = new Set(['planned', 'in_progress', 'blocked']);
const STEP_ID_SEARCH = /\bSTEP-\d{3,}\b/;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function riskFlags(step: CanonicalProjectArtifact): string[] {
  return strings(step.document.frontmatter.risk_flags).filter((item) => item !== 'none').sort();
}

function planningBlockers(
  step: CanonicalProjectArtifact,
  inventory: Awaited<ReturnType<typeof buildArtifactInventory>>,
): string[] {
  const blockers: string[] = [];
  const phase = step.document.frontmatter.phase;
  if (typeof phase !== 'string' || !phase.trim() || phase.toUpperCase() === 'TBD') {
    blockers.push('phase-is-tbd');
  }

  const relevant = new Set([
    'PROJECT',
    step.id,
    ...strings(step.document.frontmatter.requirements),
    ...strings(step.document.frontmatter.adrs),
  ]);
  for (const oq of inventory.byType.OQ) {
    if (
      oq.document.frontmatter.status === 'open' &&
      strings(oq.document.frontmatter.affects).some((target) => relevant.has(target))
    ) {
      blockers.push(`open-question:${oq.id}`);
    }
  }

  for (const adrId of strings(step.document.frontmatter.adrs)) {
    const adr = inventory.byId.get(adrId);
    if (!adr || adr.type !== 'ADR') {
      blockers.push(`missing-adr:${adrId}`);
      continue;
    }
    const status = adr.document.frontmatter.status;
    const stepType = step.document.frontmatter.type;
    const allowed = status === 'accepted' || (stepType === 'adr' && status === 'proposed');
    if (!allowed) blockers.push(`adr-not-accepted:${adrId}`);
  }
  return blockers.sort();
}

async function dependencyFailures(
  step: CanonicalProjectArtifact,
  inventory: Awaited<ReturnType<typeof buildArtifactInventory>>,
  providers: ProjectReadModelProviders,
): Promise<string[]> {
  const failures: string[] = [];
  for (const dependency of strings(step.document.frontmatter.depends_on)) {
    const target = inventory.byId.get(dependency);
    if (!target || target.type !== 'STEP') {
      failures.push(`missing-dependency:${dependency}`);
      continue;
    }
    if (providers.completion) {
      const proof = await providers.completion(dependency);
      if (!proof.complete) failures.push(`dependency-incomplete:${dependency}`);
    } else if (target.document.frontmatter.status !== 'completed') {
      failures.push(`dependency-incomplete:${dependency}`);
    }
  }
  return failures;
}

async function freshCommand(
  step: CanonicalProjectArtifact,
  inventory: Awaited<ReturnType<typeof buildArtifactInventory>>,
  providers: ProjectReadModelProviders,
): Promise<readonly [string | null, readonly string[]]> {
  const status = step.document.frontmatter.status;
  if (status !== 'planned' && status !== 'in_progress') {
    return [null, [`status:${String(status)}`]];
  }

  const plan = step.document.frontmatter.plan;
  const planStatus =
    typeof plan === 'object' && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>).status
      : null;

  if (planStatus !== 'ready') {
    const blockers = planningBlockers(step, inventory);
    return blockers.length > 0
      ? [null, blockers]
      : [`STEP PLAN ${step.id}`, []];
  }

  if (providers.planFreshness) {
    const freshness = await providers.planFreshness(step.id);
    if (freshness.status === 'stale') return [null, ['plan-context-basis-is-stale']];
    if (freshness.status !== 'fresh') return [null, [`plan-freshness:${freshness.status}`]];
  } else {
    return [null, ['planning-freshness-provider-unavailable']];
  }

  const dependency = await dependencyFailures(step, inventory, providers);
  if (dependency.length > 0) return [null, dependency];

  if (providers.implementationPrerequisites) {
    const failures = await providers.implementationPrerequisites(step.id);
    if (failures.length > 0) return [null, [...failures]];
  }

  return [`STEP IMPLEMENT ${step.id}`, []];
}

function stepIdFromExecution(item: UnresolvedExecutionFact): string | null {
  for (const value of [item.command, item.rootCommand]) {
    if (!value) continue;
    const match = STEP_ID_SEARCH.exec(value);
    if (match) return match[0];
  }
  return null;
}

function ranking(
  source: 'execution' | 'fresh',
  lifecycle: string,
  step: CanonicalProjectArtifact,
  downstream: number,
  roadmapIndex: number,
): Readonly<Record<string, unknown>> {
  const priority = String(step.document.frontmatter.priority);
  const risks = riskFlags(step);
  const sourceRank = source === 'execution' ? 0 : 1;
  const lifecycleRank =
    source === 'execution'
      ? lifecycle === 'RESUME'
        ? 0
        : 1
      : lifecycle === 'in_progress'
        ? 0
        : 1;
  return {
    sourceRank,
    lifecycleRank,
    priorityRank: PRIORITY_RANK[priority],
    priority,
    downstreamImpact: downstream,
    riskFlagCount: risks.length,
    riskFlags: risks,
    roadmapIndex,
    sortKey: [
      sourceRank,
      lifecycleRank,
      PRIORITY_RANK[priority],
      -downstream,
      -risks.length,
      roadmapIndex,
    ],
  };
}

function compareCandidates(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): number {
  const a = (left.ranking as { sortKey: number[] }).sortKey;
  const b = (right.ranking as { sortKey: number[] }).sortKey;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export async function resolveStepAction(
  projectRoot: string,
  rawStepId: string,
  providers: ProjectReadModelProviders = {},
): Promise<Readonly<Record<string, unknown>>> {
  const stepId = /^\d{3,}$/.test(rawStepId) ? `STEP-${rawStepId}` : rawStepId;
  const inventory = await buildArtifactInventory(projectRoot);
  if (inventory.diagnostics.length > 0) {
    return {
      status: 'BLOCKED',
      reasonCode: 'STEP_ACTION_STATE_INVALID',
      stepId,
      diagnostics: inventory.diagnostics,
    };
  }
  const step = inventory.byId.get(stepId);
  if (!step || step.type !== 'STEP') {
    return { status: 'BLOCKED', reasonCode: 'STEP_ACTION_STATE_INVALID', stepId, message: 'STEP not found' };
  }
  const [command, reasons] = await freshCommand(step, inventory, providers);
  if (!command) {
    return {
      status: 'BLOCKED',
      reasonCode: 'STEP_ACTION_BLOCKED',
      stepId,
      stepType: step.document.frontmatter.type,
      lifecycleStatus: step.document.frontmatter.status,
      reasons,
    };
  }
  return {
    status: 'PASS',
    stepId,
    stepType: step.document.frontmatter.type,
    lifecycleStatus: step.document.frontmatter.status,
    command,
  };
}

export async function resolveStepNext(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
): Promise<Readonly<Record<string, unknown>>> {
  const inventory = await buildArtifactInventory(projectRoot);
  const graph = buildProjectGraph(inventory);
  if (
    inventory.diagnostics.length > 0 ||
    graph.diagnostics.some((item) => item.code === 'DEPENDENCY_CYCLE' || item.code === 'MISSING_REFERENCE')
  ) {
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      reasonCode: 'STEP_NEXT_STATE_INVALID',
      diagnostics: [...inventory.diagnostics, ...graph.diagnostics],
    };
  }

  const order = [...inventory.byType.STEP].sort((a, b) => a.id.localeCompare(b.id));
  for (const step of order) {
    const priority = String(step.document.frontmatter.priority);
    if (!(priority in PRIORITY_RANK)) {
      return {
        schemaVersion: 1,
        status: 'BLOCKED',
        reasonCode: 'STEP_NEXT_STATE_INVALID',
        message: `${step.id}: unsupported priority ${JSON.stringify(priority)}`,
      };
    }
  }

  const roadmapIndex = new Map(order.map((step, index) => [step.id, index]));
  const candidates: Array<Record<string, unknown>> = [];
  const blocked: Array<Record<string, unknown>> = [];
  const executions = providers.unresolvedExecutions ? await providers.unresolvedExecutions() : [];
  const seenExecutionSteps = new Set<string>();

  for (const execution of executions) {
    if (!['RESUME', 'NEXT'].includes(execution.status)) continue;
    if (!execution.command.startsWith('STEP ')) continue;
    const stepId = stepIdFromExecution(execution);
    if (!stepId || seenExecutionSteps.has(stepId)) continue;
    const step = inventory.byId.get(stepId);
    if (!step || step.type !== 'STEP') continue;
    seenExecutionSteps.add(stepId);
    candidates.push({
      stepId,
      title: step.title,
      command: execution.command,
      source: 'execution',
      status: step.document.frontmatter.status,
      executionId: execution.executionId,
      resolverStatus: execution.status,
      ranking: ranking(
        'execution',
        execution.status,
        step,
        (graph.dependency.downstreamImpact[stepId] ?? []).filter((id) =>
          ACTIVE_STATUSES.has(String(inventory.byId.get(id)?.document.frontmatter.status)),
        ).length,
        roadmapIndex.get(stepId) ?? Number.MAX_SAFE_INTEGER,
      ),
    });
  }

  for (const step of order) {
    if (seenExecutionSteps.has(step.id)) continue;
    try {
      const [command, reasons] = await freshCommand(step, inventory, providers);
      if (!command) {
        blocked.push({ stepId: step.id, reasons });
        continue;
      }
      candidates.push({
        stepId: step.id,
        title: step.title,
        command,
        source: 'fresh',
        status: step.document.frontmatter.status,
        ranking: ranking(
          'fresh',
          String(step.document.frontmatter.status),
          step,
          (graph.dependency.downstreamImpact[step.id] ?? []).filter((id) =>
            ACTIVE_STATUSES.has(String(inventory.byId.get(id)?.document.frontmatter.status)),
          ).length,
          roadmapIndex.get(step.id) ?? Number.MAX_SAFE_INTEGER,
        ),
      });
    } catch (error) {
      blocked.push({ stepId: step.id, reasons: [(error as Error).message] });
    }
  }

  const byCommand = new Map<string, Record<string, unknown>>();
  for (const candidate of candidates) {
    const command = String(candidate.command);
    const existing = byCommand.get(command);
    if (!existing || compareCandidates(candidate, existing) < 0) byCommand.set(command, candidate);
  }
  const ranked = [...byCommand.values()].sort(compareCandidates);
  if (ranked.length === 0) {
    return {
      schemaVersion: 1,
      status: 'BLOCKED',
      reasonCode: 'NO_EXECUTABLE_STEP',
      eligibleCount: 0,
      blockedCount: blocked.length,
      blockers: blocked.slice(0, 10),
    };
  }

  const selected = ranked[0];
  return {
    schemaVersion: 1,
    status: 'PASS',
    reasonCode: selected.source === 'execution' ? 'RESUME_STEP_EXECUTION' : 'STEP_RECOMMENDATION',
    command: selected.command,
    selected,
    eligibleCount: ranked.length,
    blockedCount: blocked.length,
    alternatives: ranked.slice(1, 5),
    rankingPolicy: [
      'resume-existing-execution',
      'in-progress-before-planned',
      'priority-critical-high-medium-low',
      'larger-transitive-downstream-impact',
      'risk-flag-count-for-visibility-only',
      'canonical-roadmap-order',
    ],
  };
}
