export const CLI_EXIT_CODES = {
  success: 0,
  failure: 1,
  blocked: 2,
  usage: 64,
  input: 65,
  environment: 69,
  internal: 70,
} as const;

export type CliExitKind = keyof typeof CLI_EXIT_CODES;
export type CliFailureKind = Exclude<CliExitKind, 'success'>;

export interface CliStructuredError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export class CliPresentationError extends Error {
  readonly code: string;
  readonly category: CliFailureKind;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    category: CliFailureKind,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CliPresentationError';
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function structuredError(
  error: unknown,
  fallbackCode = 'CLI_ERROR',
): CliStructuredError {
  if (error instanceof CliPresentationError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  const candidate = isRecord(error) ? error : null;
  const code =
    candidate && typeof candidate.code === 'string' && candidate.code.length > 0
      ? candidate.code
      : fallbackCode;
  const details =
    candidate && isRecord(candidate.details)
      ? candidate.details
      : {};

  const message =
    error instanceof Error
      ? error.message
      : candidate && typeof candidate.message === 'string'
        ? candidate.message
        : String(error);

  return {
    code,
    message,
    details,
  };
}

export function setCliExitCode(kind: CliExitKind): void {
  process.exitCode = CLI_EXIT_CODES[kind];
}

export function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function jsonSuccess<T extends Readonly<Record<string, unknown>>>(
  fields: T,
): Readonly<{ schemaVersion: 1; ok: true } & T> {
  return {
    schemaVersion: 1,
    ok: true,
    ...fields,
  };
}

export function jsonFailure(
  category: CliFailureKind,
  error: unknown,
  options: {
    readonly fallbackCode?: string;
    readonly status?: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    ok: false,
    status: options.status ?? (category === 'blocked' ? 'blocked' : 'error'),
    category,
    ...(options.fields ?? {}),
    error: structuredError(error, options.fallbackCode),
  };
}
