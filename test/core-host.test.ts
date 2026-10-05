import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import {
  HOST_API_VERSION,
  loadPinnedCore,
  type CoreHostPortV1,
  type CoreHostPortsV1,
} from '../src/core/host/index.js';
import { ReleaseStore } from '../src/core/releases/store.js';

const temporaryRoots: string[] = [];

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-core-host-'));
  temporaryRoots.push(root);
  return root;
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

interface ReleaseFixtureOptions {
  release: string;
  coreSource: string;
  hostApiMin?: number;
  hostApiMax?: number;
}

async function createReleaseFixture(root: string, options: ReleaseFixtureOptions): Promise<string> {
  const sourceRoot = path.join(root, `release-${options.release}`);
  const payload: Record<string, string> = {
    'core/index.mjs': options.coreSource,
    'protocol/commands.json': `{"release":"${options.release}"}\n`,
    'schemas/project.schema.json': '{"type":"object"}\n',
    'skills/run-step/SKILL.md': '# Run STEP\n',
    'docs/PROTOCOL.md': `# Protocol ${options.release}\n`,
  };

  for (const [relativePath, data] of Object.entries(payload)) {
    await writeText(sourceRoot, relativePath, data);
  }

  const files = Object.entries(payload)
    .map(([relativePath, data]) => ({
      path: relativePath,
      size: Buffer.byteLength(data),
      sha256: sha256(data),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    formatVersion: 1,
    release: options.release,
    createdAt: '2026-10-06T00:00:00Z',
    compatibility: {
      cli: { minVersion: '0.1.0', maxVersionExclusive: null },
      hostApi: {
        minVersion: options.hostApiMin ?? HOST_API_VERSION,
        maxVersion: options.hostApiMax ?? HOST_API_VERSION,
      },
      projectSchema: {
        supported: [1],
        target: 1,
        migrateFrom: [],
      },
    },
    entrypoints: { core: 'core/index.mjs' },
    components: [
      { id: 'core', path: 'core', required: true },
      { id: 'protocol', path: 'protocol', required: true },
      { id: 'schemas', path: 'schemas', required: true },
      { id: 'skills', path: 'skills', required: true },
      { id: 'docs', path: 'docs', required: true },
    ],
    files,
  };

  await writeText(sourceRoot, 'release.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return sourceRoot;
}

async function createProject(root: string, name: string, release: string): Promise<string> {
  const projectRoot = path.join(root, name);
  await mkdir(projectRoot, { recursive: true });
  await writeConfig(projectRoot, {
    ...DEFAULT_CONFIG,
    harness: { release },
    project: {
      ...DEFAULT_CONFIG.project,
      initialized: true,
      name,
      initializedAt: '2026-10-06T00:00:00Z',
    },
  });
  return projectRoot;
}

function coreSource(semantic: string): string {
  return `export const harnessCore = {
  hostApiVersion: 1,
  async execute(request, ports) {
    const marker = await ports.storage.call({
      operation: 'marker',
      input: { semantic: '${semantic}' }
    });
    return {
      schemaVersion: 1,
      hostApiVersion: 1,
      requestId: request.requestId,
      ok: true,
      versions: request.versions,
      result: {
        semantic: '${semantic}',
        operation: request.operation,
        projectRoot: request.projectRoot,
        marker
      }
    };
  }
};
`;
}

function createPorts(): CoreHostPortsV1 {
  const noop: CoreHostPortV1 = {
    async call(request) {
      return request.input ?? null;
    },
  };
  return {
    filesystem: noop,
    git: noop,
    storage: {
      async call(request) {
        return { operation: request.operation, input: request.input ?? null };
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release-owned Core Host API v1', () => {
  it('executes the semantics of each project-pinned release with the same CLI host', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));

    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '1.0.0',
        coreSource: coreSource('alpha'),
      }),
    );
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '2.0.0',
        coreSource: coreSource('beta'),
      }),
    );

    const projectA = await createProject(root, 'project-a', '1.0.0');
    const projectB = await createProject(root, 'project-b', '2.0.0');
    const ports = createPorts();

    const hostA = await loadPinnedCore({
      projectRoot: projectA,
      releaseStore: store,
      ports,
      cliVersion: '0.1.0',
    });
    const hostB = await loadPinnedCore({
      projectRoot: projectB,
      releaseStore: store,
      ports,
      cliVersion: '0.1.0',
    });

    const resultA = await hostA.invoke('example/run', { value: 1 });
    const resultB = await hostB.invoke('example/run', { value: 1 });

    expect(hostA.descriptor).toMatchObject({
      hostApiVersion: 1,
      release: '1.0.0',
      projectSchemaVersion: 1,
      cliVersion: '0.1.0',
    });
    expect(hostB.descriptor).toMatchObject({
      hostApiVersion: 1,
      release: '2.0.0',
      projectSchemaVersion: 1,
      cliVersion: '0.1.0',
    });

    expect(resultA).toMatchObject({
      ok: true,
      versions: {
        cli: '0.1.0',
        harnessRelease: '1.0.0',
        projectSchema: 1,
      },
      result: {
        semantic: 'alpha',
        operation: 'example/run',
        marker: {
          operation: 'marker',
          input: { semantic: 'alpha' },
        },
      },
    });
    expect(resultB).toMatchObject({
      ok: true,
      versions: {
        cli: '0.1.0',
        harnessRelease: '2.0.0',
        projectSchema: 1,
      },
      result: {
        semantic: 'beta',
        operation: 'example/run',
        marker: {
          operation: 'marker',
          input: { semantic: 'beta' },
        },
      },
    });

    expect(resultA.versions.releaseDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(resultB.versions.releaseDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(resultA.versions.releaseDigest).not.toBe(resultB.versions.releaseDigest);
  });

  it('never falls back to another installed release when the exact project pin is missing', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '2.0.0',
        coreSource: coreSource('installed'),
      }),
    );
    const project = await createProject(root, 'project', '9.9.9');

    await expect(
      loadPinnedCore({
        projectRoot: project,
        releaseStore: store,
        ports: createPorts(),
        cliVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_MISSING' });
  });

  it('checks Host API compatibility before importing an incompatible Core entrypoint', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '3.0.0',
        hostApiMin: 2,
        hostApiMax: 2,
        coreSource: "throw new Error('INCOMPATIBLE_CORE_WAS_IMPORTED');\n",
      }),
    );
    const project = await createProject(root, 'project', '3.0.0');

    await expect(
      loadPinnedCore({
        projectRoot: project,
        releaseStore: store,
        ports: createPorts(),
        cliVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_INCOMPATIBLE_HOST_API' });
  });

  it('re-verifies release integrity before Core loading', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '4.0.0',
        coreSource: coreSource('trusted-before-mutation'),
      }),
    );
    const project = await createProject(root, 'project', '4.0.0');

    await writeFile(
      path.join(store.releaseRoot('4.0.0'), 'core', 'index.mjs'),
      coreSource('mutated'),
      'utf8',
    );

    await expect(
      loadPinnedCore({
        projectRoot: project,
        releaseStore: store,
        ports: createPorts(),
        cliVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_CORRUPT' });
  });

  it('rejects a Core module whose runtime Host API declaration disagrees with the verified manifest', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    const mismatched = `export const harnessCore = {
  hostApiVersion: 2,
  async execute() { throw new Error('must not execute'); }
};
`;
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '5.0.0',
        coreSource: mismatched,
      }),
    );
    const project = await createProject(root, 'project', '5.0.0');

    await expect(
      loadPinnedCore({
        projectRoot: project,
        releaseStore: store,
        ports: createPorts(),
        cliVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ code: 'CORE_HOST_API_MISMATCH' });
  });

  it('converts thrown Core execution failures into a typed error envelope', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    const throwingCore = `export const harnessCore = {
  hostApiVersion: 1,
  async execute() { throw new Error('fixture failure'); }
};
`;
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '6.0.0',
        coreSource: throwingCore,
      }),
    );
    const project = await createProject(root, 'project', '6.0.0');
    const host = await loadPinnedCore({
      projectRoot: project,
      releaseStore: store,
      ports: createPorts(),
      cliVersion: '0.1.0',
    });

    await expect(host.invoke('example/fail')).resolves.toMatchObject({
      ok: false,
      versions: {
        cli: '0.1.0',
        harnessRelease: '6.0.0',
        projectSchema: 1,
      },
      error: {
        code: 'CORE_EXECUTION_FAILED',
        message: 'Harness Core execution failed.',
      },
    });
  });

  it('rejects malformed Core responses instead of trusting release code blindly', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    const malformedCore = `export const harnessCore = {
  hostApiVersion: 1,
  async execute(request) {
    return {
      schemaVersion: 1,
      hostApiVersion: 1,
      requestId: request.requestId + '-wrong',
      ok: true,
      versions: request.versions,
      result: {}
    };
  }
};
`;
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '7.0.0',
        coreSource: malformedCore,
      }),
    );
    const project = await createProject(root, 'project', '7.0.0');
    const host = await loadPinnedCore({
      projectRoot: project,
      releaseStore: store,
      ports: createPorts(),
      cliVersion: '0.1.0',
    });

    await expect(host.invoke('example/malformed')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CORE_INVALID_RESPONSE' },
    });
  });

  it('validates required runtime-neutral ports before importing Core', async () => {
    const root = await makeTempRoot();
    const store = new ReleaseStore(path.join(root, 'store'));
    await store.installFromDirectory(
      await createReleaseFixture(root, {
        release: '8.0.0',
        coreSource: coreSource('ports'),
      }),
    );
    const project = await createProject(root, 'project', '8.0.0');

    await expect(
      loadPinnedCore({
        projectRoot: project,
        releaseStore: store,
        ports: {
          filesystem: { call: async () => null },
          git: { call: async () => null },
          storage: {} as CoreHostPortV1,
        },
        cliVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ code: 'CORE_PORTS_INVALID' });
  });
});
