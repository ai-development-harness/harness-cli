import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

interface SurfaceCase {
  readonly args: readonly string[];
  readonly structured: 'json-option' | 'machine-json';
}

const STAGE5_SURFACE: readonly SurfaceCase[] = [
  { args: ['setup'], structured: 'json-option' },
  { args: ['doctor'], structured: 'json-option' },
  { args: ['status'], structured: 'json-option' },
  { args: ['config'], structured: 'json-option' },
  { args: ['validate'], structured: 'json-option' },

  { args: ['release', 'install'], structured: 'json-option' },
  { args: ['release', 'list'], structured: 'json-option' },
  { args: ['release', 'verify'], structured: 'json-option' },

  { args: ['migrate', 'inspect'], structured: 'json-option' },
  { args: ['migrate', 'plan'], structured: 'json-option' },
  { args: ['migrate', 'apply'], structured: 'json-option' },
  { args: ['migrate', 'resume'], structured: 'json-option' },
  { args: ['migrate', 'status'], structured: 'json-option' },

  { args: ['update', 'check'], structured: 'json-option' },
  { args: ['update', 'apply'], structured: 'json-option' },

  { args: ['project', 'status'], structured: 'json-option' },
  { args: ['step', 'list'], structured: 'json-option' },
  { args: ['step', 'show'], structured: 'json-option' },
  { args: ['step', 'next'], structured: 'json-option' },
  { args: ['git', 'check'], structured: 'json-option' },

  { args: ['protocol', 'machine'], structured: 'machine-json' },
];

async function help(args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [tsxPath, cliPath, ...args, '--help'],
    { encoding: 'utf8' },
  );
  expect(stderr).toBe('');
  return stdout;
}

describe('Stage 5 public CLI parity matrix', () => {
  it('keeps every Stage 5 command registered and discoverable', async () => {
    for (const item of STAGE5_SURFACE) {
      const output = await help(item.args);
      expect(output, item.args.join(' ')).toContain('Usage: harness');
    }
  });

  it('keeps a structured automation mode for every Stage 5 surface', async () => {
    for (const item of STAGE5_SURFACE) {
      const output = await help(item.args);
      if (item.structured === 'json-option') {
        expect(output, item.args.join(' ')).toContain('--json');
      } else {
        expect(output, item.args.join(' ')).toContain(
          'Read one external-caller JSON request from stdin and write one JSON response',
        );
        expect(output, item.args.join(' ')).not.toContain('--json');
      }
    }
  });
});
