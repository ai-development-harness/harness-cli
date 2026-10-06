import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
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

async function repositoryFixture(config?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-config-surface-'));
  roots.push(root);
  await execFileAsync('git', ['init'], { cwd: root, encoding: 'utf8' });
  if (config !== undefined) {
    await writeFile(path.join(root, 'harness.yaml'), config, 'utf8');
  }
  return root;
}

function minimalConfig(): string {
  return YAML.stringify({
    schemaVersion: 1,
    harness: { release: '0.10.4' },
    project: {},
    execution: {},
    review: {},
    skills: { search: {} },
    language: { default: 'en' },
    sources: {},
    protocol: {},
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('harness config CLI', () => {
  it('returns the effective project contract with deterministic defaults', async () => {
    const root = await repositoryFixture(minimalConfig());
    const result = await runCli(root, ['config', '--json']);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: 1,
      ok: true,
      status: 'resolved',
      projectRoot: root,
      source: {
        kind: 'project-file',
        portablePath: 'harness.yaml',
        path: path.join(root, 'harness.yaml'),
      },
      effective: {
        schemaVersion: 1,
        harness: { release: '0.10.4' },
        execution: {
          maxFixReviewCycles: 3,
          verificationCommandTimeoutSeconds: 300,
        },
        review: { security: 'auto', tests: 'auto' },
        skills: { search: { maxResults: 5 } },
        language: { default: 'en' },
        sources: {
          requirements: 'docs/requirements',
        },
        protocol: {
          taskDirectory: 'planning/tasks',
        },
      },
    });
  });

  it('renders the exact same effective object for human and JSON surfaces', async () => {
    const root = await repositoryFixture(minimalConfig());
    const json = await runCli(root, ['config', '--json']);
    const human = await runCli(root, ['config']);

    expect(json.code).toBe(0);
    expect(human.code).toBe(0);
    const effective = JSON.parse(json.stdout).effective;
    expect(human.stdout).toContain(`Project: ${root}\n`);
    expect(human.stdout).toContain(`Config source: ${path.join(root, 'harness.yaml')}\n`);
    expect(human.stdout).toContain(
      `Effective configuration:\n${YAML.stringify(effective).trimEnd()}\n`,
    );
  });

  it('is read-only even when harness.yaml is untracked', async () => {
    const root = await repositoryFixture(minimalConfig());
    const before = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );

    const result = await runCli(root, ['config', '--json']);
    expect(result.code).toBe(0);

    const after = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(after.stdout).toBe(before.stdout);
    expect(await readFile(path.join(root, 'harness.yaml'), 'utf8')).toBe(minimalConfig());
  });

  it('fails closed with a typed input error for malformed or unsupported config', async () => {
    const root = await repositoryFixture('schemaVersion: 2\nharness:\n  release: latest\n');
    const result = await runCli(root, ['config', '--json']);

    expect(result.code).toBe(CLI_EXIT_CODES.input);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      status: 'error',
      category: 'input',
      error: {
        code: 'CONFIG_INVALID',
      },
    });
  });

  it('reports a missing project config as an environment prerequisite failure', async () => {
    const root = await repositoryFixture();
    const result = await runCli(root, ['config', '--json']);

    expect(result.code).toBe(CLI_EXIT_CODES.environment);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      category: 'environment',
      error: {
        code: 'CONFIG_MISSING',
      },
    });
  });

  it('rejects Windows-style project paths on every host OS', async () => {
    const raw = YAML.parse(minimalConfig()) as Record<string, any>;
    raw.sources.requirements = 'docs\\requirements';
    const root = await repositoryFixture(YAML.stringify(raw));

    const result = await runCli(root, ['config', '--json']);
    expect(result.code).toBe(CLI_EXIT_CODES.input);
    expect(JSON.parse(result.stdout)).toMatchObject({
      category: 'input',
      error: {
        code: 'CONFIG_INVALID',
        details: {
          sourceCode: 'PATH_LEXICAL_ESCAPE',
        },
      },
    });
  });
});
