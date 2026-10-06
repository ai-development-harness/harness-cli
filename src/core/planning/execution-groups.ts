export interface ExecutionGroup {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly number[];
  readonly dependsOn: readonly string[];
  readonly mutationPaths: readonly string[];
  readonly verificationResponsibilities: readonly string[];
  readonly parallel: boolean;
}

const GROUP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const GLOB_CHARS = /[*?\[\]{}]/;

export class ExecutionGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionGroupError';
  }
}

export function implementationPlanStepCount(text: string): number {
  return (text.match(/^### [0-9]+\. /gm) ?? []).length;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExecutionGroupError(`${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.includes('\n') || result.includes('\r')) {
    throw new ExecutionGroupError(`${label} must be a single line`);
  }
  return result;
}

function strings(value: unknown, label: string, required = false): string[] {
  if (value === undefined || value === null) {
    if (required) throw new ExecutionGroupError(`${label} must not be empty`);
    return [];
  }
  if (!Array.isArray(value)) throw new ExecutionGroupError(`${label} must be an array`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (required && result.length === 0) throw new ExecutionGroupError(`${label} must not be empty`);
  return result;
}

function mutationPath(value: unknown, label: string): string {
  let result = text(value, label);
  if (result.includes('\\')) {
    throw new ExecutionGroupError(`${label} must use repository-relative POSIX separators`);
  }
  if (result.startsWith('/') || /^[A-Za-z]:/.test(result)) {
    throw new ExecutionGroupError(`${label} must be repository-relative`);
  }
  if (GLOB_CHARS.test(result)) {
    throw new ExecutionGroupError(`${label} must be an explicit path/prefix; glob syntax is not supported`);
  }
  while (result.startsWith('./')) result = result.slice(2);
  result = result.replace(/\/+$/g, '') || '.';
  const parts = result.split('/');
  if (parts.some((part) => part === '' || part === '..' || (result !== '.' && part === '.'))) {
    throw new ExecutionGroupError(`${label} must not contain empty, '.' or '..' segments`);
  }
  return result;
}

export function mutationPathsOverlap(left: string, right: string): boolean {
  const a = left.toLocaleLowerCase('en-US');
  const b = right.toLocaleLowerCase('en-US');
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function dependsTransitively(
  groups: ReadonlyMap<string, ExecutionGroup>,
  groupId: string,
  dependencyId: string,
): boolean {
  const stack = [...(groups.get(groupId)?.dependsOn ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === dependencyId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(groups.get(current)?.dependsOn ?? []));
  }
  return false;
}

export function normalizeExecutionGroups(value: unknown, stepCount: number): ExecutionGroup[] {
  if (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)
  ) {
    return [];
  }

  let expanded: unknown = value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    expanded = Object.entries(value as Record<string, unknown>).map(([id, raw]) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ExecutionGroupError(`execution_groups.${id} must be a mapping`);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'id')) {
        throw new ExecutionGroupError(`execution_groups.${id} must not repeat id`);
      }
      return { id, ...(raw as Record<string, unknown>) };
    });
  }

  if (!Array.isArray(expanded)) {
    throw new ExecutionGroupError('executionGroups must be an array or canonical mapping');
  }
  if (!Number.isInteger(stepCount) || stepCount < 1) {
    throw new ExecutionGroupError('executionGroups require at least one canonical Implementation plan step');
  }

  const groups: ExecutionGroup[] = [];
  const ids = new Set<string>();
  const covered = new Set<number>();
  const allowed = new Set(['id', 'title', 'steps', 'dependsOn', 'mutationPaths', 'verificationResponsibilities', 'parallel']);

  for (let index = 0; index < expanded.length; index += 1) {
    const raw = expanded[index];
    const label = `executionGroups[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ExecutionGroupError(`${label} must be an object`);
    }
    const object = raw as Record<string, unknown>;
    const extra = Object.keys(object).filter((key) => !allowed.has(key)).sort();
    if (extra.length > 0) throw new ExecutionGroupError(`${label} has unsupported keys: ${extra.join(', ')}`);

    const id = text(object.id, `${label}.id`);
    if (!GROUP_ID.test(id)) throw new ExecutionGroupError(`${label}.id must match [a-z][a-z0-9-]{0,63}`);
    if (ids.has(id)) throw new ExecutionGroupError(`duplicate execution group id: ${id}`);
    ids.add(id);

    const title = text(object.title, `${label}.title`);
    if (!Array.isArray(object.steps) || object.steps.length === 0) {
      throw new ExecutionGroupError(`${id}.steps must be a non-empty array`);
    }
    const steps: number[] = [];
    for (const item of object.steps) {
      if (!Number.isInteger(item) || (item as number) < 1 || (item as number) > stepCount) {
        throw new ExecutionGroupError(`${id}.steps contains invalid implementation step: ${String(item)}`);
      }
      const step = item as number;
      if (steps.includes(step)) throw new ExecutionGroupError(`${id}.steps contains duplicate step: ${step}`);
      if (covered.has(step)) throw new ExecutionGroupError(`implementation step ${step} belongs to multiple execution groups`);
      steps.push(step);
      covered.add(step);
    }

    const dependsOn = strings(object.dependsOn ?? [], `${id}.dependsOn`);
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new ExecutionGroupError(`${id}.dependsOn contains duplicates`);
    }

    if (!Array.isArray(object.mutationPaths) || object.mutationPaths.length === 0) {
      throw new ExecutionGroupError(`${id}.mutationPaths must be a non-empty array`);
    }
    const mutationPaths = object.mutationPaths.map((item, i) => mutationPath(item, `${id}.mutationPaths[${i}]`));
    if (new Set(mutationPaths).size !== mutationPaths.length) {
      throw new ExecutionGroupError(`${id}.mutationPaths contains duplicate path/prefix`);
    }

    const verificationResponsibilities = strings(
      object.verificationResponsibilities,
      `${id}.verificationResponsibilities`,
      true,
    );
    const parallel = object.parallel ?? false;
    if (typeof parallel !== 'boolean') throw new ExecutionGroupError(`${id}.parallel must be boolean`);

    groups.push({ id, title, steps, dependsOn, mutationPaths, verificationResponsibilities, parallel });
  }

  const missing = Array.from({ length: stepCount }, (_, index) => index + 1).filter((step) => !covered.has(step));
  if (missing.length > 0) {
    throw new ExecutionGroupError(
      `executionGroups must cover every Implementation plan step exactly once; missing steps: ${missing.join(', ')}`,
    );
  }

  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const group of groups) {
    for (const dependency of group.dependsOn) {
      if (dependency === group.id) throw new ExecutionGroupError(`${group.id} cannot depend on itself`);
      if (!byId.has(dependency)) throw new ExecutionGroupError(`${group.id} depends on unknown group ${dependency}`);
    }
  }

  const color = new Map(groups.map((group) => [group.id, 0]));
  const visit = (id: string) => {
    if (color.get(id) === 1) throw new ExecutionGroupError(`execution group dependency cycle at ${id}`);
    if (color.get(id) === 2) return;
    color.set(id, 1);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    color.set(id, 2);
  };
  for (const id of [...byId.keys()].sort()) visit(id);

  const candidates = groups.filter((group) => group.parallel);
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (const right of candidates.slice(leftIndex + 1)) {
      if (dependsTransitively(byId, left.id, right.id) || dependsTransitively(byId, right.id, left.id)) continue;
      for (const leftPath of left.mutationPaths) {
        for (const rightPath of right.mutationPaths) {
          if (mutationPathsOverlap(leftPath, rightPath)) {
            throw new ExecutionGroupError(
              `parallel execution groups have overlapping mutation surfaces: ${left.id}:${leftPath} <-> ${right.id}:${rightPath}`,
            );
          }
        }
      }
    }
  }

  return groups;
}

export function executionGroupsToStorage(
  groups: readonly ExecutionGroup[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return Object.fromEntries(groups.map((group) => [
    group.id,
    {
      title: group.title,
      steps: [...group.steps],
      dependsOn: [...group.dependsOn],
      mutationPaths: [...group.mutationPaths],
      verificationResponsibilities: [...group.verificationResponsibilities],
      parallel: group.parallel,
    },
  ]));
}

export function topologicalGroupOrder(groups: readonly ExecutionGroup[]): string[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    for (const dependency of [...(byId.get(id)?.dependsOn ?? [])].sort()) visit(dependency);
    seen.add(id);
    order.push(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return order;
}

export function dependencyLayers(groups: readonly ExecutionGroup[]): string[][] {
  const remaining = new Map(groups.map((group) => [group.id, new Set(group.dependsOn)]));
  const completed = new Set<string>();
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((id) => completed.has(id)))
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) throw new ExecutionGroupError('execution group dependency graph is not acyclic');
    layers.push(ready);
    for (const id of ready) {
      completed.add(id);
      remaining.delete(id);
    }
  }
  return layers;
}

export function executionGroupProjection(groups: readonly ExecutionGroup[]): Readonly<Record<string, unknown>> {
  const layers = dependencyLayers(groups);
  return {
    groups,
    topologicalOrder: topologicalGroupOrder(groups),
    dependencyLayers: layers,
    parallelCandidates: layers.flatMap((layer) =>
      layer.length > 1
        ? layer.filter((id) => groups.find((group) => group.id === id)?.parallel)
        : [],
    ),
  };
}
