import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAbsolutePathWithinBoundary,
  resolvePortablePathWithinBoundary,
} from '../src/core/path-boundary.js';

const temporaryRoots: string[] = [];

async function fixture(): Promise<{ base: string; root: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-boundary-'));
  temporaryRoots.push(base);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  return { base, root, outside };
}

async function directoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('filesystem path boundaries', () => {
  it('distinguishes lexical traversal from filesystem escapes', async () => {
    const { root, outside } = await fixture();

    await expect(
      resolvePortablePathWithinBoundary(root, '../outside/file.txt', 'test path'),
    ).rejects.toMatchObject({ code: 'PATH_LEXICAL_ESCAPE' });

    await directoryLink(outside, path.join(root, 'escape'));
    await expect(
      resolvePortablePathWithinBoundary(root, 'escape/file.txt', 'test path'),
    ).rejects.toMatchObject({
      code: 'PATH_FILESYSTEM_ESCAPE',
      details: expect.objectContaining({
        canonicalExistingAncestor: expect.any(String),
      }),
    });
  });

  it('blocks a junction or symlink parent that resolves outside the boundary', async () => {
    const { root, outside } = await fixture();
    await directoryLink(outside, path.join(root, 'linked-parent'));

    await expect(
      resolvePortablePathWithinBoundary(root, 'linked-parent/nested/output.txt', 'mutation target'),
    ).rejects.toMatchObject({ code: 'PATH_FILESYSTEM_ESCAPE' });
  });

  it('allows symlinked directories whose canonical target stays inside the boundary', async () => {
    const { root } = await fixture();
    const realDirectory = path.join(root, 'real');
    await mkdir(realDirectory);
    await directoryLink(realDirectory, path.join(root, 'inside-link'));

    const resolved = await resolvePortablePathWithinBoundary(
      root,
      'inside-link/new-file.txt',
      'internal link target',
    );
    expect(resolved).toBe(path.resolve(root, 'inside-link', 'new-file.txt'));
  });

  it('allows a missing target when its nearest existing ancestor is inside the boundary', async () => {
    const { root } = await fixture();
    const resolved = await resolvePortablePathWithinBoundary(
      root,
      'new/deep/file.txt',
      'new target',
    );
    expect(resolved).toBe(path.resolve(root, 'new', 'deep', 'file.txt'));
  });

  it('validates absolute targets against the same filesystem boundary contract', async () => {
    const { root, outside } = await fixture();

    await expect(
      assertAbsolutePathWithinBoundary(root, path.join(outside, 'file.txt'), 'absolute target'),
    ).rejects.toMatchObject({ code: 'PATH_LEXICAL_ESCAPE' });

    await directoryLink(outside, path.join(root, 'state-link'));
    await expect(
      assertAbsolutePathWithinBoundary(
        root,
        path.join(root, 'state-link', 'checkpoint.json'),
        'absolute state target',
      ),
    ).rejects.toMatchObject({ code: 'PATH_FILESYSTEM_ESCAPE' });
  });
});
