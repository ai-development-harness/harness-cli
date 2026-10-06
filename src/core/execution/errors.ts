export class ExecutionStateError extends Error {
  constructor(
    readonly code:
      | 'EXECUTION_STATE_CORRUPT'
      | 'EXECUTION_NOT_FOUND'
      | 'EXECUTION_INVALID_TRANSITION'
      | 'STALE_SEMANTIC_RESULT'
      | 'INTENT_BASIS_STALE'
      | 'TASK_CONTRACT_CHANGED'
      | 'ARCHITECTURE_BASIS_CHANGED'
      | 'PLAN_BASIS_STALE'
      | 'INTENT_BASIS_MISSING'
      | 'INTENT_BASIS_SCHEMA_UNSUPPORTED'
      | 'INTENT_BASIS_INVALID'
      | 'INTENT_BASIS_UNAVAILABLE',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ExecutionStateError';
  }
}
