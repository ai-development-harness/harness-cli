import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, configPath, writeConfig } from '../core/config.js';
import { findGitRoot, harnessStatePath } from '../core/git.js';
import { resolvePortablePathWithinBoundary } from '../core/path-boundary.js';
import { globalHarnessPaths } from '../core/paths.js';
import { isReleaseError } from '../core/releases/errors.js';
import { resolvePinnedRelease } from '../core/releases/resolver.js';
import { ReleaseStore } from '../core/releases/store.js';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitignoreEntry(projectRoot: string, entry: string): Promise<void> {
  const gitignorePath = await resolvePortablePathWithinBoundary(projectRoot, '.gitignore', '.gitignore');
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

  try {
    const globalPaths = globalHarnessPaths();
    await resolvePinnedRelease(
      new ReleaseStore(globalPaths.data),
      DEFAULT_CONFIG.harness.release,
      DEFAULT_CONFIG.schemaVersion,
    );
  } catch (error) {
    if (isReleaseError(error)) {
      throw new Error(
        `${error.code}: Cannot configure project because Harness release ${DEFAULT_CONFIG.harness.release} is unavailable or incompatible. Install a verified release first with "harness release install <directory>". ${error.message}`,
      );
    }
    throw error;
  }

  const directories = [
    DEFAULT_CONFIG.sources.requirements,
    DEFAULT_CONFIG.sources.adrDirectory,
    DEFAULT_CONFIG.sources.principles,
    DEFAULT_CONFIG.sources.openQuestions,
    path.posix.dirname(DEFAULT_CONFIG.protocol.skillRegistry),
    DEFAULT_CONFIG.protocol.taskDirectory,
    DEFAULT_CONFIG.protocol.reviewDirectory,
    DEFAULT_CONFIG.protocol.planningReviewDirectory,
    DEFAULT_CONFIG.protocol.initReviewDirectory,
    DEFAULT_CONFIG.protocol.auditDirectory,
    DEFAULT_CONFIG.protocol.releaseDirectory,
    DEFAULT_CONFIG.protocol.skillSearchDirectory,
  ];

  // Resolve every mutation target before the first write. This keeps setup
  // fail-closed when any configured directory is redirected outside the
  // repository through a symlink/junction/reparse point.
  await resolvePortablePathWithinBoundary(root, 'harness.yaml', 'harness.yaml');
  for (const entry of directories) {
    await resolvePortablePathWithinBoundary(root, entry, 'setup project directory');
  }
  await resolvePortablePathWithinBoundary(root, '.gitignore', '.gitignore');
  const agentsPath = await resolvePortablePathWithinBoundary(root, 'AGENTS.md', 'AGENTS.md');
  const claudePath = await resolvePortablePathWithinBoundary(root, 'CLAUDE.md', 'CLAUDE.md');
  const statePath = await harnessStatePath(root);

  await writeConfig(root, DEFAULT_CONFIG);
  for (const entry of directories) {
    const directory = await resolvePortablePathWithinBoundary(root, entry, 'setup project directory');
    await mkdir(directory, { recursive: true });
  }
  await mkdir(await harnessStatePath(root), { recursive: true });
  await ensureGitignoreEntry(root, DEFAULT_CONFIG.sources.localBrief);

  if (!(await exists(agentsPath))) {
    await writeFile(
      await resolvePortablePathWithinBoundary(root, 'AGENTS.md', 'AGENTS.md'),
      AGENTS_BOOTSTRAP,
      'utf8',
    );
  } else {
    console.warn('AGENTS.md already exists; left unchanged.');
  }

  if (!(await exists(claudePath))) {
    await writeFile(
      await resolvePortablePathWithinBoundary(root, 'CLAUDE.md', 'CLAUDE.md'),
      CLAUDE_BOOTSTRAP,
      'utf8',
    );
  } else {
    console.warn('CLAUDE.md already exists; left unchanged.');
  }

  console.log(`Harness configured in ${root}`);
  console.log(`Pinned Harness release: ${DEFAULT_CONFIG.harness.release}`);
  console.log(`Clone-local state: ${statePath}`);
  console.log('Runtime execution is intentionally not implemented in this first slice.');
}
