import { findGitRoot, harnessStatePath } from '../core/git.js';
import { readConfig } from '../core/config.js';

export async function statusCommand(cwd: string): Promise<void> {
  const root = await findGitRoot(cwd);
  const config = await readConfig(root);
  const statePath = await harnessStatePath(root);

  console.log(`Project: ${root}`);
  console.log(`Harness release: ${config.harness.release}`);
  console.log(`Initialized: ${config.project.initialized ? 'yes' : 'no'}`);
  console.log(`Local state: ${statePath}`);
}
