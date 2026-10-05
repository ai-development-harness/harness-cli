#!/usr/bin/env node

import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { validateCommand } from './commands/validate.js';

const program = new Command();

program
  .name('harness')
  .description('CLI control plane for AI Development Harness')
  .version('0.1.0');

program.command('setup').description('Bootstrap Harness metadata in the current Git repository').action(() => setupCommand());
program.command('doctor').description('Check Harness prerequisites and project paths').action(() => doctorCommand());
program.command('validate').description('Validate harness.yaml').action(() => validateCommand());
program.command('status').description('Show the current Harness project status').action(() => statusCommand());

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
