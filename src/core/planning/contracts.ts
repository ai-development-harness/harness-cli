import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedArtifactDocument } from '../artifacts/index.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { buildArtifactInventory } from '../project/index.js';
import type {
  ArtifactInventory,
  CanonicalProjectArtifact,
  PlanFreshnessFact,
} from '../project/index.js';
import { normalizeExecutionGroups, implementationPlanStepCount } from './execution-groups.js';
import { activeBlockingPrinciples } from './principles.js';
import { contentHash, normalizeText, stableHash } from './hash.js';

const REQUIREMENT_SECTIONS = ['Requirement', 'Rationale', 'Acceptance'] as const;
const ADR_SECTIONS = [
  'Context',
  'Problem',
  'Decision',
  'Alternatives considered',
  'Consequences',
  'Security implications',
  'Data / migration implications',
  'Compatibility / operational implications',
] as const;
const STEP_CONTRACT_SECTIONS = [
  'Goal',
  'Context',
  'Scope',
  'Mutation policy',
  'Out of scope',
  'Acceptance criteria',
  'Verification',
  'Deliverables',
] as const;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sections(
  document: ParsedArtifactDocument,
  names: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(names.map((name) => [name, document.sections[name] ?? '']));
}

function artifact(
  inventory: ArtifactInventory,
  id: string,
  type: CanonicalProjectArtifact['type'],
): CanonicalProjectArtifact {
  const item = inventory.byId.get(id);
  if (!item || item.type !== type) throw new Error(`${id}: canonical ${type} artifact is missing`);
  return item;
}

export function requirementContractSnapshot(
  document: ParsedArtifactDocument,
): Readonly<Record<string, unknown>> {
  return {
    frontmatter: {
      schema: document.frontmatter.schema,
      id: document.frontmatter.id,
    },
    sections: sections(document, REQUIREMENT_SECTIONS),
  };
}

export function adrContractSnapshot(
  document: ParsedArtifactDocument,
): Readonly<Record<string, unknown>> {
  return {
    frontmatter: Object.fromEntries(
      ['schema', 'id', 'status', 'supersedes', 'superseded_by'].map((key) => [key, document.frontmatter[key]]),
    ),
    sections: sections(document, ADR_SECTIONS),
  };
}

export function taskContractSnapshot(
  step: CanonicalProjectArtifact,
): Readonly<Record<string, unknown>> {
  const meta = step.document.frontmatter;
  return {
    frontmatter: Object.fromEntries(
      ['schema', 'id', 'type', 'depends_on', 'requirements', 'adrs', 'architecture_refs', 'risk_flags']
        .map((key) => [key, meta[key]]),
    ),
    sections: sections(step.document, STEP_CONTRACT_SECTIONS),
  };
}

function headingSlug(title: string): string {
  return title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function markdownHeadings(text: string): Array<{ line: number; level: number; title: string }> {
  const result: Array<{ line: number; level: number; title: string }> = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const escaped = fence.char === '`' ? '\\`' : '~';
      if (new RegExp(`^ {0,3}${escaped}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}((?:`{3,}|~{3,}))/.exec(line);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) result.push({ line: index, level: heading[1].length, title: heading[2] });
  }
  return result;
}

async function architectureRefSnapshot(
  projectRoot: string,
  ref: string,
): Promise<Readonly<{ ref: string; content: string }>> {
  const [portablePath, fragment] = ref.split('#', 2);
  if (!portablePath) throw new Error(`architecture ref has empty path: ${ref}`);
  const filePath = await resolvePortablePathWithinBoundary(projectRoot, portablePath, `architecture ref ${ref}`);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new Error(`architecture ref file not found: ${ref}`);
  }
  if (fragment === undefined) return { ref, content: normalizeText(text) };
  if (!fragment) throw new Error(`architecture ref has empty anchor: ${ref}`);

  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headings = markdownHeadings(normalized);
  const selected = headings.find((item) => headingSlug(item.title) === fragment);
  if (!selected) throw new Error(`architecture anchor not found: ${ref}`);
  const next = headings.find((item) => item.line > selected.line && item.level <= selected.level);
  const body = lines.slice(selected.line, next?.line ?? lines.length).join('\n');
  return { ref, content: normalizeText(body) };
}

function relevantOpenQuestions(
  inventory: ArtifactInventory,
  step: CanonicalProjectArtifact,
): CanonicalProjectArtifact[] {
  const relevant = new Set([
    step.id,
    ...strings(step.document.frontmatter.requirements),
    ...strings(step.document.frontmatter.adrs),
  ]);
  return inventory.byType.OQ.filter((item) =>
    strings(item.document.frontmatter.affects).some((target) => relevant.has(target))
  );
}

export interface PlanningContextSnapshot {
  readonly schema: 4;
  readonly step: Readonly<Record<string, unknown>>;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly adrs: Readonly<Record<string, unknown>>;
  readonly dependencies: Readonly<Record<string, unknown>>;
  readonly architecture_refs: readonly Readonly<{ ref: string; content: string }>[];
  readonly open_questions: Readonly<Record<string, unknown>>;
  readonly principles?: Readonly<Record<string, unknown>>;
}

export async function planningContextSnapshot(
  projectRoot: string,
  stepId: string,
  providedInventory?: ArtifactInventory,
): Promise<PlanningContextSnapshot> {
  const inventory = providedInventory ?? (await buildArtifactInventory(projectRoot));
  if (inventory.diagnostics.length > 0) {
    throw new Error(`canonical artifact inventory is invalid: ${inventory.diagnostics.map((item) => item.message ?? item.code).join('; ')}`);
  }
  const step = artifact(inventory, stepId, 'STEP');

  const requirements: Record<string, unknown> = {};
  for (const reqId of strings(step.document.frontmatter.requirements)) {
    requirements[reqId] = requirementContractSnapshot(artifact(inventory, reqId, 'REQ').document);
  }

  const adrs: Record<string, unknown> = {};
  for (const adrId of strings(step.document.frontmatter.adrs)) {
    adrs[adrId] = adrContractSnapshot(artifact(inventory, adrId, 'ADR').document);
  }

  const dependencies: Record<string, unknown> = {};
  for (const dependencyId of strings(step.document.frontmatter.depends_on)) {
    dependencies[dependencyId] = {
      contract: taskContractSnapshot(artifact(inventory, dependencyId, 'STEP')),
    };
  }

  const architecture = [];
  for (const ref of strings(step.document.frontmatter.architecture_refs)) {
    architecture.push(await architectureRefSnapshot(projectRoot, ref));
  }

  const openQuestions: Record<string, unknown> = {};
  for (const item of relevantOpenQuestions(inventory, step)) {
    openQuestions[item.id] = {
      status: item.document.frontmatter.status,
      affects: item.document.frontmatter.affects,
      hash: contentHash(item.document.text),
    };
  }

  const snapshot: PlanningContextSnapshot = {
    schema: 4,
    step: taskContractSnapshot(step),
    requirements,
    adrs,
    dependencies,
    architecture_refs: architecture,
    open_questions: openQuestions,
  };
  const principles = activeBlockingPrinciples(inventory);
  return Object.keys(principles).length > 0 ? { ...snapshot, principles } : snapshot;
}

export function planningContextComponentsFromSnapshot(
  snapshot: PlanningContextSnapshot,
  stepId: string,
): string[] {
  const entries = [`STEP@${stepId}=${stableHash(snapshot.step)}`];
  for (const [id, value] of Object.entries(snapshot.requirements).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push(`REQ@${id}=${stableHash(value)}`);
  }
  for (const [id, value] of Object.entries(snapshot.adrs).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push(`ADR@${id}=${stableHash(value)}`);
  }
  for (const [id, value] of Object.entries(snapshot.dependencies).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push(`STEP@${id}=${stableHash(value)}`);
  }
  for (const item of snapshot.architecture_refs) {
    entries.push(`ARCH@${item.ref}=${stableHash(item)}`);
  }
  for (const [id, value] of Object.entries(snapshot.open_questions).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push(`OQ@${id}=${stableHash(value)}`);
  }
  for (const [id, value] of Object.entries(snapshot.principles ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push(`PRN@${id}=${stableHash(value)}`);
  }
  return entries.sort();
}

export async function planningContextFingerprints(
  projectRoot: string,
  stepId: string,
): Promise<Readonly<{ basis: string; components: readonly string[] }>> {
  const snapshot = await planningContextSnapshot(projectRoot, stepId);
  return {
    basis: stableHash(snapshot),
    components: planningContextComponentsFromSnapshot(snapshot, stepId),
  };
}

export async function planningContextBasis(projectRoot: string, stepId: string): Promise<string> {
  return stableHash(await planningContextSnapshot(projectRoot, stepId));
}

export async function planContentHash(projectRoot: string, stepId: string): Promise<string> {
  const inventory = await buildArtifactInventory(projectRoot);
  const step = artifact(inventory, stepId, 'STEP');
  const body = step.document.sections['Implementation plan'] ?? '';
  const plan = step.document.frontmatter.plan;
  const object =
    typeof plan === 'object' && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>)
      : {};
  const groupsValue = object.execution_groups;
  if (
    groupsValue === undefined ||
    groupsValue === null ||
    (Array.isArray(groupsValue) && groupsValue.length === 0) ||
    (typeof groupsValue === 'object' && !Array.isArray(groupsValue) && Object.keys(groupsValue as object).length === 0)
  ) {
    return contentHash(body);
  }
  const groups = normalizeExecutionGroups(groupsValue, implementationPlanStepCount(body));
  return stableHash({ implementationPlan: body, executionGroups: groups });
}

function decodeComponents(values: unknown, allowEmpty: boolean): Map<string, string> {
  if ((values === undefined || values === null) && allowEmpty) return new Map();
  if (!Array.isArray(values)) throw new Error('plan.context_components must be a string array');
  if (values.length === 0 && allowEmpty) return new Map();
  const result = new Map<string, string>();
  values.forEach((value, index) => {
    if (typeof value !== 'string' || !value.includes('=')) {
      throw new Error(`plan.context_components[${index}] must be COMPONENT=sha256`);
    }
    const cut = value.lastIndexOf('=');
    const key = value.slice(0, cut);
    const digest = value.slice(cut + 1);
    if (!key || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`plan.context_components[${index}] has invalid fingerprint`);
    }
    if (result.has(key)) throw new Error(`duplicate plan.context_components key: ${key}`);
    result.set(key, digest);
  });
  return result;
}

export function compareComponentSets(
  stored: readonly string[],
  current: readonly string[],
): readonly Readonly<{ component: string; change: 'added' | 'removed' | 'changed' }>[] {
  const before = decodeComponents(stored, false);
  const after = decodeComponents(current, false);
  const changes: Array<{ component: string; change: 'added' | 'removed' | 'changed' }> = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(key)) changes.push({ component: key, change: 'added' });
    else if (!after.has(key)) changes.push({ component: key, change: 'removed' });
    else if (before.get(key) !== after.get(key)) changes.push({ component: key, change: 'changed' });
  }
  return changes;
}

export async function planStaleness(projectRoot: string, stepId: string): Promise<PlanFreshnessFact> {
  const inventory = await buildArtifactInventory(projectRoot);
  const step = artifact(inventory, stepId, 'STEP');
  const planValue = step.document.frontmatter.plan;
  if (typeof planValue !== 'object' || planValue === null || Array.isArray(planValue)) {
    return {
      status: 'invalid',
      causes: [{ component: `STEP@${stepId}`, change: 'invalid-plan' }],
      action: `STEP PLAN ${stepId}`,
    };
  }
  const plan = planValue as Record<string, unknown>;
  if (plan.status !== 'ready') {
    return { status: 'not_ready', causes: [], action: `STEP PLAN ${stepId}` };
  }

  let fingerprints;
  try {
    fingerprints = await planningContextFingerprints(projectRoot, stepId);
  } catch (error) {
    return {
      status: 'blocked',
      causes: [{ component: 'PLANNING_CONTEXT', change: (error as Error).message }],
      action: `STEP PLAN ${stepId}`,
    };
  }
  if (plan.context_basis === fingerprints.basis) {
    return { status: 'fresh', causes: [], action: null };
  }

  let causes: readonly Readonly<{ component: string; change: string }>[];
  if (plan.context_components === undefined || (Array.isArray(plan.context_components) && plan.context_components.length === 0)) {
    causes = [{ component: 'PLANNING_CONTEXT', change: 'changed' }];
  } else {
    try {
      causes = compareComponentSets(plan.context_components as string[], fingerprints.components);
    } catch (error) {
      return {
        status: 'blocked',
        causes: [{ component: 'PLANNING_CONTEXT', change: (error as Error).message }],
        action: `STEP PLAN ${stepId}`,
      };
    }
    if (causes.length === 0) causes = [{ component: 'PLANNING_CONTEXT', change: 'changed' }];
  }
  return {
    status: 'stale',
    causes,
    action: `STEP PLAN ${stepId}`,
    storedBasis: typeof plan.context_basis === 'string' ? plan.context_basis : null,
    currentBasis: fingerprints.basis,
  };
}

export async function initReviewBasis(projectRoot: string, stage: 'requirements' | 'roadmap'): Promise<string> {
  const config = await readConfig(projectRoot);
  const inventory = await buildArtifactInventory(projectRoot, config);
  const payload: Record<string, unknown> = {
    schema: 2,
    stage,
    project_overview: null,
    requirements: {},
    adrs: {},
    open_questions: {},
    architecture: null,
  };

  const overview = await resolvePortablePathWithinBoundary(projectRoot, config.sources.projectOverview, 'sources.projectOverview');
  try {
    payload.project_overview = contentHash(await readFile(overview, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  payload.requirements = Object.fromEntries(
    inventory.byType.REQ.map((item) => [path.basename(item.path), contentHash(item.document.text)]).sort(([a], [b]) => a.localeCompare(b)),
  );
  payload.adrs = Object.fromEntries(
    inventory.byType.ADR.map((item) => [path.basename(item.path), contentHash(item.document.text)]).sort(([a], [b]) => a.localeCompare(b)),
  );
  payload.open_questions = Object.fromEntries(
    inventory.byType.OQ.map((item) => [item.id, contentHash(item.document.text)]).sort(([a], [b]) => a.localeCompare(b)),
  );

  const architecture = await resolvePortablePathWithinBoundary(projectRoot, config.sources.architecture, 'sources.architecture');
  try {
    payload.architecture = contentHash(await readFile(architecture, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (stage === 'roadmap') {
    payload.steps = Object.fromEntries(
      inventory.byType.STEP.map((item) => [path.basename(item.path), contentHash(item.document.text)]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return stableHash(payload);
}
