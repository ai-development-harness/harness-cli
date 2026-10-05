import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { buildProjectGraph } from './graph.js';
import { buildArtifactInventory } from './inventory.js';
import type {
  ArtifactInventory,
  CanonicalProjectArtifact,
  CompletionProofFact,
  ProjectReadModelProviders,
} from './types.js';

export class ProjectionDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionDerivationError';
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function fmtRefs(value: unknown): string {
  const values = strings(value);
  return values.length > 0 ? values.join(', ') : '—';
}

async function completionFact(
  step: CanonicalProjectArtifact,
  providers: ProjectReadModelProviders,
): Promise<CompletionProofFact> {
  if (providers.completion) {
    try {
      return await providers.completion(step.id);
    } catch (error) {
      throw new ProjectionDerivationError(
        `${step.id}: cannot derive completion proof: ${(error as Error).message}`,
      );
    }
  }
  const complete = step.document.frontmatter.status === 'completed';
  return {
    complete,
    reasons: complete ? ['lifecycle-status-fallback'] : ['step-not-completed'],
  };
}

function assertDerivable(inventory: ArtifactInventory): void {
  if (inventory.diagnostics.length > 0) {
    throw new ProjectionDerivationError(
      `canonical inventory is invalid: ${inventory.diagnostics
        .map((item) => item.message ?? item.code)
        .join('; ')}`,
    );
  }
  const graph = buildProjectGraph(inventory);
  if (graph.diagnostics.some((item) => item.code === 'MISSING_REFERENCE' || item.code === 'DEPENDENCY_CYCLE')) {
    throw new ProjectionDerivationError(
      `project graph is not safely derivable: ${graph.diagnostics
        .map((item) => item.message ?? `${item.code}:${item.source ?? ''}->${item.target ?? ''}`)
        .join('; ')}`,
    );
  }
}

export async function renderRequirementsSpec(inventory: ArtifactInventory): Promise<string> {
  assertDerivable(inventory);
  const lines = [
    '# Requirements Specification',
    '',
    '> Tracked deterministic projection/index. Canonical REQ находятся в отдельных versioned REQ-NNN-*.md; этот файл не является источником истины.',
    '',
    '| REQ | Название | Приоритет | Источник |',
    '|---|---|---|---|',
  ];
  for (const req of [...inventory.byType.REQ].sort((a, b) => a.id.localeCompare(b.id))) {
    const meta = req.document.frontmatter;
    lines.push(
      `| [${req.id}](${path.basename(req.path)}) | ${req.title} | ${String(meta.priority ?? '—')} | ${String(meta.source ?? '—')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function renderRequirementsStatus(
  inventory: ArtifactInventory,
  providers: ProjectReadModelProviders = {},
): Promise<string> {
  assertDerivable(inventory);
  const lines = [
    '# Requirements Status',
    '',
    '> Tracked deterministic projection lifecycle state. Статус выводится из canonical REQ + STEP completion facts.',
    '',
    '| REQ | Название | Статус | Реализующие STEP | Evidence |',
    '|---|---|---|---|---|',
  ];

  for (const req of [...inventory.byType.REQ].sort((a, b) => a.id.localeCompare(b.id))) {
    const linked = strings(req.document.frontmatter.steps);
    let status = 'planned';
    const evidence: string[] = [];
    if (linked.length > 0) {
      let completed = 0;
      let deferred = 0;
      let cancelled = 0;
      for (const stepId of linked) {
        const step = inventory.byId.get(stepId);
        if (!step || step.type !== 'STEP') {
          throw new ProjectionDerivationError(`${req.id}: missing linked STEP ${stepId}`);
        }
        if (step.document.frontmatter.status === 'deferred') deferred += 1;
        if (step.document.frontmatter.status === 'cancelled') cancelled += 1;
        const proof = await completionFact(step, providers);
        if (proof.complete) {
          completed += 1;
          if (proof.proofHash) evidence.push(proof.proofHash);
        }
      }
      if (completed === linked.length) status = 'completed';
      else if (completed > 0) status = 'partial';
      else if (deferred === linked.length) status = 'deferred';
      else if (cancelled === linked.length) status = 'cancelled';
    }
    lines.push(
      `| [${req.id}](${path.basename(req.path)}) | ${req.title} | ${status} | ${linked.length > 0 ? linked.join(', ') : '—'} | ${evidence.length > 0 ? evidence.join(', ') : '—'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function renderRoadmap(inventory: ArtifactInventory): Promise<string> {
  assertDerivable(inventory);
  const lines = [
    '# Project Roadmap',
    '',
    '> Tracked deterministic projection. Полный contract каждого STEP находится в configured protocol.taskDirectory.',
    '',
    '| STEP | Название | Type | Priority | Status | Depends on | REQ |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const step of [...inventory.byType.STEP].sort((a, b) => a.id.localeCompare(b.id))) {
    const meta = step.document.frontmatter;
    lines.push(
      `| ${step.id} | ${step.title} | ${String(meta.type ?? '—')} | ${String(meta.priority ?? '—')} | ${String(meta.status ?? '—')} | ${fmtRefs(meta.depends_on)} | ${fmtRefs(meta.requirements)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function isUnblockedPlannedStep(
  inventory: ArtifactInventory,
  step: CanonicalProjectArtifact,
  providers: ProjectReadModelProviders,
): Promise<boolean> {
  if (step.document.frontmatter.status !== 'planned') return false;
  for (const dependency of strings(step.document.frontmatter.depends_on)) {
    const target = inventory.byId.get(dependency);
    if (!target || target.type !== 'STEP') {
      throw new ProjectionDerivationError(`${step.id}: missing dependency ${dependency}`);
    }
    const proof = await completionFact(target, providers);
    if (!proof.complete) return false;
  }
  const relevant = new Set([
    'PROJECT',
    step.id,
    ...strings(step.document.frontmatter.requirements),
    ...strings(step.document.frontmatter.adrs),
  ]);
  return !inventory.byType.OQ.some(
    (oq) =>
      oq.document.frontmatter.status === 'open' &&
      strings(oq.document.frontmatter.affects).some((target) => relevant.has(target)),
  );
}

export async function renderProjectStatusProjection(
  inventory: ArtifactInventory,
  providers: ProjectReadModelProviders = {},
): Promise<string> {
  assertDerivable(inventory);
  const steps = [...inventory.byType.STEP].sort((a, b) => a.id.localeCompare(b.id));
  const counts = new Map<string, number>();
  const groups = new Map<string, string[]>();
  for (const step of steps) {
    const status = String(step.document.frontmatter.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const values = groups.get(status) ?? [];
    values.push(step.id);
    groups.set(status, values);
  }
  const lines = [
    '# Project Status',
    '',
    '> Tracked deterministic projection canonical STEP state.',
    '',
    '## Summary',
    '',
    `- total: ${steps.length}`,
  ];
  for (const status of [...counts.keys()].sort()) lines.push(`- ${status}: ${counts.get(status)}`);

  const section = (title: string, statuses: readonly string[]) => {
    const values = statuses.flatMap((status) => groups.get(status) ?? []);
    lines.push('', `## ${title}`, '', values.length > 0 ? values.join(', ') : '—');
  };
  section('In progress', ['in_progress']);
  section('Blocked', ['blocked']);

  const unblocked: string[] = [];
  for (const step of steps) if (await isUnblockedPlannedStep(inventory, step, providers)) unblocked.push(step.id);
  lines.push('', '## Next unblocked work', '', unblocked.length > 0 ? unblocked.join(', ') : '—');
  section('Recent completed', ['completed']);
  return `${lines.join('\n')}\n`;
}

export async function renderOpenQuestionsIndex(inventory: ArtifactInventory): Promise<string> {
  assertDerivable(inventory);
  const lines = [
    '# Open Questions',
    '',
    '> Tracked deterministic projection/index. Canonical OQ находятся в configured sources.openQuestions.',
    '',
    '| OQ | Статус | Вопрос | Affects |',
    '|---|---|---|---|',
  ];
  for (const oq of [...inventory.byType.OQ].sort((a, b) => a.id.localeCompare(b.id))) {
    const meta = oq.document.frontmatter;
    lines.push(
      `| [${oq.id}](${oq.path}) | ${String(meta.status ?? '—')} | ${oq.title} | ${fmtRefs(meta.affects)} |`,
    );
  }
  lines.push(
    '',
    '## Blocking semantics',
    '',
    'status: open блокирует STEP по explicit affects; PROJECT используется как project-level blocker для INIT.',
  );
  return `${lines.join('\n')}\n`;
}

export async function projectionTargets(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
  providedConfig?: HarnessConfig,
): Promise<ReadonlyMap<string, string>> {
  const config = providedConfig ?? (await readConfig(projectRoot));
  const inventory = await buildArtifactInventory(projectRoot, config);
  const reqDir = await resolvePortablePathWithinBoundary(projectRoot, config.sources.requirements, 'sources.requirements');
  const targets = new Map<string, string>();
  targets.set(path.join(reqDir, 'SPEC.md'), await renderRequirementsSpec(inventory));
  targets.set(path.join(reqDir, 'STATUS.md'), await renderRequirementsStatus(inventory, providers));
  targets.set(
    await resolvePortablePathWithinBoundary(projectRoot, config.sources.roadmap, 'sources.roadmap'),
    await renderRoadmap(inventory),
  );
  targets.set(
    await resolvePortablePathWithinBoundary(projectRoot, config.sources.status, 'sources.status'),
    await renderProjectStatusProjection(inventory, providers),
  );
  targets.set(
    await resolvePortablePathWithinBoundary(projectRoot, config.sources.openQuestionsIndex, 'sources.openQuestionsIndex'),
    await renderOpenQuestionsIndex(inventory),
  );
  return targets;
}

export async function validateProjections(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
): Promise<readonly string[]> {
  const errors: string[] = [];
  const targets = await projectionTargets(projectRoot, providers);
  for (const [target, expected] of targets) {
    let actual: string;
    try {
      actual = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        errors.push(`projection missing: ${path.relative(projectRoot, target).split(path.sep).join('/')}`);
        continue;
      }
      throw error;
    }
    if (actual.replace(/\r\n/g, '\n') !== expected) {
      errors.push(`projection drift: ${path.relative(projectRoot, target).split(path.sep).join('/')}`);
    }
  }
  return errors;
}

export async function writeProjections(
  projectRoot: string,
  providers: ProjectReadModelProviders = {},
): Promise<readonly string[]> {
  const changed: string[] = [];
  const targets = await projectionTargets(projectRoot, providers);
  for (const [target, expected] of targets) {
    let actual: string | null = null;
    try {
      actual = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (actual === expected) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, expected, 'utf8');
    changed.push(path.relative(projectRoot, target).split(path.sep).join('/'));
  }
  return changed;
}
