import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { assertAbsolutePathWithinBoundary } from './path-boundary.js';
import { z } from 'zod';

const languageSchema = z.string().min(2);

export const harnessConfigSchema = z.object({
  schemaVersion: z.literal(1),
  harness: z.object({
    release: z.string().regex(/^\d+\.\d+\.\d+$/, 'Expected semantic version X.Y.Z'),
  }),
  project: z.object({
    initialized: z.boolean().default(false),
    name: z.string().min(1).nullable().default(null),
    initializedAt: z.string().min(1).nullable().default(null),
  }),
  execution: z.object({
    maxFixReviewCycles: z.number().int().min(1).max(5).default(3),
    verificationCommandTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
  }),
  review: z.object({
    security: z.enum(['auto', 'always']).default('auto'),
    tests: z.enum(['auto', 'always']).default('auto'),
  }),
  skills: z.object({
    search: z.object({
      maxResults: z.number().int().min(1).max(10).default(5),
    }),
  }),
  language: z.object({
    default: languageSchema.default('ru'),
    agentResponses: languageSchema.optional(),
    documentation: languageSchema.optional(),
    commitMessages: languageSchema.optional(),
    codeComments: languageSchema.optional(),
    testNames: languageSchema.optional(),
    fixtures: languageSchema.optional(),
    githubTemplates: languageSchema.optional(),
    releaseNotes: languageSchema.optional(),
  }),
  sources: z.object({
    localBrief: z.string().default('PROJECT_BRIEF.local.md'),
    projectOverview: z.string().default('docs/PROJECT.md'),
    requirements: z.string().default('docs/requirements'),
    adrDirectory: z.string().default('docs/adr'),
    principles: z.string().default('docs/principles'),
    architecture: z.string().default('docs/architecture.md'),
    openQuestions: z.string().default('docs/open-questions'),
    openQuestionsIndex: z.string().default('docs/OPEN_QUESTIONS.md'),
    roadmap: z.string().default('planning/PLAN.md'),
    status: z.string().default('planning/STATUS.md'),
  }),
  protocol: z.object({
    taskDirectory: z.string().default('planning/tasks'),
    reviewDirectory: z.string().default('planning/reviews'),
    planningReviewDirectory: z.string().default('planning/plan-reviews'),
    initReviewDirectory: z.string().default('planning/init-reviews'),
    auditDirectory: z.string().default('planning/audits'),
    releaseDirectory: z.string().default('planning/releases'),
    skillSearchDirectory: z.string().default('planning/skill-searches'),
    skillRegistry: z.string().default('docs/skills/REGISTRY.md'),
  }),
});

export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

export const DEFAULT_CONFIG: HarnessConfig = {
  schemaVersion: 1,
  harness: { release: '0.10.4' },
  project: {
    initialized: false,
    name: null,
    initializedAt: null,
  },
  execution: {
    maxFixReviewCycles: 3,
    verificationCommandTimeoutSeconds: 300,
  },
  review: {
    security: 'auto',
    tests: 'auto',
  },
  skills: {
    search: {
      maxResults: 5,
    },
  },
  language: {
    default: 'ru',
    agentResponses: 'ru',
    documentation: 'ru',
    commitMessages: 'ru',
    codeComments: 'ru',
    testNames: 'ru',
    fixtures: 'ru',
    githubTemplates: 'ru',
    releaseNotes: 'ru',
  },
  sources: {
    localBrief: 'PROJECT_BRIEF.local.md',
    projectOverview: 'docs/PROJECT.md',
    requirements: 'docs/requirements',
    adrDirectory: 'docs/adr',
    principles: 'docs/principles',
    architecture: 'docs/architecture.md',
    openQuestions: 'docs/open-questions',
    openQuestionsIndex: 'docs/OPEN_QUESTIONS.md',
    roadmap: 'planning/PLAN.md',
    status: 'planning/STATUS.md',
  },
  protocol: {
    taskDirectory: 'planning/tasks',
    reviewDirectory: 'planning/reviews',
    planningReviewDirectory: 'planning/plan-reviews',
    initReviewDirectory: 'planning/init-reviews',
    auditDirectory: 'planning/audits',
    releaseDirectory: 'planning/releases',
    skillSearchDirectory: 'planning/skill-searches',
    skillRegistry: 'docs/skills/REGISTRY.md',
  },
};

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, 'harness.yaml');
}

export async function readConfig(projectRoot: string): Promise<HarnessConfig> {
  const target = configPath(projectRoot);
  await assertAbsolutePathWithinBoundary(projectRoot, target, 'harness.yaml');
  const raw = await readFile(target, 'utf8');
  return harnessConfigSchema.parse(YAML.parse(raw));
}

export async function writeConfig(
  projectRoot: string,
  config: HarnessConfig,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const target = configPath(projectRoot);
  await assertAbsolutePathWithinBoundary(projectRoot, target, 'harness.yaml');
  await writeFile(target, YAML.stringify(config), {
    encoding: 'utf8',
    flag: options.exclusive ? 'wx' : 'w',
  });
}
