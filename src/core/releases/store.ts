import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { globalHarnessPaths } from '../paths.js';
import { ReleaseError, isReleaseError, type ReleaseErrorCode } from './errors.js';
import type { ReleaseManifest } from './manifest.js';
import { compareSemver, parseSemver } from './semver.js';
import { verifyReleaseTree } from './verifier.js';

interface ReleaseStoreRecord {
  schemaVersion: 1;
  release: string;
  digest: string;
  installedAt: string;
}

export interface InstalledRelease {
  release: string;
  digest: string;
  root: string;
  installedAt: string;
  manifest: ReleaseManifest;
}

export interface InstallReleaseResult extends InstalledRelease {
  reused: boolean;
}

export interface ReleaseListEntry {
  release: string;
  status: 'valid' | 'invalid';
  digest: string | null;
  errorCode: ReleaseErrorCode | null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseRecord(raw: string, expectedRelease: string): ReleaseStoreRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ReleaseError('RELEASE_CORRUPT', `Invalid store record for Harness release ${expectedRelease}.`, {
      cause: (error as Error).message,
    });
  }

  if (typeof value !== 'object' || value === null) {
    throw new ReleaseError('RELEASE_CORRUPT', `Invalid store record for Harness release ${expectedRelease}.`);
  }

  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.release !== expectedRelease ||
    !assertDigest(record.digest) ||
    typeof record.installedAt !== 'string' ||
    Number.isNaN(Date.parse(record.installedAt))
  ) {
    throw new ReleaseError('RELEASE_CORRUPT', `Invalid store record for Harness release ${expectedRelease}.`);
  }

  return {
    schemaVersion: 1,
    release: expectedRelease,
    digest: record.digest,
    installedAt: record.installedAt,
  };
}

export class ReleaseStore {
  readonly releasesRoot: string;
  readonly stateRoot: string;
  readonly recordsRoot: string;
  readonly stagingRoot: string;

  constructor(readonly dataRoot: string = globalHarnessPaths().data) {
    this.releasesRoot = path.join(dataRoot, 'releases');
    this.stateRoot = path.join(dataRoot, 'store-state');
    this.recordsRoot = path.join(this.stateRoot, 'releases');
    this.stagingRoot = path.join(this.stateRoot, 'staging');
  }

  releaseRoot(release: string): string {
    parseSemver(release);
    return path.join(this.releasesRoot, release);
  }

  private recordPath(release: string): string {
    parseSemver(release);
    return path.join(this.recordsRoot, `${release}.json`);
  }

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.releasesRoot, { recursive: true }),
      mkdir(this.recordsRoot, { recursive: true }),
      mkdir(this.stagingRoot, { recursive: true }),
    ]);
  }

  private async readRecord(release: string): Promise<ReleaseStoreRecord | null> {
    const target = this.recordPath(release);
    try {
      return parseRecord(await readFile(target, 'utf8'), release);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeRecord(record: ReleaseStoreRecord): Promise<ReleaseStoreRecord> {
    await mkdir(this.recordsRoot, { recursive: true });
    const target = this.recordPath(record.release);
    let handle;

    try {
      handle = await open(target, 'wx');
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await handle.sync();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await this.readRecord(record.release);
        if (existing && existing.digest === record.digest) return existing;
        throw new ReleaseError(
          'RELEASE_IDENTITY_CONFLICT',
          `Harness release ${record.release} already has a different store identity.`,
          { release: record.release, expectedDigest: record.digest, actualDigest: existing?.digest ?? null },
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async installFromDirectory(sourceRoot: string): Promise<InstallReleaseResult> {
    const source = await verifyReleaseTree(sourceRoot);
    const release = source.manifest.release;
    await this.ensureLayout();

    const targetRoot = this.releaseRoot(release);
    const existingTarget = await exists(targetRoot);
    const existingRecord = await this.readRecord(release);

    if (existingTarget) {
      const installedTree = await verifyReleaseTree(targetRoot, release);
      if (installedTree.digest !== source.digest) {
        throw new ReleaseError(
          'RELEASE_IDENTITY_CONFLICT',
          `Harness release ${release} is already installed with different content.`,
          { release, installedDigest: installedTree.digest, incomingDigest: source.digest },
        );
      }

      if (existingRecord && existingRecord.digest !== installedTree.digest) {
        throw new ReleaseError('RELEASE_CORRUPT', `Store record digest mismatch for Harness release ${release}.`, {
          release,
          recordDigest: existingRecord.digest,
          actualDigest: installedTree.digest,
        });
      }

      const record = existingRecord ??
        (await this.writeRecord({
          schemaVersion: 1,
          release,
          digest: installedTree.digest,
          installedAt: new Date().toISOString(),
        }));

      return {
        release,
        digest: installedTree.digest,
        root: targetRoot,
        installedAt: record.installedAt,
        manifest: installedTree.manifest,
        reused: true,
      };
    }

    if (existingRecord) {
      throw new ReleaseError('RELEASE_CORRUPT', `Store record exists but release tree is missing: ${release}.`, {
        release,
        recordDigest: existingRecord.digest,
      });
    }

    const stagingRoot = path.join(this.stagingRoot, `${release}-${randomUUID()}`);
    try {
      await cp(sourceRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false });
      const staged = await verifyReleaseTree(stagingRoot, release);
      if (staged.digest !== source.digest) {
        throw new ReleaseError('RELEASE_CORRUPT', `Staged Harness release changed during installation: ${release}.`, {
          sourceDigest: source.digest,
          stagedDigest: staged.digest,
        });
      }

      try {
        await rename(stagingRoot, targetRoot);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '') || !(await exists(targetRoot))) throw error;

        const raced = await verifyReleaseTree(targetRoot, release);
        if (raced.digest !== source.digest) {
          throw new ReleaseError(
            'RELEASE_IDENTITY_CONFLICT',
            `Concurrent installation published different content for Harness release ${release}.`,
            { release, installedDigest: raced.digest, incomingDigest: source.digest },
          );
        }
      }

      const installed = await verifyReleaseTree(targetRoot, release);
      const record = await this.writeRecord({
        schemaVersion: 1,
        release,
        digest: installed.digest,
        installedAt: new Date().toISOString(),
      });

      return {
        release,
        digest: installed.digest,
        root: targetRoot,
        installedAt: record.installedAt,
        manifest: installed.manifest,
        reused: false,
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async verify(release: string): Promise<InstalledRelease> {
    const targetRoot = this.releaseRoot(release);
    const targetExists = await exists(targetRoot);
    const record = await this.readRecord(release);

    if (!targetExists && !record) {
      throw new ReleaseError('RELEASE_MISSING', `Harness release ${release} is not installed.`, { release });
    }

    if (!targetExists || !record) {
      throw new ReleaseError('RELEASE_CORRUPT', `Harness release ${release} has incomplete store state.`, {
        release,
        releaseTreeExists: targetExists,
        storeRecordExists: record !== null,
      });
    }

    let verified;
    try {
      verified = await verifyReleaseTree(targetRoot, release);
    } catch (error) {
      if (isReleaseError(error)) throw error;
      throw new ReleaseError('RELEASE_CORRUPT', `Could not verify Harness release ${release}.`, {
        release,
        cause: (error as Error).message,
      });
    }

    if (verified.digest !== record.digest) {
      throw new ReleaseError('RELEASE_CORRUPT', `Harness release ${release} metadata digest changed after installation.`, {
        release,
        expectedDigest: record.digest,
        actualDigest: verified.digest,
      });
    }

    return {
      release,
      digest: verified.digest,
      root: targetRoot,
      installedAt: record.installedAt,
      manifest: verified.manifest,
    };
  }

  async list(): Promise<ReleaseListEntry[]> {
    await this.ensureLayout();
    const versions = new Set<string>();

    for (const entry of await readdir(this.releasesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        parseSemver(entry.name);
        versions.add(entry.name);
      } catch {
        // Unknown directories are not installed Harness releases.
      }
    }

    for (const entry of await readdir(this.recordsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const version = entry.name.slice(0, -'.json'.length);
      try {
        parseSemver(version);
        versions.add(version);
      } catch {
        // Unknown record files are ignored by the release inventory.
      }
    }

    const ordered = [...versions].sort(compareSemver);
    const result: ReleaseListEntry[] = [];

    for (const release of ordered) {
      try {
        const installed = await this.verify(release);
        result.push({ release, status: 'valid', digest: installed.digest, errorCode: null });
      } catch (error) {
        result.push({
          release,
          status: 'invalid',
          digest: null,
          errorCode: isReleaseError(error) ? error.code : 'RELEASE_CORRUPT',
        });
      }
    }

    return result;
  }
}
