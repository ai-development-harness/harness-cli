import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git/filesystem-heavy suites spawn many short-lived child processes.
    // Running files in parallel is reliable on Unix runners, but on Windows
    // the extra process/filesystem contention can push otherwise healthy
    // migration tests past their intentionally tight per-test timeouts and
    // leave Git handles open long enough for cleanup to hit EBUSY.
    //
    // Keep the normal parallel execution everywhere else. On Windows,
    // serialize test files so timeout failures continue to mean a genuinely
    // slow/hung test instead of runner contention.
    fileParallelism: process.platform !== 'win32',
  },
});
