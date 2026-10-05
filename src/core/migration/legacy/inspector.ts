import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { readConfig } from '../../config.js';
import { harnessStatePath } from '../../git.js';
import type {
  LegacyBaselineResolution,
  LegacyFileOwnership,
  LegacyInspectionDiagnostic,
  LegacyMetadataSummary,
  ProjectInspectionResult,
  ProjectInspectionState,
  ProjectInspectorOptions,
} from '../types.js';
import { getLegacyBaselineDescriptor, type LegacyBaselineDescriptor } from './baselines.js';
import { matchesAnyLegacyPattern, normalizeGitPath } from './patterns.js';

const execFileAsync = promisify(execFile);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface LegacyManifestData {
  harness?: { version?: unknown; release?: unknown };
  sources?: Record<string, unknown>;
  protocol?: Record<string, unknown>;
}

interface LegacyLockData {
  schemaVersion: 1;
  harnessVersion: string;
  release: string;
  source: { repository: string; ref: string; commit?: string };
}

interface GitInventory {
  trackedFiles: string[];
  indexBlobSha1: Map<string, string>;
  dirtyTrackedPaths: string[];
  untrackedPaths: string[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function tryFindGitRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

function resolveGitPath(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

async function gitMetadata(root: string): Promise<{ gitDir: string; commonGitDir: string; headSha: string }> {
  const [gitDir, commonGitDir, headSha] = await Promise.all([
    git(root, ['rev-parse', '--git-dir']),
    git(root, ['rev-parse', '--git-common-dir']),
    git(root, ['rev-parse', 'HEAD']),
  ]);
  return {
    gitDir: resolveGitPath(root, gitDir.trim()),
    commonGitDir: resolveGitPath(root, commonGitDir.trim()),
    headSha: headSha.trim(),
  };
}

function parseIndex(stdout: string): { trackedFiles: string[]; indexBlobSha1: Map<string, string> } {
  const trackedFiles: string[] = [];
  const indexBlobSha1 = new Map<string, string>();

  for (const token of stdout.split('\0')) {
    if (!token) continue;
    const tab = token.indexOf('\t');
    if (tab < 0) continue;
    const metadata = token.slice(0, tab).split(' ');
    const filePath = normalizeGitPath(token.slice(tab + 1));
    const sha = metadata[1] ?? '';
    trackedFiles.push(filePath);
    if (/^[0-9a-f]{40}$/.test(sha)) indexBlobSha1.set(filePath, sha);
  }

  trackedFiles.sort();
  return { trackedFiles, indexBlobSha1 };
}

function parseStatus(stdout: string): { dirtyTrackedPaths: string[]; untrackedPaths: string[] } {
  const tokens = stdout.split('\0');
  const dirty = new Set<string>();
  const untracked = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 3) continue;
    const status = token.slice(0, 2);
    const filePath = normalizeGitPath(token.slice(3));

    if (status === '??') {
      untracked.add(filePath);
      continue;
    }

    if (status === '!!') continue;
    dirty.add(filePath);

    if (/[RC]/.test(status) && tokens[index + 1]) {
      dirty.add(normalizeGitPath(tokens[index + 1]));
      index += 1;
    }
  }

  return {
    dirtyTrackedPaths: [...dirty].sort(),
    untrackedPaths: [...untracked].sort(),
  };
}

async function inspectGitInventory(root: string): Promise<GitInventory> {
  const [indexOutput, statusOutput] = await Promise.all([
    git(root, ['ls-files', '-s', '-z']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  return { ...parseIndex(indexOutput), ...parseStatus(statusOutput) };
}

async function workingTreeBlobSha1(
  root: string,
  filePath: string,
  indexSha: string | undefined,
  dirty: boolean,
): Promise<string | null> {
  if (!dirty && indexSha) return indexSha;

  try {
    const value = (await git(root, ['hash-object', '--no-filters', '--', filePath])).trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readOptionalText(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseLegacyManifest(raw: string): { data: LegacyManifestData; release: string; harnessVersion: string | null } {
  const parsed = YAML.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Legacy manifest must be a mapping.');
  const data = parsed as LegacyManifestData;
  const release = data.harness?.release;
  if (typeof release !== 'string' || !SEMVER.test(release)) {
    throw new Error('Legacy manifest does not contain a valid harness.release.');
  }

  const harnessVersionRaw = data.harness?.version;
  const harnessVersion =
    typeof harnessVersionRaw === 'string' || typeof harnessVersionRaw === 'number'
      ? String(harnessVersionRaw)
      : null;

  return { data, release, harnessVersion };
}

function parseLegacyLock(raw: string): LegacyLockData {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Legacy lock must be an object.');
  const value = parsed as Record<string, unknown>;
  const source = value.source;
  if (
    value.schemaVersion !== 1 ||
    typeof value.harnessVersion !== 'string' ||
    typeof value.release !== 'string' ||
    !SEMVER.test(value.release) ||
    typeof source !== 'object' ||
    source === null
  ) {
    throw new Error('Legacy lock has an unsupported schema.');
  }
  const sourceValue = source as Record<string, unknown>;
  if (typeof sourceValue.repository !== 'string' || typeof sourceValue.ref !== 'string') {
    throw new Error('Legacy lock source is incomplete.');
  }
  if (sourceValue.commit !== undefined && typeof sourceValue.commit !== 'string') {
    throw new Error('Legacy lock source.commit must be a string.');
  }
  return {
    schemaVersion: 1,
    harnessVersion: value.harnessVersion,
    release: value.release,
    source: {
      repository: sourceValue.repository,
      ref: sourceValue.ref,
      ...(sourceValue.commit === undefined ? {} : { commit: sourceValue.commit }),
    },
  };
}

function normalizeExplicitRelease(value: string | undefined): string | null {
  if (value === undefined) return null;
  const release = value.startsWith('v') ? value.slice(1) : value;
  return SEMVER.test(release) ? release : null;
}

function blocker(
  code: LegacyInspectionDiagnostic['code'],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): LegacyInspectionDiagnostic {
  return { code, severity: 'blocker', message, ...(details ? { details } : {}) };
}

function warning(
  code: LegacyInspectionDiagnostic['code'],
  message: string,
  paths?: readonly string[],
): LegacyInspectionDiagnostic {
  return { code, severity: 'warning', message, ...(paths ? { paths } : {}) };
}

function resolveBaseline(
  manifestRelease: string,
  lockRaw: string | null,
  explicitReleaseInput: string | undefined,
  diagnostics: LegacyInspectionDiagnostic[],
): { baseline: LegacyBaselineResolution | null; descriptor: LegacyBaselineDescriptor | null; state: ProjectInspectionState } {
  const explicitRelease = normalizeExplicitRelease(explicitReleaseInput);
  if (explicitReleaseInput !== undefined && explicitRelease === null) {
    diagnostics.push(blocker('BASELINE_MISMATCH', `Invalid explicit legacy baseline: ${explicitReleaseInput}.`));
    return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
  }

  let lock: LegacyLockData | null = null;
  if (lockRaw !== null) {
    try {
      lock = parseLegacyLock(lockRaw);
    } catch (error) {
      diagnostics.push(blocker('INVALID_LEGACY_LOCK', (error as Error).message));
      return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
    }
  }

  if (lock !== null && lock.release !== manifestRelease) {
    diagnostics.push(
      blocker('BASELINE_MISMATCH', 'Legacy manifest and lock point to different Harness releases.', {
        manifestRelease,
        lockRelease: lock.release,
      }),
    );
    return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
  }

  if (explicitRelease !== null && explicitRelease !== manifestRelease) {
    diagnostics.push(
      blocker('BASELINE_MISMATCH', 'Explicit baseline does not match legacy manifest release.', {
        manifestRelease,
        explicitRelease,
      }),
    );
    return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
  }

  if (lock !== null && explicitRelease !== null && explicitRelease !== lock.release) {
    diagnostics.push(blocker('BASELINE_MISMATCH', 'Explicit baseline does not match legacy lock release.'));
    return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
  }

  const release = lock?.release ?? explicitRelease;
  if (release === null || release === undefined) {
    diagnostics.push(blocker('BASELINE_REQUIRED', 'Legacy project has no proven baseline; provide an explicit release.'));
    return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
  }

  const descriptor = getLegacyBaselineDescriptor(release);
  if (descriptor === null) {
    diagnostics.push(
      blocker('UNSUPPORTED_LEGACY_RELEASE', `Legacy Harness release ${release} is not supported by this CLI.`, {
        release,
      }),
    );
    return { baseline: null, descriptor: null, state: 'legacy-harness-unsupported' };
  }

  if (lock !== null) {
    if (lock.source.repository !== descriptor.source.repository || lock.source.ref !== descriptor.source.ref) {
      diagnostics.push(
        blocker('BASELINE_MISMATCH', 'Legacy lock source does not match the immutable compatibility descriptor.', {
          expectedRepository: descriptor.source.repository,
          actualRepository: lock.source.repository,
          expectedRef: descriptor.source.ref,
          actualRef: lock.source.ref,
        }),
      );
      return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
    }
    if (lock.source.commit !== undefined && lock.source.commit !== descriptor.source.commit) {
      diagnostics.push(
        blocker('BASELINE_MISMATCH', 'Legacy lock commit does not match the immutable compatibility descriptor.', {
          expectedCommit: descriptor.source.commit,
          actualCommit: lock.source.commit,
        }),
      );
      return { baseline: null, descriptor: null, state: 'legacy-harness-baseline-required' };
    }
  }

  return {
    baseline: {
      release,
      sourceRepository: descriptor.source.repository,
      sourceRef: descriptor.source.ref,
      sourceCommit: descriptor.source.commit,
      resolvedBy: lock === null ? 'explicit' : 'lock',
    },
    descriptor,
    state: 'legacy-harness-supported',
  };
}

function collectProjectOwnedPrefixes(manifest: LegacyManifestData): string[] {
  const values = new Set<string>([
    'src',
    'test',
    'tests',
    'planning/harness-updates',
  ]);

  for (const value of Object.values(manifest.sources ?? {})) {
    if (typeof value === 'string' && value.length > 0) values.add(normalizeGitPath(value));
  }

  for (const [key, value] of Object.entries(manifest.protocol ?? {})) {
    if (key === 'file') continue;
    if (typeof value === 'string' && value.length > 0) values.add(normalizeGitPath(value));
  }

  return [...values];
}

function matchesPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function isProjectOwnedPath(filePath: string, projectOwnedPrefixes: readonly string[]): boolean {
  if (filePath.startsWith('.agents/skills/')) return true;
  return projectOwnedPrefixes.some((prefix) => matchesPrefix(filePath, prefix));
}

async function classifyOwnership(
  root: string,
  descriptor: LegacyBaselineDescriptor,
  manifest: LegacyManifestData,
  inventory: GitInventory,
  diagnostics: LegacyInspectionDiagnostic[],
): Promise<LegacyFileOwnership[]> {
  const dirty = new Set(inventory.dirtyTrackedPaths);
  const projectOwnedPrefixes = collectProjectOwnedPrefixes(manifest);
  const result: LegacyFileOwnership[] = [];
  const modifiedHarnessPaths: string[] = [];
  const unverifiedHarnessPaths: string[] = [];

  for (const filePath of inventory.trackedFiles) {
    if (matchesAnyLegacyPattern(filePath, descriptor.ownership.markerMerge) || matchesAnyLegacyPattern(filePath, descriptor.ownership.shared)) {
      result.push({
        path: filePath,
        classification: 'shared-customized',
        expectedBlobSha1: null,
        actualBlobSha1: await workingTreeBlobSha1(
          root,
          filePath,
          inventory.indexBlobSha1.get(filePath),
          dirty.has(filePath),
        ),
        dirty: dirty.has(filePath),
      });
      continue;
    }

    if (matchesAnyLegacyPattern(filePath, descriptor.ownership.harnessOwned)) {
      const expectedBlobSha1 = descriptor.baselineBlobSha1[filePath] ?? null;
      const actualBlobSha1 = await workingTreeBlobSha1(
        root,
        filePath,
        inventory.indexBlobSha1.get(filePath),
        dirty.has(filePath),
      );
      const clean = expectedBlobSha1 !== null && actualBlobSha1 === expectedBlobSha1;
      if (!clean) modifiedHarnessPaths.push(filePath);
      if (expectedBlobSha1 === null) unverifiedHarnessPaths.push(filePath);
      result.push({
        path: filePath,
        classification: clean ? 'harness-owned-clean' : 'harness-owned-modified',
        expectedBlobSha1,
        actualBlobSha1,
        dirty: dirty.has(filePath),
      });
      continue;
    }

    if (isProjectOwnedPath(filePath, projectOwnedPrefixes)) {
      result.push({
        path: filePath,
        classification: 'project-owned',
        expectedBlobSha1: null,
        actualBlobSha1: await workingTreeBlobSha1(
          root,
          filePath,
          inventory.indexBlobSha1.get(filePath),
          dirty.has(filePath),
        ),
        dirty: dirty.has(filePath),
      });
      continue;
    }

    result.push({
      path: filePath,
      classification: 'unknown',
      expectedBlobSha1: null,
      actualBlobSha1: await workingTreeBlobSha1(
        root,
        filePath,
        inventory.indexBlobSha1.get(filePath),
        dirty.has(filePath),
      ),
      dirty: dirty.has(filePath),
    });
  }

  if (unverifiedHarnessPaths.length > 0) {
    diagnostics.push(
      blocker(
        'BASELINE_FILE_UNVERIFIED',
        'Some Harness-owned paths are not present in the immutable compatibility descriptor.',
        { paths: unverifiedHarnessPaths },
      ),
    );
  }

  if (modifiedHarnessPaths.length > 0) {
    diagnostics.push({
      code: 'HARNESS_OWNED_MODIFIED',
      severity: 'blocker',
      message: 'Harness-owned files diverge from the proven legacy baseline.',
      paths: modifiedHarnessPaths,
    });
  }

  const dirtyManaged = result
    .filter((entry) => entry.dirty && entry.classification !== 'project-owned' && entry.classification !== 'unknown')
    .map((entry) => entry.path);
  if (dirtyManaged.length > 0) {
    diagnostics.push(warning('DIRTY_MANAGED_PATH', 'Managed legacy paths have uncommitted changes.', dirtyManaged));
  }

  return result;
}

function relevantUntrackedPaths(
  untrackedPaths: readonly string[],
  descriptor: LegacyBaselineDescriptor | null,
): string[] {
  return untrackedPaths.filter((filePath) => {
    if (filePath === 'harness.yaml' || filePath === '.harness/manifest.yaml') return true;
    if (filePath.startsWith('.agents/skills/')) return true;
    if (descriptor === null) {
      return (
        filePath.startsWith('.harness/') ||
        filePath.startsWith('.codex/') ||
        filePath.startsWith('.claude/') ||
        filePath === 'AGENTS.md' ||
        filePath === 'CLAUDE.md' ||
        filePath === 'README.md'
      );
    }
    return (
      matchesAnyLegacyPattern(filePath, descriptor.ownership.harnessOwned) ||
      matchesAnyLegacyPattern(filePath, descriptor.ownership.shared) ||
      matchesAnyLegacyPattern(filePath, descriptor.ownership.markerMerge)
    );
  });
}

async function hasMigrationCheckpoint(cloneLocalHarnessPath: string): Promise<boolean> {
  const migrationsPath = path.join(cloneLocalHarnessPath, 'migrations');
  try {
    const entries = await readdir(migrationsPath, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function inspectProject(
  cwd: string,
  options: ProjectInspectorOptions = {},
): Promise<ProjectInspectionResult> {
  const root = await tryFindGitRoot(cwd);
  if (root === null) {
    return {
      state: 'not-git',
      projectRoot: null,
      headSha: null,
      gitDir: null,
      commonGitDir: null,
      cloneLocalHarnessPath: null,
      trackedFiles: [],
      dirtyTrackedPaths: [],
      untrackedPaths: [],
      relevantUntrackedCollisions: [],
      legacy: null,
      baseline: null,
      ownership: [],
      diagnostics: [],
    };
  }

  const [{ gitDir, commonGitDir, headSha }, inventory, cloneLocalHarnessPath] = await Promise.all([
    gitMetadata(root),
    inspectGitInventory(root),
    harnessStatePath(root),
  ]);
  const migrationInProgress = await hasMigrationCheckpoint(cloneLocalHarnessPath);
  const legacyManifestPath = path.join(root, '.harness', 'manifest.yaml');
  const legacyLockPath = path.join(root, '.harness', 'harness.lock.json');
  const legacyUpdatePolicyPath = path.join(root, '.harness', 'harness-update.toml');
  const thinConfigPath = path.join(root, 'harness.yaml');
  const [manifestRaw, lockRaw, updatePolicyRaw, thinConfigPresent] = await Promise.all([
    readOptionalText(legacyManifestPath),
    readOptionalText(legacyLockPath),
    readOptionalText(legacyUpdatePolicyPath),
    exists(thinConfigPath),
  ]);
  const diagnostics: LegacyInspectionDiagnostic[] = [];

  if (manifestRaw === null) {
    if (migrationInProgress) {
      return {
        state: 'migration-in-progress',
        projectRoot: root,
        headSha,
        gitDir,
        commonGitDir,
        cloneLocalHarnessPath,
        trackedFiles: inventory.trackedFiles,
        dirtyTrackedPaths: inventory.dirtyTrackedPaths,
        untrackedPaths: inventory.untrackedPaths,
        relevantUntrackedCollisions: relevantUntrackedPaths(inventory.untrackedPaths, null),
        legacy: null,
        baseline: null,
        ownership: [],
        diagnostics,
      };
    }

    if (!thinConfigPresent) {
      return {
        state: 'git-non-harness',
        projectRoot: root,
        headSha,
        gitDir,
        commonGitDir,
        cloneLocalHarnessPath,
        trackedFiles: inventory.trackedFiles,
        dirtyTrackedPaths: inventory.dirtyTrackedPaths,
        untrackedPaths: inventory.untrackedPaths,
        relevantUntrackedCollisions: relevantUntrackedPaths(inventory.untrackedPaths, null),
        legacy: null,
        baseline: null,
        ownership: [],
        diagnostics,
      };
    }

    try {
      await readConfig(root);
      return {
        state: 'thin-harness-current',
        projectRoot: root,
        headSha,
        gitDir,
        commonGitDir,
        cloneLocalHarnessPath,
        trackedFiles: inventory.trackedFiles,
        dirtyTrackedPaths: inventory.dirtyTrackedPaths,
        untrackedPaths: inventory.untrackedPaths,
        relevantUntrackedCollisions: relevantUntrackedPaths(inventory.untrackedPaths, null),
        legacy: null,
        baseline: null,
        ownership: [],
        diagnostics,
      };
    } catch (error) {
      diagnostics.push(blocker('INVALID_THIN_CONFIG', (error as Error).message));
      return {
        state: 'thin-harness-invalid',
        projectRoot: root,
        headSha,
        gitDir,
        commonGitDir,
        cloneLocalHarnessPath,
        trackedFiles: inventory.trackedFiles,
        dirtyTrackedPaths: inventory.dirtyTrackedPaths,
        untrackedPaths: inventory.untrackedPaths,
        relevantUntrackedCollisions: relevantUntrackedPaths(inventory.untrackedPaths, null),
        legacy: null,
        baseline: null,
        ownership: [],
        diagnostics,
      };
    }
  }

  let parsedManifest: ReturnType<typeof parseLegacyManifest>;
  try {
    parsedManifest = parseLegacyManifest(manifestRaw);
  } catch (error) {
    diagnostics.push(blocker('INVALID_LEGACY_MANIFEST', (error as Error).message));
    return {
      state: migrationInProgress ? 'migration-in-progress' : 'legacy-harness-unsupported',
      projectRoot: root,
      headSha,
      gitDir,
      commonGitDir,
      cloneLocalHarnessPath,
      trackedFiles: inventory.trackedFiles,
      dirtyTrackedPaths: inventory.dirtyTrackedPaths,
      untrackedPaths: inventory.untrackedPaths,
      relevantUntrackedCollisions: relevantUntrackedPaths(inventory.untrackedPaths, null),
      legacy: {
        manifestPath: '.harness/manifest.yaml',
        release: null,
        harnessVersion: null,
        lockPath: '.harness/harness.lock.json',
        lockPresent: lockRaw !== null,
        updatePolicyPath: '.harness/harness-update.toml',
        updatePolicyPresent: updatePolicyRaw !== null,
      },
      baseline: null,
      ownership: [],
      diagnostics,
    };
  }

  const legacy: LegacyMetadataSummary = {
    manifestPath: '.harness/manifest.yaml',
    release: parsedManifest.release,
    harnessVersion: parsedManifest.harnessVersion,
    lockPath: '.harness/harness.lock.json',
    lockPresent: lockRaw !== null,
    updatePolicyPath: '.harness/harness-update.toml',
    updatePolicyPresent: updatePolicyRaw !== null,
  };

  if (thinConfigPresent) {
    diagnostics.push(
      blocker('LEGACY_AND_THIN_STATE', 'Both legacy .harness/manifest.yaml and thin harness.yaml are present.'),
    );
  }

  const resolution = resolveBaseline(parsedManifest.release, lockRaw, options.fromRelease, diagnostics);
  const ownership =
    resolution.descriptor === null
      ? []
      : await classifyOwnership(root, resolution.descriptor, parsedManifest.data, inventory, diagnostics);
  const relevantUntrackedCollisions = relevantUntrackedPaths(inventory.untrackedPaths, resolution.descriptor);
  if (relevantUntrackedCollisions.length > 0) {
    diagnostics.push(
      warning(
        'UNTRACKED_MANAGED_PATH',
        'Untracked files intersect the legacy/target migration surface.',
        relevantUntrackedCollisions,
      ),
    );
  }

  let state = resolution.state;
  if (thinConfigPresent) state = 'thin-harness-invalid';
  if (migrationInProgress) state = 'migration-in-progress';

  return {
    state,
    projectRoot: root,
    headSha,
    gitDir,
    commonGitDir,
    cloneLocalHarnessPath,
    trackedFiles: inventory.trackedFiles,
    dirtyTrackedPaths: inventory.dirtyTrackedPaths,
    untrackedPaths: inventory.untrackedPaths,
    relevantUntrackedCollisions,
    legacy,
    baseline: resolution.baseline,
    ownership,
    diagnostics,
  };
}
