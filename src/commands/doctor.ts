import { access } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../core/config.js';
import { findGitRoot, harnessStatePath } from '../core/git.js';
import { resolvePortablePathWithinBoundary } from '../core/path-boundary.js';
import { globalHarnessPaths } from '../core/paths.js';
import { isReleaseError } from '../core/releases/errors.js';
import { resolvePinnedRelease } from '../core/releases/resolver.js';
import { ReleaseStore } from '../core/releases/store.js';
import { setCliExitCode, structuredError, writeJson } from './presentation.js';

export interface DoctorCommandOptions {
  readonly json?: boolean;
}

interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'fail';
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function pass(
  checks: DoctorCheck[],
  id: string,
  label: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  checks.push({ id, label, status: 'pass', ...(details ? { details } : {}) });
}

function fail(checks: DoctorCheck[], id: string, label: string, error: unknown): void {
  const structured = structuredError(error, 'DOCTOR_CHECK_FAILED');
  checks.push({
    id,
    label,
    status: 'fail',
    message: structured.message,
    details: {
      code: structured.code,
      ...structured.details,
    },
  });
}

export async function doctorCommand(
  cwd: string,
  options: DoctorCommandOptions = {},
): Promise<void> {
  const checks: DoctorCheck[] = [];
  let root: string | null = null;

  try {
    root = await findGitRoot(cwd);
    pass(checks, 'git-repository', `Git repository: ${root}`, { root });
  } catch (error) {
    fail(checks, 'git-repository', 'Git repository', error);
  }

  let config: Awaited<ReturnType<typeof readConfig>> | null = null;
  if (root) {
    try {
      config = await readConfig(root);
      pass(checks, 'project-config', `harness.yaml: schema ${config.schemaVersion}`, {
        schemaVersion: config.schemaVersion,
        release: config.harness.release,
      });
      pass(checks, 'release-pin', `Harness release pin: ${config.harness.release}`);
    } catch (error) {
      fail(checks, 'project-config', 'harness.yaml', error);
    }
  }

  if (root && config) {
    const requiredDirectories = [
      config.sources.requirements,
      config.sources.adrDirectory,
      config.sources.principles,
      config.sources.openQuestions,
      config.protocol.taskDirectory,
      config.protocol.reviewDirectory,
      config.protocol.planningReviewDirectory,
      config.protocol.initReviewDirectory,
      config.protocol.auditDirectory,
      config.protocol.releaseDirectory,
      config.protocol.skillSearchDirectory,
      path.posix.dirname(config.protocol.skillRegistry),
    ];

    for (const relativePath of requiredDirectories) {
      try {
        const target = await resolvePortablePathWithinBoundary(root, relativePath, 'configured project path');
        await access(target);
        pass(checks, `project-path:${relativePath}`, relativePath, { target });
      } catch (error) {
        fail(checks, `project-path:${relativePath}`, relativePath, error);
      }
    }

    try {
      const statePath = await harnessStatePath(root);
      pass(checks, 'local-state', `Clone-local state: ${statePath}`, { path: statePath });
    } catch (error) {
      fail(checks, 'local-state', 'Clone-local state', error);
    }

    const globalPaths = globalHarnessPaths();
    pass(checks, 'harness-data', `Harness data directory: ${globalPaths.data}`, {
      path: globalPaths.data,
    });

    try {
      const resolved = await resolvePinnedRelease(
        new ReleaseStore(globalPaths.data),
        config.harness.release,
        config.schemaVersion,
      );
      pass(
        checks,
        'release-resolution',
        `Harness release resolved: ${resolved.release} (${resolved.digest.slice(0, 12)}…)`,
        { release: resolved.release, digest: resolved.digest, root: resolved.root },
      );
    } catch (error) {
      if (isReleaseError(error)) {
        fail(checks, 'release-resolution', 'Harness release', error);
      } else {
        throw error;
      }
    }
  }

  const failed = checks.some((check) => check.status === 'fail');
  const output = {
    schemaVersion: 1 as const,
    ok: !failed,
    status: failed ? 'fail' as const : 'pass' as const,
    projectRoot: root,
    checks,
  };

  if (options.json) {
    writeJson(output);
  } else {
    for (const check of checks) {
      if (check.status === 'pass') {
        console.log(`✓ ${check.label}`);
      } else {
        console.error(`✗ ${check.label}: ${check.message ?? 'failed'}`);
      }
    }
  }

  if (failed) setCliExitCode('environment');
}
