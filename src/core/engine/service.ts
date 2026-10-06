import {
  beginCommand,
  blockExecution,
  completeCurrent,
  startExecution,
  type ExecutionRecord,
} from '../execution/index.js';
import {
  PROTOCOL_MODEL,
  parseCanonicalCommand,
  validateCommandText,
  type CommandResult,
} from '../protocol/index.js';
import type {
  EngineBlockedResult,
  EngineCommandIdentity,
  ProtocolEnginePorts,
  ProtocolEngineResult,
  ProtocolExecutionAdapter,
  RuntimePreconditionRequest,
  SemanticHandoffV1,
} from './types.js';
import { resolveRoot } from '../execution/index.js';

const DEFAULT_EXECUTION_ADAPTER: ProtocolExecutionAdapter = {
  startExecution,
  beginCommand,
  resolveRoot,
  completeCurrent,
  blockExecution,
};

const MAX_ENGINE_STEPS = 64;

function structuralBlocker(rawCommand: string, code: string, message: string): EngineBlockedResult {
  return {
    kind: 'blocked',
    status: 'BLOCKED',
    rootCommand: rawCommand.trim(),
    reasonCode: code,
    details: { message },
  };
}

function identity(record: ExecutionRecord): EngineCommandIdentity {
  const parsed = parseCanonicalCommand(record.current.command);
  if (!parsed.valid) {
    throw new Error(`Core execution state contains invalid command: ${record.current.command}`);
  }
  return {
    executionId: record.executionId,
    rootCommand: record.rootCommand,
    command: parsed.normalized,
    domain: parsed.domain,
    operation: parsed.operation,
    target: parsed.target,
    input: parsed.input,
  };
}

function commandSpec(record: ExecutionRecord) {
  const parsed = parseCanonicalCommand(record.current.command);
  if (!parsed.valid) throw new Error(parsed.message);
  return PROTOCOL_MODEL.domains[parsed.domain].commands[parsed.operation];
}

function transitionPreconditions(rootCommand: string, currentCommand: string): readonly string[] {
  const validation = validateCommandText(rootCommand);
  if (!validation.valid || validation.code !== 'VALID_CHAIN') return [];
  const index = validation.normalized.indexOf(currentCommand);
  if (index <= 0) return [];
  return validation.transitions[index - 1]?.runtimePreconditions ?? [];
}

export class ProtocolEngine {
  readonly #projectRoot: string;
  readonly #ports: ProtocolEnginePorts;
  readonly #execution: ProtocolExecutionAdapter;

  constructor(
    projectRoot: string,
    ports: ProtocolEnginePorts,
    options: { readonly execution?: ProtocolExecutionAdapter } = {},
  ) {
    this.#projectRoot = projectRoot;
    this.#ports = ports;
    this.#execution = options.execution ?? DEFAULT_EXECUTION_ADAPTER;
  }

  async start(rawCommand: string): Promise<ProtocolEngineResult> {
    const validation = validateCommandText(rawCommand);
    if (!validation.valid) return structuralBlocker(rawCommand, validation.code, validation.message);

    const record = await this.#execution.startExecution(this.#projectRoot, rawCommand);
    return this.#drive(record.rootCommand, record);
  }

  async resume(rootCommand: string): Promise<ProtocolEngineResult> {
    const validation = validateCommandText(rootCommand);
    if (!validation.valid) return structuralBlocker(rootCommand, validation.code, validation.message);

    const resolution = await this.#execution.resolveRoot(this.#projectRoot, validation.normalized.join(' > '));
    if (resolution.status === 'NOT_FOUND') {
      return {
        kind: 'blocked',
        status: 'BLOCKED',
        rootCommand: validation.normalized.join(' > '),
        reasonCode: 'EXECUTION_NOT_FOUND',
      };
    }
    if (resolution.status === 'DONE') {
      return {
        kind: 'terminal',
        status: 'DONE',
        executionId: resolution.executionId,
        rootCommand: resolution.rootCommand ?? validation.normalized.join(' > '),
        reasonCode: resolution.reasonCode,
      };
    }
    if (resolution.status === 'BLOCKED') {
      return {
        kind: 'blocked',
        status: 'BLOCKED',
        executionId: resolution.executionId,
        rootCommand: resolution.rootCommand ?? validation.normalized.join(' > '),
        reasonCode: resolution.reasonCode,
        ...(resolution.intent ? { details: resolution.intent } : {}),
      };
    }

    const record =
      resolution.status === 'RESUME'
        ? await this.#execution.startExecution(this.#projectRoot, validation.normalized.join(' > '))
        : await this.#execution.beginCommand(
            this.#projectRoot,
            validation.normalized.join(' > '),
            resolution.command!,
          );
    return this.#drive(validation.normalized.join(' > '), record);
  }

  async completeSemantic(
    handoff: SemanticHandoffV1,
    proposal: unknown,
  ): Promise<ProtocolEngineResult> {
    const parsed = parseCanonicalCommand(handoff.command);
    if (!parsed.valid) return structuralBlocker(handoff.rootCommand, parsed.code, parsed.message);
    const spec = PROTOCOL_MODEL.domains[parsed.domain].commands[parsed.operation];
    if (spec.dispatch.kind !== 'semantic') {
      return {
        kind: 'blocked',
        status: 'BLOCKED',
        executionId: handoff.executionId,
        rootCommand: handoff.rootCommand,
        reasonCode: 'SEMANTIC_COMPLETION_FOR_DETERMINISTIC_COMMAND',
      };
    }

    const committed = await this.#ports.commitSemanticProposal({
      executionId: handoff.executionId,
      rootCommand: handoff.rootCommand,
      command: handoff.command,
      domain: parsed.domain,
      operation: parsed.operation,
      target: parsed.target,
      input: parsed.input,
      requiredSkill: spec.dispatch.skill,
      contextPhase: spec.dispatch.contextPhase ?? null,
      context: handoff.context,
      proposal,
    });

    await this.#execution.completeCurrent(
      this.#projectRoot,
      handoff.rootCommand,
      committed.result,
      {
        command: handoff.command,
        expectedExecutionId: handoff.executionId,
        ...(committed.details ? { details: committed.details } : {}),
      },
    );
    return this.#drive(handoff.rootCommand);
  }

  async #drive(
    rootCommand: string,
    initialRecord?: ExecutionRecord,
  ): Promise<ProtocolEngineResult> {
    let record = initialRecord;

    for (let step = 0; step < MAX_ENGINE_STEPS; step += 1) {
      if (!record) {
        const resolution = await this.#execution.resolveRoot(this.#projectRoot, rootCommand);
        if (resolution.status === 'DONE') {
          return {
            kind: 'terminal',
            status: 'DONE',
            executionId: resolution.executionId,
            rootCommand,
            reasonCode: resolution.reasonCode,
          };
        }
        if (resolution.status === 'BLOCKED' || resolution.status === 'NOT_FOUND') {
          return {
            kind: 'blocked',
            status: 'BLOCKED',
            executionId: resolution.executionId,
            rootCommand,
            reasonCode: resolution.reasonCode,
            ...(resolution.intent ? { details: resolution.intent } : {}),
          };
        }
        record =
          resolution.status === 'RESUME'
            ? await this.#execution.startExecution(this.#projectRoot, rootCommand)
            : await this.#execution.beginCommand(this.#projectRoot, rootCommand, resolution.command!);
      }

      const id = identity(record);
      const spec = commandSpec(record);

      for (const precondition of transitionPreconditions(rootCommand, id.command)) {
        const request: RuntimePreconditionRequest = { ...id, precondition };
        const check = this.#ports.runtimePrecondition
          ? await this.#ports.runtimePrecondition(request)
          : { ok: false, reasonCode: 'RUNTIME_PRECONDITION_PROVIDER_UNAVAILABLE' };
        if (!check.ok) {
          const blocker = {
            reasonCode: check.reasonCode ?? 'RUNTIME_PRECONDITION_FAILED',
            precondition,
            ...(check.details ?? {}),
          };
          await this.#execution.blockExecution(
            this.#projectRoot,
            rootCommand,
            blocker,
            id.executionId,
          );
          return {
            kind: 'blocked',
            status: 'BLOCKED',
            executionId: id.executionId,
            rootCommand,
            reasonCode: String(blocker.reasonCode),
            details: blocker,
          };
        }
      }

      if (spec.reasoning.mode === 'conditional' && this.#ports.conditionalFastPath) {
        for (const fastPath of spec.reasoning.fastPaths) {
          const fast = await this.#ports.conditionalFastPath({
            ...id,
            fastPathId: fastPath.id,
            context: record.current.context,
          });
          if (!fast) continue;
          await this.#execution.completeCurrent(this.#projectRoot, rootCommand, fast.result, {
            command: id.command,
            expectedExecutionId: id.executionId,
            ...(fast.details ? { details: fast.details } : {}),
          });
          record = undefined;
          break;
        }
        if (!record) continue;
      }

      if (spec.dispatch.kind === 'semantic') {
        return {
          schemaVersion: 1,
          kind: 'semantic-handoff',
          ...id,
          requiredSkill: spec.dispatch.skill,
          contextPhase: spec.dispatch.contextPhase ?? null,
          reasoningMode: spec.reasoning.mode,
          context: record.current.context,
        };
      }

      const deterministic = await this.#ports.deterministicHandler({
        ...id,
        handler: spec.dispatch.handler,
        context: record.current.context,
      });
      await this.#execution.completeCurrent(
        this.#projectRoot,
        rootCommand,
        deterministic.result,
        {
          command: id.command,
          expectedExecutionId: id.executionId,
          ...(deterministic.details ? { details: deterministic.details } : {}),
        },
      );
      record = undefined;
    }

    return {
      kind: 'blocked',
      status: 'BLOCKED',
      rootCommand,
      reasonCode: 'PROTOCOL_ENGINE_STEP_LIMIT',
      details: { limit: MAX_ENGINE_STEPS },
    };
  }
}
