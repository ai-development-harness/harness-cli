import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, harnessConfigSchema } from '../src/core/config.js';

describe('harness config', () => {
  it('accepts the default project contract', () => {
    expect(harnessConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it('rejects out-of-range FIX/REVIEW cycle limits', () => {
    expect(() =>
      harnessConfigSchema.parse({
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          maxFixReviewCycles: 6,
        },
      }),
    ).toThrow();
  });
});
