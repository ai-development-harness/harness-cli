import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPackageVersion } from '../src/core/package.js';

describe('getPackageVersion', () => {
  it('uses package.json as the source of truth', () => {
    const packageJsonUrl = new URL('../package.json', import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version: string };

    expect(getPackageVersion()).toBe(packageJson.version);
  });
});
