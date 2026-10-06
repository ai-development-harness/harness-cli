import type { SemanticCompletionIdentityV1 } from './types.js';

export type ExternalCallerRequestV1 =
  | {
      readonly schemaVersion: 1;
      readonly operation: 'start';
      readonly command: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly operation: 'resume';
      readonly rootCommand: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly operation: 'semantic-complete';
      readonly completion: SemanticCompletionIdentityV1;
      readonly proposal: unknown;
    };

export class ExternalCallerRequestError extends Error {
  constructor(
    readonly code: 'EXTERNAL_REQUEST_INVALID',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ExternalCallerRequestError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  operation: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (extras.length > 0) {
    throw new ExternalCallerRequestError(
      'EXTERNAL_REQUEST_INVALID',
      `Unsupported fields for ${operation}: ${extras.join(', ')}.`,
      { operation, unsupportedFields: extras },
    );
  }
}

export function parseExternalCallerRequest(value: unknown): ExternalCallerRequestV1 {
  const input = record(value);
  if (!input || input.schemaVersion !== 1 || !nonEmpty(input.operation)) {
    throw new ExternalCallerRequestError(
      'EXTERNAL_REQUEST_INVALID',
      'External caller request must be a schemaVersion=1 object with an operation.',
    );
  }

  if (input.operation === 'start') {
    exactKeys(input, ['schemaVersion', 'operation', 'command'], 'start');
    if (!nonEmpty(input.command)) {
      throw new ExternalCallerRequestError(
        'EXTERNAL_REQUEST_INVALID',
        'start.command must be a non-empty canonical command string.',
      );
    }
    return {
      schemaVersion: 1,
      operation: 'start',
      command: input.command,
    };
  }

  if (input.operation === 'resume') {
    exactKeys(input, ['schemaVersion', 'operation', 'rootCommand'], 'resume');
    if (!nonEmpty(input.rootCommand)) {
      throw new ExternalCallerRequestError(
        'EXTERNAL_REQUEST_INVALID',
        'resume.rootCommand must be a non-empty canonical root command string.',
      );
    }
    return {
      schemaVersion: 1,
      operation: 'resume',
      rootCommand: input.rootCommand,
    };
  }

  if (input.operation === 'semantic-complete') {
    exactKeys(
      input,
      ['schemaVersion', 'operation', 'completion', 'proposal'],
      'semantic-complete',
    );
    const completion = record(input.completion);
    if (
      !completion ||
      completion.schemaVersion !== 1 ||
      !nonEmpty(completion.executionId) ||
      !nonEmpty(completion.rootCommand) ||
      !nonEmpty(completion.command)
    ) {
      throw new ExternalCallerRequestError(
        'EXTERNAL_REQUEST_INVALID',
        'semantic-complete.completion must contain schemaVersion, executionId, rootCommand and command.',
      );
    }
    exactKeys(
      completion,
      ['schemaVersion', 'executionId', 'rootCommand', 'command'],
      'semantic-complete.completion',
    );
    if (!Object.prototype.hasOwnProperty.call(input, 'proposal')) {
      throw new ExternalCallerRequestError(
        'EXTERNAL_REQUEST_INVALID',
        'semantic-complete.proposal is required.',
      );
    }
    return {
      schemaVersion: 1,
      operation: 'semantic-complete',
      completion: {
        schemaVersion: 1,
        executionId: completion.executionId as string,
        rootCommand: completion.rootCommand as string,
        command: completion.command as string,
      },
      proposal: input.proposal,
    };
  }

  throw new ExternalCallerRequestError(
    'EXTERNAL_REQUEST_INVALID',
    `Unsupported external caller operation: ${input.operation}.`,
    { operation: input.operation },
  );
}
