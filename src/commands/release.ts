import path from 'node:path';
import { isReleaseError } from '../core/releases/errors.js';
import { ReleaseStore } from '../core/releases/store.js';

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function handleReleaseCommandError(error: unknown, json: boolean): never {
  if (isReleaseError(error)) {
    if (json) {
      writeJson({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    throw error;
  }
  throw error;
}

export async function releaseInstallCommand(
  source: string,
  cwd: string,
  json = false,
): Promise<void> {
  try {
    const result = await new ReleaseStore().installFromDirectory(path.resolve(cwd, source));
    const output = {
      ok: true,
      release: result.release,
      digest: result.digest,
      root: result.root,
      reused: result.reused,
      installedAt: result.installedAt,
    };

    if (json) {
      writeJson(output);
      return;
    }

    console.log(`${result.reused ? 'Reused' : 'Installed'} Harness release ${result.release}`);
    console.log(`Digest: ${result.digest}`);
    console.log(`Path: ${result.root}`);
  } catch (error) {
    handleReleaseCommandError(error, json);
  }
}

export async function releaseListCommand(json = false): Promise<void> {
  try {
    const releases = await new ReleaseStore().list();
    if (json) {
      writeJson({ ok: true, releases });
      return;
    }

    if (releases.length === 0) {
      console.log('No Harness releases installed.');
      return;
    }

    for (const release of releases) {
      if (release.status === 'valid') {
        console.log(`${release.release}\tvalid\t${release.digest}`);
      } else {
        console.log(`${release.release}\tinvalid\t${release.errorCode}`);
      }
    }
  } catch (error) {
    handleReleaseCommandError(error, json);
  }
}

export async function releaseVerifyCommand(release: string, json = false): Promise<void> {
  try {
    const result = await new ReleaseStore().verify(release);
    const output = {
      ok: true,
      release: result.release,
      digest: result.digest,
      root: result.root,
      installedAt: result.installedAt,
    };

    if (json) {
      writeJson(output);
      return;
    }

    console.log(`Harness release ${result.release} is valid.`);
    console.log(`Digest: ${result.digest}`);
    console.log(`Path: ${result.root}`);
  } catch (error) {
    handleReleaseCommandError(error, json);
  }
}
