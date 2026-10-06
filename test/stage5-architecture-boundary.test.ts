import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await sourceFiles(target));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push(target);
    }
  }
  return result.sort();
}

describe('Stage 5 architecture boundary', () => {
  it('keeps AI runtime SDK/process ownership out of CLI/Core source', async () => {
    const files = await sourceFiles(path.resolve('src'));
    const forbidden = [
      /RuntimeAdapter/,
      /@anthropic-ai\//,
      /\bclaude\s+auth\b/i,
      /\bclaude\s+code\b/i,
      /\bcodex\s+login\b/i,
      /\bopenai\/codex\b/i,
    ];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const pattern of forbidden) {
        expect(text, `${path.relative(process.cwd(), file)} contains ${pattern}`)
          .not.toMatch(pattern);
      }
    }
  });

  it('keeps Commander registration separate from protocol/execution state-machine modules', async () => {
    const cli = await readFile(path.resolve('src/cli.ts'), 'utf8');

    expect(cli).not.toMatch(/from ['"].*core\/protocol/);
    expect(cli).not.toMatch(/from ['"].*core\/engine/);
    expect(cli).not.toMatch(/from ['"].*core\/execution/);
    expect(cli).not.toContain('PROTOCOL_MODEL');
    expect(cli).not.toContain('validateCommandText');
    expect(cli).not.toContain('parseCanonicalCommand');
    expect(cli).not.toContain('startExecution');
    expect(cli).not.toContain('completeCurrent');
  });
});
