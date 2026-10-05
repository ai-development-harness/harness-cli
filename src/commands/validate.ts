import { ZodError } from 'zod';
import { readHarnessConfig } from '../core/config.js';
import { findGitRoot } from '../core/git.js';

export async function validateCommand(cwd = process.cwd()): Promise<void> {
  const projectRoot = await findGitRoot(cwd);

  try {
    const config = await readHarnessConfig(projectRoot);
    console.log(`PASS harness.yaml (schema ${config.schemaVersion}, release ${config.harness.release})`);
  } catch (error) {
    if (error instanceof ZodError) {
      console.error('FAIL harness.yaml');
      for (const issue of error.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        console.error(`- ${path}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
