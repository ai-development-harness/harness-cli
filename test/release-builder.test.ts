import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHarnessRelease } from '../src/release/builder.js';
import { verifyReleaseTree } from '../src/core/releases/verifier.js';
import { PROTOCOL_MODEL } from '../src/core/protocol/index.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-release-builder-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('real Harness release builder', () => {
  it('builds a verifier-compatible canonical tree with protocol-derived base skills', async () => {
    const root = await tempRoot();
    const core = path.join(root, 'compiled-core');
    await mkdir(core, { recursive: true });
    await writeFile(path.join(core, 'release-entrypoint.js'), 'export const harnessCore = {};\n', 'utf8');
    await writeFile(path.join(core, 'support.js'), 'export const support = true;\n', 'utf8');

    const output = path.join(root, 'release');
    const built = await buildHarnessRelease({
      release: '0.11.0',
      outputRoot: output,
      coreSourceRoot: core,
      createdAt: '2026-10-06T00:00:00.000Z',
    });

    expect(built.manifest.entrypoints.core).toBe('core/release-entrypoint.js');
    expect(built.manifest.files.some((item) => item.path.startsWith('core/node_modules/zod/'))).toBe(true);
    expect(built.manifest.files.some((item) => item.path.startsWith('core/node_modules/yaml/'))).toBe(true);
    expect(built.manifest.files.some((item) => item.path.startsWith('core/node_modules/env-paths/'))).toBe(true);
    expect(built.manifest.components.map((item) => item.id)).toEqual([
      'core', 'protocol', 'schemas', 'skills', 'docs',
    ]);
    expect(await verifyReleaseTree(output, '0.11.0')).toMatchObject({
      digest: built.digest,
      manifest: { release: '0.11.0' },
    });

    const semanticSkills = new Set(
      Object.values(PROTOCOL_MODEL.domains).flatMap((domain) =>
        Object.values(domain.commands).flatMap((command) =>
          command.dispatch.kind === 'semantic' ? [command.dispatch.skill] : [],
        ),
      ),
    );
    for (const skill of semanticSkills) {
      const text = await readFile(path.join(output, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toContain(`name: ${skill}`);
      expect(text).toContain('typed Harness Core semantic handoff');
      expect(text).not.toContain('.harness/tools/');
    }
  });

  it('is byte-deterministic for the same compiled Core and explicit build timestamp', async () => {
    const root = await tempRoot();
    const core = path.join(root, 'compiled-core');
    await mkdir(core, { recursive: true });
    await writeFile(path.join(core, 'release-entrypoint.js'), 'export const harnessCore = {};\n', 'utf8');

    const a = await buildHarnessRelease({
      release: '0.11.0',
      outputRoot: path.join(root, 'a'),
      coreSourceRoot: core,
      createdAt: '2026-10-06T00:00:00.000Z',
    });
    const b = await buildHarnessRelease({
      release: '0.11.0',
      outputRoot: path.join(root, 'b'),
      coreSourceRoot: core,
      createdAt: '2026-10-06T00:00:00.000Z',
    });

    expect(a.digest).toBe(b.digest);
    expect(await readFile(path.join(root, 'a', 'release.json'), 'utf8'))
      .toBe(await readFile(path.join(root, 'b', 'release.json'), 'utf8'));
  });

  it('refuses nondeterministic timestamp generation', async () => {
    const root = await tempRoot();
    const core = path.join(root, 'compiled-core');
    await mkdir(core, { recursive: true });
    await writeFile(path.join(core, 'release-entrypoint.js'), 'export const harnessCore = {};\n', 'utf8');

    const previous = process.env.SOURCE_DATE_EPOCH;
    delete process.env.SOURCE_DATE_EPOCH;
    try {
      await expect(buildHarnessRelease({
        release: '0.11.0',
        outputRoot: path.join(root, 'release'),
        coreSourceRoot: core,
      })).rejects.toThrow('deterministic release build requires createdAt or SOURCE_DATE_EPOCH');
    } finally {
      if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = previous;
    }
  });
});
