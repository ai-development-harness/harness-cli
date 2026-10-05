import { PROTOCOL_MODEL } from './model.js';
import type { ProtocolModel } from './schema.js';

export function canonicalCommands(model: ProtocolModel = PROTOCOL_MODEL): string[] {
  return Object.values(model.domains).flatMap((domain) =>
    Object.values(domain.commands).map((command) => command.canonical),
  );
}

export function authorityContract(model: ProtocolModel = PROTOCOL_MODEL) {
  return { ...model.authorityContract };
}

export function dispatchSpec(
  domain: string,
  operation: string,
  model: ProtocolModel = PROTOCOL_MODEL,
) {
  const command = model.domains[domain]?.commands[operation];
  return command ? { ...command.dispatch } : null;
}

export function helpCatalog(model: ProtocolModel = PROTOCOL_MODEL) {
  return Object.entries(model.domains).map(([domain, spec]) => ({
    domain,
    commands: Object.values(spec.commands).map((command) => ({
      canonical: command.canonical,
      summary: command.summary,
      documentation: command.documentation,
    })),
  }));
}

export function reasoningProjection(model: ProtocolModel = PROTOCOL_MODEL) {
  const commands = Object.entries(model.domains).flatMap(([domain, spec]) =>
    Object.entries(spec.commands).map(([operation, command]) => ({
      command: command.canonical,
      domain,
      operation,
      summary: command.summary,
      documentation: command.documentation,
      dispatch: { ...command.dispatch },
      reasoning: {
        mode: command.reasoning.mode,
        modelWork: [...command.reasoning.modelWork],
        deterministicWork: [...command.reasoning.deterministicWork],
        fastPaths: command.reasoning.fastPaths.map((fastPath) => ({ ...fastPath })),
      },
    })),
  );

  return {
    schemaVersion: 1 as const,
    classification: {
      scope: 'command-node' as const,
      source: 'canonical-protocol-model' as const,
    },
    summary: {
      total: commands.length,
      none: commands.filter((item) => item.reasoning.mode === 'none').length,
      required: commands.filter((item) => item.reasoning.mode === 'required').length,
      conditional: commands.filter((item) => item.reasoning.mode === 'conditional').length,
    },
    commands,
  };
}

export function transitionRows(model: ProtocolModel = PROTOCOL_MODEL) {
  const rows: {
    command: string;
    chain: 'yes' | 'no';
    next: string;
    condition: string;
  }[] = [];

  for (const [domainName, domain] of Object.entries(model.domains)) {
    for (const [operation, command] of Object.entries(domain.commands)) {
      const outgoing = domain.transitions.filter((edge) => edge.from === operation);
      if (!command.chainAllowed) {
        rows.push({
          command: command.canonical,
          chain: 'no',
          next: '—',
          condition: 'standalone-only',
        });
        continue;
      }

      if (outgoing.length === 0) {
        rows.push({
          command: command.canonical,
          chain: 'yes',
          next: '—',
          condition: 'terminal chain segment',
        });
        continue;
      }

      rows.push({
        command: command.canonical,
        chain: 'yes',
        next: outgoing.map((edge) => `${domainName} ${edge.to}`).join('<br>'),
        condition: outgoing
          .map((edge) => {
            const result = edge.onPreviousResult.join('/');
            const pre = edge.runtimePreconditions.join(', ') || '—';
            return `${edge.to}: result=${result}; pre=${pre}`;
          })
          .join('<br>'),
      });
    }
  }
  return rows;
}
