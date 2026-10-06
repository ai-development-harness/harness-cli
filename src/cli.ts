#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import {
  releaseInstallCommand,
  releaseListCommand,
  releaseVerifyCommand,
} from './commands/release.js';
import {
  migrationApplyCommand,
  migrationInspectCommand,
  migrationPlanCommand,
  migrationResumeCommand,
  migrationStatusCommand,
} from './commands/migrate.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { validateCommand } from './commands/validate.js';
import { updateApplyCommand, updateCheckCommand } from './commands/update.js';
import { getPackageVersion } from './core/package.js';

const program = new Command();

program
  .name('harness')
  .description('AI Development Harness CLI control plane')
  .version(getPackageVersion());

program
  .command('setup')
  .description('Configure the current Git repository for Harness')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { json?: boolean }) =>
    setupCommand(process.cwd(), { json: options.json ?? false }),
  );

program
  .command('config')
  .description('Show the effective read-only Harness project configuration')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { json?: boolean }) =>
    configCommand(process.cwd(), { json: options.json ?? false }),
  );

program
  .command('doctor')
  .description('Check local Harness prerequisites and project structure')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { json?: boolean }) =>
    doctorCommand(process.cwd(), { json: options.json ?? false }),
  );

program
  .command('validate')
  .description('Validate the pinned Harness release, harness.yaml and project artifact contracts')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { json?: boolean }) =>
    validateCommand(process.cwd(), { json: options.json ?? false }),
  );

program
  .command('status')
  .description('Show deterministic Harness project status and STEP facts')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { json?: boolean }) =>
    statusCommand(process.cwd(), { json: options.json ?? false }),
  );

const update = program
  .command('update')
  .description('Check and apply deterministic Harness release pin updates');

update
  .command('check')
  .description('Check the deterministic Harness update plan without mutating the project')
  .option('--target-release <release>', 'Explicit installed Harness release target')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { targetRelease?: string; json?: boolean }) =>
    updateCheckCommand(process.cwd(), {
      targetRelease: options.targetRelease,
      json: options.json ?? false,
    }),
  );

update
  .command('apply')
  .description('Apply a deterministic Harness release pin update through Core UpdateService')
  .option('--target-release <release>', 'Explicit installed Harness release target')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { targetRelease?: string; json?: boolean }) =>
    updateApplyCommand(process.cwd(), {
      targetRelease: options.targetRelease,
      json: options.json ?? false,
    }),
  );

const migrate = program
  .command('migrate')
  .description('Inspect, plan and execute legacy Harness migrations');

migrate
  .command('inspect')
  .description('Inspect the current repository for legacy Harness migration')
  .option('--from <release>', 'Explicit legacy baseline release, for example v0.10.4')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { from?: string; json?: boolean }) =>
    migrationInspectCommand(process.cwd(), options),
  );

migrate
  .command('plan')
  .description('Build a read-only prepared migration plan')
  .option('--from <release>', 'Explicit legacy baseline release, for example v0.10.4')
  .option('--target-release <release>', 'Explicit target Harness release')
  .option('--out <file>', 'Persist the exact prepared plan for a later apply')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { from?: string; targetRelease?: string; out?: string; json?: boolean }) =>
    migrationPlanCommand(process.cwd(), options),
  );

migrate
  .command('apply')
  .description('Apply an exact previously saved migration plan')
  .requiredOption('--plan <file>', 'Prepared migration plan created by migrate plan --out')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { plan: string; json?: boolean }) =>
    migrationApplyCommand(process.cwd(), options.plan, options.json ?? false),
  );

migrate
  .command('resume')
  .description('Resume an interrupted migration checkpoint')
  .argument('<migration-id>', 'Migration checkpoint id')
  .option('--json', 'Write a machine-readable JSON result')
  .action((migrationId: string, options: { json?: boolean }) =>
    migrationResumeCommand(process.cwd(), migrationId, options.json ?? false),
  );

migrate
  .command('status')
  .description('Show migration checkpoint/recovery diagnostics')
  .argument('[migration-id]', 'Optional migration checkpoint id')
  .option('--json', 'Write a machine-readable JSON result')
  .action((migrationId: string | undefined, options: { json?: boolean }) =>
    migrationStatusCommand(process.cwd(), migrationId, options.json ?? false),
  );

const release = program
  .command('release')
  .description('Manage installed Harness releases');

release
  .command('install')
  .description('Install a verified Harness release tree from a local directory')
  .argument('<directory>', 'Path to an unpacked Harness release tree')
  .option('--json', 'Write a machine-readable JSON result')
  .action((directory: string, options: { json?: boolean }) =>
    releaseInstallCommand(directory, process.cwd(), options.json ?? false),
  );

release
  .command('list')
  .description('List installed Harness releases')
  .option('--json', 'Write a machine-readable JSON result')
  .action((options: { json?: boolean }) => releaseListCommand(options.json ?? false));

release
  .command('verify')
  .description('Verify an installed Harness release')
  .argument('<version>', 'Harness release version')
  .option('--json', 'Write a machine-readable JSON result')
  .action((version: string, options: { json?: boolean }) =>
    releaseVerifyCommand(version, options.json ?? false),
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
}
