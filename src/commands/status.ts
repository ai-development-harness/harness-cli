import { findGitRoot, harnessStatePath } from '../core/git.js';
import { readConfig } from '../core/config.js';
import { globalHarnessPaths } from '../core/paths.js';
import { isReleaseError } from '../core/releases/errors.js';
import { resolvePinnedRelease } from '../core/releases/resolver.js';
import { ReleaseStore } from '../core/releases/store.js';

export async function statusCommand(cwd: string): Promise<void> {
  const root = await findGitRoot(cwd);
  const config = await readConfig(root);
  const statePath = await harnessStatePath(root);

  console.log(`Project: ${root}`);
  console.log(`Schema version: ${config.schemaVersion}`);
  console.log(`Harness release: ${config.harness.release}`);
  console.log(`Initialized: ${config.project.initialized ? 'yes' : 'no'}`);
  console.log(`Local state: ${statePath}`);

  try {
    const globalPaths = globalHarnessPaths();
    const resolved = await resolvePinnedRelease(
      new ReleaseStore(globalPaths.data),
      config.harness.release,
      config.schemaVersion,
    );
    console.log(`Release status: resolved (${resolved.digest.slice(0, 12)}…)`);
  } catch (error) {
    if (isReleaseError(error)) {
      console.log(`Release status: ${error.code}`);
      return;
    }
    throw error;
  }
}
