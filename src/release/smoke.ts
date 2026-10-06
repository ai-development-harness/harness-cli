import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG, writeConfig } from '../core/config.js';
import { loadPinnedCore, type CoreHostPortV1 } from '../core/host/index.js';
import { ReleaseStore } from '../core/releases/store.js';
import { buildHarnessRelease } from './builder.js';
import { CURRENT_HARNESS_RELEASE } from './version.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'harness-release-smoke-'));

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

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
  await execFileAsync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
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

  const validation = await host.invoke('protocol/validate-command', {
    command: 'PROJECT STATUS',
  });
  if (!validation.ok || (validation.result as { valid?: boolean }).valid !== true) {
    throw new Error(`release-owned Core validation smoke failed: ${JSON.stringify(validation)}`);
  }

  const rootCommand = 'PROJECT QUICK FIX: release smoke';
  const started = await host.invoke('protocol/external-call', {
    schemaVersion: 1,
    operation: 'start',
    command: rootCommand,
  });
  if (!started.ok) {
    throw new Error(`external start failed: ${JSON.stringify(started)}`);
  }
  const handoff = object(started.result);
  if (
    handoff.kind !== 'semantic-handoff' ||
    typeof handoff.executionId !== 'string' ||
    handoff.rootCommand !== rootCommand ||
    handoff.command !== rootCommand
  ) {
    throw new Error(`unexpected semantic handoff: ${JSON.stringify(started)}`);
  }

  const resumed = await host.invoke('protocol/external-call', {
    schemaVersion: 1,
    operation: 'resume',
    rootCommand,
  });
  if (!resumed.ok) {
    throw new Error(`external resume failed: ${JSON.stringify(resumed)}`);
  }
  const resumedHandoff = object(resumed.result);
  if (
    resumedHandoff.kind !== 'semantic-handoff' ||
    resumedHandoff.executionId !== handoff.executionId ||
    resumedHandoff.command !== rootCommand
  ) {
    throw new Error(`unexpected resumed handoff: ${JSON.stringify(resumed)}`);
  }

  const completion = {
    schemaVersion: 1,
    executionId: handoff.executionId,
    rootCommand,
    command: rootCommand,
  };
  const completed = await host.invoke('protocol/external-call', {
    schemaVersion: 1,
    operation: 'semantic-complete',
    completion,
    proposal: {
      schemaVersion: 1,
      result: 'SUCCESS',
      details: { smoke: true },
    },
  });
  if (!completed.ok) {
    throw new Error(`semantic completion failed: ${JSON.stringify(completed)}`);
  }
  const terminal = object(completed.result);
  if (
    terminal.kind !== 'terminal' ||
    terminal.status !== 'DONE' ||
    terminal.executionId !== handoff.executionId
  ) {
    throw new Error(`unexpected terminal result: ${JSON.stringify(completed)}`);
  }

  const stale = await host.invoke('protocol/external-call', {
    schemaVersion: 1,
    operation: 'semantic-complete',
    completion,
    proposal: {
      schemaVersion: 1,
      result: 'SUCCESS',
    },
  });
  if (!stale.ok) {
    throw new Error(`stale completion transport failed: ${JSON.stringify(stale)}`);
  }
  const staleResult = object(stale.result);
  if (
    staleResult.kind !== 'blocked' ||
    staleResult.reasonCode !== 'STALE_SEMANTIC_RESULT'
  ) {
    throw new Error(`stale completion was not rejected: ${JSON.stringify(stale)}`);
  }

  process.stdout.write(
    `release-smoke PASS ${CURRENT_HARNESS_RELEASE} ${host.descriptor.releaseDigest}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
