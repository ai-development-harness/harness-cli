import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, writeConfig } from '../core/config.js';
import { loadPinnedCore, type CoreHostPortV1 } from '../core/host/index.js';
import { ReleaseStore } from '../core/releases/store.js';
import { buildHarnessRelease } from './builder.js';
import { CURRENT_HARNESS_RELEASE } from './version.js';

const root = await mkdtemp(path.join(tmpdir(), 'harness-release-smoke-'));
try {
  const releaseRoot = path.join(root, 'release');
  await buildHarnessRelease({
    release: CURRENT_HARNESS_RELEASE,
    outputRoot: releaseRoot,
    createdAt: '2026-10-06T00:00:00.000Z',
  });

  const store = new ReleaseStore(path.join(root, 'store'));
  await store.installFromDirectory(releaseRoot);

  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeConfig(projectRoot, {
    ...DEFAULT_CONFIG,
    harness: { release: CURRENT_HARNESS_RELEASE },
  });

  const noop: CoreHostPortV1 = { async call(request) { return request.input ?? null; } };
  const host = await loadPinnedCore({
    projectRoot,
    releaseStore: store,
    ports: { filesystem: noop, git: noop, storage: noop },
  });
  const result = await host.invoke('protocol/validate-command', { command: 'PROJECT STATUS' });
  if (!result.ok || (result.result as { valid?: boolean }).valid !== true) {
    throw new Error(`release-owned Core smoke failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`release-smoke PASS ${CURRENT_HARNESS_RELEASE} ${host.descriptor.releaseDigest}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
