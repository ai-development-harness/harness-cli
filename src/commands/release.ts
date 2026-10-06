import path from 'node:path';
import { isReleaseError } from '../core/releases/errors.js';
import { ReleaseStore } from '../core/releases/store.js';
import { jsonFailure, jsonSuccess, setCliExitCode, writeJson } from './presentation.js';

function handleReleaseCommandError(error: unknown, json: boolean): boolean {
  if (!isReleaseError(error) || !json) return false;

  writeJson(jsonFailure('failure', error));
  setCliExitCode('failure');
  return true;
}

export async function releaseInstallCommand(
  source: string,
  cwd: string,
  json = false,
): Promise<void> {
  try {
    const result = await new ReleaseStore().installFromDirectory(path.resolve(cwd, source));
    const output = jsonSuccess({
      release: result.release,
      digest: result.digest,
      root: result.root,
      reused: result.reused,
      installedAt: result.installedAt,
    });

    if (json) {
      writeJson(output);
      return;
    }

    console.log(`${result.reused ? 'Reused' : 'Installed'} Harness release ${result.release}`);
    console.log(`Digest: ${result.digest}`);
    console.log(`Path: ${result.root}`);
  } catch (error) {
    if (!handleReleaseCommandError(error, json)) throw error;
  }
}

export async function releaseListCommand(json = false): Promise<void> {
  try {
    const releases = await new ReleaseStore().list();
    if (json) {
      writeJson(jsonSuccess({ releases }));
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
    if (!handleReleaseCommandError(error, json)) throw error;
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
    if (!handleReleaseCommandError(error, json)) throw error;
  }
}
