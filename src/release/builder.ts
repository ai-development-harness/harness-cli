import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROTOCOL_MODEL, reasoningProjection } from '../core/protocol/index.js';
import { verifyReleaseTree } from '../core/releases/verifier.js';

export interface BuildHarnessReleaseOptions {
  readonly release: string;
  readonly outputRoot: string;
  readonly coreSourceRoot?: string;
  readonly createdAt?: string;
  readonly cliMinVersion?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function files(root: string, relative = ''): Promise<string[]> {
  const directory = relative ? path.join(root, ...relative.split('/')) : root;
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, child));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`release builder refuses non-file payload: ${child}`);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function skillMarkdown(skill: string, commands: string[], modelWork: string[], deterministicWork: string[]): string {
  return `---
name: ${skill}
description: Release-owned semantic capability for ${commands.join(', ')}.
---
# ${skill}

This skill is selected only by a typed Harness Core semantic handoff.

## Commands

${commands.map((item) => `- \`${item}\``).join('\n')}

## Semantic responsibility

${modelWork.length ? modelWork.map((item) => `- ${item}`).join('\n') : '- Follow the exact semantic handoff contract.'}

## Deterministic boundary

Do not emulate these Core-owned operations in reasoning:

${deterministicWork.map((item) => `- ${item}`).join('\n')}

Treat the semantic result as a proposal. Do not mutate execution state, canonical transitions, release identity, or external side-effect proof directly. Return the proposal to Harness Core for deterministic validation and commit.
`;
}

async function writeGeneratedSkills(root: string): Promise<void> {
  const bySkill = new Map<string, { commands: string[]; model: string[]; deterministic: string[] }>();
  for (const domain of Object.values(PROTOCOL_MODEL.domains)) {
    for (const command of Object.values(domain.commands)) {
      if (command.dispatch.kind !== 'semantic') continue;
      const item = bySkill.get(command.dispatch.skill) ?? { commands: [], model: [], deterministic: [] };
      item.commands.push(command.canonical);
      item.model.push(...command.reasoning.modelWork);
      item.deterministic.push(...command.reasoning.deterministicWork);
      bySkill.set(command.dispatch.skill, item);
    }
  }
  for (const [skill, item] of [...bySkill.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(root, 'skills', skill, 'SKILL.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, skillMarkdown(
      skill,
      [...new Set(item.commands)],
      [...new Set(item.model)],
      [...new Set(item.deterministic)],
    ), 'utf8');
  }
}

export async function buildHarnessRelease(options: BuildHarnessReleaseOptions) {
  if (!/^\d+\.\d+\.\d+$/.test(options.release)) throw new Error('release must be X.Y.Z');
  const createdAt = options.createdAt ??
    (process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : null);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new Error('deterministic release build requires createdAt or SOURCE_DATE_EPOCH');
  }

  const outputRoot = path.resolve(options.outputRoot);
  const coreSourceRoot = path.resolve(options.coreSourceRoot ?? path.join(process.cwd(), 'dist', 'core'));
  const entrypoint = path.join(coreSourceRoot, 'release-entrypoint.js');
  if (!(await stat(entrypoint)).isFile()) throw new Error(`compiled Core entrypoint missing: ${entrypoint}`);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const coreRoot = path.join(outputRoot, 'core');
  await cp(coreSourceRoot, coreRoot, { recursive: true });

  const runtimeDependencies = ['env-paths', 'yaml', 'zod'] as const;
  const releaseNodeModules = path.join(coreRoot, 'node_modules');
  await mkdir(releaseNodeModules, { recursive: true });
  for (const dependency of runtimeDependencies) {
    const source = path.join(process.cwd(), 'node_modules', dependency);
    const target = path.join(releaseNodeModules, dependency);
    if (!(await stat(source)).isDirectory()) {
      throw new Error(`runtime dependency missing from build environment: ${dependency}`);
    }
    await cp(source, target, { recursive: true });
  }

  await mkdir(path.join(outputRoot, 'protocol'), { recursive: true });
  await writeFile(path.join(outputRoot, 'protocol', 'model.json'), `${JSON.stringify(PROTOCOL_MODEL, null, 2)}\n`);
  await writeFile(path.join(outputRoot, 'protocol', 'reasoning.json'), `${JSON.stringify(reasoningProjection(), null, 2)}\n`);

  await mkdir(path.join(outputRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(outputRoot, 'schemas', 'semantic-handoff.schema.json'), `${JSON.stringify({
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    title: 'Harness Semantic Handoff v1',
    type: 'object',
    required: ['schemaVersion', 'kind', 'executionId', 'rootCommand', 'command', 'requiredSkill', 'context'],
    properties: {
      schemaVersion: { const: 1 },
      kind: { const: 'semantic-handoff' },
      executionId: { type: 'string', minLength: 1 },
      rootCommand: { type: 'string', minLength: 1 },
      command: { type: 'string', minLength: 1 },
      requiredSkill: { type: 'string', minLength: 1 },
      context: { type: 'object' },
    },
    additionalProperties: true,
  }, null, 2)}\n`);
  await writeFile(path.join(outputRoot, 'schemas', 'core-host-result.schema.json'), `${JSON.stringify({
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    title: 'Harness Core Host API v1 Result',
    type: 'object',
    required: ['schemaVersion', 'hostApiVersion', 'requestId', 'ok', 'versions'],
    properties: {
      schemaVersion: { const: 1 },
      hostApiVersion: { const: 1 },
      requestId: { type: 'string', minLength: 1 },
      ok: { type: 'boolean' },
      versions: { type: 'object' },
    },
    additionalProperties: true,
  }, null, 2)}\n`);

  await writeGeneratedSkills(outputRoot);

  await mkdir(path.join(outputRoot, 'docs'), { recursive: true });
  await writeFile(path.join(outputRoot, 'docs', 'README.md'), `# AI Development Harness ${options.release}

This immutable distribution owns executable Harness Core semantics.

- Core entrypoint: \`core/release-entrypoint.js\`
- Host API: v1
- Protocol: \`protocol/model.json\`
- Reasoning projection: \`protocol/reasoning.json\`
- Generated base semantic skills: \`skills/*/SKILL.md\`

Project repositories keep project-owned artifacts and thin runtime bootstrap only.
`);

  const payload = await files(outputRoot);
  const inventory = [];
  for (const relativePath of payload) {
    const bytes = await readFile(path.join(outputRoot, ...relativePath.split('/')));
    inventory.push({ path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) });
  }

  const manifest = {
    formatVersion: 1,
    release: options.release,
    createdAt,
    compatibility: {
      cli: { minVersion: options.cliMinVersion ?? '0.1.0', maxVersionExclusive: null },
      hostApi: { minVersion: 1, maxVersion: 1 },
      projectSchema: { supported: [1], target: 1, migrateFrom: [] },
    },
    entrypoints: { core: 'core/release-entrypoint.js' },
    components: [
      { id: 'core', path: 'core', required: true },
      { id: 'protocol', path: 'protocol', required: true },
      { id: 'schemas', path: 'schemas', required: true },
      { id: 'skills', path: 'skills', required: true },
      { id: 'docs', path: 'docs', required: true },
    ],
    files: inventory,
  };
  await writeFile(path.join(outputRoot, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return verifyReleaseTree(outputRoot, options.release);
}
