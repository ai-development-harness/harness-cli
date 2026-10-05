import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertAbsolutePathWithinBoundary } from '../path-boundary.js';

export class DurableArtifactError extends Error {
  constructor(
    public readonly code: 'DURABLE_ARTIFACT_EXISTS' | 'DURABLE_ARTIFACT_INVALID_PATH',
    message: string,
  ) {
    super(message);
    this.name = 'DurableArtifactError';
  }
}

/**
 * Create a durable report exactly once.
 *
 * Existing report paths are immutable: callers must choose a new canonical
 * timestamp rather than overwrite, truncate, rename-in-place or "fix" history.
 */
export async function createDurableArtifact(
  projectRoot: string,
  filePath: string,
  content: string,
): Promise<void> {
  const target = await assertAbsolutePathWithinBoundary(projectRoot, filePath, 'durable artifact');
  await mkdir(path.dirname(target), { recursive: true });

  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DurableArtifactError(
        'DURABLE_ARTIFACT_EXISTS',
        `Durable artifact already exists and cannot be overwritten: ${target}.`,
      );
    }
    throw error;
  }
}
