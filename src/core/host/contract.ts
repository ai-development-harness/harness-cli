export const HOST_API_VERSION = 1 as const;

export interface CoreHostVersionsV1 {
  readonly cli: string;
  readonly harnessRelease: string;
  readonly projectSchema: number;
  readonly releaseDigest: string;
}

export interface CoreHostPortRequestV1 {
  readonly operation: string;
  readonly input?: unknown;
}

export interface CoreHostPortV1 {
  call(request: CoreHostPortRequestV1): Promise<unknown>;
}

export interface CoreHostPortsV1 {
  readonly filesystem: CoreHostPortV1;
  readonly git: CoreHostPortV1;
  readonly storage: CoreHostPortV1;
}

export interface CoreHostRequestV1 {
  readonly schemaVersion: 1;
  readonly hostApiVersion: typeof HOST_API_VERSION;
  readonly requestId: string;
  readonly projectRoot: string;
  readonly operation: string;
  readonly versions: CoreHostVersionsV1;
  readonly input: unknown;
}

export interface CoreHostStructuredErrorV1 {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CoreHostSuccessV1 {
  readonly schemaVersion: 1;
  readonly hostApiVersion: typeof HOST_API_VERSION;
  readonly requestId: string;
  readonly ok: true;
  readonly versions: CoreHostVersionsV1;
  readonly result: unknown;
}

export interface CoreHostFailureV1 {
  readonly schemaVersion: 1;
  readonly hostApiVersion: typeof HOST_API_VERSION;
  readonly requestId: string;
  readonly ok: false;
  readonly versions: CoreHostVersionsV1;
  readonly error: CoreHostStructuredErrorV1;
}

export type CoreHostResultV1 = CoreHostSuccessV1 | CoreHostFailureV1;

export interface HarnessCoreV1 {
  readonly hostApiVersion: typeof HOST_API_VERSION;
  execute(
    request: CoreHostRequestV1,
    ports: CoreHostPortsV1,
  ): CoreHostResultV1 | Promise<CoreHostResultV1>;
}

export interface LoadedCoreDescriptorV1 {
  readonly hostApiVersion: typeof HOST_API_VERSION;
  readonly projectRoot: string;
  readonly projectSchemaVersion: number;
  readonly release: string;
  readonly releaseDigest: string;
  readonly cliVersion: string;
}

export interface LoadedPinnedCoreV1 {
  readonly descriptor: LoadedCoreDescriptorV1;
  invoke(operation: string, input?: unknown): Promise<CoreHostResultV1>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameVersions(value: unknown, expected: CoreHostVersionsV1): boolean {
  if (!isRecord(value)) return false;
  return (
    value.cli === expected.cli &&
    value.harnessRelease === expected.harnessRelease &&
    value.projectSchema === expected.projectSchema &&
    value.releaseDigest === expected.releaseDigest
  );
}

export function isCoreHostResultV1(
  value: unknown,
  request: CoreHostRequestV1,
): value is CoreHostResultV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    value.hostApiVersion !== HOST_API_VERSION ||
    value.requestId !== request.requestId ||
    !sameVersions(value.versions, request.versions) ||
    typeof value.ok !== 'boolean'
  ) {
    return false;
  }

  if (value.ok === true) return Object.prototype.hasOwnProperty.call(value, 'result');
  if (!isRecord(value.error)) return false;

  return (
    typeof value.error.code === 'string' &&
    value.error.code.length > 0 &&
    typeof value.error.message === 'string' &&
    value.error.message.length > 0 &&
    (value.error.details === undefined || isRecord(value.error.details))
  );
}
