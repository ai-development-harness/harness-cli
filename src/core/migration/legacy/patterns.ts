export function matchesLegacyPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  return path === pattern;
}

export function matchesAnyLegacyPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesLegacyPattern(path, pattern));
}

export function normalizeGitPath(path: string): string {
  return path.replaceAll('\\', '/');
}
