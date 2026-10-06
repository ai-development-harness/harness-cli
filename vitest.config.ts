import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git/filesystem-heavy suites spawn many short-lived child processes and
    // assemble real immutable releases. Windows CI is materially slower than
    // Unix runners for these operations, so Vitest's 5-second defaults cause
    // false-negative timeout flakes.
    //
    // Keep one repository-wide timeout budget instead of scattering arbitrary
    // per-test overrides. Tests with an explicit timeout still keep that local
    // contract.
    testTimeout: 60_000,
    hookTimeout: 60_000,

    // Parallel file execution is reliable on Unix runners, but on Windows the
    // additional process/filesystem contention can make real Git/worktree
    // scenarios unnecessarily unstable and can leave handles open during
    // cleanup.
    fileParallelism: process.platform !== 'win32',
  },
});
