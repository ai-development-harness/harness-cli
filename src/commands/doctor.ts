import { access } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../core/config.js';
import { findGitRoot, harnessStatePath } from '../core/git.js';
import { globalHarnessPaths } from '../core/paths.js';

export async function doctorCommand(cwd: string): Promise<void> {
  let failed = false;

  try {
    const root = await findGitRoot(cwd);
    console.log(`✓ Git repository: ${root}`);

    const config = await readConfig(root);
    console.log(`✓ harness.yaml: schema ${config.schemaVersion}`);
    console.log(`✓ Harness release pin: ${config.harness.release}`);

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
      path.dirname(config.protocol.skillRegistry),
    ];

    for (const relativePath of requiredDirectories) {
      try {
        await access(path.join(root, relativePath));
        console.log(`✓ ${relativePath}`);
      } catch {
        failed = true;
        console.error(`✗ missing: ${relativePath}`);
      }
    }

    const statePath = await harnessStatePath(root);
    console.log(`✓ Clone-local state: ${statePath}`);

    const globalPaths = globalHarnessPaths();
    console.log(`✓ Harness data directory: ${globalPaths.data}`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${(error as Error).message}`);
  }

  if (failed) process.exitCode = 1;
}
