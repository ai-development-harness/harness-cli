import { validateProjectArtifacts } from '../core/artifacts/index.js';
import { readConfig } from '../core/config.js';
import { findGitRoot } from '../core/git.js';
import { globalHarnessPaths } from '../core/paths.js';
import { isReleaseError } from '../core/releases/errors.js';
import { resolvePinnedRelease } from '../core/releases/resolver.js';
import { ReleaseStore } from '../core/releases/store.js';
import { validatePlanningState } from '../core/planning/index.js';

export interface ValidateCommandOptions {
  readonly json?: boolean;
}

export async function validateCommand(
  cwd: string,
  options: ValidateCommandOptions = {},
): Promise<void> {
  const root = await findGitRoot(cwd);
  const config = await readConfig(root);

  const globalPaths = globalHarnessPaths();
  let releaseDigest: string;
  try {
    const resolved = await resolvePinnedRelease(
      new ReleaseStore(globalPaths.data),
      config.harness.release,
      config.schemaVersion,
    );
    releaseDigest = resolved.digest;
  } catch (error) {
    if (isReleaseError(error)) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              status: 'FAIL',
              projectRoot: root,
              harnessRelease: config.harness.release,
              projectSchemaVersion: config.schemaVersion,
              release: {
                status: 'FAIL',
                code: error.code,
                message: error.message,
              },
              diagnostics: [],
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`Harness release validation failed: ${error.code}: ${error.message}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const result = await validateProjectArtifacts(root, config);
  const planning = result.status === 'PASS'
    ? await validatePlanningState(root)
    : { schemaVersion: 1 as const, status: 'FAIL' as const, errors: ['artifact validation failed before planning validation'] };
  const overallStatus = result.status === 'PASS' && planning.status === 'PASS' ? 'PASS' : 'FAIL';
  const output = {
    ...result,
    status: overallStatus,
    planning,
    release: {
      status: 'PASS' as const,
      digest: releaseDigest,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else if (overallStatus === 'PASS') {
    const total = Object.values(result.checked).reduce((sum, count) => sum + count, 0);
    console.log(
      `Valid Harness project: schema ${config.schemaVersion}, release ${config.harness.release}, ${total} artifact/report contracts checked, planning contracts PASS.`,
    );
  } else {
    if (result.status === 'FAIL') {
      console.error(`Harness artifact validation failed with ${result.diagnostics.length} diagnostic(s):`);
      for (const item of result.diagnostics) {
        console.error(`- [${item.code}] ${item.path}: ${item.message}`);
      }
    }
    if (planning.status === 'FAIL') {
      console.error(`Harness planning validation failed with ${planning.errors.length} diagnostic(s):`);
      for (const item of planning.errors) console.error(`- [PLANNING] ${item}`);
    }
    process.exitCode = 1;
  }
}
