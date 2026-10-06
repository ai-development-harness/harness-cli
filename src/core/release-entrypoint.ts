import {
  HOST_API_VERSION,
  type CoreHostFailureV1,
  type CoreHostRequestV1,
  type CoreHostResultV1,
  type HarnessCoreV1,
} from './host/index.js';
import {
  canonicalCommands,
  reasoningProjection,
  validateCommandText,
} from './protocol/index.js';
import {
  projectStatus,
  resolveStepNext,
  stepList,
  stepShow,
} from './project/index.js';
import { createPlanningProjectProviders } from './planning/index.js';

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

async function execute(request: CoreHostRequestV1): Promise<CoreHostResultV1> {
  try {
    switch (request.operation) {
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
