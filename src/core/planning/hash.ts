import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function normalizeText(value: string): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, ''));
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim().length === 0) lines.pop();
  return lines.join('\n');
}

export function contentHash(value: string): string {
  return `sha256:${createHash('sha256').update(normalizeText(value), 'utf8').digest('hex')}`;
}

export function stableHash(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value);
}
