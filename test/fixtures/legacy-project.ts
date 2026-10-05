import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  baselineAgents0104,
  baselineClaude0104,
} from '../../src/core/migration/legacy/bootstrap-baseline-0.10.4.js';

const execFileAsync = promisify(execFile);

export const LEGACY_RELEASE = '0.10.4';
export const LEGACY_SOURCE_COMMIT = '6832c41ad6a0cae4fceffbadf7a4258a441d1001';

export const BASELINE_UPDATE_REPORT_README = `# Harness update reports

Этот каталог хранит durable evidence применения \`HARNESS UPDATE APPLY\` к конкретному проекту.

- \`README.md\` принадлежит Harness protocol layer.
- \`UPDATE-<UTC timestamp>.md\` принадлежит конкретному проекту и создаётся updater-ом после успешной mutation; report фиксирует initial release, requested final target, фактически пройденный route/hops и возможную \`reloadRequired\` boundary.
- Reports не являются STEP и не меняют product roadmap/status.
- \`HARNESS UPDATE CHECK\` ничего сюда не пишет.
- Report не означает commit/push/PR: после него требуется обычный \`GIT CHECK\` → \`GIT COMMIT\`.

При конфликте report не создаётся, потому что updater обязан остановиться до mutation.
`;

export interface LegacyFixtureOptions {
  withLock?: boolean;
  activeExecution?: boolean;
  windowsStyleRequirementsPath?: boolean;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

export async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function legacyManifest(options: LegacyFixtureOptions): string {
  const requirements = options.windowsStyleRequirementsPath ? 'docs\\\\requirements' : 'docs/requirements';
  return `harness:
  version: "1"
  release: "${LEGACY_RELEASE}"
project:
  initialized: true
  name: acme
  initializedAt: "2026-10-01T10:00:00Z"
execution:
  maxFixReviewCycles: 3
  verificationCommandTimeoutSeconds: 300
review:
  security: auto
  tests: auto
skills:
  search:
    maxResults: 5
language:
  default: ru
sources:
  localBrief: PROJECT_BRIEF.local.md
  projectOverview: docs/PROJECT.md
  requirements: ${requirements}
  adrDirectory: docs/adr
  principles: docs/principles
  architecture: docs/architecture.md
  openQuestions: docs/open-questions
  openQuestionsIndex: docs/OPEN_QUESTIONS.md
  roadmap: planning/PLAN.md
  status: planning/STATUS.md
protocol:
  file: .harness/docs/EXECUTION_PROTOCOL.md
  taskDirectory: planning/tasks
  reviewDirectory: planning/reviews
  planningReviewDirectory: planning/plan-reviews
  initReviewDirectory: planning/init-reviews
  auditDirectory: planning/audits
  releaseDirectory: planning/releases
  skillSearchDirectory: planning/skill-searches
  skillRegistry: docs/skills/REGISTRY.md
`;
}

function legacyLock(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    harnessVersion: '1',
    release: LEGACY_RELEASE,
    source: {
      repository: 'ai-development-harness/ai-development-harness-template',
      ref: `v${LEGACY_RELEASE}`,
      commit: LEGACY_SOURCE_COMMIT,
    },
    updatedAt: null,
  }, null, 2)}\n`;
}

function customizedAgents(): string {
  return baselineAgents0104
    .replace(
      'Проект ещё не инициализирован. До успешного \`PROJECT INIT\` не создавай production-код и не придумывай product-specific архитектуру. Сырой вход находится по configured \`.harness/manifest.yaml → sources.localBrief\`.',
      'Проект Acme инициализирован. Сохраняй этот project-specific context.',
    )
    .replace(
      'Дополнительные project/technology-specific skills пока не установлены. После \`SKILL INSTALL\` / \`SKILL CREATE\` добавляй сюда только краткие routing rules вида \`класс задач → skill\`, не копируя полный playbook.',
      '- backend задачи → custom-backend',
    );
}

export async function createLegacyFixture(
  options: LegacyFixtureOptions = {},
): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'harness-cli-e2e-'));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Harness Test']);

  await writeText(repo, '.harness/manifest.yaml', legacyManifest(options));
  if (options.withLock !== false) {
    await writeText(repo, '.harness/harness.lock.json', legacyLock());
  }

  await writeText(repo, 'AGENTS.md', customizedAgents());
  await writeText(repo, 'CLAUDE.md', `${baselineClaude0104}\nProject-specific Claude note.\n`);
  await writeText(repo, 'planning/harness-updates/README.md', BASELINE_UPDATE_REPORT_README);
  await writeText(repo, '.agents/skills/custom-backend/SKILL.md', '# Custom backend skill\n');
  await writeText(repo, '.codex/config.toml', '[project]\nname = "acme"\n');
  await writeText(repo, 'CUSTOM.md', '# Unknown project file\n');
  await writeText(repo, 'src/index.ts', 'export const value = 1;\n');

  const directories = [
    'docs/requirements',
    'docs/adr',
    'docs/principles',
    'docs/open-questions',
    'docs/skills',
    'planning/tasks',
    'planning/reviews',
    'planning/plan-reviews',
    'planning/init-reviews',
    'planning/audits',
    'planning/releases',
    'planning/skill-searches',
  ];
  for (const directory of directories) {
    await writeText(repo, `${directory}/.gitkeep`, '');
  }
  await writeText(repo, 'planning/PLAN.md', '# Project Roadmap\n');
  await writeText(repo, 'planning/STATUS.md', '# Project Status\n');

  if (options.activeExecution) {
    await writeText(
      repo,
      '.harness/local/execution/execution-status.json',
      `${JSON.stringify({
        schemaVersion: 2,
        executions: [{ id: 'active-1', command: 'STEP RUN STEP-001' }],
        stepRecovery: {},
        recentTerminals: [],
        nextOrdinal: 2,
      })}\n`,
    );
  }

  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'legacy fixture']);
  return { base, repo };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function createReleaseTree(base: string): Promise<string> {
  const releaseRoot = path.join(base, 'release');
  const payload: Record<string, string> = {
    'core/index.mjs': "export const release = '0.10.4';\n",
    'protocol/commands.json': '{}\n',
    'schemas/project.schema.json': '{"type":"object"}\n',
    'skills/run-step/SKILL.md': '# Run\n',
    'docs/PROTOCOL.md': '# Protocol\n',
  };
  for (const [relativePath, content] of Object.entries(payload)) {
    await writeText(releaseRoot, relativePath, content);
  }
  const files = Object.entries(payload)
    .map(([relativePath, content]) => ({
      path: relativePath,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  await writeText(
    releaseRoot,
    'release.json',
    `${JSON.stringify({
      formatVersion: 1,
      release: LEGACY_RELEASE,
      createdAt: '2026-10-05T10:00:00Z',
      compatibility: {
        cli: { minVersion: '0.1.0', maxVersionExclusive: null },
        hostApi: { minVersion: 1, maxVersion: 1 },
        projectSchema: { supported: [1], target: 1, migrateFrom: [] },
      },
      entrypoints: { core: 'core/index.mjs' },
      components: [
        { id: 'core', path: 'core', required: true },
        { id: 'protocol', path: 'protocol', required: true },
        { id: 'schemas', path: 'schemas', required: true },
        { id: 'skills', path: 'skills', required: true },
        { id: 'docs', path: 'docs', required: true },
      ],
      files,
    }, null, 2)}\n`,
  );
  return releaseRoot;
}
