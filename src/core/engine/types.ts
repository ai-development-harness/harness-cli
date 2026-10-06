import type { ExecutionCommandContext, ExecutionRecord } from '../execution/index.js';
import type { CommandResult, ReasoningMode } from '../protocol/index.js';

export interface EngineCommandIdentity {
  readonly executionId: string;
  readonly rootCommand: string;
  readonly command: string;
  readonly domain: string;
  readonly operation: string;
  readonly target: string | null;
  readonly input: string | null;
}

export interface SemanticCompletionIdentityV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly rootCommand: string;
  readonly command: string;
}

export interface SemanticHandoffV1 extends EngineCommandIdentity {
  readonly schemaVersion: 1;
  readonly kind: 'semantic-handoff';
  readonly requiredSkill: string;
  readonly contextPhase: 'plan' | 'implement' | 'review' | null;
  readonly reasoningMode: Exclude<ReasoningMode, 'none'>;
  readonly context: ExecutionCommandContext;
}

export interface EngineTerminalResult {
  readonly kind: 'terminal';
  readonly status: 'DONE';
  readonly executionId?: string;
  readonly rootCommand: string;
  readonly reasonCode: string;
}

export interface EngineBlockedResult {
  readonly kind: 'blocked';
  readonly status: 'BLOCKED';
  readonly executionId?: string;
  readonly rootCommand: string;
  readonly reasonCode: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ProtocolEngineResult =
  | SemanticHandoffV1
  | EngineTerminalResult
  | EngineBlockedResult;

export interface DeterministicHandlerRequest extends EngineCommandIdentity {
  readonly handler: string;
  readonly context: ExecutionCommandContext;
}

export interface DeterministicHandlerResult {
  readonly result: CommandResult;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimePreconditionRequest extends EngineCommandIdentity {
  readonly precondition: string;
}

export interface RuntimePreconditionResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ConditionalFastPathRequest extends EngineCommandIdentity {
  readonly fastPathId: string;
  readonly context: ExecutionCommandContext;
}

export interface SemanticCommitRequest extends EngineCommandIdentity {
  readonly requiredSkill: string;
  readonly contextPhase: 'plan' | 'implement' | 'review' | null;
  readonly context: ExecutionCommandContext;
  readonly proposal: unknown;
}

export interface ProtocolEnginePorts {
  readonly deterministicHandler: (
    request: DeterministicHandlerRequest,
  ) => Promise<DeterministicHandlerResult>;
  readonly runtimePrecondition?: (
    request: RuntimePreconditionRequest,
  ) => Promise<RuntimePreconditionResult>;
  readonly conditionalFastPath?: (
    request: ConditionalFastPathRequest,
  ) => Promise<DeterministicHandlerResult | null>;
  /**
   * Converts an untrusted semantic proposal into a Core-owned committed result.
   * The semantic runtime never writes execution state directly.
   */
  readonly commitSemanticProposal: (
    request: SemanticCommitRequest,
  ) => Promise<DeterministicHandlerResult>;
}

export interface ProtocolExecutionAdapter {
  readonly startExecution: (projectRoot: string, command: string) => Promise<ExecutionRecord>;
  readonly currentExecution: (
    projectRoot: string,
    rootCommand: string,
  ) => Promise<ExecutionRecord | null>;
  readonly beginCommand: (
    projectRoot: string,
    rootCommand: string,
    command: string,
  ) => Promise<ExecutionRecord>;
  readonly resolveRoot: (
    projectRoot: string,
    rootCommand: string,
    options?: { readonly mutate?: boolean },
  ) => Promise<{
    readonly status: 'RESUME' | 'NEXT' | 'DONE' | 'BLOCKED' | 'NOT_FOUND';
    readonly executionId?: string;
    readonly rootCommand?: string;
    readonly command: string | null;
    readonly reasonCode: string;
    readonly intent?: Readonly<Record<string, unknown>>;
  }>;
  readonly completeCurrent: (
    projectRoot: string,
    rootCommand: string,
    result: CommandResult,
    options?: {
      readonly command?: string;
      readonly expectedExecutionId?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) => Promise<unknown>;
  readonly blockExecution: (
    projectRoot: string,
    rootCommand: string,
    reason: Readonly<Record<string, unknown>>,
    expectedExecutionId?: string,
  ) => Promise<unknown>;
}
