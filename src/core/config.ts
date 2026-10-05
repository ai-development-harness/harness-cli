import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const relativeProjectPath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value), {
    message: 'Expected a project-relative path',
  });

export const HarnessConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    harness: z
      .object({
        release: z.string().min(1),
      })
      .strict(),
    project: z
      .object({
        initialized: z.boolean(),
      })
      .strict(),
    sources: z
      .object({
        requirements: relativeProjectPath,
        adr: relativeProjectPath,
        openQuestions: relativeProjectPath,
      })
      .strict(),
    planning: z
      .object({
        tasks: relativeProjectPath,
        reviews: relativeProjectPath,
        audits: relativeProjectPath,
      })
      .strict(),
  })
  .strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  schemaVersion: 1,
  harness: {
    release: '0.10.1',
  },
  project: {
    initialized: false,
  },
  sources: {
    requirements: 'docs/requirements',
    adr: 'docs/adr',
    openQuestions: 'docs/open-questions',
  },
  planning: {
    tasks: 'planning/tasks',
    reviews: 'planning/reviews',
    audits: 'planning/audits',
  },
};

export function parseHarnessConfig(source: string): HarnessConfig {
  return HarnessConfigSchema.parse(parse(source));
}

export function serializeHarnessConfig(config: HarnessConfig): string {
  return stringify(config, { indent: 2, lineWidth: 0 });
}

export async function readHarnessConfig(projectRoot: string): Promise<HarnessConfig> {
  const path = resolve(projectRoot, 'harness.yaml');
  const source = await readFile(path, 'utf8');
  return parseHarnessConfig(source);
}

export async function writeHarnessConfig(
  projectRoot: string,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): Promise<void> {
  const path = resolve(projectRoot, 'harness.yaml');
  await writeFile(path, serializeHarnessConfig(config), { encoding: 'utf8', flag: 'wx' });
}
