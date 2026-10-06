import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { assertAbsolutePathWithinBoundary } from '../path-boundary.js';
import { UpdateError } from './errors.js';
import type { UpdateProjectState, UpdateProjectStatePort } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRaw(projectRoot: string): Promise<{ target: string; value: Record<string, unknown> }> {
  const target = path.join(projectRoot, 'harness.yaml');
  await assertAbsolutePathWithinBoundary(projectRoot, target, 'harness.yaml');
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(target, 'utf8'));
  } catch (error) {
    throw new UpdateError('UPDATE_PROJECT_CONFIG_INVALID', 'Cannot read harness.yaml for update.', {
      cause: (error as Error).message,
    });
  }
  if (!isRecord(parsed)) {
    throw new UpdateError('UPDATE_PROJECT_CONFIG_INVALID', 'harness.yaml root must be an object.');
  }
  return { target, value: parsed };
}

function stateFromRaw(value: Record<string, unknown>): UpdateProjectState {
  const schemaVersion = value.schemaVersion;
  const harness = value.harness;
  if (
    !Number.isInteger(schemaVersion) ||
    (schemaVersion as number) < 0 ||
    !isRecord(harness) ||
    typeof harness.release !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(harness.release)
  ) {
    throw new UpdateError(
      'UPDATE_PROJECT_CONFIG_INVALID',
      'harness.yaml does not contain a valid schemaVersion and harness.release.',
    );
  }
  return { release: harness.release, schemaVersion: schemaVersion as number };
}

export class FileUpdateProjectState implements UpdateProjectStatePort {
  async read(projectRoot: string): Promise<UpdateProjectState> {
    return stateFromRaw((await readRaw(projectRoot)).value);
  }

  async writeReleasePin(
    projectRoot: string,
    expectedCurrentRelease: string,
    targetRelease: string,
  ): Promise<void> {
    const { target, value } = await readRaw(projectRoot);
    const state = stateFromRaw(value);
    if (state.release !== expectedCurrentRelease) {
      throw new UpdateError(
        'UPDATE_PIN_CHANGED',
        'Harness release pin changed after update planning.',
        { expectedCurrentRelease, actualRelease: state.release, targetRelease },
      );
    }

    const harness = value.harness as Record<string, unknown>;
    const next = {
      ...value,
      harness: {
        ...harness,
        release: targetRelease,
      },
    };
    await assertAbsolutePathWithinBoundary(projectRoot, target, 'harness.yaml');
    await writeFile(target, YAML.stringify(next), 'utf8');
  }
}
