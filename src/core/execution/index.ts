export { ExecutionStateError } from './errors.js';
export {
  captureIntentBasis,
  intentResumeBlocker,
} from './intent.js';
export {
  beginCommand,
  blockExecution,
  completeCurrent,
  currentExecution,
  emptyExecutionState,
  findCompleted,
  readExecutionState,
  resolveRoot,
  startExecution,
  unresolvedExecutionFacts,
  unresolvedExecutions,
} from './service.js';
export {
  executionStatePath,
  loadExecutionState,
  saveExecutionState,
  validateExecutionState,
} from './storage.js';
export {
  EXECUTION_STATE_SCHEMA_VERSION,
  INTENT_BASIS_SCHEMA_VERSION,
  MAX_DETAILS_BYTES,
  MAX_INTENT_BASIS_BYTES,
  MAX_PROGRESS_SAMPLES,
  RECENT_TERMINAL_LIMIT,
} from './types.js';
export type {
  CommandResult,
  CommandStatus,
  ExecutionCommandContext,
  ExecutionCurrent,
  ExecutionMode,
  ExecutionRecord,
  ExecutionResolution,
  ExecutionState,
  ExecutionStatus,
  IntentBasisV1,
  StepRecoveryBaseline,
  TerminalExecution,
} from './types.js';
