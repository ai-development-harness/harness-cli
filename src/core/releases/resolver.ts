import { HOST_API_VERSION } from '../host/contract.js';
import { getPackageVersion } from '../package.js';
import { ReleaseError } from './errors.js';
import { isSemverInRange } from './semver.js';
import { ReleaseStore, type InstalledRelease } from './store.js';

export interface ResolveReleaseOptions {
  cliVersion?: string;
  hostApiVersion?: number;
}

export interface ResolvedRelease extends InstalledRelease {
  status: 'resolved';
}

export async function resolvePinnedRelease(
  store: ReleaseStore,
  release: string,
  projectSchemaVersion: number,
  options: ResolveReleaseOptions = {},
): Promise<ResolvedRelease> {
  const installed = await store.verify(release);
  const compatibility = installed.manifest.compatibility;
  const cliVersion = options.cliVersion ?? getPackageVersion();
  const hostApiVersion = options.hostApiVersion ?? HOST_API_VERSION;

  if (!isSemverInRange(cliVersion, compatibility.cli.minVersion, compatibility.cli.maxVersionExclusive)) {
    throw new ReleaseError(
      'RELEASE_INCOMPATIBLE_CLI',
      `Harness release ${release} is incompatible with CLI ${cliVersion}.`,
      {
        release,
        cliVersion,
        minVersion: compatibility.cli.minVersion,
        maxVersionExclusive: compatibility.cli.maxVersionExclusive,
      },
    );
  }

  if (hostApiVersion < compatibility.hostApi.minVersion || hostApiVersion > compatibility.hostApi.maxVersion) {
    throw new ReleaseError(
      'RELEASE_INCOMPATIBLE_HOST_API',
      `Harness release ${release} is incompatible with Host API ${hostApiVersion}.`,
      {
        release,
        hostApiVersion,
        minVersion: compatibility.hostApi.minVersion,
        maxVersion: compatibility.hostApi.maxVersion,
      },
    );
  }

  if (!compatibility.projectSchema.supported.includes(projectSchemaVersion)) {
    if (compatibility.projectSchema.migrateFrom.includes(projectSchemaVersion)) {
      throw new ReleaseError(
        'PROJECT_SCHEMA_MIGRATION_REQUIRED',
        `Harness release ${release} requires project schema migration from ${projectSchemaVersion} to ${compatibility.projectSchema.target}.`,
        {
          release,
          projectSchemaVersion,
          targetSchemaVersion: compatibility.projectSchema.target,
        },
      );
    }

    throw new ReleaseError(
      'RELEASE_INCOMPATIBLE_PROJECT_SCHEMA',
      `Harness release ${release} does not support project schema ${projectSchemaVersion}.`,
      {
        release,
        projectSchemaVersion,
        supported: compatibility.projectSchema.supported,
      },
    );
  }

  return { ...installed, status: 'resolved' };
}

export { HOST_API_VERSION } from '../host/contract.js';
