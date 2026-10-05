import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readHarnessConfig } from '../core/config.js';
import { findGitRoot } from '../core/git.js';
import { getCloneLocalStatePath, getHarnessGlobalPaths } from '../core/paths.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function doctorCommand(cwd = process.cwd()): Promise<void> {
  const checks: CheckResult[] = [];
  const projectRoot = await findGitRoot(cwd);
  checks.push({ name: 'git', ok: true, detail: projectRoot });

  try {
    const config = await readHarnessConfig(projectRoot);
    checks.push({
      name: 'harness.yaml',
      ok: true,
      detail: `schema ${config.schemaVersion}, release ${config.harness.release}`,
    });

    for (const [name, relativePath] of Object.entries({ ...config.sources, ...config.planning })) {
      const absolutePath = resolve(projectRoot, relativePath);
      checks.push({ name, ok: await pathExists(absolutePath), detail: relativePath });
    }
  } catch (error) {
    checks.push({
      name: 'harness.yaml',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const cloneState = await getCloneLocalStatePath(projectRoot);
  checks.push({ name: 'clone-local state', ok: await pathExists(cloneState), detail: cloneState });

  const globalPaths = getHarnessGlobalPaths();
  checks.push({ name: 'global data', ok: await pathExists(globalPaths.data), detail: globalPaths.data });

  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}
