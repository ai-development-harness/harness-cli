import type { Readable } from 'node:stream';
import { findGitRoot } from '../core/git.js';
import {
  isCoreHostError,
  loadPinnedCore,
  type CoreHostPortRequestV1,
  type CoreHostPortV1,
} from '../core/host/index.js';
import { isReleaseError } from '../core/releases/errors.js';
import {
  CliPresentationError,
  jsonFailure,
  setCliExitCode,
  writeJson,
  type CliFailureKind,
} from './presentation.js';

const MAX_MACHINE_REQUEST_BYTES = 1024 * 1024;

const inertPort: CoreHostPortV1 = Object.freeze({
  async call(request: CoreHostPortRequestV1) {
    throw new Error(
      `Host port operation is unavailable for protocol machine transport: ${request.operation}`,
    );
  },
});

function loaderError(error: unknown): CliPresentationError {
  if (isReleaseError(error)) {
    return new CliPresentationError(
      error.code,
      'environment',
      error.message,
      error.details,
    );
  }
  if (isCoreHostError(error)) {
    const category: CliFailureKind =
      error.code === 'CORE_PROJECT_ROOT_INVALID' || error.code === 'CORE_PORTS_INVALID'
        ? 'environment'
        : 'failure';
    return new CliPresentationError(error.code, category, error.message, error.details);
  }
  return new CliPresentationError(
    'PROTOCOL_MACHINE_FAILED',
    'internal',
    error instanceof Error ? error.message : String(error),
  );
}

function hostFailureCategory(code: string): CliFailureKind {
  if (code === 'CORE_INVALID_REQUEST' || code === 'EXTERNAL_REQUEST_INVALID') return 'input';
  return 'failure';
}

function engineBlocked(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.kind === 'blocked' && item.status === 'BLOCKED';
}

export async function readProtocolMachineRequest(
  input: Readable = process.stdin,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    total += bytes.byteLength;
    if (total > MAX_MACHINE_REQUEST_BYTES) {
      throw new CliPresentationError(
        'PROTOCOL_MACHINE_REQUEST_TOO_LARGE',
        'input',
        `Protocol machine request exceeds ${MAX_MACHINE_REQUEST_BYTES} bytes.`,
        { maxBytes: MAX_MACHINE_REQUEST_BYTES },
      );
    }
    chunks.push(bytes);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new CliPresentationError(
      'PROTOCOL_MACHINE_REQUEST_EMPTY',
      'input',
      'Protocol machine expects one JSON request on stdin.',
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliPresentationError(
      'PROTOCOL_MACHINE_INVALID_JSON',
      'input',
      'Protocol machine stdin is not valid JSON.',
      { cause: (error as Error).message },
    );
  }
}

export async function protocolMachineCommand(
  cwd: string,
  input?: unknown,
): Promise<void> {
  try {
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

    const request = input === undefined
      ? await readProtocolMachineRequest()
      : input;

    const host = await loadPinnedCore({
      projectRoot,
      ports: {
        filesystem: inertPort,
        git: inertPort,
        storage: inertPort,
      },
    });

    const result = await host.invoke('protocol/external-call', request);
    writeJson(result);

    if (!result.ok) {
      setCliExitCode(hostFailureCategory(result.error.code));
      return;
    }
    if (engineBlocked(result.result)) {
      setCliExitCode('blocked');
    }
  } catch (error) {
    const normalized = error instanceof CliPresentationError
      ? error
      : loaderError(error);
    writeJson(jsonFailure(normalized.category, normalized));
    setCliExitCode(normalized.category);
  }
}
