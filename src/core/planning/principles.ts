import type { ArtifactInventory } from '../project/index.js';

export interface PrincipleSnapshot {
  readonly frontmatter: {
    readonly schema: unknown;
    readonly id: string;
    readonly status: 'active';
    readonly severity: 'blocking';
    readonly scope: unknown;
  };
  readonly sections: Readonly<Record<string, string>>;
}

const PRINCIPLE_SECTIONS = ['Rule', 'Rationale', 'Applies to', 'Exceptions / approved deviation'] as const;

export function activeBlockingPrinciples(
  inventory: ArtifactInventory,
): Readonly<Record<string, PrincipleSnapshot>> {
  const result: Record<string, PrincipleSnapshot> = {};
  for (const principle of [...inventory.byType.PRN].sort((a, b) => a.id.localeCompare(b.id))) {
    const meta = principle.document.frontmatter;
    if (meta.status !== 'active' || meta.severity !== 'blocking') continue;
    result[principle.id] = {
      frontmatter: {
        schema: meta.schema,
        id: principle.id,
        status: 'active',
        severity: 'blocking',
        scope: meta.scope,
      },
      sections: Object.fromEntries(
        PRINCIPLE_SECTIONS.map((name) => [name, principle.document.sections[name] ?? '']),
      ),
    };
  }
  return result;
}

export function activePrincipleContextCandidates(
  inventory: ArtifactInventory,
): readonly Readonly<{
  artifact: string;
  path: string;
  sections: readonly string[];
}>[] {
  return [...inventory.byType.PRN]
    .filter((item) => item.document.frontmatter.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => ({
      artifact: item.id,
      path: item.path,
      sections: ['Rule', 'Applies to', 'Exceptions / approved deviation'],
    }));
}
