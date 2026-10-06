import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

export async function atomicWriteText(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export function renderDocument(
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
): string {
  return '---\n' + YAML.stringify(frontmatter).trimEnd() + '\n---\n' + body.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

export function replaceH2Section(text: string, title: string, value: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let fence: string | null = null;
  let start = -1;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trimStart();
    const fenceMatch = /^(\x60{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    if (fence !== null) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
    if (!heading) continue;
    if (start < 0 && heading[1] === title) {
      start = index;
      continue;
    }
    if (start >= 0) {
      end = index;
      break;
    }
  }

  if (start < 0) throw new Error("missing section '## " + title + "'");
  const replacement = ['## ' + title, '', value.trim(), ''];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join('\n').replace(/\n+$/, '\n');
}
