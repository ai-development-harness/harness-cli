import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export type PathBoundaryErrorCode =
  | 'PATH_LEXICAL_ESCAPE'
  | 'PATH_FILESYSTEM_ESCAPE'
  | 'PATH_BOUNDARY_UNAVAILABLE';

export class PathBoundaryError extends Error {
  constructor(
    public readonly code: PathBoundaryErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'PathBoundaryError';
  }
}

export function isPathBoundaryError(error: unknown): error is PathBoundaryError {
  return error instanceof PathBoundaryError;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function lexicalPortableSegments(portablePath: string): string[] {
  if (
    !portablePath ||
    portablePath.startsWith('/') ||
    portablePath.includes('\\') ||
    portablePath.includes('\0') ||
    /^[A-Za-z]:/.test(portablePath)
  ) {
    throw new PathBoundaryError(
      'PATH_LEXICAL_ESCAPE',
      `Unsafe portable path: ${portablePath}.`,
      { path: portablePath },
    );
  }

  const segments = portablePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PathBoundaryError(
      'PATH_LEXICAL_ESCAPE',
      `Unsafe portable path segments: ${portablePath}.`,
      { path: portablePath },
    );
  }
  return segments;
}

async function canonicalBoundary(boundaryRoot: string): Promise<{ lexical: string; canonical: string }> {
  const lexical = path.resolve(boundaryRoot);
  try {
    return { lexical, canonical: await realpath(lexical) };
  } catch (error) {
    throw new PathBoundaryError(
      'PATH_BOUNDARY_UNAVAILABLE',
      `Path boundary is missing or cannot be resolved: ${lexical}.`,
      { boundaryRoot: lexical, cause: (error as Error).message },
    );
  }
}

async function nearestExistingAncestor(target: string, stopAt: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PathBoundaryError(
          'PATH_BOUNDARY_UNAVAILABLE',
          `Cannot inspect filesystem path boundary for ${target}.`,
          { target, current, cause: (error as Error).message },
        );
      }
    }

    if (current === stopAt) return stopAt;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export async function assertAbsolutePathWithinBoundary(
  boundaryRoot: string,
  targetPath: string,
  label = 'path',
): Promise<string> {
  const boundary = await canonicalBoundary(boundaryRoot);
  const lexicalTarget = path.resolve(targetPath);

  if (!isWithin(boundary.lexical, lexicalTarget)) {
    throw new PathBoundaryError(
      'PATH_LEXICAL_ESCAPE',
      `${label} escapes its lexical boundary: ${targetPath}.`,
      {
        label,
        boundaryRoot: boundary.lexical,
        target: lexicalTarget,
      },
    );
  }

  const ancestor = await nearestExistingAncestor(lexicalTarget, boundary.lexical);
  let canonicalAncestor: string;
  try {
    canonicalAncestor = await realpath(ancestor);
  } catch (error) {
    throw new PathBoundaryError(
      'PATH_BOUNDARY_UNAVAILABLE',
      `Cannot resolve existing filesystem ancestor for ${label}: ${ancestor}.`,
      {
        label,
        boundaryRoot: boundary.lexical,
        target: lexicalTarget,
        existingAncestor: ancestor,
        cause: (error as Error).message,
      },
    );
  }

  if (!isWithin(boundary.canonical, canonicalAncestor)) {
    throw new PathBoundaryError(
      'PATH_FILESYSTEM_ESCAPE',
      `${label} escapes its filesystem boundary through a symlink, junction, or reparse point: ${targetPath}.`,
      {
        label,
        boundaryRoot: boundary.lexical,
        canonicalBoundaryRoot: boundary.canonical,
        target: lexicalTarget,
        existingAncestor: ancestor,
        canonicalExistingAncestor: canonicalAncestor,
      },
    );
  }

  return lexicalTarget;
}

export async function resolvePortablePathWithinBoundary(
  boundaryRoot: string,
  portablePath: string,
  label = 'path',
): Promise<string> {
  const segments = lexicalPortableSegments(portablePath);
  const target = path.resolve(boundaryRoot, ...segments);
  return assertAbsolutePathWithinBoundary(boundaryRoot, target, label);
}
