import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../config.js';
import { getPackageVersion } from '../package.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { resolvePinnedRelease } from '../releases/resolver.js';
import { ReleaseStore } from '../releases/store.js';
import {
  HOST_API_VERSION,
  isCoreHostResultV1,
  type CoreHostFailureV1,
  type CoreHostPortsV1,
  type CoreHostRequestV1,
  type CoreHostResultV1,
  type CoreHostVersionsV1,
  type HarnessCoreV1,
  type LoadedPinnedCoreV1,
} from './contract.js';
import { CoreHostError } from './errors.js';

export interface LoadPinnedCoreOptions {
  readonly projectRoot: string;
  readonly ports: CoreHostPortsV1;
  readonly releaseStore?: ReleaseStore;
  readonly cliVersion?: string;
}

function validatePort(name: keyof CoreHostPortsV1, value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { call?: unknown }).call !== 'function'
  ) {
    throw new CoreHostError(
      'CORE_PORTS_INVALID',
      `Harness Core Host API requires a valid ${name} port.`,
      { port: name },
    );
  }
}

function validatePorts(ports: CoreHostPortsV1): void {
  if (typeof ports !== 'object' || ports === null) {
    throw new CoreHostError('CORE_PORTS_INVALID', 'Harness Core Host API ports are missing.');
  }
  validatePort('filesystem', ports.filesystem);
  validatePort('git', ports.git);
  validatePort('storage', ports.storage);
}

function failure(
  requestId: string,
  versions: CoreHostVersionsV1,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CoreHostFailureV1 {
  return {
    schemaVersion: 1,
    hostApiVersion: HOST_API_VERSION,
    requestId,
    ok: false,
    versions,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function normalizeResult(
  value: CoreHostResultV1,
  request: CoreHostRequestV1,
): CoreHostResultV1 {
  if (value.ok) {
    return {
      schemaVersion: 1,
      hostApiVersion: HOST_API_VERSION,
      requestId: request.requestId,
      ok: true,
      versions: request.versions,
      result: value.result,
    };
  }

  return {
    schemaVersion: 1,
    hostApiVersion: HOST_API_VERSION,
    requestId: request.requestId,
    ok: false,
    versions: request.versions,
    error:
      value.error.details === undefined
        ? { code: value.error.code, message: value.error.message }
        : {
            code: value.error.code,
            message: value.error.message,
            details: value.error.details,
          },
  };
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(path.resolve(projectRoot));
  } catch (error) {
    throw new CoreHostError(
      'CORE_PROJECT_ROOT_INVALID',
      `Project root cannot be resolved: ${projectRoot}.`,
      { projectRoot: path.resolve(projectRoot), cause: (error as Error).message },
    );
  }
}

async function loadCoreModule(entrypoint: string): Promise<HarnessCoreV1> {
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(pathToFileURL(entrypoint).href)) as Record<string, unknown>;
  } catch (error) {
    throw new CoreHostError(
      'CORE_LOAD_FAILED',
      'Verified Harness Core entrypoint could not be loaded.',
      { cause: (error as Error).message },
    );
  }

  const candidate = namespace.harnessCore;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new CoreHostError(
      'CORE_ENTRYPOINT_INVALID',
      'Harness Core entrypoint must export a named harnessCore object.',
    );
  }

  const hostApiVersion = (candidate as { hostApiVersion?: unknown }).hostApiVersion;
  if (hostApiVersion !== HOST_API_VERSION) {
    throw new CoreHostError(
      'CORE_HOST_API_MISMATCH',
      `Loaded Harness Core declares Host API ${String(hostApiVersion)}, expected ${HOST_API_VERSION}.`,
      { declaredHostApiVersion: hostApiVersion ?? null, supportedHostApiVersion: HOST_API_VERSION },
    );
  }

  if (typeof (candidate as { execute?: unknown }).execute !== 'function') {
    throw new CoreHostError(
      'CORE_ENTRYPOINT_INVALID',
      'Harness Core entrypoint harnessCore.execute must be a function.',
    );
  }

  return candidate as HarnessCoreV1;
}

export async function loadPinnedCore(
  options: LoadPinnedCoreOptions,
): Promise<LoadedPinnedCoreV1> {
  validatePorts(options.ports);

  const projectRoot = await canonicalProjectRoot(options.projectRoot);
  const config = await readConfig(projectRoot);
  const cliVersion = options.cliVersion ?? getPackageVersion();
  const releaseStore = options.releaseStore ?? new ReleaseStore();

  // Resolution is deliberately immediately before module loading. It verifies
  // the installed immutable tree and checks CLI / Host API / project-schema
  // compatibility for the exact project pin. No latest/main fallback exists.
  const resolved = await resolvePinnedRelease(
    releaseStore,
    config.harness.release,
    config.schemaVersion,
    { cliVersion, hostApiVersion: HOST_API_VERSION },
  );

  const entrypoint = await resolvePortablePathWithinBoundary(
    resolved.root,
    resolved.manifest.entrypoints.core,
    'Harness Core entrypoint',
  );
  const core = await loadCoreModule(entrypoint);

  const versions: CoreHostVersionsV1 = Object.freeze({
    cli: cliVersion,
    harnessRelease: resolved.release,
    projectSchema: config.schemaVersion,
    releaseDigest: resolved.digest,
  });

  const descriptor = Object.freeze({
    hostApiVersion: HOST_API_VERSION,
    projectRoot,
    projectSchemaVersion: config.schemaVersion,
    release: resolved.release,
    releaseDigest: resolved.digest,
    cliVersion,
  });

  const execute = core.execute.bind(core);

  return Object.freeze({
    descriptor,
    async invoke(operation: string, input: unknown = null): Promise<CoreHostResultV1> {
      const requestId = randomUUID();
      const normalizedOperation = typeof operation === 'string' ? operation.trim() : '';

      if (!normalizedOperation) {
        return failure(
          requestId,
          versions,
          'CORE_INVALID_REQUEST',
          'Harness Core operation must be a non-empty string.',
        );
      }

      const request: CoreHostRequestV1 = Object.freeze({
        schemaVersion: 1,
        hostApiVersion: HOST_API_VERSION,
        requestId,
        projectRoot,
        operation: normalizedOperation,
        versions,
        input,
      });

      let value: unknown;
      try {
        value = await execute(request, options.ports);
      } catch (error) {
        return failure(
          requestId,
          versions,
          'CORE_EXECUTION_FAILED',
          'Harness Core execution failed.',
          { cause: (error as Error).message },
        );
      }

      if (!isCoreHostResultV1(value, request)) {
        return failure(
          requestId,
          versions,
          'CORE_INVALID_RESPONSE',
          'Harness Core returned an invalid Host API v1 response envelope.',
        );
      }

      return normalizeResult(value, request);
    },
  });
}
