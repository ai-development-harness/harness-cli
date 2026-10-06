import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildArtifactInventory } from '../project/index.js';
import type { ArtifactInventory, CanonicalProjectArtifact } from '../project/index.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { activePrincipleContextCandidates } from './principles.js';
import { implementationPlanStepCount, normalizeExecutionGroups } from './execution-groups.js';
import { planContentHash, planningContextBasis } from './contracts.js';
import { implementationPrerequisiteFailures } from './prerequisites.js';

const execFileAsync = promisify(execFile);

export type ContextRole = 'planner' | 'implementer' | 'reviewer';

const ROLE_COMMAND: Readonly<Record<ContextRole, string>> = {
  planner: 'STEP PLAN',
  implementer: 'STEP IMPLEMENT',
  reviewer: 'STEP REVIEW',
};

const ROLE_SECTIONS: Readonly<Record<ContextRole, Readonly<Record<string, readonly string[]>>>> = {
  planner: {
    step: ['Goal', 'Context', 'Scope', 'Mutation policy', 'Out of scope', 'Acceptance criteria', 'Verification'],
    requirement: ['Requirement', 'Rationale', 'Acceptance'],
    adr: ['Decision', 'Consequences', 'Security implications', 'Data / migration implications', 'Compatibility / operational implications'],
    dependency: ['Goal', 'Acceptance criteria'],
    oq: ['Context', 'Decision needed'],
  },
  implementer: {
    step: ['Scope', 'Mutation policy', 'Out of scope', 'Acceptance criteria', 'Verification', 'Implementation plan'],
    requirement: ['Requirement', 'Acceptance'],
    adr: ['Decision', 'Consequences', 'Security implications', 'Data / migration implications', 'Compatibility / operational implications'],
    dependency: ['Goal', 'Acceptance criteria', 'Evidence'],
    oq: ['Decision needed'],
  },
  reviewer: {
    step: ['Scope', 'Mutation policy', 'Out of scope', 'Acceptance criteria', 'Verification', 'Implementation plan', 'Evidence'],
    requirement: ['Requirement', 'Acceptance'],
    adr: ['Decision', 'Consequences', 'Security implications', 'Data / migration implications', 'Compatibility / operational implications'],
    dependency: ['Goal', 'Acceptance criteria', 'Evidence'],
    oq: ['Context', 'Decision needed'],
  },
};

export class ContextContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextContractError';
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function artifact(
  inventory: ArtifactInventory,
  id: string,
  type: CanonicalProjectArtifact['type'],
): CanonicalProjectArtifact {
  const item = inventory.byId.get(id);
  if (!item || item.type !== type) throw new ContextContractError(`${id}: required canonical artifact is missing`);
  return item;
}

function projection(
  artifactItem: CanonicalProjectArtifact,
  sectionNames: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const missing = sectionNames.filter((name) => !(name in artifactItem.document.sections));
  if (missing.length > 0) {
    throw new ContextContractError(
      `${artifactItem.id}: required sections missing: ${missing.join(', ')}`,
    );
  }
  const selected = [...sectionNames];
  for (const name of optional) {
    if (name in artifactItem.document.sections && !selected.includes(name)) selected.push(name);
  }
  return { artifact: artifactItem.id, path: artifactItem.path, sections: selected };
}

async function architectureProjection(
  projectRoot: string,
  ref: string,
): Promise<Readonly<Record<string, unknown>>> {
  const [portablePath, anchor] = ref.split('#', 2);
  if (!portablePath) throw new ContextContractError(`architecture ref has empty path: ${ref}`);
  const target = await resolvePortablePathWithinBoundary(projectRoot, portablePath, `architecture context ${ref}`);
  try {
    await readFile(target, 'utf8');
  } catch {
    throw new ContextContractError(`architecture ref file not found: ${ref}`);
  }
  return { artifact: ref, path: portablePath, anchor: anchor ?? null, sections: [] };
}

async function repositoryRevision(projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }),
      execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }),
    ]);
    return {
      gitHead: head.trim() || null,
      dirty: status.length > 0,
    };
  } catch {
    return { gitHead: null, dirty: null };
  }
}

function relevantOqs(
  inventory: ArtifactInventory,
  step: CanonicalProjectArtifact,
): CanonicalProjectArtifact[] {
  const relevant = new Set([
    step.id,
    ...strings(step.document.frontmatter.requirements),
    ...strings(step.document.frontmatter.adrs),
  ]);
  return inventory.byType.OQ
    .filter((item) => strings(item.document.frontmatter.affects).some((target) => relevant.has(target)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildContextContract(
  projectRoot: string,
  stepId: string,
  role: ContextRole,
): Promise<Readonly<Record<string, unknown>>> {
  const inventory = await buildArtifactInventory(projectRoot);
  if (inventory.diagnostics.length > 0) {
    throw new ContextContractError(
      `context resolution failed: ${inventory.diagnostics.map((item) => item.message ?? item.code).join('; ')}`,
    );
  }
  const step = artifact(inventory, stepId, 'STEP');
  const sections = ROLE_SECTIONS[role];
  const required: Array<Readonly<Record<string, unknown>>> = [
    projection(step, sections.step),
  ];

  for (const reqId of strings(step.document.frontmatter.requirements)) {
    required.push(projection(artifact(inventory, reqId, 'REQ'), sections.requirement));
  }
  for (const adrId of strings(step.document.frontmatter.adrs)) {
    required.push(projection(artifact(inventory, adrId, 'ADR'), sections.adr));
  }
  for (const dependencyId of strings(step.document.frontmatter.depends_on)) {
    required.push(projection(artifact(inventory, dependencyId, 'STEP'), sections.dependency));
  }
  for (const oq of relevantOqs(inventory, step)) {
    required.push(projection(oq, sections.oq, ['Resolution']));
  }
  for (const ref of strings(step.document.frontmatter.architecture_refs)) {
    required.push(await architectureProjection(projectRoot, ref));
  }
  if (role === 'planner' || role === 'reviewer') {
    required.push(...activePrincipleContextCandidates(inventory));
  }

  const unique: Array<Readonly<Record<string, unknown>>> = [];
  const seen = new Set<string>();
  for (const item of required) {
    const key = JSON.stringify([item.artifact, item.path, item.sections ?? [], item.anchor ?? null]);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  const contract: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'PASS',
    runtimeNeutral: true,
    role,
    command: `${ROLE_COMMAND[role]} ${stepId}`,
    stepId,
    repositoryRevision: await repositoryRevision(projectRoot),
    required: unique,
    optionalExpansions: [
      {
        trigger: 'material integration/security/domain boundary discovered',
        action: 'request explicit expansion with repository-relative path and reason',
      },
      {
        trigger: 'verification/review evidence references an additional file',
        action: 'request explicit expansion with repository-relative path and reason',
      },
    ],
    forbiddenOrUnnecessary: [
      '.harness/tools/**',
      'planning/** unrelated to current STEP',
      'docs/** unrelated to explicit canonical links',
      '.agents/skills/** except selected command skill',
    ],
  };
  const manifestChars = JSON.stringify(contract).length;
  contract.metrics = {
    artifactCount: unique.length,
    sectionCount: unique.reduce((sum, item) => sum + ((item.sections as unknown[])?.length ?? 0), 0),
    manifestChars,
    fullRepositoryPreload: false,
  };
  return contract;
}

export async function validateContextExpansion(
  projectRoot: string,
  portablePath: string,
  reason: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!reason.trim()) throw new ContextContractError('context expansion requires a non-empty reason');
  const target = await resolvePortablePathWithinBoundary(projectRoot, portablePath, 'context expansion');
  const normalized = path.relative(projectRoot, target).split(path.sep).join('/');
  if (normalized === '.harness/tools' || normalized.startsWith('.harness/tools/')) {
    throw new ContextContractError('tool source is forbidden in normal semantic context');
  }
  try {
    await readFile(target, 'utf8');
  } catch {
    throw new ContextContractError(`expanded context file not found: ${normalized}`);
  }
  return {
    schemaVersion: 1,
    status: 'PASS',
    path: normalized,
    reason: reason.trim(),
  };
}

export async function buildStepContext(
  projectRoot: string,
  stepId: string,
  phase: 'plan' | 'implement' | 'review',
): Promise<Readonly<Record<string, unknown>>> {
  const inventory = await buildArtifactInventory(projectRoot);
  const step = artifact(inventory, stepId, 'STEP');
  const meta = step.document.frontmatter;
  const plan =
    typeof meta.plan === 'object' && meta.plan !== null && !Array.isArray(meta.plan)
      ? (meta.plan as Record<string, unknown>)
      : {};
  const groups = normalizeExecutionGroups(
    plan.execution_groups,
    implementationPlanStepCount(step.document.sections['Implementation plan'] ?? ''),
  );

  const role: ContextRole = phase === 'plan' ? 'planner' : phase === 'implement' ? 'implementer' : 'reviewer';
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'PASS',
    phase,
    step: {
      id: step.id,
      path: step.path,
      status: meta.status,
      type: meta.type,
      priority: meta.priority,
      phase: meta.phase,
      riskFlags: strings(meta.risk_flags),
      plan: {
        status: plan.status ?? null,
        revision: plan.revision ?? null,
        reviewedReport: plan.reviewed_report ?? null,
        executionGroups: groups,
      },
    },
    contextContract: await buildContextContract(projectRoot, stepId, role),
  };

  if (phase === 'plan') {
    result.deterministic = {
      contextBasis: await planningContextBasis(projectRoot, stepId),
      planContentHash: await planContentHash(projectRoot, stepId),
      dependencyCompletionRequired: false,
    };
  } else if (phase === 'implement') {
    const failures = await implementationPrerequisiteFailures(projectRoot, stepId);
    result.deterministic = {
      implementPrerequisites: {
        status: failures.length === 0 ? 'PASS' : 'BLOCKED',
        failures,
      },
    };
  } else {
    result.deterministic = {
      reviewTarget: await repositoryRevision(projectRoot),
    };
  }
  return result;
}
