import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARNESS_CONFIG,
  parseHarnessConfig,
  serializeHarnessConfig,
} from '../src/core/config.js';

describe('harness.yaml', () => {
  it('round-trips the default config', () => {
    const source = serializeHarnessConfig(DEFAULT_HARNESS_CONFIG);
    expect(parseHarnessConfig(source)).toEqual(DEFAULT_HARNESS_CONFIG);
  });

  it('rejects absolute project paths', () => {
    const source = serializeHarnessConfig({
      ...DEFAULT_HARNESS_CONFIG,
      sources: {
        ...DEFAULT_HARNESS_CONFIG.sources,
        requirements: '/tmp/requirements',
      },
    });

    expect(() => parseHarnessConfig(source)).toThrow(/project-relative path/);
  });

  it('rejects unknown top-level keys', () => {
    const source = `${serializeHarnessConfig(DEFAULT_HARNESS_CONFIG)}unexpected: true\n`;
    expect(() => parseHarnessConfig(source)).toThrow();
  });
});
