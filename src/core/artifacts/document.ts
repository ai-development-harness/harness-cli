import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import type { ParsedArtifactDocument } from './types.js';

export class ArtifactDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactDocumentError';
  }
}

function parseFrontmatter(text: string): {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
} {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new ArtifactDocumentError('missing YAML frontmatter');
  }

  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new ArtifactDocumentError('unterminated YAML frontmatter');
  }

  const raw = normalized.slice(4, end);
  let parsed: unknown;
  try {
    const document = YAML.parseDocument(raw, {
      merge: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join('; '));
    }
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new ArtifactDocumentError(`invalid YAML frontmatter: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArtifactDocumentError('frontmatter must be a mapping');
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body: normalized.slice(end + 5),
  };
}

function parseBody(body: string): {
  readonly h1: string | null;
  readonly sections: Readonly<Record<string, string>>;
  readonly duplicateSections: readonly string[];
} {
  const lines = body.split('\n');
  let h1: string | null = null;
  const sections: Record<string, string> = {};
  const duplicateSections: string[] = [];

  let currentSection: string | null = null;
  let buffer: string[] = [];

  const commit = () => {
    if (currentSection === null) return;
    if (Object.prototype.hasOwnProperty.call(sections, currentSection)) {
      if (!duplicateSections.includes(currentSection)) duplicateSections.push(currentSection);
      return;
    }
    sections[currentSection] = buffer.join('\n').trim();
  };

  let fence: string | null = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(\x60{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }

    if (fence === null) {
      if (h1 === null && /^#\s+\S/.test(line) && !/^##/.test(line)) {
        h1 = line.trimEnd();
      }

      const section = /^##\s+(.+?)\s*$/.exec(line);
      if (section) {
        commit();
        currentSection = section[1];
        buffer = [];
        continue;
      }
    }

    if (currentSection !== null) buffer.push(line);
  }
  commit();

  return { h1, sections, duplicateSections };
}

export async function parseArtifactDocument(filePath: string): Promise<ParsedArtifactDocument> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ArtifactDocumentError(`cannot read UTF-8 document: ${(error as Error).message}`);
  }

  const { frontmatter, body } = parseFrontmatter(text);
  const { h1, sections, duplicateSections } = parseBody(body);
  return {
    path: filePath,
    frontmatter,
    h1,
    sections,
    duplicateSections,
    text,
  };
}

export function exactArtifactH1(document: ParsedArtifactDocument, artifactId: string): boolean {
  return (
    document.h1 === `# ${artifactId}` ||
    document.h1?.startsWith(`# ${artifactId} — `) === true
  );
}

export function isNonEmptySection(
  document: ParsedArtifactDocument,
  section: string,
): boolean {
  const value = document.sections[section];
  return typeof value === 'string' && value.trim().length > 0;
}
