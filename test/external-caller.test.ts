import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ExternalCallerRequestError,
  parseExternalCallerRequest,
} from '../src/core/engine/index.js';
import { readProtocolMachineRequest } from '../src/commands/protocol-machine.js';

describe('external caller request v1', () => {
  it('accepts minimal start/resume/semantic-complete DTOs', () => {
    expect(parseExternalCallerRequest({
      schemaVersion: 1,
      operation: 'start',
      command: 'PROJECT STATUS',
    })).toEqual({
      schemaVersion: 1,
      operation: 'start',
      command: 'PROJECT STATUS',
    });

    expect(parseExternalCallerRequest({
      schemaVersion: 1,
      operation: 'resume',
      rootCommand: 'STEP RUN STEP-001',
    })).toEqual({
      schemaVersion: 1,
      operation: 'resume',
      rootCommand: 'STEP RUN STEP-001',
    });

    expect(parseExternalCallerRequest({
      schemaVersion: 1,
      operation: 'semantic-complete',
      completion: {
        schemaVersion: 1,
        executionId: 'exec-1',
        rootCommand: 'PROJECT QUICK FIX: example',
        command: 'PROJECT QUICK FIX: example',
      },
      proposal: {
        schemaVersion: 1,
        result: 'SUCCESS',
      },
    })).toMatchObject({
      schemaVersion: 1,
      operation: 'semantic-complete',
      completion: {
        executionId: 'exec-1',
      },
      proposal: {
        result: 'SUCCESS',
      },
    });
  });

  it('rejects caller attempts to echo or override handoff-only authority fields', () => {
    expect(() => parseExternalCallerRequest({
      schemaVersion: 1,
      operation: 'semantic-complete',
      completion: {
        schemaVersion: 1,
        executionId: 'exec-1',
        rootCommand: 'STEP PLAN STEP-001',
        command: 'STEP PLAN STEP-001',
        context: { injected: true },
        requiredSkill: 'different-skill',
      },
      proposal: {
        schemaVersion: 1,
        result: 'SUCCESS',
      },
    })).toThrowError(ExternalCallerRequestError);

    try {
      parseExternalCallerRequest({
        schemaVersion: 1,
        operation: 'semantic-complete',
        completion: {
          schemaVersion: 1,
          executionId: 'exec-1',
          rootCommand: 'STEP PLAN STEP-001',
          command: 'STEP PLAN STEP-001',
          context: { injected: true },
        },
        proposal: {},
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'EXTERNAL_REQUEST_INVALID',
        details: {
          operation: 'semantic-complete.completion',
          unsupportedFields: ['context'],
        },
      });
    }
  });

  it('reads exactly one JSON object from stdin-friendly transport', async () => {
    await expect(
      readProtocolMachineRequest(
        Readable.from([
          '{"schemaVersion":1,',
          '"operation":"start","command":"PROJECT STATUS"}',
        ]),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      operation: 'start',
      command: 'PROJECT STATUS',
    });
  });

  it('returns typed input failures for invalid JSON and bounded input overflow', async () => {
    await expect(
      readProtocolMachineRequest(Readable.from(['{invalid'])),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_MACHINE_INVALID_JSON',
      category: 'input',
    });

    await expect(
      readProtocolMachineRequest(Readable.from(['x'.repeat(1024 * 1024 + 1)])),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_MACHINE_REQUEST_TOO_LARGE',
      category: 'input',
    });
  });
});
