import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolveGitPath } from './git.js';

export interface HarnessGlobalPaths {
  data: string;
  releases: string;
  cache: string;
}

export function getHarnessGlobalPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): HarnessGlobalPaths {
  let data: string;

  if (platform === 'win32') {
    data = join(env.LOCALAPPDATA ?? env.APPDATA ?? join(home, 'AppData', 'Local'), 'AI Development Harness');
  } else if (platform === 'darwin') {
    data = join(home, 'Library', 'Application Support', 'ai-development-harness');
  } else {
    data = join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'ai-development-harness');
  }

  const cacheBase =
    platform === 'win32'
      ? env.LOCALAPPDATA ?? env.APPDATA ?? join(home, 'AppData', 'Local')
      : platform === 'darwin'
        ? join(home, 'Library', 'Caches')
        : env.XDG_CACHE_HOME ?? join(home, '.cache');

  return {
    data,
    releases: join(data, 'releases'),
    cache: join(cacheBase, 'ai-development-harness'),
  };
}

export async function ensureGlobalHarnessPaths(): Promise<HarnessGlobalPaths> {
  const paths = getHarnessGlobalPaths();
  await Promise.all([
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.releases, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
  ]);
  return paths;
}

export async function getCloneLocalStatePath(projectRoot: string): Promise<string> {
  return resolveGitPath(projectRoot, 'ai-harness');
}

export async function ensureCloneLocalStatePath(projectRoot: string): Promise<string> {
  const path = await getCloneLocalStatePath(projectRoot);
  await mkdir(path, { recursive: true });
  return path;
}
