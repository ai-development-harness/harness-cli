export type UpdateErrorCode =
  | 'UPDATE_BLOCKED'
  | 'UPDATE_STATE_CORRUPT'
  | 'UPDATE_STATE_CONFLICT'
  | 'UPDATE_PROJECT_CONFIG_INVALID'
  | 'UPDATE_PIN_CHANGED'
  | 'UPDATE_MIGRATION_FAILED'
  | 'UPDATE_POSTCONDITION_FAILED';

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}
