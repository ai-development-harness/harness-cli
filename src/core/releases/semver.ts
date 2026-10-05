const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type SemverTuple = readonly [major: number, minor: number, patch: number];

export function parseSemver(value: string): SemverTuple {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`Unsupported semantic version: ${value}`);

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }

  return 0;
}

export function isSemverInRange(
  version: string,
  minVersion: string,
  maxVersionExclusive: string | null,
): boolean {
  if (compareSemver(version, minVersion) < 0) return false;
  if (maxVersionExclusive !== null && compareSemver(version, maxVersionExclusive) >= 0) return false;
  return true;
}
