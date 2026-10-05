import envPaths from 'env-paths';

export function globalHarnessPaths() {
  return envPaths('ai-development-harness', { suffix: '' });
}
