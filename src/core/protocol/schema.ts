import { z } from 'zod';

export const AUTHORITY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  semanticResult: 'proposal',
  executionStateCommit: 'dispatcher',
  transitionCommit: 'dispatcher',
  canonicalArtifactCommit: 'deterministic-writer',
  sideEffectCommit: 'deterministic-action',
} as const);

export const VALIDATION_ORDER = Object.freeze([
  'tokenize',
  'normalize',
  'transition-table',
  'runtime-preconditions',
  'dispatch',
] as const);

export const CHAIN_SEPARATOR = ' > ' as const;

export const TARGET_KINDS = ['none', 'step', 'release-optional'] as const;
export const INPUT_MODES = ['none', 'optional', 'required'] as const;
export const COMMAND_RESULTS = ['PASS', 'SUCCESS', 'FAIL', 'BLOCKED'] as const;
export const DISPATCH_KINDS = ['deterministic', 'semantic'] as const;
export const CONTEXT_PHASES = ['plan', 'implement', 'review'] as const;
export const REASONING_MODES = ['none', 'required', 'conditional'] as const;

export const RUNTIME_PRECONDITIONS = [
  'matching-update-target-and-route',
  'step-implement-ready',
  'git-push-ready',
  'git-pr-ready',
] as const;

export const DETERMINISTIC_HANDLERS = [
  'harness-help',
  'harness-status',
  'harness-resume',
  'harness-doctor',
  'harness-config',
  'harness-update-check',
  'harness-update-apply',
  'project-status',
  'step-list',
  'step-show',
  'step-next',
  'git-check',
  'git-pr-finish',
  'git-sync',
] as const;

const nonEmptyText = z.string().trim().min(1);

const authorityContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    semanticResult: z.literal('proposal'),
    executionStateCommit: z.literal('dispatcher'),
    transitionCommit: z.literal('dispatcher'),
    canonicalArtifactCommit: z.literal('deterministic-writer'),
    sideEffectCommit: z.literal('deterministic-action'),
  })
  .strict();

const deterministicDispatchSchema = z
  .object({
    kind: z.literal('deterministic'),
    handler: z.enum(DETERMINISTIC_HANDLERS),
  })
  .strict();

const semanticDispatchSchema = z
  .object({
    kind: z.literal('semantic'),
    skill: nonEmptyText,
    contextPhase: z.enum(CONTEXT_PHASES).optional(),
  })
  .strict();

const dispatchSchema = z.discriminatedUnion('kind', [
  deterministicDispatchSchema,
  semanticDispatchSchema,
]);

const fastPathSchema = z
  .object({
    id: nonEmptyText,
    description: nonEmptyText,
    implementation: z
      .string()
      .regex(/^\.harness\/tools\/[A-Za-z0-9_.-]+\.py::[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();

const reasoningSchema = z
  .object({
    mode: z.enum(REASONING_MODES),
    modelWork: z.array(nonEmptyText),
    deterministicWork: z.array(nonEmptyText).min(1),
    fastPaths: z.array(fastPathSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const fastPathIds = new Set<string>();
    value.fastPaths.forEach((fastPath, index) => {
      if (fastPathIds.has(fastPath.id)) {
        context.addIssue({
          code: 'custom',
          path: ['fastPaths', index, 'id'],
          message: 'fastPath id must be unique within command',
        });
      }
      fastPathIds.add(fastPath.id);
    });

    if (value.mode === 'none') {
      if (value.modelWork.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['modelWork'],
          message: 'reasoning.mode=none requires empty modelWork',
        });
      }
      if (value.fastPaths.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['fastPaths'],
          message: 'reasoning.mode=none requires empty fastPaths',
        });
      }
    }

    if (value.mode === 'required') {
      if (value.modelWork.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['modelWork'],
          message: 'reasoning.mode=required requires non-empty modelWork',
        });
      }
      if (value.fastPaths.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['fastPaths'],
          message: 'reasoning.mode=required requires empty fastPaths',
        });
      }
    }

    if (value.mode === 'conditional') {
      if (value.modelWork.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['modelWork'],
          message: 'reasoning.mode=conditional requires non-empty modelWork',
        });
      }
      if (value.fastPaths.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['fastPaths'],
          message: 'reasoning.mode=conditional requires at least one fastPath',
        });
      }
    }
  });

const commandSchema = z
  .object({
    canonical: nonEmptyText,
    chainAllowed: z.boolean(),
    target: z.enum(TARGET_KINDS),
    input: z.enum(INPUT_MODES),
    summary: nonEmptyText,
    documentation: nonEmptyText,
    dispatch: dispatchSchema,
    reasoning: reasoningSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dispatch.kind === 'deterministic' && value.reasoning.mode !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['reasoning', 'mode'],
        message: 'deterministic dispatch requires reasoning.mode=none',
      });
    }
    if (value.dispatch.kind === 'semantic' && value.reasoning.mode === 'none') {
      context.addIssue({
        code: 'custom',
        path: ['reasoning', 'mode'],
        message: 'semantic dispatch cannot use reasoning.mode=none',
      });
    }
  });

const transitionSchema = z
  .object({
    from: nonEmptyText,
    to: nonEmptyText,
    onPreviousResult: z.array(z.enum(COMMAND_RESULTS)).min(1),
    runtimePreconditions: z.array(z.enum(RUNTIME_PRECONDITIONS)),
  })
  .strict();

const domainSchema = z
  .object({
    chainEnabled: z.boolean(),
    inheritTarget: z.boolean(),
    continuationAliases: z.record(nonEmptyText, nonEmptyText),
    commands: z.record(nonEmptyText, commandSchema),
    transitions: z.array(transitionSchema),
  })
  .strict();

export const protocolModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorityContract: authorityContractSchema,
    validationOrder: z.tuple([
      z.literal('tokenize'),
      z.literal('normalize'),
      z.literal('transition-table'),
      z.literal('runtime-preconditions'),
      z.literal('dispatch'),
    ]),
    chainSeparator: z.literal(CHAIN_SEPARATOR),
    domains: z.record(z.string().regex(/^[A-Z]+$/), domainSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const canonicalCommands = new Set<string>();

    if (Object.keys(value.domains).length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['domains'],
        message: 'domains must be a non-empty object',
      });
    }

    for (const [domainName, domain] of Object.entries(value.domains)) {
      const commands = domain.commands;
      if (Object.keys(commands).length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['domains', domainName, 'commands'],
          message: 'commands must be a non-empty object',
        });
      }

      for (const [operation, command] of Object.entries(commands)) {
        const commandPath = ['domains', domainName, 'commands', operation] as const;

        if (!command.canonical.startsWith(`${domainName} `)) {
          context.addIssue({
            code: 'custom',
            path: [...commandPath, 'canonical'],
            message: `canonical command must start with '${domainName} '`,
          });
        }

        if (canonicalCommands.has(command.canonical)) {
          context.addIssue({
            code: 'custom',
            path: [...commandPath, 'canonical'],
            message: `duplicate canonical command: ${command.canonical}`,
          });
        }
        canonicalCommands.add(command.canonical);

        if (command.chainAllowed && !domain.chainEnabled) {
          context.addIssue({
            code: 'custom',
            path: [...commandPath, 'chainAllowed'],
            message: 'standalone-only domain cannot contain a chain-enabled command',
          });
        }
      }

      for (const [alias, operation] of Object.entries(domain.continuationAliases)) {
        if (!(operation in commands)) {
          context.addIssue({
            code: 'custom',
            path: ['domains', domainName, 'continuationAliases', alias],
            message: `continuation alias points to unknown operation: ${operation}`,
          });
        }
      }

      const edges = new Set<string>();
      domain.transitions.forEach((transition, index) => {
        const edgePath = ['domains', domainName, 'transitions', index] as const;
        const source = commands[transition.from];
        const target = commands[transition.to];

        if (!source || !target) {
          context.addIssue({
            code: 'custom',
            path: edgePath,
            message: `transition references unknown operation: ${transition.from} -> ${transition.to}`,
          });
          return;
        }

        if (!source.chainAllowed || !target.chainAllowed) {
          context.addIssue({
            code: 'custom',
            path: edgePath,
            message: `transition uses standalone-only command: ${transition.from} -> ${transition.to}`,
          });
        }

        const edgeId = `${transition.from}\u0000${transition.to}`;
        if (edges.has(edgeId)) {
          context.addIssue({
            code: 'custom',
            path: edgePath,
            message: `duplicate transition: ${transition.from} -> ${transition.to}`,
          });
        }
        edges.add(edgeId);
      });

      if (!domain.chainEnabled && domain.transitions.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['domains', domainName, 'transitions'],
          message: 'standalone-only domain must not define transitions',
        });
      }
    }
  });

export type ProtocolModel = z.infer<typeof protocolModelSchema>;
export type ProtocolDomain = ProtocolModel['domains'][string];
export type CommandSpec = ProtocolDomain['commands'][string];
export type TransitionSpec = ProtocolDomain['transitions'][number];
export type CommandResult = (typeof COMMAND_RESULTS)[number];
export type ReasoningMode = (typeof REASONING_MODES)[number];

export function validateProtocolModel(value: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const parsed = protocolModelSchema.safeParse(value);
  if (parsed.success) return { valid: true, errors: [] };

  return {
    valid: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? ` ${issue.path.join('.')}` : '';
      return `command-transitions:${path} ${issue.message}`;
    }),
  };
}
