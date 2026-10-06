import YAML from 'yaml';
import { configPath, readConfig, type HarnessConfig } from '../core/config.js';
import { findGitRoot } from '../core/git.js';
import { isPathBoundaryError } from '../core/path-boundary.js';
import {
  CliPresentationError,
  jsonFailure,
  jsonSuccess,
  setCliExitCode,
  writeJson,
  type CliFailureKind,
} from './presentation.js';

export interface ConfigCommandOptions {
  readonly json?: boolean;
}

export interface ConfigView {
  readonly status: 'resolved';
  readonly projectRoot: string;
  readonly source: {
    readonly kind: 'project-file';
    readonly portablePath: 'harness.yaml';
    readonly path: string;
  };
  readonly effective: HarnessConfig;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function configReadError(error: unknown): CliPresentationError {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return new CliPresentationError(
      'CONFIG_MISSING',
      'environment',
      'Harness project configuration does not exist: harness.yaml.',
    );
  }

  if (isPathBoundaryError(error)) {
    return new CliPresentationError(
      'CONFIG_INVALID',
      'input',
      error.message,
      {
        sourceCode: error.code,
        ...error.details,
      },
    );
  }

  return new CliPresentationError(
    'CONFIG_INVALID',
    'input',
    error instanceof Error ? error.message : String(error),
    {
      ...(error instanceof Error ? { sourceError: error.name } : {}),
    },
  );
}

export async function loadConfigView(cwd: string): Promise<ConfigView> {
  let projectRoot: string;
  try {
    projectRoot = await findGitRoot(cwd);
  } catch (error) {
    throw new CliPresentationError(
      'PROJECT_NOT_GIT_REPOSITORY',
      'environment',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const effective = await readConfig(projectRoot);
    return {
      status: 'resolved',
      projectRoot,
      source: {
        kind: 'project-file',
        portablePath: 'harness.yaml',
        path: configPath(projectRoot),
      },
      effective,
    };
  } catch (error) {
    throw configReadError(error);
  }
}

export function renderConfigHuman(view: ConfigView): string {
  return [
    `Project: ${view.projectRoot}`,
    `Config source: ${view.source.path}`,
    'Effective configuration:',
    YAML.stringify(view.effective).trimEnd(),
  ].join('\n');
}

export async function configCommand(
  cwd: string,
  options: ConfigCommandOptions = {},
): Promise<void> {
  try {
    const view = await loadConfigView(cwd);

    if (options.json) {
      writeJson(jsonSuccess(view));
      return;
    }

    console.log(renderConfigHuman(view));
  } catch (error) {
    const normalized = error instanceof CliPresentationError
      ? error
      : new CliPresentationError(
          'CONFIG_READ_FAILED',
          'internal',
          error instanceof Error ? error.message : String(error),
        );
    const category: CliFailureKind = normalized.category;

    if (options.json) {
      writeJson(jsonFailure(category, normalized));
    } else {
      console.error(`${normalized.code}: ${normalized.message}`);
    }
    setCliExitCode(category);
  }
}
