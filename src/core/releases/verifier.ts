import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ReleaseError } from './errors.js';
import { releaseManifestSchema, type ReleaseManifest, type VerifiedReleaseTree } from './manifest.js';

const REQUIRED_COMPONENTS = ['core', 'protocol', 'schemas', 'skills', 'docs'] as const;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

function corrupt(message: string, details: Record<string, unknown> = {}): never {
  throw new ReleaseError('RELEASE_CORRUPT', message, details);
}

export function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function assertPortableReleasePath(value: string, label: string): void {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    corrupt(`Invalid ${label} path: ${value}`, { path: value });
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    corrupt(`Invalid ${label} path segments: ${value}`, { path: value });
  }

  for (const segment of segments) {
    if (segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_INVALID_CHARS.test(segment)) {
      corrupt(`Path is not portable to Windows: ${value}`, { path: value });
    }

    if (WINDOWS_RESERVED_NAME.test(segment)) {
      corrupt(`Path uses a reserved Windows name: ${value}`, { path: value });
    }
  }
}

function absoluteReleasePath(root: string, portablePath: string): string {
  return path.join(root, ...portablePath.split('/'));
}

async function collectPayloadFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = relativeDirectory
      ? absoluteReleasePath(root, relativeDirectory)
      : root;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertPortableReleasePath(relativePath, 'payload');

      const absolutePath = absoluteReleasePath(root, relativePath);
      const metadata = await lstat(absolutePath);

      if (metadata.isSymbolicLink()) {
        corrupt(`Symbolic links are not allowed in a Harness release: ${relativePath}`, { path: relativePath });
      }

      if (metadata.isDirectory()) {
        await walk(relativePath);
        continue;
      }

      if (!metadata.isFile()) {
        corrupt(`Special files are not allowed in a Harness release: ${relativePath}`, { path: relativePath });
      }

      if (metadata.nlink > 1) {
        corrupt(`Hard-linked files are not allowed in a Harness release: ${relativePath}`, { path: relativePath });
      }

      if (relativePath !== 'release.json') files.push(relativePath);
    }
  }

  await walk('');
  return files.sort((left, right) => left.localeCompare(right));
}

function validateUniquePortablePaths(paths: string[], label: string): void {
  const exact = new Set<string>();
  const folded = new Map<string, string>();

  for (const value of paths) {
    assertPortableReleasePath(value, label);

    if (exact.has(value)) corrupt(`Duplicate ${label} path: ${value}`, { path: value });
    exact.add(value);

    const key = value.toLocaleLowerCase('en-US');
    const previous = folded.get(key);
    if (previous && previous !== value) {
      corrupt(`Case-insensitive path collision: ${previous} vs ${value}`, { paths: [previous, value] });
    }
    folded.set(key, value);
  }
}

async function parseManifest(root: string): Promise<{ bytes: Buffer; manifest: ReleaseManifest }> {
  const metadataPath = path.join(root, 'release.json');
  let bytes: Buffer;

  try {
    const metadata = await lstat(metadataPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      corrupt('release.json must be an ordinary non-linked file.');
    }
    bytes = await readFile(metadataPath);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    corrupt('release.json is missing or unreadable.', { cause: (error as Error).message });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    corrupt('release.json is not valid UTF-8 JSON.', { cause: (error as Error).message });
  }

  if (
    typeof raw === 'object' &&
    raw !== null &&
    'formatVersion' in raw &&
    (raw as { formatVersion?: unknown }).formatVersion !== 1
  ) {
    throw new ReleaseError('UNSUPPORTED_RELEASE_FORMAT', 'Unsupported Harness release format.', {
      formatVersion: (raw as { formatVersion?: unknown }).formatVersion,
    });
  }

  const parsed = releaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    corrupt('release.json does not match formatVersion 1.', { issues: parsed.error.issues });
  }

  return { bytes, manifest: parsed.data };
}

export async function verifyReleaseTree(
  root: string,
  expectedRelease?: string,
): Promise<VerifiedReleaseTree> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    corrupt('Harness release root is missing or unreadable.', { root, cause: (error as Error).message });
  }

  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    corrupt('Harness release root must be a real directory.', { root });
  }

  const { bytes: manifestBytes, manifest } = await parseManifest(root);

  if (expectedRelease !== undefined && manifest.release !== expectedRelease) {
    corrupt(`Release metadata identifies ${manifest.release}, expected ${expectedRelease}.`, {
      expectedRelease,
      actualRelease: manifest.release,
    });
  }

  const componentIds = new Set<string>();
  const componentPaths: string[] = [];
  for (const component of manifest.components) {
    if (componentIds.has(component.id)) {
      corrupt(`Duplicate component id: ${component.id}`, { componentId: component.id });
    }
    componentIds.add(component.id);
    componentPaths.push(component.path);
    assertPortableReleasePath(component.path, 'component');

    let metadata;
    try {
      metadata = await lstat(absoluteReleasePath(root, component.path));
    } catch {
      corrupt(`Declared component path is missing: ${component.path}`, { component: component.id });
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      corrupt(`Declared component path is not a real directory: ${component.path}`, { component: component.id });
    }
  }
  validateUniquePortablePaths(componentPaths, 'component');

  for (const requiredId of REQUIRED_COMPONENTS) {
    const component = manifest.components.find((entry) => entry.id === requiredId);
    if (!component || !component.required) {
      corrupt(`Required release component is missing: ${requiredId}`, { component: requiredId });
    }
  }

  const declaredPaths = manifest.files.map((entry) => entry.path);
  if (declaredPaths.includes('release.json')) {
    corrupt('release.json must not be included in the payload file inventory.');
  }
  validateUniquePortablePaths(declaredPaths, 'file');

  const sortedDeclared = [...declaredPaths].sort((left, right) => left.localeCompare(right));
  if (sortedDeclared.some((value, index) => value !== declaredPaths[index])) {
    corrupt('release.json files inventory must be sorted lexicographically by path.');
  }

  assertPortableReleasePath(manifest.entrypoints.core, 'core entrypoint');
  const coreComponent = manifest.components.find((entry) => entry.id === 'core')!;
  const corePrefix = `${coreComponent.path}/`;
  if (!manifest.entrypoints.core.startsWith(corePrefix) || !declaredPaths.includes(manifest.entrypoints.core)) {
    corrupt('Core entrypoint must be a declared payload file inside the core component.', {
      entrypoint: manifest.entrypoints.core,
    });
  }

  const actualPaths = await collectPayloadFiles(root);
  if (actualPaths.length !== sortedDeclared.length) {
    corrupt('Release payload inventory does not match files on disk.', {
      declared: sortedDeclared,
      actual: actualPaths,
    });
  }

  for (let index = 0; index < sortedDeclared.length; index += 1) {
    if (sortedDeclared[index] !== actualPaths[index]) {
      corrupt('Release payload inventory does not match files on disk.', {
        declared: sortedDeclared,
        actual: actualPaths,
      });
    }
  }

  const filesByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const relativePath of actualPaths) {
    const expected = filesByPath.get(relativePath)!;
    const content = await readFile(absoluteReleasePath(root, relativePath));
    if (content.byteLength !== expected.size) {
      corrupt(`Payload size mismatch: ${relativePath}`, {
        path: relativePath,
        expected: expected.size,
        actual: content.byteLength,
      });
    }

    const actualHash = sha256(content);
    if (actualHash !== expected.sha256) {
      corrupt(`Payload SHA-256 mismatch: ${relativePath}`, {
        path: relativePath,
        expected: expected.sha256,
        actual: actualHash,
      });
    }
  }

  for (const requiredId of REQUIRED_COMPONENTS) {
    const component = manifest.components.find((entry) => entry.id === requiredId)!;
    const prefix = `${component.path}/`;
    if (!declaredPaths.some((entry) => entry.startsWith(prefix))) {
      corrupt(`Required component has no declared payload files: ${requiredId}`, { component: requiredId });
    }
  }

  return {
    root,
    digest: sha256(manifestBytes),
    manifest,
  };
}
