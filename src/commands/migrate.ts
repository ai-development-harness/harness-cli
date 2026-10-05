import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findGitRoot, harnessStatePath } from '../core/git.js';
import {
  executeLegacyThinMigration,
  inspectMigrationCheckpoint,
  inspectProject,
  isMigrationExecutionError,
  prepareLegacyThinMigration,
  resumeLegacyThinMigration,
  serializeMigrationPlan,
  type MigrationPlan,
  type MigrationPlannerOptions,
} from '../core/migration/index.js';

interface MigrationCliOptions {
  json?: boolean;
  from?: string;
  targetRelease?: string;
  out?: string;
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function errorPayload(error: unknown): {
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
} {
  if (isMigrationExecutionError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'MIGRATION_ERROR',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function handleError(error: unknown, json: boolean): void {
  const payload = errorPayload(error);
  if (json) {
    writeJson({ ok: false, error: payload });
  } else {
    console.error(`${payload.code}: ${payload.message}`);
    if (Object.keys(payload.details).length > 0) {
      console.error(JSON.stringify(payload.details, null, 2));
    }
  }
  process.exitCode = 1;
}

function plannerOptions(options: MigrationCliOptions): MigrationPlannerOptions {
  return {
    ...(options.from ? { fromRelease: options.from } : {}),
    ...(options.targetRelease ? { targetRelease: options.targetRelease } : {}),
  };
}

async function savePlan(cwd: string, output: string, plan: MigrationPlan): Promise<string> {
  const target = path.resolve(cwd, output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serializeMigrationPlan(plan), { encoding: 'utf8', flag: 'wx' });
  return target;
}

function parseSavedPlan(raw: string): MigrationPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Saved migration plan is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Saved migration plan must be a JSON object.');
  }
  const plan = value as Partial<MigrationPlan>;
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.migrationId !== 'string' ||
    plan.status !== 'ready' ||
    !Array.isArray(plan.operations) ||
    !Array.isArray(plan.blockers) ||
    plan.blockers.length !== 0 ||
    typeof plan.source !== 'object' ||
    plan.source === null ||
    typeof plan.target !== 'object' ||
    plan.target === null ||
    typeof plan.preconditions !== 'object' ||
    plan.preconditions === null
  ) {
    throw new Error('Saved migration plan is not an executable prepared plan.');
  }
  return plan as MigrationPlan;
}

async function loadSavedPlan(cwd: string, planPath: string): Promise<{ path: string; plan: MigrationPlan }> {
  const resolved = path.resolve(cwd, planPath);
  const raw = await readFile(resolved, 'utf8');
  return { path: resolved, plan: parseSavedPlan(raw) };
}

function printInspectionHuman(inspection: Awaited<ReturnType<typeof inspectProject>>): void {
  console.log(`State: ${inspection.state}`);
  console.log(`Project: ${inspection.projectRoot ?? 'n/a'}`);
  console.log(`Legacy release: ${inspection.legacy?.release ?? 'n/a'}`);
  console.log(`Baseline: ${inspection.baseline ? `${inspection.baseline.sourceRef} @ ${inspection.baseline.sourceCommit}` : 'n/a'}`);
  console.log(`Tracked files: ${inspection.trackedFiles.length}`);
  console.log(`Dirty tracked paths: ${inspection.dirtyTrackedPaths.length}`);
  console.log(`Relevant untracked collisions: ${inspection.relevantUntrackedCollisions.length}`);
  for (const diagnostic of inspection.diagnostics) {
    console.log(`${diagnostic.severity === 'blocker' ? 'BLOCKER' : 'WARNING'} ${diagnostic.code}: ${diagnostic.message}`);
  }
}

export async function migrationInspectCommand(
  cwd: string,
  options: MigrationCliOptions = {},
): Promise<void> {
  try {
    const inspection = await inspectProject(cwd, { fromRelease: options.from });
    if (options.json) {
      writeJson({ ok: true, inspection });
      return;
    }
    printInspectionHuman(inspection);
  } catch (error) {
    handleError(error, options.json ?? false);
  }
}

export async function migrationPlanCommand(
  cwd: string,
  options: MigrationCliOptions = {},
): Promise<void> {
  try {
    const preparation = await prepareLegacyThinMigration(cwd, plannerOptions(options));

    if (preparation.status === 'already-migrated') {
      const output = {
        ok: true,
        status: 'already-migrated',
        projectRoot: preparation.projectRoot,
        mutations: 0,
      };
      if (options.json) writeJson(output);
      else console.log(`Already migrated: ${preparation.projectRoot}`);
      return;
    }

    let savedPlan: string | null = null;
    if (options.out) {
      if (preparation.status !== 'ready') {
        throw new Error('Blocked migration plans are not persisted as executable Apply input.');
      }
      savedPlan = await savePlan(cwd, options.out, preparation.plan);
    }

    if (options.json) {
      writeJson({
        ok: preparation.status === 'ready',
        status: preparation.status,
        plan: preparation.plan,
        savedPlan,
      });
    } else {
      console.log(`Migration: ${preparation.plan.migrationId}`);
      console.log(`Status: ${preparation.status}`);
      console.log(`Operations: ${preparation.plan.operations.length}`);
      console.log(`Blockers: ${preparation.plan.blockers.length}`);
      for (const blocker of preparation.plan.blockers) {
        console.log(`BLOCKER ${blocker.code}: ${blocker.message}`);
      }
      if (savedPlan) console.log(`Saved plan: ${savedPlan}`);
      if (!savedPlan && preparation.status === 'ready') {
        console.log('Dry-run only. Use --out <file> to persist the exact prepared plan for apply.');
      }
    }

    if (preparation.status === 'blocked') process.exitCode = 2;
  } catch (error) {
    handleError(error, options.json ?? false);
  }
}

export async function migrationApplyCommand(
  cwd: string,
  planPath: string,
  json = false,
): Promise<void> {
  try {
    const saved = await loadSavedPlan(cwd, planPath);
    const result = await executeLegacyThinMigration({ status: 'ready', plan: saved.plan });
    if (json) {
      writeJson({ ok: true, status: result.status, planPath: saved.path, result });
      return;
    }
    console.log(`Migration ${saved.plan.migrationId}: ${result.status}`);
    console.log(`Plan: ${saved.path}`);
    if ('verifiedOperations' in result) {
      console.log(`Verified operations: ${result.verifiedOperations}`);
    }
  } catch (error) {
    handleError(error, json);
  }
}

export async function migrationResumeCommand(
  cwd: string,
  migrationId: string,
  json = false,
): Promise<void> {
  try {
    const root = await findGitRoot(cwd);
    const result = await resumeLegacyThinMigration(root, migrationId);
    if (json) {
      writeJson({ ok: true, status: result.status, result });
      return;
    }
    console.log(`Migration ${migrationId}: ${result.status}`);
    console.log(`Verified operations: ${result.verifiedOperations}`);
  } catch (error) {
    handleError(error, json);
  }
}

interface CheckpointDiagnostic {
  migrationId: string;
  ok: boolean;
  state?: string;
  updatedAt?: string;
  recovery?: unknown;
  operations?: Readonly<Record<string, number>>;
  error?: ReturnType<typeof errorPayload>;
}

function operationCounts(statuses: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

async function checkpointDiagnostic(projectRoot: string, migrationId: string): Promise<CheckpointDiagnostic> {
  try {
    const checkpoint = await inspectMigrationCheckpoint(projectRoot, migrationId);
    return {
      migrationId,
      ok: true,
      state: checkpoint.journal.state,
      updatedAt: checkpoint.journal.updatedAt,
      recovery: checkpoint.journal.recovery,
      operations: operationCounts(checkpoint.journal.operations.map((operation) => operation.status)),
    };
  } catch (error) {
    return { migrationId, ok: false, error: errorPayload(error) };
  }
}

async function checkpointIds(projectRoot: string): Promise<string[]> {
  const root = path.join(await harnessStatePath(projectRoot), 'migrations');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function migrationStatusCommand(
  cwd: string,
  migrationId: string | undefined,
  json = false,
): Promise<void> {
  try {
    const root = await findGitRoot(cwd);
    const ids = migrationId ? [migrationId] : await checkpointIds(root);
    const checkpoints = await Promise.all(ids.map((id) => checkpointDiagnostic(root, id)));

    if (json) {
      writeJson({ ok: true, projectRoot: root, checkpoints });
      return;
    }

    if (checkpoints.length === 0) {
      console.log('No migration checkpoints.');
      return;
    }

    for (const checkpoint of checkpoints) {
      if (!checkpoint.ok) {
        console.log(`${checkpoint.migrationId}\tERROR\t${checkpoint.error?.code}: ${checkpoint.error?.message}`);
        continue;
      }
      console.log(`${checkpoint.migrationId}\t${checkpoint.state}\t${checkpoint.updatedAt}`);
      if (checkpoint.recovery) console.log(JSON.stringify(checkpoint.recovery, null, 2));
    }
  } catch (error) {
    handleError(error, json);
  }
}
