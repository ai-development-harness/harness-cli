import { findGitRoot, harnessStatePath } from '../core/git.js';
import { readConfig } from '../core/config.js';
import { globalHarnessPaths } from '../core/paths.js';
import { isReleaseError } from '../core/releases/errors.js';
import { resolvePinnedRelease } from '../core/releases/resolver.js';
import { ReleaseStore } from '../core/releases/store.js';
import { projectStatus, resolveStepNext, writeProjections } from '../core/project/index.js';

export interface StatusCommandOptions {
  readonly json?: boolean;
}

export async function statusCommand(
  cwd: string,
  options: StatusCommandOptions = {},
): Promise<void> {
  const root = await findGitRoot(cwd);
  const config = await readConfig(root);
  const statePath = await harnessStatePath(root);

  try {
    const globalPaths = globalHarnessPaths();
    const resolved = await resolvePinnedRelease(
      new ReleaseStore(globalPaths.data),
      config.harness.release,
      config.schemaVersion,
    );

    let changedProjections: readonly string[] = [];
    let status: Readonly<Record<string, unknown>>;
    try {
      changedProjections = await writeProjections(root);
      const facts = await projectStatus(root);
      status = {
        ...facts,
        changedProjections,
        nextWork: await resolveStepNext(root),
      };
    } catch (error) {
      status = {
        status: 'BLOCKED',
        reasonCode: 'PROJECT_STATUS_PROJECTION_FAILED',
        message: (error as Error).message,
        changedProjections,
      };
      process.exitCode = 1;
    }

    const output = {
      schemaVersion: 1,
      project: {
        root,
        name: config.project.name,
        initialized: config.project.initialized,
        initializedAt: config.project.initializedAt,
        schemaVersion: config.schemaVersion,
      },
      harness: {
        release: config.harness.release,
        releaseDigest: resolved.digest,
      },
      localState: statePath,
      projectStatus: status,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`Project: ${root}`);
    console.log(`Schema version: ${config.schemaVersion}`);
    console.log(`Harness release: ${config.harness.release}`);
    console.log(`Initialized: ${config.project.initialized ? 'yes' : 'no'}`);
    console.log(`Local state: ${statePath}`);
    console.log(`Release status: resolved (${resolved.digest.slice(0, 12)}…)`);

    if (status.status === 'PASS') {
      const summary = status.summary as Record<string, unknown>;
      console.log(`STEPs: ${String(summary.total ?? 0)}`);
      console.log(`Stale plans: ${String(summary.stalePlans ?? 0)}`);
      if (changedProjections.length > 0) {
        console.log(`Updated projections: ${changedProjections.join(', ')}`);
      }
      const next = status.nextWork as Record<string, unknown> | undefined;
      if (next?.status === 'PASS') console.log(`Next work: ${String(next.command)}`);
    } else {
      console.log(`Project status: ${String(status.status)} (${String(status.reasonCode ?? 'unknown')})`);
    }
  } catch (error) {
    if (isReleaseError(error)) {
      if (options.json) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          status: 'BLOCKED',
          reasonCode: error.code,
          message: error.message,
        }, null, 2));
      } else {
        console.log(`Release status: ${error.code}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
