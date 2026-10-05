export type ReleaseErrorCode =
  | 'RELEASE_MISSING'
  | 'RELEASE_CORRUPT'
  | 'RELEASE_IDENTITY_CONFLICT'
  | 'RELEASE_INCOMPATIBLE_CLI'
  | 'RELEASE_INCOMPATIBLE_HOST_API'
  | 'RELEASE_INCOMPATIBLE_PROJECT_SCHEMA'
  | 'PROJECT_SCHEMA_MIGRATION_REQUIRED'
  | 'UNSUPPORTED_RELEASE_FORMAT';

export class ReleaseError extends Error {
  constructor(
    public readonly code: ReleaseErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ReleaseError';
  }
}

export function isReleaseError(error: unknown): error is ReleaseError {
  return error instanceof ReleaseError;
}
