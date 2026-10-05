import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG, harnessConfigSchema, readConfig, type HarnessConfig } from '../config.js';
import { harnessStatePath } from '../git.js';
import { resolvePinnedRelease } from '../releases/resolver.js';
import { ReleaseStore } from '../releases/store.js';
import { atomicWriteText } from './checkpoint.js';
import { executeMigration, resumeMigration } from './executor.js';
import type {
  MigrationExecutionResult,
  MigrationExecutorDependencies,
  MigrationOperationContext,
  MigrationOperationHandler,
  MigrationOperationHandlers,
  MigrationOperationPostcondition,
} from './executor-types.js';
import { baselineAgents0104, baselineClaude0104 } from './legacy/bootstrap-baseline-0.10.4.js';
import { inspectProject } from './legacy/inspector.js';
import type { MigrationPlan, MigrationPlanMessage, MigrationPlannerOptions } from './plan-types.js';
import { planMigration, type MigrationPlannerDependencies } from './planner.js';

const PROJECT_CONTEXT_START = '<!-- PROJECT-CONTEXT:START -->';
const PROJECT_CONTEXT_END = '<!-- PROJECT-CONTEXT:END -->';
const SKILL_ROUTING_START = '<!-- SKILL-ROUTING:START -->';
const SKILL_ROUTING_END = '<!-- SKILL-ROUTING:END -->';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobSha1(value: Uint8Array): string {
  const prefix = Buffer.from(`blob ${value.byteLength}\0`, 'utf8');
  return createHash('sha1').update(prefix).update(value).digest('hex');
}

function safeProjectPath(projectRoot: string, portablePath: string): string {
  if (!portablePath || portablePath.startsWith('/') || portablePath.includes('\\')) {
    throw new Error(`Unsafe project path: ${portablePath}`);
  }
  const segments = portablePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe project path: ${portablePath}`);
  }
  const resolved = path.resolve(projectRoot, ...segments);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${portablePath}`);
  }
  return resolved;
}

async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return true;
    throw error;
  }
}

async function fileSha256(target: string): Promise<string | null> {
  try {
    return sha256(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function workingTreeBlobSha1(projectRoot: string, portablePath: string): Promise<string | null> {
  try {
    return gitBlobSha1(await readFile(safeProjectPath(projectRoot, portablePath)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface MarkerBlock { before: string; inner: string; after: string }

function normalizeTextEol(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitMarker(text: string, start: string, end: string): MarkerBlock {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`Required bootstrap markers are missing: ${start} / ${end}`);
  }
  const contentStart = startIndex + start.length;
  return {
    before: text.slice(0, contentStart),
    inner: text.slice(contentStart, endIndex),
    after: text.slice(endIndex),
  };
}

function normalizedAgents(text: string): string {
  const project = splitMarker(text, PROJECT_CONTEXT_START, PROJECT_CONTEXT_END);
  const skill = splitMarker(project.after, SKILL_ROUTING_START, SKILL_ROUTING_END);
  return `${project.before}\n<PROJECT-CONTEXT>\n${skill.before}\n<SKILL-ROUTING>\n${skill.after}`;
}

function buildThinAgents(source: string): string {
  const normalizedSource = normalizeTextEol(source);
  const normalizedBaseline = normalizeTextEol(baselineAgents0104);
  if (normalizedAgents(normalizedSource) !== normalizedAgents(normalizedBaseline)) {
    throw new Error(
      'AGENTS.md contains changes outside the supported PROJECT-CONTEXT/SKILL-ROUTING blocks; destructive bootstrap rewrite is unsafe.',
    );
  }
  const project = splitMarker(normalizedSource, PROJECT_CONTEXT_START, PROJECT_CONTEXT_END);
  const skill = splitMarker(project.after, SKILL_ROUTING_START, SKILL_ROUTING_END);
  const projectBlock = `${PROJECT_CONTEXT_START}${project.inner}${PROJECT_CONTEXT_END}`;
  const skillBlock = `${SKILL_ROUTING_START}${skill.inner}${SKILL_ROUTING_END}`;
  return [
    '# AI Development Harness — project bootstrap',
    '',
    'Этот репозиторий использует установленный AI Development Harness CLI/Core.',
    '',
    '- `harness.yaml` — project-owned контракт и закреплённый Harness release.',
    '- Общая реализация protocol/Core не хранится в repository и не должна восстанавливаться из legacy `.harness/tools/**` или `.harness/docs/**`.',
    '- Детерминированную семантику Harness получает из установленного release, а project artifacts остаются source of truth проекта.',
    '',
    projectBlock,
    '',
    '## Project skill routing',
    '',
    skillBlock,
    '',
    '## Local instructions',
    '',
    'Если существует `AGENTS.local.md`, читай его последним. Локальные инструкции могут расширять workflow, но не отменяют project contract и safety invariants Harness.',
    '',
  ].join('\n');
}

function buildThinClaude(source: string): string {
  const normalizedSource = normalizeTextEol(source);
  const normalizedBaseline = normalizeTextEol(baselineClaude0104);
  if (!normalizedSource.startsWith(normalizedBaseline)) {
    throw new Error('CLAUDE.md diverges from the supported v0.10.4 adapter prefix; destructive bootstrap rewrite is unsafe.');
  }
  const suffix = normalizedSource.slice(normalizedBaseline.length).trim();
  const lines = [
    '@AGENTS.md',
    '',
    '# Claude Code adapter',
    '',
    'Используй `AGENTS.md` как общие project instructions. Claude-specific настройки проекта остаются в `.claude/**`; они не меняют семантику Harness Core.',
  ];
  if (suffix) lines.push('', '## Preserved project-specific Claude instructions', '', suffix);
  lines.push('');
  return lines.join('\n');
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertTargetConfigPaths(projectRoot: string, config: HarnessConfig): void {
  const configuredPaths = [
    ...Object.values(config.sources),
    ...Object.values(config.protocol),
  ];
  for (const configuredPath of configuredPaths) {
    safeProjectPath(projectRoot, configuredPath);
  }
}

function buildThinConfig(source: string, plan: MigrationPlan): string {
  const parsed = YAML.parse(source) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Legacy manifest must be a mapping.');
  }
  if (plan.target.harnessRelease === null || plan.target.projectSchemaVersion !== 1) {
    throw new Error('v0.10.4 thin migration currently supports target project schema 1 only.');
  }
  const legacy = parsed as Record<string, unknown>;
  const protocolSource = objectValue(legacy.protocol);
  const { file: _legacyProtocolFile, ...protocolWithoutFile } = protocolSource;
  const target = {
    ...DEFAULT_CONFIG,
    schemaVersion: 1 as const,
    harness: { release: plan.target.harnessRelease },
    project: { ...DEFAULT_CONFIG.project, ...objectValue(legacy.project) },
    execution: { ...DEFAULT_CONFIG.execution, ...objectValue(legacy.execution) },
    review: { ...DEFAULT_CONFIG.review, ...objectValue(legacy.review) },
    skills: { ...DEFAULT_CONFIG.skills, ...objectValue(legacy.skills) },
    language: { ...DEFAULT_CONFIG.language, ...objectValue(legacy.language) },
    sources: { ...DEFAULT_CONFIG.sources, ...objectValue(legacy.sources) },
    protocol: { ...DEFAULT_CONFIG.protocol, ...protocolWithoutFile },
  };
  return YAML.stringify(harnessConfigSchema.parse(target));
}

function descriptorContent(operation: MigrationPlan['operations'][number]): string {
  const value = operation.targetDescriptor?.content;
  if (typeof value !== 'string') throw new Error(`Operation ${operation.id} has no prepared target content.`);
  return value;
}

function enrichPlanOperation(operation: MigrationPlan['operations'][number], content: string) {
  return {
    ...operation,
    targetDescriptor: {
      ...(operation.targetDescriptor ?? {}),
      content,
      sha256: sha256(content),
    },
  };
}

export type LegacyThinPreparation =
  | { status: 'already-migrated'; projectRoot: string }
  | { status: 'blocked'; plan: MigrationPlan }
  | { status: 'ready'; plan: MigrationPlan };

export interface LegacyThinMigrationDependencies extends MigrationPlannerDependencies {
  releaseStore?: ReleaseStore;
}

export async function prepareLegacyThinMigration(
  cwd: string,
  options: MigrationPlannerOptions = {},
  dependencies: LegacyThinMigrationDependencies = {},
): Promise<LegacyThinPreparation> {
  const inspection = await inspectProject(cwd, { fromRelease: options.fromRelease });
  if (inspection.state === 'thin-harness-current' && inspection.projectRoot !== null) {
    return { status: 'already-migrated', projectRoot: inspection.projectRoot };
  }
  const plan = await planMigration(cwd, options, dependencies);
  if (plan.status === 'blocked' || plan.source.projectRoot === null) return { status: 'blocked', plan };

  const blockers: MigrationPlanMessage[] = [...plan.blockers];
  const operations: MigrationPlan['operations'][number][] = [];
  for (const operation of plan.operations) {
    try {
      if (operation.strategy === 'legacy-manifest-to-thin-config') {
        const source = await readFile(safeProjectPath(plan.source.projectRoot, operation.path), 'utf8');
        const content = buildThinConfig(source, plan);
        assertTargetConfigPaths(
          plan.source.projectRoot,
          harnessConfigSchema.parse(YAML.parse(content)),
        );
        operations.push(enrichPlanOperation(operation, content));
      } else if (operation.strategy === 'thin-agents-bootstrap-preserve-project-blocks') {
        const source = await readFile(safeProjectPath(plan.source.projectRoot, operation.path), 'utf8');
        operations.push(enrichPlanOperation(operation, buildThinAgents(source)));
      } else if (operation.strategy === 'thin-claude-adapter-preserve-project-content') {
        const source = await readFile(safeProjectPath(plan.source.projectRoot, operation.path), 'utf8');
        operations.push(enrichPlanOperation(operation, buildThinClaude(source)));
      } else {
        operations.push(operation);
      }
    } catch (error) {
      blockers.push({
        code: operation.path === '.harness/manifest.yaml' ? 'PROJECT_SCHEMA_CONFLICT' : 'UNSAFE_SHARED_MERGE',
        message: (error as Error).message,
        paths: [operation.path],
      });
      operations.push(operation);
    }
  }

  const localStateOperation = operations.find((operation) => operation.kind === 'MIGRATE_LOCAL_STATE');
  if (localStateOperation) {
    const stateRoot = await harnessStatePath(plan.source.projectRoot);
    const target = path.join(stateRoot, 'execution', 'execution-status.json');
    if (await exists(target)) {
      blockers.push({
        code: 'LOCAL_STATE_TARGET_CONFLICT',
        message: 'Clone-local execution state already exists; migration will not overwrite it.',
        paths: [localStateOperation.path],
        details: { target },
      });
    }
  }

  const enriched: MigrationPlan = {
    ...plan,
    status: blockers.length === 0 ? 'ready' : 'blocked',
    operations,
    blockers,
  };
  return enriched.status === 'ready'
    ? { status: 'ready', plan: enriched }
    : { status: 'blocked', plan: enriched };
}

async function backupSource(context: MigrationOperationContext): Promise<string | null> {
  const source = safeProjectPath(context.projectRoot, context.operation.path);
  if (!(await exists(source))) return null;
  const backup = path.join(context.checkpoint.backups, ...context.operation.path.split('/'));
  await mkdir(path.dirname(backup), { recursive: true });
  await copyFile(source, backup);
  return backup;
}

function transformHandler(): MigrationOperationHandler {
  return {
    async apply(context): Promise<MigrationOperationPostcondition> {
      if (context.operation.strategy !== 'legacy-manifest-to-thin-config' || !context.operation.targetPath) {
        throw new Error(`Unsupported TRANSFORM strategy: ${context.operation.strategy}`);
      }
      const content = descriptorContent(context.operation);
      const expected = context.operation.targetDescriptor?.sha256;
      if (typeof expected !== 'string' || expected !== sha256(content)) {
        throw new Error('Prepared transform descriptor hash is inconsistent.');
      }
      await backupSource(context);
      await atomicWriteText(safeProjectPath(context.projectRoot, context.operation.targetPath), content);
      await rm(safeProjectPath(context.projectRoot, context.operation.path), { force: true });
      return { sourceAbsent: true, targetPath: context.operation.targetPath, sha256: expected };
    },
    async verify(context, postcondition): Promise<boolean> {
      if (postcondition.sourceAbsent !== true || typeof postcondition.targetPath !== 'string' || typeof postcondition.sha256 !== 'string') return false;
      return !(await exists(safeProjectPath(context.projectRoot, context.operation.path))) &&
        (await fileSha256(safeProjectPath(context.projectRoot, postcondition.targetPath))) === postcondition.sha256;
    },
  };
}

function replaceBootstrapHandler(): MigrationOperationHandler {
  return {
    async apply(context): Promise<MigrationOperationPostcondition> {
      const content = descriptorContent(context.operation);
      const expected = context.operation.targetDescriptor?.sha256;
      if (typeof expected !== 'string' || expected !== sha256(content)) {
        throw new Error('Prepared bootstrap descriptor hash is inconsistent.');
      }
      await backupSource(context);
      await atomicWriteText(safeProjectPath(context.projectRoot, context.operation.path), content);
      return { sha256: expected };
    },
    async verify(context, postcondition): Promise<boolean> {
      return typeof postcondition.sha256 === 'string' &&
        (await fileSha256(safeProjectPath(context.projectRoot, context.operation.path))) === postcondition.sha256;
    },
  };
}

function deleteCleanHandler(): MigrationOperationHandler {
  return {
    async apply(context): Promise<MigrationOperationPostcondition> {
      await backupSource(context);
      await rm(safeProjectPath(context.projectRoot, context.operation.path), { force: true });
      return { absent: true };
    },
    async verify(context, postcondition): Promise<boolean> {
      return postcondition.absent === true && !(await exists(safeProjectPath(context.projectRoot, context.operation.path)));
    },
  };
}

function migrateLocalStateHandler(): MigrationOperationHandler {
  return {
    async apply(context): Promise<MigrationOperationPostcondition> {
      const source = safeProjectPath(context.projectRoot, context.operation.path);
      const bytes = await readFile(source);
      await backupSource(context);
      const stateRoot = await harnessStatePath(context.projectRoot);
      const target = path.join(stateRoot, 'execution', 'execution-status.json');
      if (await exists(target)) {
        throw new Error('Clone-local execution state appeared after planning; refusing to overwrite it.');
      }
      await atomicWriteText(target, bytes.toString('utf8'));
      await rm(source, { force: true });
      return { sourceAbsent: true, target, sha256: sha256(bytes) };
    },
    async verify(context, postcondition): Promise<boolean> {
      return postcondition.sourceAbsent === true && typeof postcondition.target === 'string' && typeof postcondition.sha256 === 'string' &&
        !(await exists(safeProjectPath(context.projectRoot, context.operation.path))) &&
        (await fileSha256(postcondition.target)) === postcondition.sha256;
    },
  };
}

async function verifyRequiredDirectories(projectRoot: string, config: HarnessConfig): Promise<string[]> {
  const required = [
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
    path.posix.dirname(config.protocol.skillRegistry),
  ];
  const missing: string[] = [];
  for (const relativePath of required) {
    if (!(await exists(safeProjectPath(projectRoot, relativePath)))) missing.push(relativePath);
  }
  return missing;
}

async function verifyPreservedPaths(plan: MigrationPlan): Promise<string[]> {
  if (plan.source.projectRoot === null) return ['project-root-missing'];
  const failures: string[] = [];
  for (const operation of plan.operations) {
    if (operation.kind !== 'PRESERVE') continue;
    if (operation.precondition.kind === 'git-blob-sha1') {
      const actual = await workingTreeBlobSha1(plan.source.projectRoot, operation.path);
      if (actual !== operation.precondition.value) failures.push(operation.path);
    } else if (!(await exists(safeProjectPath(plan.source.projectRoot, operation.path)))) {
      failures.push(operation.path);
    }
  }
  return failures;
}

async function verifyLegacyThinResult(
  plan: MigrationPlan,
  store: ReleaseStore,
  checkpointRoot: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (plan.source.projectRoot === null || plan.target.harnessRelease === null) {
    throw new Error('Migration plan is missing target identity.');
  }
  const projectRoot = plan.source.projectRoot;
  const config = await readConfig(projectRoot);
  if (config.harness.release !== plan.target.harnessRelease || config.schemaVersion !== plan.target.projectSchemaVersion) {
    throw new Error('Target harness.yaml identity does not match migration plan.');
  }
  const release = await resolvePinnedRelease(store, config.harness.release, config.schemaVersion);
  if (release.digest !== plan.target.releaseDigest) throw new Error('Resolved target release digest does not match migration plan.');
  const missingDirectories = await verifyRequiredDirectories(projectRoot, config);
  if (missingDirectories.length > 0) {
    throw new Error(`Doctor-equivalent required paths are missing: ${missingDirectories.join(', ')}`);
  }
  const preservedFailures = await verifyPreservedPaths(plan);
  if (preservedFailures.length > 0) {
    throw new Error(`Project-owned/customized paths changed unexpectedly: ${preservedFailures.join(', ')}`);
  }
  const inspection = await inspectProject(projectRoot);
  if (path.basename(checkpointRoot) !== plan.migrationId || !(await exists(checkpointRoot))) {
    throw new Error('Current migration checkpoint identity cannot be proven during final verification.');
  }
  if (inspection.state !== 'migration-in-progress' || inspection.legacy !== null) {
    throw new Error(
      `Post-migration target is not thin-ready while checkpoint is active: ${inspection.state}.`,
    );
  }
  return {
    config: 'PASS',
    release: 'PASS',
    pathBoundaries: 'PASS',
    requiredDirectories: 'PASS',
    preservedArtifacts: 'PASS',
    legacyControlPlaneRetired: 'PASS',
    checkpointState: inspection.state,
    expectedStateAfterCheckpointRemoval: 'thin-harness-current',
  };
}

function buildMigrationReport(plan: MigrationPlan, verification: Readonly<Record<string, unknown>>): string {
  const preserved = plan.operations.filter((operation) => operation.kind === 'PRESERVE').map((operation) => operation.path);
  const deleted = plan.operations.filter((operation) => operation.kind === 'DELETE_HARNESS_OWNED_CLEAN').map((operation) => operation.path);
  const transformed = plan.operations.filter((operation) => operation.kind === 'TRANSFORM' || operation.kind === 'REPLACE_GENERATED_BLOCK').map((operation) => operation.path);
  return [
    `# Migration Report — ${plan.migrationId}`,
    '',
    '## Result',
    '',
    '- status: PASS',
    `- source release: ${plan.source.legacyRelease ?? 'unknown'}`,
    `- source baseline: ${plan.source.baseline?.repository ?? 'unknown'}@${plan.source.baseline?.ref ?? 'unknown'} (${plan.source.baseline?.commit ?? 'unknown'})`,
    `- target release: ${plan.target.harnessRelease ?? 'unknown'}`,
    `- target schema: ${plan.target.projectSchemaVersion}`,
    `- generated at: ${new Date().toISOString()}`,
    '',
    '## Verification',
    '',
    '```json',
    JSON.stringify(verification, null, 2),
    '```',
    '',
    '## Transformed paths',
    '',
    transformed.length ? transformed.map((item) => `- \`${item}\``).join('\n') : '—',
    '',
    '## Retired legacy paths',
    '',
    deleted.length ? deleted.map((item) => `- \`${item}\``).join('\n') : '—',
    '',
    '## Preserved project/customized paths',
    '',
    preserved.length ? preserved.map((item) => `- \`${item}\``).join('\n') : '—',
    '',
    '## Manual follow-up',
    '',
    '- Review the Git diff before committing the migration.',
    '- Historical project-owned reports and runtime-specific project configuration were preserved.',
    '',
  ].join('\n');
}

function reportHandler(store: ReleaseStore): MigrationOperationHandler {
  return {
    async apply(context): Promise<MigrationOperationPostcondition> {
      if (context.operation.strategy !== 'write-final-migration-report-after-verification') {
        throw new Error(`Unsupported CREATE strategy: ${context.operation.strategy}`);
      }
      const verification = await verifyLegacyThinResult(context.plan, store, context.checkpoint.root);
      const report = buildMigrationReport(context.plan, verification);
      const target = safeProjectPath(context.projectRoot, context.operation.path);
      await mkdir(path.dirname(target), { recursive: true });
      await atomicWriteText(target, report);
      return { sha256: sha256(report), verification: 'PASS' };
    },
    async verify(context, postcondition): Promise<boolean> {
      return postcondition.verification === 'PASS' && typeof postcondition.sha256 === 'string' &&
        (await fileSha256(safeProjectPath(context.projectRoot, context.operation.path))) === postcondition.sha256;
    },
  };
}

export function legacyThinOperationHandlers(store: ReleaseStore): MigrationOperationHandlers {
  return {
    TRANSFORM: transformHandler(),
    REPLACE_GENERATED_BLOCK: replaceBootstrapHandler(),
    DELETE_HARNESS_OWNED_CLEAN: deleteCleanHandler(),
    MIGRATE_LOCAL_STATE: migrateLocalStateHandler(),
    CREATE: reportHandler(store),
  };
}

function assertPreparedLegacyThinPlan(plan: MigrationPlan): void {
  if (
    plan.schemaVersion !== 1 ||
    plan.status !== 'ready' ||
    plan.blockers.length !== 0 ||
    plan.source.projectRoot === null ||
    plan.target.harnessRelease === null ||
    plan.target.releaseDigest === null
  ) {
    throw new Error('Legacy thin migration requires a ready prepared plan with verified target identity.');
  }

  const preparedStrategies = new Set([
    'legacy-manifest-to-thin-config',
    'thin-agents-bootstrap-preserve-project-blocks',
    'thin-claude-adapter-preserve-project-content',
  ]);

  for (const operation of plan.operations) {
    if (!preparedStrategies.has(operation.strategy)) continue;
    const content = operation.targetDescriptor?.content;
    const digest = operation.targetDescriptor?.sha256;
    if (
      typeof content !== 'string' ||
      typeof digest !== 'string' ||
      digest !== sha256(content)
    ) {
      throw new Error(
        `Migration operation ${operation.id} is missing an immutable prepared target descriptor.`,
      );
    }
  }
}

export type LegacyThinMigrationExecution =
  | { status: 'already-migrated'; mutations: 0; projectRoot: string }
  | MigrationExecutionResult;

export async function executeLegacyThinMigration(
  preparation: LegacyThinPreparation,
  dependencies: MigrationExecutorDependencies = {},
): Promise<LegacyThinMigrationExecution> {
  if (preparation.status === 'already-migrated') {
    return { status: 'already-migrated', mutations: 0, projectRoot: preparation.projectRoot };
  }
  if (preparation.status === 'blocked') throw new Error('Legacy thin migration plan is blocked.');
  assertPreparedLegacyThinPlan(preparation.plan);
  const store = dependencies.releaseStore ?? new ReleaseStore();
  const result = await executeMigration(preparation.plan, {
    ...dependencies,
    releaseStore: store,
    handlers: { ...legacyThinOperationHandlers(store), ...(dependencies.handlers ?? {}) },
  });
  const finalInspection = await inspectProject(preparation.plan.source.projectRoot ?? '');
  if (finalInspection.state !== 'thin-harness-current') {
    throw new Error(
      `Migration completed but final project state is ${finalInspection.state}, expected thin-harness-current.`,
    );
  }
  return result;
}


export async function resumeLegacyThinMigration(
  projectRoot: string,
  migrationId: string,
  dependencies: MigrationExecutorDependencies = {},
): Promise<MigrationExecutionResult> {
  const store = dependencies.releaseStore ?? new ReleaseStore();
  const result = await resumeMigration(projectRoot, migrationId, {
    ...dependencies,
    releaseStore: store,
    handlers: { ...legacyThinOperationHandlers(store), ...(dependencies.handlers ?? {}) },
  });
  const finalInspection = await inspectProject(projectRoot);
  if (finalInspection.state !== 'thin-harness-current') {
    throw new Error(
      `Migration resumed but final project state is ${finalInspection.state}, expected thin-harness-current.`,
    );
  }
  return result;
}
