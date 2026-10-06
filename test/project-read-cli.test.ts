import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../src/core/config.js';
import { CLI_EXIT_CODES } from '../src/commands/presentation.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const cliPath = path.resolve('src/cli.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(cwd: string, args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxPath, cliPath, ...args],
      { cwd, encoding: 'utf8' },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof value.code === 'number' ? value.code : 1,
      stdout: value.stdout ?? '',
      stderr: value.stderr ?? '',
    };
  }
}

function step(id = 'STEP-001'): string {
  return `---
schema: 1
id: ${id}
status: planned
type: implementation
priority: high
phase: foundation
depends_on: []
requirements: []
adrs: []
architecture_refs: []
risk_flags:
  - none
plan:
  status: not_planned
  revision: 0
  context_basis: null
  content_hash: null
  reviewed_report: null
  planned_at: null
---

# ${id} — Read surface fixture

## Goal

fixture

## Context

fixture

## Scope

fixture

## Mutation policy

### Allowed

fixture

### Conditional

fixture

### Forbidden

fixture

## Out of scope

fixture

## Acceptance criteria

fixture

## Verification

fixture

## Deliverables

fixture

## Implementation plan

fixture

## Evidence


## Blocker / Failure reason


`;
}

async function repositoryFixture(): Promise<string> {
  const createdRoot = await mkdtemp(path.join(tmpdir(), 'harness-cli-project-read-'));
  await execFileAsync('git', ['init'], { cwd: createdRoot, encoding: 'utf8' });
  await writeConfig(createdRoot, {
    ...DEFAULT_CONFIG,
    harness: { release: '0.10.4' },
    project: {
      initialized: true,
      name: 'Read fixture',
      initializedAt: '2026-10-06T00:00:00Z',
    },
  });
  await mkdir(path.join(createdRoot, 'planning', 'tasks'), { recursive: true });
  await writeFile(path.join(createdRoot, 'planning', 'tasks', 'STEP-001.md'), step(), 'utf8');
  const root = await realpath(createdRoot);
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ),
  );
});

describe('project and STEP read CLI surfaces', () => {
  it('exposes project status without writing tracked projections or project files', async () => {
    const root = await repositoryFixture();
    const beforeConfig = await readFile(path.join(root, 'harness.yaml'), 'utf8');
    const beforeStep = await readFile(path.join(root, 'planning', 'tasks', 'STEP-001.md'), 'utf8');
    const beforeStatus = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );

    const result = await runCli(root, ['project', 'status', '--json']);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'PASS',
      summary: {
        total: 1,
        byStatus: { planned: 1 },
        stalePlans: 0,
      },
    });
    expect(await readFile(path.join(root, 'harness.yaml'), 'utf8')).toBe(beforeConfig);
    expect(await readFile(path.join(root, 'planning', 'tasks', 'STEP-001.md'), 'utf8')).toBe(beforeStep);
    const afterStatus = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(afterStatus.stdout).toBe(beforeStatus.stdout);
    await expect(readFile(path.join(root, 'planning', 'PLAN.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'planning', 'STATUS.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists canonical STEP facts through the Core read model', async () => {
    const root = await repositoryFixture();
    const result = await runCli(root, ['step', 'list', '--json']);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'PASS',
      steps: [{
        id: 'STEP-001',
        title: 'Read surface fixture',
        status: 'planned',
        priority: 'high',
        planStatus: 'not_planned',
        planFreshness: 'not_ready',
        path: 'planning/tasks/STEP-001.md',
      }],
    });
  });

  it('normalizes numeric STEP targets through canonical Protocol parser rules', async () => {
    const root = await repositoryFixture();
    const result = await runCli(root, ['step', 'show', '001', '--json']);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'PASS',
      step: {
        id: 'STEP-001',
        title: 'Read surface fixture',
        status: 'planned',
        path: 'planning/tasks/STEP-001.md',
      },
    });
  });

  it('returns a typed input error for invalid or missing STEP targets', async () => {
    const root = await repositoryFixture();

    const invalid = await runCli(root, ['step', 'show', '1', '--json']);
    expect(invalid.code).toBe(CLI_EXIT_CODES.input);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      category: 'input',
      error: {
        code: 'STEP_TARGET_INVALID',
        details: {
          rawStepId: '1',
          parserCode: 'MISSING_TARGET',
        },
      },
    });

    const missing = await runCli(root, ['step', 'show', '999', '--json']);
    expect(missing.code).toBe(CLI_EXIT_CODES.input);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      category: 'input',
      reasonCode: 'STEP_NOT_FOUND',
      stepId: 'STEP-999',
      error: {
        code: 'STEP_NOT_FOUND',
        details: { stepId: 'STEP-999' },
      },
    });
  });

  it('recommends next work from the Core STEP NEXT resolver', async () => {
    const root = await repositoryFixture();
    const result = await runCli(root, ['step', 'next', '--json']);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'PASS',
      reasonCode: 'STEP_RECOMMENDATION',
      command: 'STEP PLAN STEP-001',
      selected: {
        stepId: 'STEP-001',
        source: 'fresh',
        status: 'planned',
      },
      eligibleCount: 1,
    });
  });
});
