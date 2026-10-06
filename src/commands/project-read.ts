import { findGitRoot } from '../core/git.js';
import { unresolvedExecutionFacts } from '../core/execution/index.js';
import { createPlanningProjectProviders } from '../core/planning/index.js';
import {
  projectStatus,
  resolveStepNext,
  stepList,
  stepShow,
  type ProjectReadModelProviders,
} from '../core/project/index.js';
import { parseCanonicalCommand } from '../core/protocol/index.js';
import { stepCompletionProof } from '../core/review/index.js';
import {
  CliPresentationError,
  jsonFailure,
  jsonSuccess,
  setCliExitCode,
  writeJson,
  type CliFailureKind,
} from './presentation.js';

export interface ProjectReadCommandOptions {
  readonly json?: boolean;
}

export type ProjectReadProvidersFactory = (projectRoot: string) => ProjectReadModelProviders;

export const defaultProjectReadProviders: ProjectReadProvidersFactory = (projectRoot) => {
  const planning = createPlanningProjectProviders(projectRoot, {
    completion: (stepId) => stepCompletionProof(projectRoot, stepId),
  });
  return {
    ...planning,
    unresolvedExecutions: () => unresolvedExecutionFacts(projectRoot),
  };
};

async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    return await findGitRoot(cwd);
  } catch (error) {
    throw new CliPresentationError(
      'PROJECT_NOT_GIT_REPOSITORY',
      'environment',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeStepTarget(rawStepId: string): string {
  const parsed = parseCanonicalCommand(`STEP SHOW ${rawStepId}`);
  if (!parsed.valid || parsed.domain !== 'STEP' || parsed.operation !== 'SHOW' || !parsed.target) {
    throw new CliPresentationError(
      'STEP_TARGET_INVALID',
      'input',
      `Invalid STEP target: ${rawStepId}. Expected STEP-NNN or NNN.`,
      parsed.valid ? { rawStepId } : {
        rawStepId,
        parserCode: parsed.code,
        parserMessage: parsed.message,
      },
    );
  }
  return parsed.target;
}

function normalizeReadError(error: unknown): CliPresentationError {
  if (error instanceof CliPresentationError) return error;
  return new CliPresentationError(
    'PROJECT_READ_FAILED',
    'internal',
    error instanceof Error ? error.message : String(error),
  );
}

function writeFailure(
  error: CliPresentationError,
  json: boolean,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  if (json) {
    writeJson(jsonFailure(error.category, error, { fields }));
  } else {
    console.error(`${error.code}: ${error.message}`);
  }
  setCliExitCode(error.category);
}

function blockedError(
  code: string,
  message: string,
  result: Readonly<Record<string, unknown>>,
): CliPresentationError {
  return new CliPresentationError(code, 'blocked', message, {
    reasonCode: result.reasonCode ?? null,
  });
}

export function renderProjectStatusHuman(result: Readonly<Record<string, unknown>>): string {
  const summary = (result.summary ?? {}) as Record<string, unknown>;
  return [
    `Status: ${String(result.status)}`,
    `STEPs: ${String(summary.total ?? 0)}`,
    `Stale plans: ${String(summary.stalePlans ?? 0)}`,
    `In progress: ${Array.isArray(result.inProgress) ? result.inProgress.length : 0}`,
    `Blocked: ${Array.isArray(result.blocked) ? result.blocked.length : 0}`,
  ].join('\n');
}

export function renderStepListHuman(result: Readonly<Record<string, unknown>>): string {
  const steps = Array.isArray(result.steps) ? result.steps as Array<Record<string, unknown>> : [];
  if (steps.length === 0) return 'No STEP artifacts found.';
  return steps.map((step) =>
    [
      String(step.id),
      String(step.status ?? '-'),
      String(step.priority ?? '-'),
      String(step.planFreshness ?? '-'),
      String(step.title ?? ''),
    ].join('\t')
  ).join('\n');
}

export function renderStepShowHuman(result: Readonly<Record<string, unknown>>): string {
  const step = (result.step ?? {}) as Record<string, unknown>;
  const dependencies = Array.isArray(step.dependencies)
    ? (step.dependencies as Array<Record<string, unknown>>).map((item) => String(item.id)).join(', ')
    : '';
  return [
    `STEP: ${String(step.id ?? '-')}`,
    `Title: ${String(step.title ?? '')}`,
    `Status: ${String(step.status ?? '-')}`,
    `Priority: ${String(step.priority ?? '-')}`,
    `Phase: ${String(step.phase ?? '-')}`,
    `Plan freshness: ${String(((step.planFreshness ?? {}) as Record<string, unknown>).status ?? '-')}`,
    `Dependencies: ${dependencies || '-'}`,
    `Path: ${String(step.path ?? '-')}`,
  ].join('\n');
}

export function renderStepNextHuman(result: Readonly<Record<string, unknown>>): string {
  const selected = (result.selected ?? {}) as Record<string, unknown>;
  return [
    `Status: ${String(result.status)}`,
    `Command: ${String(result.command ?? '-')}`,
    `STEP: ${String(selected.stepId ?? '-')}`,
    `Reason: ${String(result.reasonCode ?? '-')}`,
    `Eligible: ${String(result.eligibleCount ?? 0)}`,
    `Blocked candidates: ${String(result.blockedCount ?? 0)}`,
  ].join('\n');
}

export async function projectStatusCommand(
  cwd: string,
  options: ProjectReadCommandOptions = {},
  createProviders: ProjectReadProvidersFactory = defaultProjectReadProviders,
): Promise<void> {
  try {
    const root = await resolveProjectRoot(cwd);
    const result = await projectStatus(root, createProviders(root));

    if (result.status !== 'PASS') {
      const error = blockedError(
        'PROJECT_STATUS_BLOCKED',
        'Project status cannot be derived from the current canonical artifacts.',
        result,
      );
      if (options.json) writeJson(jsonFailure('blocked', error, { fields: result }));
      else console.log(renderProjectStatusHuman(result));
      setCliExitCode('blocked');
      return;
    }

    if (options.json) writeJson(jsonSuccess(result));
    else console.log(renderProjectStatusHuman(result));
  } catch (error) {
    writeFailure(normalizeReadError(error), options.json ?? false);
  }
}

export async function stepListCommand(
  cwd: string,
  options: ProjectReadCommandOptions = {},
  createProviders: ProjectReadProvidersFactory = defaultProjectReadProviders,
): Promise<void> {
  try {
    const root = await resolveProjectRoot(cwd);
    const result = await stepList(root, createProviders(root));

    if (result.status !== 'PASS') {
      const error = blockedError(
        'STEP_LIST_BLOCKED',
        'STEP list cannot be derived from the current canonical artifacts.',
        result,
      );
      if (options.json) writeJson(jsonFailure('blocked', error, { fields: result }));
      else console.log(renderStepListHuman(result));
      setCliExitCode('blocked');
      return;
    }

    if (options.json) writeJson(jsonSuccess(result));
    else console.log(renderStepListHuman(result));
  } catch (error) {
    writeFailure(normalizeReadError(error), options.json ?? false);
  }
}

export async function stepShowCommand(
  cwd: string,
  rawStepId: string,
  options: ProjectReadCommandOptions = {},
  createProviders: ProjectReadProvidersFactory = defaultProjectReadProviders,
): Promise<void> {
  try {
    const stepId = normalizeStepTarget(rawStepId);
    const root = await resolveProjectRoot(cwd);
    const result = await stepShow(root, stepId, createProviders(root));

    if (result.status !== 'PASS') {
      const error = new CliPresentationError(
        String(result.reasonCode ?? 'STEP_NOT_FOUND'),
        'input',
        `STEP does not exist: ${stepId}.`,
        { stepId },
      );
      writeFailure(error, options.json ?? false, result);
      return;
    }

    if (options.json) writeJson(jsonSuccess(result));
    else console.log(renderStepShowHuman(result));
  } catch (error) {
    writeFailure(normalizeReadError(error), options.json ?? false);
  }
}

export async function stepNextCommand(
  cwd: string,
  options: ProjectReadCommandOptions = {},
  createProviders: ProjectReadProvidersFactory = defaultProjectReadProviders,
): Promise<void> {
  try {
    const root = await resolveProjectRoot(cwd);
    const result = await resolveStepNext(root, createProviders(root));

    if (result.status !== 'PASS') {
      const error = blockedError(
        String(result.reasonCode ?? 'STEP_NEXT_BLOCKED'),
        'No executable STEP can be recommended from the current project state.',
        result,
      );
      if (options.json) writeJson(jsonFailure('blocked', error, { fields: result }));
      else console.log([
        `Status: ${String(result.status)}`,
        `Reason: ${String(result.reasonCode ?? '-')}`,
      ].join('\n'));
      setCliExitCode('blocked');
      return;
    }

    if (options.json) writeJson(jsonSuccess(result));
    else console.log(renderStepNextHuman(result));
  } catch (error) {
    writeFailure(normalizeReadError(error), options.json ?? false);
  }
}
