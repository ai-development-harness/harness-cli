import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  updateApplyCommand,
  updateCheckCommand,
  type UpdateServiceFactory,
} from '../src/commands/update.js';
import { CLI_EXIT_CODES } from '../src/commands/presentation.js';
import { ReleaseStore } from '../src/core/releases/store.js';
import { UpdateService, type UpdatePlan } from '../src/core/update/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempStoreRoot(): Promise<string> {
  const createdRoot = await mkdtemp(path.join(tmpdir(), 'harness-cli-update-store-'));
  const root = await realpath(createdRoot);
  roots.push(root);
  return root;
}

async function repositoryFixture(): Promise<string> {
  const createdRoot = await mkdtemp(path.join(tmpdir(), 'harness-cli-update-surface-'));
  await execFileAsync('git', ['init'], { cwd: createdRoot, encoding: 'utf8' });
  await writeFile(
    path.join(createdRoot, 'harness.yaml'),
    YAML.stringify({
      schemaVersion: 1,
      harness: { release: '1.0.0' },
      project: { initialized: true, name: 'fixture', initializedAt: '2026-10-06T00:00:00Z' },
    }),
    'utf8',
  );
  const root = await realpath(createdRoot);
  roots.push(root);
  return root;
}

function readyPlan(): UpdatePlan {
  return {
    schemaVersion: 1,
    status: 'ready',
    currentRelease: '1.0.0',
    targetRelease: '1.1.0',
    targetDigest: 'a'.repeat(64),
    projectSchemaVersion: 1,
    targetProjectSchemaVersion: 1,
    migrationRequired: false,
    blockers: [],
    mutationPlan: {
      updateReleasePin: true,
      createEmbeddedTools: false,
      genericThreeWayUpdate: false,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ),
  );
});

describe('harness update CLI', () => {
  it('delegates check target selection to the Core service and returns exact plan facts', async () => {
    const root = await repositoryFixture();
    let receivedRoot = '';
    let receivedTarget: string | undefined;
    const createService: UpdateServiceFactory = (projectRoot) => {
      receivedRoot = projectRoot;
      return {
        async check(target) {
          receivedTarget = target;
          return readyPlan();
        },
        async apply() {
          throw new Error('not used');
        },
      };
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await updateCheckCommand(
      root,
      { json: true, targetRelease: '1.1.0' },
      createService,
    );

    expect(receivedRoot).toBe(root);
    expect(receivedTarget).toBe('1.1.0');
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'ready',
      currentRelease: '1.0.0',
      targetRelease: '1.1.0',
      targetDigest: 'a'.repeat(64),
      migrationRequired: false,
    });
  });

  it('runs check through UpdateService without mutating project configuration', async () => {
    const root = await repositoryFixture();
    const storeRoot = await tempStoreRoot();
    const before = await readFile(path.join(root, 'harness.yaml'), 'utf8');
    const beforeStatus = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await updateCheckCommand(
      root,
      { json: true },
      (projectRoot) =>
        new UpdateService({
          projectRoot,
          releaseStore: new ReleaseStore(storeRoot),
          cliVersion: '0.1.0',
          hostApiVersion: 1,
        }),
    );

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      status: 'noop',
      currentRelease: '1.0.0',
      targetRelease: '1.0.0',
    });
    expect(await readFile(path.join(root, 'harness.yaml'), 'utf8')).toBe(before);
    const afterStatus = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(afterStatus.stdout).toBe(beforeStatus.stdout);
  });

  it('returns a structured blocked plan and exit code 2 from check', async () => {
    const root = await repositoryFixture();
    const plan: UpdatePlan = {
      ...readyPlan(),
      status: 'blocked',
      targetRelease: '9.9.9',
      targetDigest: null,
      targetProjectSchemaVersion: null,
      blockers: [{
        code: 'UPDATE_TARGET_UNAVAILABLE',
        message: 'target is unavailable',
        details: { targetRelease: '9.9.9' },
      }],
      mutationPlan: {
        updateReleasePin: false,
        createEmbeddedTools: false,
        genericThreeWayUpdate: false,
      },
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await updateCheckCommand(
      root,
      { json: true, targetRelease: '9.9.9' },
      () => ({
        async check() {
          return plan;
        },
        async apply() {
          throw new Error('not used');
        },
      }),
    );

    expect(process.exitCode).toBe(CLI_EXIT_CODES.blocked);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: 1,
      ok: false,
      status: 'blocked',
      category: 'blocked',
      currentRelease: '1.0.0',
      targetRelease: '9.9.9',
      error: {
        code: 'UPDATE_BLOCKED',
      },
    });
  });

  it('delegates apply and exposes deterministic Core result facts', async () => {
    const root = await repositoryFixture();
    let receivedTarget: string | undefined;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await updateApplyCommand(
      root,
      { json: true, targetRelease: '1.1.0' },
      () => ({
        async check() {
          throw new Error('not used');
        },
        async apply(target) {
          receivedTarget = target;
          return {
            status: 'SUCCESS',
            currentRelease: '1.0.0',
            targetRelease: '1.1.0',
            targetDigest: 'b'.repeat(64),
            migrated: false,
            recovered: false,
          };
        },
      }),
    );

    expect(receivedTarget).toBe('1.1.0');
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'SUCCESS',
      currentRelease: '1.0.0',
      targetRelease: '1.1.0',
      migrated: false,
      recovered: false,
    });
  });

  it('fails closed through UpdateService when apply target is unavailable', async () => {
    const root = await repositoryFixture();
    const storeRoot = await tempStoreRoot();
    const before = await readFile(path.join(root, 'harness.yaml'), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await updateApplyCommand(
      root,
      { json: true, targetRelease: '9.9.9' },
      (projectRoot) =>
        new UpdateService({
          projectRoot,
          releaseStore: new ReleaseStore(storeRoot),
          cliVersion: '0.1.0',
          hostApiVersion: 1,
        }),
    );

    expect(process.exitCode).toBe(CLI_EXIT_CODES.blocked);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: 1,
      ok: false,
      status: 'blocked',
      category: 'blocked',
      error: {
        code: 'UPDATE_BLOCKED',
      },
    });
    expect(await readFile(path.join(root, 'harness.yaml'), 'utf8')).toBe(before);
  });

  it('rejects an invalid explicit target before invoking Core update semantics', async () => {
    const root = await repositoryFixture();
    let invoked = false;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await updateCheckCommand(
      root,
      { json: true, targetRelease: 'latest' },
      () => {
        invoked = true;
        throw new Error('service must not be created');
      },
    );

    expect(invoked).toBe(false);
    expect(process.exitCode).toBe(CLI_EXIT_CODES.input);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      category: 'input',
      error: {
        code: 'UPDATE_TARGET_INVALID',
        details: { targetRelease: 'latest' },
      },
    });
  });
});
