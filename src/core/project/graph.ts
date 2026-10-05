import type {
  ArtifactInventory,
  ProjectStateDiagnostic,
  ProjectStateEdge,
  ProjectStateNode,
} from './types.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface ProjectGraph {
  readonly nodes: readonly ProjectStateNode[];
  readonly edges: readonly ProjectStateEdge[];
  readonly diagnostics: readonly ProjectStateDiagnostic[];
  readonly dependency: {
    readonly longestChain: number;
    readonly cycles: readonly (readonly string[])[];
    readonly downstreamImpact: Readonly<Record<string, readonly string[]>>;
  };
}

function dependencyAnalysis(
  steps: ArtifactInventory['byType']['STEP'],
): ProjectGraph['dependency'] {
  const known = new Set(steps.map((item) => item.id));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, Set<string>>();
  for (const step of steps) {
    const deps = strings(step.document.frontmatter.depends_on).filter((id) => known.has(id));
    dependencies.set(step.id, deps);
    for (const dep of deps) {
      const set = dependents.get(dep) ?? new Set<string>();
      set.add(step.id);
      dependents.set(dep, set);
    }
  }

  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>(steps.map((step) => [step.id, 0]));
  const stack: string[] = [];
  const visit = (id: string) => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      const state = color.get(dep) ?? 0;
      if (state === 0) visit(dep);
      else if (state === 1) {
        const start = stack.indexOf(dep);
        const cycle = [...stack.slice(Math.max(0, start)), dep];
        if (!cycles.some((existing) => existing.join('>') === cycle.join('>'))) cycles.push(cycle);
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const step of steps) if ((color.get(step.id) ?? 0) === 0) visit(step.id);

  const memo = new Map<string, number>();
  const longestFrom = (id: string, active = new Set<string>()): number => {
    if (active.has(id)) return 0;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    active.add(id);
    const value = 1 + Math.max(0, ...(dependencies.get(id) ?? []).map((dep) => longestFrom(dep, new Set(active))));
    memo.set(id, value);
    return value;
  };

  const downstreamImpact: Record<string, string[]> = {};
  for (const step of steps) {
    const seen = new Set<string>();
    const pending = [...(dependents.get(step.id) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(dependents.get(current) ?? []));
    }
    downstreamImpact[step.id] = [...seen].sort();
  }

  return {
    longestChain: steps.length === 0 ? 0 : Math.max(...steps.map((step) => longestFrom(step.id))),
    cycles,
    downstreamImpact,
  };
}

export function buildProjectGraph(inventory: ArtifactInventory): ProjectGraph {
  const nodes = new Map<string, ProjectStateNode>();
  const diagnostics: ProjectStateDiagnostic[] = [...inventory.diagnostics];
  const edgeMap = new Map<string, ProjectStateEdge>();

  for (const artifact of inventory.artifacts) {
    const meta = artifact.document.frontmatter;
    nodes.set(artifact.id, {
      id: artifact.id,
      artifactId: artifact.id,
      type: artifact.type,
      title: artifact.title,
      status: String(meta.status ?? (artifact.type === 'REQ' ? 'derived' : 'unknown')),
      path: artifact.path,
      metadata: artifact.type === 'STEP'
        ? {
            priority: meta.priority,
            stepType: meta.type,
            phase: meta.phase,
            riskFlags: strings(meta.risk_flags),
            planStatus:
              typeof meta.plan === 'object' && meta.plan !== null && !Array.isArray(meta.plan)
                ? (meta.plan as Record<string, unknown>).status
                : null,
          }
        : artifact.type === 'REQ'
          ? { priority: meta.priority, source: meta.source }
          : artifact.type === 'ADR'
            ? { date: meta.date }
            : artifact.type === 'OQ'
              ? { createdAt: meta.created_at, resolvedAt: meta.resolved_at }
              : { severity: meta.severity, scope: meta.scope },
    });
  }

  const resolve = (id: string, declaredBy: string, relation: ProjectStateEdge['relation']): string => {
    if (nodes.has(id) || id === 'PROJECT') return id;
    const missingId = `MISSING:${id}`;
    if (!nodes.has(missingId)) {
      nodes.set(missingId, {
        id: missingId,
        artifactId: id,
        type: 'MISSING',
        title: id,
        status: 'missing',
        path: null,
        metadata: { expectedType: id.includes('-') ? id.split('-', 1)[0] : 'UNKNOWN' },
      });
    }
    if (!diagnostics.some((item) =>
      item.code === 'MISSING_REFERENCE' &&
      item.source === declaredBy &&
      item.target === id &&
      item.relation === relation
    )) {
      diagnostics.push({ code: 'MISSING_REFERENCE', source: declaredBy, target: id, relation });
    }
    return missingId;
  };

  const addEdge = (
    source: string,
    target: string,
    relation: ProjectStateEdge['relation'],
    declaredBy: string,
  ) => {
    const actualSource = resolve(source, declaredBy, relation);
    const actualTarget = resolve(target, declaredBy, relation);
    const key = `${relation}:${actualSource}:${actualTarget}`;
    const existing = edgeMap.get(key);
    if (existing) {
      const declaredBySet = new Set(existing.declaredBy);
      declaredBySet.add(declaredBy);
      edgeMap.set(key, { ...existing, declaredBy: [...declaredBySet].sort() });
      return;
    }
    edgeMap.set(key, {
      id: key,
      source: actualSource,
      target: actualTarget,
      relation,
      declaredBy: [declaredBy],
    });
  };

  for (const req of inventory.byType.REQ) {
    for (const step of strings(req.document.frontmatter.steps)) addEdge(req.id, step, 'implemented_by', req.id);
    for (const adr of strings(req.document.frontmatter.adrs)) addEdge(adr, req.id, 'addresses', req.id);
  }
  for (const adr of inventory.byType.ADR) {
    for (const req of strings(adr.document.frontmatter.requirements)) addEdge(adr.id, req, 'addresses', adr.id);
    for (const step of strings(adr.document.frontmatter.steps)) addEdge(adr.id, step, 'governs', adr.id);
  }
  for (const step of inventory.byType.STEP) {
    for (const dep of strings(step.document.frontmatter.depends_on)) addEdge(step.id, dep, 'depends_on', step.id);
    for (const req of strings(step.document.frontmatter.requirements)) addEdge(req, step.id, 'implemented_by', step.id);
    for (const adr of strings(step.document.frontmatter.adrs)) addEdge(adr, step.id, 'governs', step.id);
  }
  for (const oq of inventory.byType.OQ) {
    for (const target of strings(oq.document.frontmatter.affects)) addEdge(oq.id, target, 'affects', oq.id);
  }

  const dependency = dependencyAnalysis(inventory.byType.STEP);
  for (const cycle of dependency.cycles) {
    diagnostics.push({
      code: 'DEPENDENCY_CYCLE',
      source: cycle[0],
      target: cycle.at(-1),
      relation: 'depends_on',
      message: cycle.join(' -> '),
    });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id)),
    edges: [...edgeMap.values()].sort((a, b) =>
      a.relation.localeCompare(b.relation) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    ),
    diagnostics,
    dependency,
  };
}
