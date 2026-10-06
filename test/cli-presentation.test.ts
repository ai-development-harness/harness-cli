import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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

async function runCli(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxPath, cliPath, ...args],
      { cwd, env, encoding: 'utf8' },
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

async function repositoryFixture(): Promise<{
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-presentation-'));
  roots.push(base);
  const root = path.join(base, 'repo');
  await mkdir(root);
  await execFileAsync('git', ['init'], { cwd: root, encoding: 'utf8' });

  const env = {
    ...process.env,
    HOME: path.join(base, 'home'),
    XDG_DATA_HOME: path.join(base, 'data'),
    LOCALAPPDATA: path.join(base, 'localappdata'),
    APPDATA: path.join(base, 'appdata'),
  };
  await mkdir(env.HOME, { recursive: true });
  return { root, env };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('CLI presentation contract', () => {
  it('keeps stable cross-platform exit-code assignments', () => {
    expect(CLI_EXIT_CODES).toEqual({
      success: 0,
      failure: 1,
      blocked: 2,
      usage: 64,
      input: 65,
      environment: 69,
      internal: 70,
    });
  });

  it('returns a structured environment failure from setup --json', async () => {
    const fixture = await repositoryFixture();
    const result = await runCli(fixture.root, ['setup', '--json'], fixture.env);

    expect(result.code).toBe(CLI_EXIT_CODES.environment);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      status: 'error',
      category: 'environment',
      error: {
        code: 'RELEASE_MISSING',
      },
    });
  });

  it('returns structured doctor diagnostics without human output leakage', async () => {
    const fixture = await repositoryFixture();
    const result = await runCli(fixture.root, ['doctor', '--json'], fixture.env);

    expect(result.code).toBe(CLI_EXIT_CODES.environment);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: 1,
      ok: false,
      status: 'fail',
    });
    expect(output.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'git-repository', status: 'pass' }),
        expect.objectContaining({ id: 'project-config', status: 'fail' }),
      ]),
    );
  });
});
