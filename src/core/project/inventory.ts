import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { parseArtifactDocument } from '../artifacts/index.js';
import type {
  ArtifactInventory,
  CanonicalProjectArtifact,
  ProjectArtifactType,
  ProjectStateDiagnostic,
} from './types.js';

function titleFromH1(h1: string | null): string {
  if (!h1) return '';
  const clean = h1.replace(/^#\s+/, '');
  const separator = clean.indexOf(' — ');
  return separator >= 0 ? clean.slice(separator + 3).trim() : clean.trim();
}

async function files(directory: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.startsWith(prefix) && entry.name.endsWith('.md'))
    .filter((entry) => entry.name !== 'TEMPLATE.md')
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function expectedIdentity(type: ProjectArtifactType, filePath: string, id: string): boolean {
  const name = path.basename(filePath);
  if (type === 'STEP') return name === `${id}.md`;
  return name === `${id}.md` || name.startsWith(`${id}-`);
}

function expectedId(type: ProjectArtifactType, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return new RegExp(`^${type}-\\d{3,}$`).test(value);
}

export async function buildArtifactInventory(
  projectRoot: string,
  providedConfig?: HarnessConfig,
): Promise<ArtifactInventory> {
  const config = providedConfig ?? (await readConfig(projectRoot));
  const specifications: ReadonlyArray<readonly [ProjectArtifactType, string, string]> = [
    ['REQ', config.sources.requirements, 'REQ-'],
    ['ADR', config.sources.adrDirectory, 'ADR-'],
    ['STEP', config.protocol.taskDirectory, 'STEP-'],
    ['OQ', config.sources.openQuestions, 'OQ-'],
    ['PRN', config.sources.principles, 'PRN-'],
  ];

  const artifacts: CanonicalProjectArtifact[] = [];
  const diagnostics: ProjectStateDiagnostic[] = [];
  const seen = new Map<string, string>();

  for (const [type, portableDirectory, prefix] of specifications) {
    const directory = await resolvePortablePathWithinBoundary(projectRoot, portableDirectory, `project-state ${type} directory`);
    for (const filePath of await files(directory, prefix)) {
      try {
        const document = await parseArtifactDocument(filePath);
        const id = document.frontmatter.id;
        if (!expectedId(type, id) || !expectedIdentity(type, filePath, id)) {
          diagnostics.push({
            code: 'INVALID_CANONICAL_ARTIFACT',
            path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
            message: `${type} canonical filename/id mismatch`,
          });
          continue;
        }
        const previous = seen.get(id);
        if (previous) {
          diagnostics.push({
            code: 'INVALID_CANONICAL_ARTIFACT',
            path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
            message: `duplicate canonical id ${id}; first seen at ${previous}`,
          });
          continue;
        }
        const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/');
        seen.set(id, relativePath);
        artifacts.push({
          id,
          type,
          title: titleFromH1(document.h1),
          path: relativePath,
          document,
        });
      } catch (error) {
        diagnostics.push({
          code: 'INVALID_CANONICAL_ARTIFACT',
          path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
          message: (error as Error).message,
        });
      }
    }
  }

  artifacts.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const byId = new Map(artifacts.map((item) => [item.id, item]));
  const byType = {
    REQ: artifacts.filter((item) => item.type === 'REQ'),
    ADR: artifacts.filter((item) => item.type === 'ADR'),
    STEP: artifacts.filter((item) => item.type === 'STEP'),
    OQ: artifacts.filter((item) => item.type === 'OQ'),
    PRN: artifacts.filter((item) => item.type === 'PRN'),
  } satisfies Record<ProjectArtifactType, readonly CanonicalProjectArtifact[]>;

  return { projectRoot, artifacts, byId, byType, diagnostics };
}
