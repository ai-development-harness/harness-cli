import {
  HOST_API_VERSION,
  type CoreHostFailureV1,
  type CoreHostRequestV1,
  type CoreHostResultV1,
  type HarnessCoreV1,
} from './host/index.js';
import {
  COMMAND_RESULTS,
  canonicalCommands,
  reasoningProjection,
  validateCommandText,
  type CommandResult,
} from './protocol/index.js';
import {
  projectStatus,
  resolveStepNext,
  stepList,
  stepShow,
} from './project/index.js';
import {
  createPlanningProjectProviders,
  implementationPrerequisiteFailures,
} from './planning/index.js';
import {
  ExternalCallerRequestError,
  ProtocolEngine,
  parseExternalCallerRequest,
  type DeterministicHandlerResult,
  type ProtocolEnginePorts,
} from './engine/index.js';

function success(request: CoreHostRequestV1, result: unknown): CoreHostResultV1 {
  return {
    schemaVersion: 1,
    hostApiVersion: HOST_API_VERSION,
    requestId: request.requestId,
    ok: true,
    versions: request.versions,
    result,
  };
}

function failure(
  request: CoreHostRequestV1,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CoreHostFailureV1 {
  return {
    schemaVersion: 1,
    hostApiVersion: HOST_API_VERSION,
    requestId: request.requestId,
    ok: false,
    versions: request.versions,
    error: details ? { code, message, details } : { code, message },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function semanticProposal(value: unknown): DeterministicHandlerResult {
  const proposal = record(value);
  if (!proposal || proposal.schemaVersion !== 1) {
    return {
      result: 'BLOCKED',
      details: {
        reasonCode: 'SEMANTIC_PROPOSAL_INVALID',
        message: 'Semantic proposal must be a schemaVersion=1 object.',
      },
    };
  }

  const rawResult = proposal.result;
  if (
    typeof rawResult !== 'string' ||
    !(COMMAND_RESULTS as readonly string[]).includes(rawResult)
  ) {
    return {
      result: 'BLOCKED',
      details: {
        reasonCode: 'SEMANTIC_PROPOSAL_INVALID',
        message: 'Semantic proposal result must be PASS, SUCCESS, FAIL or BLOCKED.',
      },
    };
  }

  const details = proposal.details;
  if (details !== undefined && record(details) === null) {
    return {
      result: 'BLOCKED',
      details: {
        reasonCode: 'SEMANTIC_PROPOSAL_INVALID',
        message: 'Semantic proposal details must be an object when present.',
      },
    };
  }

  return {
    result: rawResult as CommandResult,
    ...(details === undefined ? {} : { details: details as Readonly<Record<string, unknown>> }),
  };
}

function enginePorts(projectRoot: string): ProtocolEnginePorts {
  const providers = createPlanningProjectProviders(projectRoot);

  return {
    async deterministicHandler(request) {
      switch (request.handler) {
        case 'harness-help':
          return {
            result: 'PASS',
            details: {
              output: {
                schemaVersion: 1,
                commands: canonicalCommands(),
              },
            },
          };
        case 'project-status': {
          const output = await projectStatus(projectRoot, providers);
          return {
            result: output.status === 'PASS' ? 'PASS' : 'BLOCKED',
            details: { output },
          };
        }
        case 'step-list': {
          const output = await stepList(projectRoot, providers);
          return {
            result: output.status === 'PASS' ? 'PASS' : 'BLOCKED',
            details: { output },
          };
        }
        case 'step-show': {
          const output = request.target
            ? await stepShow(projectRoot, request.target, providers)
            : { status: 'BLOCKED', reasonCode: 'STEP_TARGET_REQUIRED' };
          return {
            result: output.status === 'PASS' ? 'PASS' : 'BLOCKED',
            details: { output },
          };
        }
        case 'step-next': {
          const output = await resolveStepNext(projectRoot, providers);
          return {
            result: output.status === 'PASS' ? 'PASS' : 'BLOCKED',
            details: { output },
          };
        }
        default:
          return {
            result: 'BLOCKED',
            details: {
              reasonCode: 'DETERMINISTIC_HANDLER_UNAVAILABLE',
              handler: request.handler,
            },
          };
      }
    },

    async runtimePrecondition(request) {
      if (request.precondition === 'step-implement-ready') {
        if (!request.target) {
          return {
            ok: false,
            reasonCode: 'STEP_TARGET_REQUIRED',
          };
        }
        const failures = await implementationPrerequisiteFailures(
          projectRoot,
          request.target,
        );
        return failures.length === 0
          ? { ok: true }
          : {
              ok: false,
              reasonCode: 'STEP_IMPLEMENT_NOT_READY',
              details: { failures },
            };
      }

      return {
        ok: false,
        reasonCode: 'RUNTIME_PRECONDITION_UNAVAILABLE',
        details: { precondition: request.precondition },
      };
    },

    async conditionalFastPath() {
      return null;
    },

    async commitSemanticProposal(request) {
      const committed = semanticProposal(request.proposal);
      return committed.details
        ? {
            ...committed,
            details: {
              ...committed.details,
              semanticCommit: {
                executionId: request.executionId,
                command: request.command,
              },
            },
          }
        : committed;
    },
  };
}

async function externalCall(
  request: CoreHostRequestV1,
): Promise<CoreHostResultV1> {
  let call;
  try {
    call = parseExternalCallerRequest(request.input);
  } catch (error) {
    if (error instanceof ExternalCallerRequestError) {
      return failure(request, error.code, error.message, error.details);
    }
    throw error;
  }

  const engine = new ProtocolEngine(
    request.projectRoot,
    enginePorts(request.projectRoot),
  );

  if (call.operation === 'start') {
    return success(request, await engine.start(call.command));
  }
  if (call.operation === 'resume') {
    return success(request, await engine.resume(call.rootCommand));
  }
  return success(
    request,
    await engine.completeSemantic(call.completion, call.proposal),
  );
}

async function execute(request: CoreHostRequestV1): Promise<CoreHostResultV1> {
  try {
    switch (request.operation) {
      case 'protocol/external-call':
        return externalCall(request);
      case 'protocol/commands':
        return success(request, { schemaVersion: 1, commands: canonicalCommands() });
      case 'protocol/reasoning':
        return success(request, reasoningProjection());
      case 'protocol/validate-command': {
        const input = record(request.input);
        const command = typeof input?.command === 'string' ? input.command : '';
        if (!command.trim()) {
          return failure(request, 'CORE_INVALID_REQUEST', 'input.command must be a non-empty string.');
        }
        return success(request, validateCommandText(command));
      }
      case 'project/status': {
        const providers = createPlanningProjectProviders(request.projectRoot);
        return success(request, await projectStatus(request.projectRoot, providers));
      }
      case 'step/list': {
        const providers = createPlanningProjectProviders(request.projectRoot);
        return success(request, await stepList(request.projectRoot, providers));
      }
      case 'step/show': {
        const input = record(request.input);
        const stepId = typeof input?.stepId === 'string' ? input.stepId : '';
        if (!stepId.trim()) {
          return failure(request, 'CORE_INVALID_REQUEST', 'input.stepId must be a non-empty string.');
        }
        const providers = createPlanningProjectProviders(request.projectRoot);
        return success(request, await stepShow(request.projectRoot, stepId, providers));
      }
      case 'step/next': {
        const providers = createPlanningProjectProviders(request.projectRoot);
        return success(request, await resolveStepNext(request.projectRoot, providers));
      }
      default:
        return failure(
          request,
          'CORE_OPERATION_UNSUPPORTED',
          `Unsupported Harness Core operation: ${request.operation}`,
          { operation: request.operation },
        );
    }
  } catch (error) {
    return failure(request, 'CORE_OPERATION_FAILED', (error as Error).message);
  }
}

export const harnessCore: HarnessCoreV1 = Object.freeze({
  hostApiVersion: HOST_API_VERSION,
  execute,
});
