import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, configPath, writeConfig } from '../core/config.js';
import { findGitRoot, harnessStatePath } from '../core/git.js';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitignoreEntry(projectRoot: string, entry: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const current = (await exists(gitignorePath)) ? await readFile(gitignorePath, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((line) => line.trim());

  if (lines.includes(entry)) return;

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await writeFile(gitignorePath, `${current}${prefix}${entry}\n`, 'utf8');
}

const AGENTS_BOOTSTRAP = `# AI Development Harness\n\nThis project uses AI Development Harness.\nProject configuration: \`harness.yaml\`.\nUse the installed Harness integration for Harness protocol commands.\n`;

const CLAUDE_BOOTSTRAP = `# AI Development Harness\n\nThis project uses AI Development Harness.\nProject configuration: \`harness.yaml\`.\nUse the installed Harness integration for Harness protocol commands.\n`;

export async function setupCommand(cwd: string): Promise<void> {
  const root = await findGitRoot(cwd);
  const targetConfig = configPath(root);

  if (await exists(targetConfig)) {
    throw new Error(`Harness is already configured: ${targetConfig}`);
  }

  await writeConfig(root, DEFAULT_CONFIG);

  const directories = [
    DEFAULT_CONFIG.sources.requirements,
    DEFAULT_CONFIG.sources.adrDirectory,
    DEFAULT_CONFIG.sources.principles,
    DEFAULT_CONFIG.sources.openQuestions,
    path.dirname(DEFAULT_CONFIG.protocol.skillRegistry),
    DEFAULT_CONFIG.protocol.taskDirectory,
    DEFAULT_CONFIG.protocol.reviewDirectory,
    DEFAULT_CONFIG.protocol.planningReviewDirectory,
    DEFAULT_CONFIG.protocol.initReviewDirectory,
    DEFAULT_CONFIG.protocol.auditDirectory,
    DEFAULT_CONFIG.protocol.releaseDirectory,
    DEFAULT_CONFIG.protocol.skillSearchDirectory,
  ];

  await Promise.all(directories.map((entry) => mkdir(path.join(root, entry), { recursive: true })));

  const statePath = await harnessStatePath(root);
  await mkdir(statePath, { recursive: true });

  await ensureGitignoreEntry(root, DEFAULT_CONFIG.sources.localBrief);

  const agentsPath = path.join(root, 'AGENTS.md');
  if (!(await exists(agentsPath))) {
    await writeFile(agentsPath, AGENTS_BOOTSTRAP, 'utf8');
  } else {
    console.warn('AGENTS.md already exists; left unchanged.');
  }

  const claudePath = path.join(root, 'CLAUDE.md');
  if (!(await exists(claudePath))) {
    await writeFile(claudePath, CLAUDE_BOOTSTRAP, 'utf8');
  } else {
    console.warn('CLAUDE.md already exists; left unchanged.');
  }

  console.log(`Harness configured in ${root}`);
  console.log(`Pinned Harness release: ${DEFAULT_CONFIG.harness.release}`);
  console.log(`Clone-local state: ${statePath}`);
  console.log('Runtime execution is intentionally not implemented in this first slice.');
}
