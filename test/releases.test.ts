import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePinnedRelease } from '../src/core/releases/resolver.js';
import { ReleaseStore } from '../src/core/releases/store.js';

const temporaryRoots: string[] = [];

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

interface ReleaseFixtureOptions {
  release?: string;
  cliMinVersion?: string;
  cliMaxVersionExclusive?: string | null;
  supportedSchemas?: number[];
  migrateFrom?: number[];
  contentSuffix?: string;
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-release-'));
  temporaryRoots.push(root);
  return root;
}

async function createReleaseFixture(root: string, options: ReleaseFixtureOptions = {}): Promise<string> {
  const release = options.release ?? '1.2.3';
  const sourceRoot = path.join(root, `source-${release}-${options.contentSuffix ?? 'default'}`);
  const suffix = options.contentSuffix ?? '';

  const payload: Record<string, string> = {
    'core/index.mjs': `export const release = '${release}${suffix}';\n`,
    'protocol/commands.json': `{"release":"${release}","suffix":"${suffix}"}\n`,
    'schemas/project.schema.json': '{"type":"object"}\n',
    'skills/run-step/SKILL.md': `# Run STEP ${suffix}\n`,
    'docs/PROTOCOL.md': `# Protocol ${release} ${suffix}\n`,
  };

  for (const [relativePath, data] of Object.entries(payload)) {
    const target = path.join(sourceRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, 'utf8');
  }

  const files = Object.entries(payload)
    .map(([relativePath, data]) => ({
      path: relativePath,
      size: Buffer.byteLength(data),
      sha256: hash(data),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    formatVersion: 1,
    release,
    createdAt: '2026-10-05T10:00:00Z',
    compatibility: {
      cli: {
        minVersion: options.cliMinVersion ?? '0.1.0',
        maxVersionExclusive: options.cliMaxVersionExclusive ?? null,
      },
      hostApi: {
        minVersion: 1,
        maxVersion: 1,
      },
      projectSchema: {
        supported: options.supportedSchemas ?? [1],
        target: 1,
        migrateFrom: options.migrateFrom ?? [],
      },
    },
    entrypoints: {
      core: 'core/index.mjs',
    },
    components: [
      { id: 'core', path: 'core', required: true },
      { id: 'protocol', path: 'protocol', required: true },
      { id: 'schemas', path: 'schemas', required: true },
      { id: 'skills', path: 'skills', required: true },
      { id: 'docs', path: 'docs', required: true },
    ],
    files,
  };

  await writeFile(path.join(sourceRoot, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return sourceRoot;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ReleaseStore', () => {
  it('installs, verifies and resolves a pinned release', async () => {
    const root = await makeTempRoot();
    const source = await createReleaseFixture(root);
    const store = new ReleaseStore(path.join(root, 'data'));

    const installed = await store.installFromDirectory(source);
    expect(installed.release).toBe('1.2.3');
    expect(installed.reused).toBe(false);

    const resolved = await resolvePinnedRelease(store, '1.2.3', 1, {
      cliVersion: '0.1.0',
      hostApiVersion: 1,
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.digest).toBe(installed.digest);
    expect(resolved.root).toBe(store.releaseRoot('1.2.3'));
  });

  it('reuses an identical immutable release safely', async () => {
    const root = await makeTempRoot();
    const source = await createReleaseFixture(root);
    const store = new ReleaseStore(path.join(root, 'data'));

    const first = await store.installFromDirectory(source);
    const second = await store.installFromDirectory(source);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.digest).toBe(first.digest);
    expect(second.installedAt).toBe(first.installedAt);
  });

  it('lists multiple installed releases in semantic version order', async () => {
    const root = await makeTempRoot();
    const sourceA = await createReleaseFixture(root, { release: '1.10.0' });
    const sourceB = await createReleaseFixture(root, { release: '1.2.3' });
    const store = new ReleaseStore(path.join(root, 'data'));

    await store.installFromDirectory(sourceA);
    await store.installFromDirectory(sourceB);

    expect(await store.list()).toMatchObject([
      { release: '1.2.3', status: 'valid', errorCode: null },
      { release: '1.10.0', status: 'valid', errorCode: null },
    ]);
  });

  it('distinguishes a missing release', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'data'));

    await expect(store.verify('1.2.3')).rejects.toMatchObject({ code: 'RELEASE_MISSING' });
  });

  it('detects payload corruption after installation', async () => {
    const root = await makeTempRoot();
    const source = await createReleaseFixture(root);
    const store = new ReleaseStore(path.join(root, 'data'));
    await store.installFromDirectory(source);

    await writeFile(path.join(store.releaseRoot('1.2.3'), 'core', 'index.mjs'), 'mutated\n', 'utf8');

    await expect(store.verify('1.2.3')).rejects.toMatchObject({ code: 'RELEASE_CORRUPT' });
  });

  it('rejects different content for an already installed release version', async () => {
    const root = await makeTempRoot();
    const sourceA = await createReleaseFixture(root, { contentSuffix: 'a' });
    const sourceB = await createReleaseFixture(root, { contentSuffix: 'b' });
    const store = new ReleaseStore(path.join(root, 'data'));

    await store.installFromDirectory(sourceA);

    await expect(store.installFromDirectory(sourceB)).rejects.toMatchObject({
      code: 'RELEASE_IDENTITY_CONFLICT',
    });
  });

  it('rejects undeclared payload files before installation', async () => {
    const root = await makeTempRoot();
    const source = await createReleaseFixture(root);
    const store = new ReleaseStore(path.join(root, 'data'));
    await writeFile(path.join(source, 'extra.txt'), 'not declared\n', 'utf8');

    await expect(store.installFromDirectory(source)).rejects.toMatchObject({ code: 'RELEASE_CORRUPT' });
  });
});

describe('resolvePinnedRelease', () => {
  it('reports CLI incompatibility separately', async () => {
    const root = await makeTempRoot();
    const source = await createReleaseFixture(root, { cliMinVersion: '9.0.0' });
    const store = new ReleaseStore(path.join(root, 'data'));
    await store.installFromDirectory(source);

    await expect(
      resolvePinnedRelease(store, '1.2.3', 1, { cliVersion: '0.1.0', hostApiVersion: 1 }),
    ).rejects.toMatchObject({ code: 'RELEASE_INCOMPATIBLE_CLI' });
  });

  it('reports required project schema migration separately', async () => {
    const root = await makeTempRoot();
    const source = await createReleaseFixture(root, { supportedSchemas: [2], migrateFrom: [1] });
    const store = new ReleaseStore(path.join(root, 'data'));
    await store.installFromDirectory(source);

    await expect(
      resolvePinnedRelease(store, '1.2.3', 1, { cliVersion: '0.1.0', hostApiVersion: 1 }),
    ).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_MIGRATION_REQUIRED' });
  });
});
