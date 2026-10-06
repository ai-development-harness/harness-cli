import {
  DEFAULT_GIT_WORKFLOW_POLICY,
  GitActionError,
  GitActionService,
  type GitCheckReport,
} from '../core/git-actions/index.js';
import { findGitRoot } from '../core/git.js';
import { ReadOnlyLocalGitPort } from '../infrastructure/read-only-local-git.js';
import {
  CliPresentationError,
  jsonFailure,
  jsonSuccess,
  setCliExitCode,
  writeJson,
} from './presentation.js';

export interface GitCheckCommandOptions {
  readonly json?: boolean;
}

export type GitCheckServiceFactory = (projectRoot: string) => Pick<GitActionService, 'diagnose'>;

const defaultServiceFactory: GitCheckServiceFactory = (projectRoot) =>
  new GitActionService({
    projectRoot,
    git: new ReadOnlyLocalGitPort(projectRoot),
    policy: DEFAULT_GIT_WORKFLOW_POLICY,
  });

function normalizeGitCheckError(error: unknown): CliPresentationError {
  if (error instanceof CliPresentationError) return error;
  if (error instanceof GitActionError) {
    return new CliPresentationError(
      error.code,
      'blocked',
      error.message,
      error.details,
    );
  }
  return new CliPresentationError(
    'GIT_CHECK_FAILED',
    'internal',
    error instanceof Error ? error.message : String(error),
  );
}

export function renderGitCheckHuman(report: GitCheckReport): string {
  const dirty =
    report.worktree.staged.length +
    report.worktree.unstaged.length +
    report.worktree.untracked.length;

  const lines = [
    `Status: ${report.status}`,
    `Branch: ${report.branch}${report.protected ? ' (protected)' : ''}`,
    `HEAD: ${report.head ?? '-'}`,
    `Remote: ${report.configured.pushRemote}`,
    `Remote HEAD: ${report.relation.remoteHead ?? '-'}`,
    `Ahead/behind: ${report.relation.ahead}/${report.relation.behind}`,
    `Upstream: ${report.relation.upstream ?? '-'}`,
    `Worktree changes: ${dirty}`,
  ];

  if (report.observations.length > 0) {
    lines.push('Observations:');
    for (const item of report.observations) {
      lines.push(`- ${item.code}: ${item.message}`);
    }
  }

  lines.push('Preconditions:');
  for (const item of report.preconditions) {
    lines.push(
      item.status === 'READY'
        ? `- ${item.action}: READY`
        : `- ${item.action}: BLOCKED (${item.reasonCode ?? 'unknown'})`,
    );
  }

  return lines.join('\n');
}

export async function gitCheckCommand(
  cwd: string,
  options: GitCheckCommandOptions = {},
  createService: GitCheckServiceFactory = defaultServiceFactory,
): Promise<void> {
  let projectRoot: string;
  try {
    projectRoot = await findGitRoot(cwd);
  } catch (error) {
    const normalized = new CliPresentationError(
      'PROJECT_NOT_GIT_REPOSITORY',
      'environment',
      error instanceof Error ? error.message : String(error),
    );
    if (options.json) writeJson(jsonFailure('environment', normalized));
    else console.error(`${normalized.code}: ${normalized.message}`);
    setCliExitCode('environment');
    return;
  }

  try {
    const report = await createService(projectRoot).diagnose();
    if (options.json) writeJson(jsonSuccess(report));
    else console.log(renderGitCheckHuman(report));
  } catch (error) {
    const normalized = normalizeGitCheckError(error);
    if (options.json) writeJson(jsonFailure(normalized.category, normalized));
    else console.error(`${normalized.code}: ${normalized.message}`);
    setCliExitCode(normalized.category);
  }
}
