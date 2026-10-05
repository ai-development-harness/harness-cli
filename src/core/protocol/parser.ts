import { PROTOCOL_MODEL } from './model.js';
import {
  CHAIN_SEPARATOR,
  type ProtocolModel,
  validateProtocolModel,
} from './schema.js';

export interface ParsedCommandSegment {
  readonly valid: true;
  readonly domain: string;
  readonly operation: string;
  readonly target: string | null;
  readonly input: string | null;
  readonly chainAllowed: boolean;
  readonly normalized: string;
}

export interface InvalidCommand {
  readonly valid: false;
  readonly code: string;
  readonly message: string;
  readonly segmentIndex?: number;
  readonly errors?: readonly string[];
}

export interface ValidCommandText {
  readonly valid: true;
  readonly code: 'VALID_COMMAND' | 'VALID_CHAIN';
  readonly domain: string;
  readonly normalized: readonly string[];
  readonly transitions: readonly {
    readonly from: string;
    readonly to: string;
    readonly onPreviousResult: readonly string[];
    readonly runtimePreconditions: readonly string[];
  }[];
}

export type CommandTextValidation = ValidCommandText | InvalidCommand;
export type CanonicalCommandParse = ParsedCommandSegment | InvalidCommand;

function operationMatch(
  text: string,
  operations: readonly string[],
): { operation: string | null; rest: string } {
  const stripped = text.trim();
  for (const operation of [...operations].sort((a, b) => b.length - a.length)) {
    if (stripped === operation) return { operation, rest: '' };
    if (stripped.startsWith(operation)) {
      const rest = stripped.slice(operation.length);
      if (rest.startsWith(' ') || rest.startsWith(':')) return { operation, rest };
    }
  }
  return { operation: null, rest: stripped };
}

function parseSegment(
  rawSegment: string,
  model: ProtocolModel,
  expectedDomain: string | null,
  inheritedTarget: string | null,
  firstSegment: boolean,
): ParsedCommandSegment | InvalidCommand {
  const segment = rawSegment.trim();
  const domains = model.domains;
  let domainName: string | null = null;
  let remainder = segment;

  for (const candidate of Object.keys(domains).sort((a, b) => b.length - a.length)) {
    if (segment === candidate || segment.startsWith(`${candidate} `)) {
      domainName = candidate;
      remainder = segment.slice(candidate.length).trim();
      break;
    }
  }

  if (firstSegment) {
    if (domainName === null) {
      return {
        valid: false,
        code: 'MISSING_DOMAIN',
        message: 'first chain segment must contain an explicit canonical DOMAIN',
      };
    }
  } else {
    if (domainName !== null && domainName !== expectedDomain) {
      return {
        valid: false,
        code: 'DOMAIN_MISMATCH',
        message: `chain domain changed from ${expectedDomain} to ${domainName}`,
      };
    }
    if (domainName === null) domainName = expectedDomain;
  }

  if (domainName === null || !(domainName in domains)) {
    return {
      valid: false,
      code: 'UNKNOWN_DOMAIN',
      message: `unknown command domain in segment: ${segment}`,
    };
  }

  const domain = domains[domainName];
  const commands = domain.commands;
  let { operation, rest } = operationMatch(remainder, Object.keys(commands));

  if (operation === null && !firstSegment) {
    const aliases = domain.continuationAliases;
    const aliasMatch = operationMatch(remainder, Object.keys(aliases));
    if (aliasMatch.operation !== null) {
      operation = aliases[aliasMatch.operation];
      rest = aliasMatch.rest;
    }
  }

  if (operation === null) {
    return {
      valid: false,
      code: 'UNKNOWN_OPERATION',
      message: `unknown ${domainName} operation in segment: ${segment}`,
    };
  }

  const spec = commands[operation];
  rest = rest.trim();
  let target: string | null = null;

  if (spec.target === 'step') {
    if (rest) {
      const [token, ...tail] = rest.split(' ');
      if (/^STEP-\d{3,}$/.test(token)) {
        target = token;
        rest = tail.join(' ').trim();
      } else if (/^\d{3,}$/.test(token)) {
        target = `STEP-${token}`;
        rest = tail.join(' ').trim();
      }
    }
    if (target === null) {
      if (inheritedTarget !== null) target = inheritedTarget;
      else {
        return {
          valid: false,
          code: 'MISSING_TARGET',
          message: `${domainName} ${operation} requires STEP-NNN or NNN target`,
        };
      }
    }
  } else if (spec.target === 'release-optional') {
    if (rest) {
      const match = /^TO\s+(\S+)$/.exec(rest);
      if (!match) {
        return {
          valid: false,
          code: 'INVALID_TARGET_SYNTAX',
          message: `${domainName} ${operation} accepts only optional 'TO <tag>' target`,
        };
      }
      target = match[1];
      rest = '';
    } else if (inheritedTarget !== null) {
      target = inheritedTarget;
    }
  }

  let input: string | null = null;
  if (spec.input === 'optional' || spec.input === 'required') {
    if (rest) {
      if (!rest.startsWith(':')) {
        return {
          valid: false,
          code: 'INVALID_INPUT_SYNTAX',
          message: `${domainName} ${operation} free-form input must follow ':'`,
        };
      }
      input = rest.slice(1).trim();
      rest = '';
    }
    if (spec.input === 'required' && !input) {
      return {
        valid: false,
        code: 'MISSING_INPUT',
        message: `${domainName} ${operation} requires non-empty input after ':'`,
      };
    }
  } else if (rest) {
    return {
      valid: false,
      code: 'UNEXPECTED_ARGUMENTS',
      message: `unexpected arguments after ${domainName} ${operation}: ${rest}`,
    };
  }

  if (rest) {
    return {
      valid: false,
      code: 'UNEXPECTED_ARGUMENTS',
      message: `unexpected arguments in segment: ${segment}`,
    };
  }

  if (inheritedTarget !== null && target !== null && target !== inheritedTarget) {
    return {
      valid: false,
      code: 'TARGET_MISMATCH',
      message: `chain target changed from ${inheritedTarget} to ${target}`,
    };
  }

  let normalized = `${domainName} ${operation}`;
  if (spec.target === 'step' && target) normalized += ` ${target}`;
  else if (spec.target === 'release-optional' && target) normalized += ` TO ${target}`;
  if (input !== null) normalized += `: ${input}`;

  return {
    valid: true,
    domain: domainName,
    operation,
    target,
    input,
    chainAllowed: spec.chainAllowed,
    normalized,
  };
}

function invalidModel(model: unknown): InvalidCommand | null {
  const validation = validateProtocolModel(model);
  if (validation.valid) return null;
  return {
    valid: false,
    code: 'INVALID_TRANSITION_TABLE',
    message: 'command transition table is invalid',
    errors: validation.errors,
  };
}

export function parseCanonicalCommand(
  raw: string,
  model: ProtocolModel = PROTOCOL_MODEL,
): CanonicalCommandParse {
  const modelError = invalidModel(model);
  if (modelError) return modelError;

  const text = raw.trim();
  if (!text) return { valid: false, code: 'EMPTY_COMMAND', message: 'command is empty' };
  if (text.includes(model.chainSeparator)) {
    return {
      valid: false,
      code: 'CHAIN_NOT_ALLOWED',
      message: 'parseCanonicalCommand accepts exactly one command',
    };
  }

  return parseSegment(text, model, null, null, true);
}

export function validateCommandText(
  raw: string,
  model: ProtocolModel = PROTOCOL_MODEL,
): CommandTextValidation {
  const modelError = invalidModel(model);
  if (modelError) return modelError;

  const text = raw.trim();
  if (!text) return { valid: false, code: 'EMPTY_COMMAND', message: 'command is empty' };

  const segments = text.split(model.chainSeparator).map((part) => part.trim());
  if (segments.some((part) => !part)) {
    return { valid: false, code: 'EMPTY_SEGMENT', message: 'chain contains an empty segment' };
  }

  const parsed: ParsedCommandSegment[] = [];
  let domainName: string | null = null;
  let inheritedTarget: string | null = null;

  for (let index = 0; index < segments.length; index += 1) {
    const item = parseSegment(
      segments[index],
      model,
      domainName,
      inheritedTarget,
      index === 0,
    );
    if (!item.valid) return { ...item, segmentIndex: index };

    if (domainName === null) domainName = item.domain;
    if (item.target !== null) {
      if (inheritedTarget === null) {
        if (index > 0) {
          return {
            valid: false,
            code: 'TARGET_MISMATCH',
            message: 'chain target cannot be introduced after the first segment',
            segmentIndex: index,
          };
        }
        inheritedTarget = item.target;
      } else if (item.target !== inheritedTarget) {
        return {
          valid: false,
          code: 'TARGET_MISMATCH',
          message: `chain target changed from ${inheritedTarget} to ${item.target}`,
          segmentIndex: index,
        };
      }
    }
    parsed.push(item);
  }

  if (parsed.length === 1) {
    return {
      valid: true,
      code: 'VALID_COMMAND',
      domain: parsed[0].domain,
      normalized: [parsed[0].normalized],
      transitions: [],
    };
  }

  const domain = model.domains[domainName!];
  if (!domain.chainEnabled) {
    return {
      valid: false,
      code: 'CHAIN_NOT_ALLOWED',
      message: `${domainName} commands are standalone-only`,
    };
  }

  for (let index = 0; index < parsed.length; index += 1) {
    if (!parsed[index].chainAllowed) {
      return {
        valid: false,
        code: 'CHAIN_NOT_ALLOWED',
        message: `${parsed[index].normalized} is standalone-only`,
        segmentIndex: index,
      };
    }
  }

  const transitions: ValidCommandText['transitions'][number][] = [];
  for (let index = 0; index < parsed.length - 1; index += 1) {
    const left = parsed[index];
    const right = parsed[index + 1];
    const edge = domain.transitions.find(
      (candidate) => candidate.from === left.operation && candidate.to === right.operation,
    );
    if (!edge) {
      return {
        valid: false,
        code: 'INVALID_CHAIN',
        message: `transition ${domainName} ${left.operation} -> ${domainName} ${right.operation} is not allowed`,
        segmentIndex: index + 1,
      };
    }
    transitions.push({
      from: left.normalized,
      to: right.normalized,
      onPreviousResult: edge.onPreviousResult,
      runtimePreconditions: edge.runtimePreconditions,
    });
  }

  return {
    valid: true,
    code: 'VALID_CHAIN',
    domain: domainName!,
    normalized: parsed.map((item) => item.normalized),
    transitions,
  };
}

export function protocolValidationOrder(): readonly string[] {
  return [...PROTOCOL_MODEL.validationOrder];
}

export { CHAIN_SEPARATOR };
