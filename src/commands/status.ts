import { readHarnessConfig } from '../core/config.js';
import { findGitRoot, getCurrentBranch } from '../core/git.js';
import { getCloneLocalStatePath } from '../core/paths.js';

export async function statusCommand(cwd = process.cwd()): Promise<void> {
  const projectRoot = await findGitRoot(cwd);
  const [config, branch, cloneState] = await Promise.all([
    readHarnessConfig(projectRoot),
    getCurrentBranch(projectRoot),
    getCloneLocalStatePath(projectRoot),
  ]);

  console.log(`Project: ${projectRoot}`);
  console.log(`Branch: ${branch ?? '(detached HEAD)'}`);
  console.log(`Harness release: ${config.harness.release}`);
  console.log(`Project initialized: ${config.project.initialized ? 'yes' : 'no'}`);
  console.log(`Clone-local state: ${cloneState}`);
}
