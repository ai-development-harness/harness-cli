import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, harnessConfigSchema, writeConfig } from '../src/core/config.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('harness config', () => {
  it('accepts the default project contract', () => {
    expect(harnessConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it('supports exclusive config creation without overwriting an existing target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-config-'));
    temporaryRoots.push(root);

    await writeConfig(root, DEFAULT_CONFIG, { exclusive: true });
    expect(await readFile(path.join(root, 'harness.yaml'), 'utf8')).toContain('schemaVersion: 1');

    await expect(
      writeConfig(root, DEFAULT_CONFIG, { exclusive: true }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects out-of-range FIX/REVIEW cycle limits', () => {
    expect(() =>
      harnessConfigSchema.parse({
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          maxFixReviewCycles: 6,
        },
      }),
    ).toThrow();
  });
});
