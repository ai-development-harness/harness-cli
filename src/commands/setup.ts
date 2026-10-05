import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_HARNESS_CONFIG, writeHarnessConfig } from '../core/config.js';
import { findGitRoot } from '../core/git.js';
import { ensureCloneLocalStatePath, ensureGlobalHarnessPaths } from '../core/paths.js';

const AGENTS_BOOTSTRAP = `# AI Development Harness\n\nThis project uses AI Development Harness.\n\nProject configuration: \`harness.yaml\`.\nProject-specific requirements, ADRs, STEP files and review evidence remain in this repository.\nHarness core tooling is distributed separately by the Harness CLI.\n`;

const CLAUDE_BOOTSTRAP = `@AGENTS.md\n`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  if (await exists(path)) {
    return false;
  }
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  return true;
}

export async function setupCommand(cwd = process.cwd()): Promise<void> {
  const projectRoot = await findGitRoot(cwd);
  const configPath = resolve(projectRoot, 'harness.yaml');

  const created: string[] = [];

  if (!(await exists(configPath))) {
    await writeHarnessConfig(projectRoot, DEFAULT_HARNESS_CONFIG);
    created.push('harness.yaml');
  }

  for (const directory of [
    DEFAULT_HARNESS_CONFIG.sources.requirements,
    DEFAULT_HARNESS_CONFIG.sources.adr,
    DEFAULT_HARNESS_CONFIG.sources.openQuestions,
    DEFAULT_HARNESS_CONFIG.planning.tasks,
    DEFAULT_HARNESS_CONFIG.planning.reviews,
    DEFAULT_HARNESS_CONFIG.planning.audits,
  ]) {
    await mkdir(resolve(projectRoot, directory), { recursive: true });
  }

  if (await writeIfMissing(resolve(projectRoot, 'AGENTS.md'), AGENTS_BOOTSTRAP)) {
    created.push('AGENTS.md');
  }
  if (await writeIfMissing(resolve(projectRoot, 'CLAUDE.md'), CLAUDE_BOOTSTRAP)) {
    created.push('CLAUDE.md');
  }

  const cloneState = await ensureCloneLocalStatePath(projectRoot);
  const globalPaths = await ensureGlobalHarnessPaths();

  console.log(`Harness project: ${projectRoot}`);
  console.log(created.length > 0 ? `Created: ${created.join(', ')}` : 'Bootstrap files already exist.');
  console.log(`Clone-local state: ${cloneState}`);
  console.log(`Harness data: ${globalPaths.data}`);
}
