import { findGitRoot } from '../core/git.js';
import { readConfig } from '../core/config.js';

export async function validateCommand(cwd: string): Promise<void> {
  const root = await findGitRoot(cwd);
  const config = await readConfig(root);
  console.log(`Valid harness.yaml (schema ${config.schemaVersion}, release ${config.harness.release}).`);
}
