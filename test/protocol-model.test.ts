import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_CONTRACT,
  PROTOCOL_MODEL,
  authorityContract,
  canonicalCommands,
  dispatchSpec,
  helpCatalog,
  parseCanonicalCommand,
  protocolValidationOrder,
  reasoningProjection,
  validateCommandText,
  validateProtocolModel,
} from '../src/core/protocol/index.js';

describe('canonical protocol model parity', () => {
  it('owns the exact v0.10.4 command surface in Core', () => {
    expect(validateProtocolModel(PROTOCOL_MODEL)).toEqual({ valid: true, errors: [] });
    expect(canonicalCommands()).toHaveLength(32);
    expect(Object.keys(PROTOCOL_MODEL.domains)).toEqual([
      'PROJECT',
      'STEP',
      'SKILL',
      'GITHUB',
      'RELEASE',
      'HARNESS',
      'GIT',
    ]);
    expect(protocolValidationOrder()).toEqual([
      'tokenize',
      'normalize',
      'transition-table',
      'runtime-preconditions',
      'dispatch',
    ]);
  });

  it('preserves authority and deterministic/semantic dispatch metadata', () => {
    expect(authorityContract()).toEqual(AUTHORITY_CONTRACT);
    expect(dispatchSpec('STEP', 'PLAN')).toEqual({
      kind: 'semantic',
      skill: 'plan-step',
      contextPhase: 'plan',
    });
    expect(dispatchSpec('GIT', 'CHECK')).toEqual({
      kind: 'deterministic',
      handler: 'git-check',
    });
    expect(dispatchSpec('HARNESS', 'HELP')).toEqual({
      kind: 'deterministic',
      handler: 'harness-help',
    });
  });

  it('builds help and reasoning projections from the same model', () => {
    const help = helpCatalog();
    expect(help).toHaveLength(7);
    expect(help.flatMap((domain) => domain.commands)).toHaveLength(32);
    expect(help.find((domain) => domain.domain === 'STEP')?.commands).toContainEqual({
      canonical: 'STEP PLAN STEP-NNN',
      summary: 'Подготовить и независимо проверить план реализации STEP.',
      documentation: '.harness/docs/COMMANDS.md#command-step-plan',
    });

    const reasoning = reasoningProjection();
    expect(reasoning.classification).toEqual({
      scope: 'command-node',
      source: 'canonical-protocol-model',
    });
    expect(reasoning.summary).toEqual({
      total: 32,
      none: 14,
      required: 16,
      conditional: 2,
    });
    expect(reasoning.commands.find((item) => item.command === 'STEP RUN STEP-NNN')?.reasoning.mode)
      .toBe('conditional');
    expect(reasoning.commands.find((item) => item.command === 'GIT PUSH')?.reasoning.mode)
      .toBe('conditional');
  });
});

describe('canonical command parser parity', () => {
  it('normalizes numeric STEP targets and inherits them across valid chains', () => {
    expect(validateCommandText('STEP PLAN 024 > IMPLEMENT > REVIEW')).toEqual({
      valid: true,
      code: 'VALID_CHAIN',
      domain: 'STEP',
      normalized: [
        'STEP PLAN STEP-024',
        'STEP IMPLEMENT STEP-024',
        'STEP REVIEW STEP-024',
      ],
      transitions: [
        {
          from: 'STEP PLAN STEP-024',
          to: 'STEP IMPLEMENT STEP-024',
          onPreviousResult: ['SUCCESS'],
          runtimePreconditions: ['step-implement-ready'],
        },
        {
          from: 'STEP IMPLEMENT STEP-024',
          to: 'STEP REVIEW STEP-024',
          onPreviousResult: ['SUCCESS'],
          runtimePreconditions: [],
        },
      ],
    });
  });

  it('normalizes HARNESS continuation alias and inherits the release target', () => {
    expect(validateCommandText('HARNESS UPDATE CHECK TO v0.10.4 > APPLY')).toEqual({
      valid: true,
      code: 'VALID_CHAIN',
      domain: 'HARNESS',
      normalized: [
        'HARNESS UPDATE CHECK TO v0.10.4',
        'HARNESS UPDATE APPLY TO v0.10.4',
      ],
      transitions: [
        {
          from: 'HARNESS UPDATE CHECK TO v0.10.4',
          to: 'HARNESS UPDATE APPLY TO v0.10.4',
          onPreviousResult: ['PASS'],
          runtimePreconditions: ['matching-update-target-and-route'],
        },
      ],
    });
  });

  it('parses required and optional free-form input only after a colon', () => {
    expect(parseCanonicalCommand('PROJECT QUICK FIX: исправить опечатку')).toMatchObject({
      valid: true,
      domain: 'PROJECT',
      operation: 'QUICK FIX',
      input: 'исправить опечатку',
      normalized: 'PROJECT QUICK FIX: исправить опечатку',
    });
    expect(parseCanonicalCommand('GIT COMMIT: docs: update protocol')).toMatchObject({
      valid: true,
      domain: 'GIT',
      operation: 'COMMIT',
      input: 'docs: update protocol',
    });
    expect(parseCanonicalCommand('PROJECT QUICK FIX исправить')).toMatchObject({
      valid: false,
      code: 'INVALID_INPUT_SYNTAX',
    });
    expect(parseCanonicalCommand('PROJECT QUICK FIX:')).toMatchObject({
      valid: false,
      code: 'MISSING_INPUT',
    });
  });

  it('rejects cross-domain chains before dispatch', () => {
    expect(validateCommandText('STEP PLAN STEP-024 > GIT CHECK')).toMatchObject({
      valid: false,
      code: 'DOMAIN_MISMATCH',
      segmentIndex: 1,
    });
  });

  it('rejects same-domain ordering that is absent from the transition graph', () => {
    expect(validateCommandText('GIT PUSH > COMMIT')).toMatchObject({
      valid: false,
      code: 'INVALID_CHAIN',
      segmentIndex: 1,
    });
    expect(validateCommandText('STEP REVIEW STEP-024 > IMPLEMENT')).toMatchObject({
      valid: false,
      code: 'INVALID_CHAIN',
      segmentIndex: 1,
    });
  });

  it('rejects target changes and targets introduced after the first segment', () => {
    expect(validateCommandText('STEP PLAN STEP-024 > IMPLEMENT STEP-025')).toMatchObject({
      valid: false,
      code: 'TARGET_MISMATCH',
      segmentIndex: 1,
    });
    expect(validateCommandText('HARNESS UPDATE CHECK > APPLY TO v0.10.4')).toMatchObject({
      valid: false,
      code: 'TARGET_MISMATCH',
      segmentIndex: 1,
    });
  });

  it('rejects standalone-only commands used as a chain', () => {
    expect(validateCommandText('PROJECT INIT > STATUS')).toMatchObject({
      valid: false,
      code: 'CHAIN_NOT_ALLOWED',
    });
    expect(validateCommandText('STEP RUN STEP-024 > REVIEW')).toMatchObject({
      valid: false,
      code: 'CHAIN_NOT_ALLOWED',
      segmentIndex: 0,
    });
  });

  it('keeps the chain separator strict and rejects implicit punctuation', () => {
    expect(validateCommandText('GIT CHECK>COMMIT')).toMatchObject({
      valid: false,
      code: 'UNKNOWN_OPERATION',
      segmentIndex: 0,
    });
    expect(validateCommandText('GIT CHECK >  > COMMIT')).toMatchObject({
      valid: false,
      code: 'EMPTY_SEGMENT',
    });
    expect(parseCanonicalCommand('GIT CHECK > COMMIT')).toMatchObject({
      valid: false,
      code: 'CHAIN_NOT_ALLOWED',
    });
  });
});
