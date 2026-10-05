export type CoreHostErrorCode =
  | 'CORE_PROJECT_ROOT_INVALID'
  | 'CORE_PORTS_INVALID'
  | 'CORE_ENTRYPOINT_INVALID'
  | 'CORE_HOST_API_MISMATCH'
  | 'CORE_LOAD_FAILED';

export class CoreHostError extends Error {
  constructor(
    public readonly code: CoreHostErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CoreHostError';
  }
}

export function isCoreHostError(error: unknown): error is CoreHostError {
  return error instanceof CoreHostError;
}
