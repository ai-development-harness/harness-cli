#!/usr/bin/env node
import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { validateCommand } from './commands/validate.js';
import { getPackageVersion } from './core/package.js';

const program = new Command();

program
  .name('harness')
  .description('AI Development Harness CLI control plane')
  .version(getPackageVersion());

program
  .command('setup')
  .description('Configure the current Git repository for Harness')
  .action(() => setupCommand(process.cwd()));

program
  .command('doctor')
  .description('Check local Harness prerequisites and project structure')
  .action(() => doctorCommand(process.cwd()));

program
  .command('validate')
  .description('Validate harness.yaml')
  .action(() => validateCommand(process.cwd()));

program
  .command('status')
  .description('Show Harness project status')
  .action(() => statusCommand(process.cwd()));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
}
