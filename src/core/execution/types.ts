import type { ProgressTelemetry, ReviewExpectationV1 } from '../review/types.js';

export const EXECUTION_STATE_SCHEMA_VERSION = 2 as const;
export const INTENT_BASIS_SCHEMA_VERSION = 1 as const;
export const RECENT_TERMINAL_LIMIT = 100;
export const MAX_DETAILS_BYTES = 16 * 1024;
export const MAX_INTENT_BASIS_BYTES = 16 * 1024;
export const MAX_PROGRESS_SAMPLES = 8;

export type ExecutionMode = 'single' | 'chain' | 'orchestration';
export type ExecutionStatus = 'running' | 'complete' | 'blocked';
export type CommandStatus = 'running' | 'complete' | 'blocked';
export type CommandResult = 'SUCCESS' | 'PASS' | 'FAIL' | 'BLOCKED';

export interface IntentBasisV1 {
  readonly schemaVersion: 1;
  readonly stepId: string;
  readonly command: string;
  readonly operation: 'PLAN' | 'IMPLEMENT' | 'REVIEW' | 'FIX';
  readonly contextBasis: string;
  readonly contextComponents: readonly string[];
  readonly planContentRequired: boolean;
  readonly planContentHash: string | null;
  readonly planRevision: number | null;
  readonly capturedAt: string;
}

export interface StepRecoveryBaseline {
  readonly stepId: string;
  readonly gitHead: string;
  readonly capturedAt: string;
  readonly sourceExecutionId: string;
}

export interface ExecutionCommandContext {
  readonly intentBasis?: IntentBasisV1;
  readonly intentBasisError?: Readonly<{
    reasonCode: 'INTENT_BASIS_UNAVAILABLE';
    message: string;
  }>;
  readonly implementationBaseline?: StepRecoveryBaseline;
  readonly reviewExpectation?: ReviewExpectationV1;
  readonly reviewExpectationError?: Readonly<{
    reasonCode: 'REVIEW_EXPECTATION_UNAVAILABLE';
    message: string;
  }>;
  readonly progress?: ProgressTelemetry;
}

export interface ExecutionCurrent {
  command: string;
  status: CommandStatus;
  result: CommandResult | null;
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  context: ExecutionCommandContext;
  details?: Readonly<Record<string, unknown>>;
}

export interface ExecutionRecord {
  readonly executionId: string;
  readonly ordinal: number;
  readonly mode: ExecutionMode;
  readonly requestedCommand: string;
  readonly rootCommand: string;
  readonly sequence: readonly string[];
  currentIndex: number | null;
  status: ExecutionStatus;
  current: ExecutionCurrent;
  notExecuted: string[];
  fixReviewCycles: number;
  readonly maxFixReviewCycles: number;
  readonly startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  blockedBy?: Readonly<Record<string, unknown>>;
}

export interface TerminalExecution {
  readonly executionId: string;
  readonly ordinal: number;
  readonly rootCommand: string;
  readonly mode: ExecutionMode;
  readonly status: 'complete' | 'blocked';
  readonly current: Readonly<{
    command: string;
    status: CommandStatus;
    result: CommandResult | null;
    completedAt: string | null;
    details?: Readonly<Record<string, unknown>>;
  }>;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface ExecutionState {
  readonly schemaVersion: 2;
  executions: ExecutionRecord[];
  stepRecovery: Record<string, StepRecoveryBaseline>;
  recentTerminals: TerminalExecution[];
  nextOrdinal: number;
}

export interface ExecutionResolution {
  readonly status: 'RESUME' | 'NEXT' | 'DONE' | 'BLOCKED' | 'NOT_FOUND';
  readonly executionId?: string;
  readonly rootCommand?: string;
  readonly command: string | null;
  readonly reasonCode: string;
  readonly remediation?: string;
  readonly intent?: Readonly<Record<string, unknown>>;
  readonly fixReviewCycles?: number;
}
