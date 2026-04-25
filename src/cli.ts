#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';

import { WorkspaceManager } from './workspace/WorkspaceManager';
import { SandboxManager } from './sandbox/SandboxManager';
import { AgentRunner } from './agents/AgentRunner';
import { getAgent, listAgents } from './agents/registry';
import { DiffExtractor } from './diff/DiffExtractor';
import { ApprovalUI } from './approval/ApprovalUI';
import { Applier } from './approval/Applier';
import { log, setLevel } from './utils/logger';
import { printPlatformInfo, detectSandboxBackend, detectWorkspaceStrategy } from './utils/platform';
import type { SandboxBackendType } from './utils/platform';
import type { WorkspacePaths } from './workspace/WorkspaceManager';

const program = new Command();

program
  .name('agentbox')
  .description('Run AI coding agents inside a strict filesystem sandbox')
  .version('0.1.0');

// ──────────────────────────────────────────────
// agentbox run <folder>
// ──────────────────────────────────────────────
program
  .command('run <folder>')
  .description('Run an AI coding agent inside a sandbox scoped to <folder>')
  .option('-a, --agent <name>', 'agent to run: claude (default), codex, aider, ...', 'claude')
  .option('-b, --backend <type>', 'sandbox backend: bubblewrap | sandbox-exec | docker | none')
  .option('--no-network', 'disable outbound network inside the sandbox')
  .option('--no-inject', 'skip injecting sandbox notice into the project')
  .option('--no-approval', 'apply all changes without asking for approval (dangerous!)')
  .option('--no-backup', 'skip creating .sandbox-backup files before overwriting')
  .option('--verbose', 'verbose output')
  .allowUnknownOption(true)
  .action(async (folder: string, opts: {
    agent: string;
    backend?: string;
    network: boolean;
    inject: boolean;
    approval: boolean;
    backup: boolean;
    verbose: boolean;
  }) => {
    if (opts.verbose) setLevel('debug');

    const projectDir = path.resolve(folder);

    if (!fs.existsSync(projectDir)) {
      console.error(chalk.red(`Error: folder not found: ${projectDir}`));
      process.exit(1);
    }
    if (!fs.statSync(projectDir).isDirectory()) {
      console.error(chalk.red(`Error: not a directory: ${projectDir}`));
      process.exit(1);
    }

    // Resolve agent driver
    let agent;
    try {
      agent = getAgent(opts.agent);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }

    // Collect any extra args after '--'
    const rawArgs = process.argv.slice(process.argv.indexOf(folder) + 1);
    const dashDash = rawArgs.indexOf('--');
    const agentArgs = dashDash >= 0 ? rawArgs.slice(dashDash + 1) : [];

    console.log(chalk.bold('\n╔══════════════════════════════════════════════╗'));
    console.log(chalk.bold('║              agentbox  v0.1.0                ║'));
    console.log(chalk.bold('╚══════════════════════════════════════════════╝\n'));
    console.log(`  Project: ${chalk.cyan(projectDir)}`);
    console.log(`  Agent:   ${chalk.cyan(agent.name)}`);
    console.log(`  Backend: ${chalk.cyan(opts.backend ?? detectSandboxBackend())}`);
    console.log(`  Network: ${opts.network ? chalk.green('allowed') : chalk.red('blocked')}`);
    console.log();

    const workspaceManager = new WorkspaceManager();
    const sandboxManager = new SandboxManager(opts.backend as SandboxBackendType | undefined);
    const agentRunner = new AgentRunner();
    const diffExtractor = new DiffExtractor();
    const approvalUI = new ApprovalUI();
    const applier = new Applier();

    let workspacePaths: WorkspacePaths | null = null;

    // Graceful shutdown
    const teardownAll = async () => {
      if (workspacePaths) {
        await workspacePaths.teardown();
        workspacePaths = null;
      }
    };

    process.on('SIGINT', async () => {
      log.warn('\nInterrupted — cleaning up sandbox...');
      await teardownAll();
      process.exit(130);
    });
    process.on('SIGTERM', async () => {
      await teardownAll();
      process.exit(143);
    });

    try {
      // 1. Set up workspace
      const spinner = ora('Setting up sandbox workspace...').start();
      try {
        workspacePaths = await workspaceManager.create({ projectDir });
        spinner.succeed('Sandbox workspace ready');
      } catch (err: any) {
        spinner.fail(`Failed to set up workspace: ${err.message}`);
        process.exit(1);
      }

      // 2. Configure agent (resolve binary, env, inject notice)
      const agentSetup = await agent.setup({
        workspaceDir: workspacePaths.workspaceDir,
        fakeHomeDir: workspacePaths.fakeHomeDir,
        agentArgs,
        injectNotice: opts.inject,
      });

      // 3. Prepare the sandboxed command (builds the sandbox wrapper invocation)
      const sandboxed = await sandboxManager.prepare({
        workspaceDir: workspacePaths.workspaceDir,
        fakeHomeDir: workspacePaths.fakeHomeDir,
        command: agentSetup.command,
        args: agentSetup.args,
        env: agentSetup.env,
        allowNetwork: opts.network,
      });

      // 4. Launch inside a PTY so the agent gets a real terminal
      log.step(`Launching ${agent.name} in sandbox...`);
      log.separator();
      console.log(chalk.gray(`  Workspace: ${workspacePaths.workspaceDir}`));
      console.log(chalk.gray(`  Home:      ${workspacePaths.fakeHomeDir}`));
      log.separator();
      console.log();

      const { exitCode } = await agentRunner.run(sandboxed);

      console.log('\n');
      log.separator();
      log.step(`${agent.name} exited (code ${exitCode})`);

      // 4. Extract diff
      const isOverlay = detectWorkspaceStrategy() === 'overlay' ||
                        detectWorkspaceStrategy() === 'fuse-overlay';

      const diffSummary = await diffExtractor.extract({
        projectDir,
        workspaceDir: workspacePaths.workspaceDir,
        upperDir: workspacePaths.upperDir,
        isOverlay,
      });

      // Agent cleanup (remove injected context files)
      await agent.cleanup(workspacePaths.workspaceDir);

      if (diffSummary.files.length === 0) {
        log.info('No changes made by the agent.');
        await teardownAll();
        process.exit(exitCode);
      }

      // 5. Approval UI
      let acceptedFiles = diffSummary.files;
      let cancelled = false;

      if (opts.approval) {
        const approval = await approvalUI.run(diffSummary);
        acceptedFiles = approval.acceptedFiles;
        cancelled = approval.cancelled;
      }

      // 6. Apply accepted changes
      if (acceptedFiles.length > 0) {
        const result = await applier.apply({
          projectDir,
          files: acceptedFiles,
          backup: opts.backup,
        });

        if (result.failed.length > 0) {
          log.error(`${result.failed.length} file(s) failed to apply:`);
          for (const f of result.failed) {
            log.error(`  ${f.path}: ${f.error}`);
          }
        }
      }

      // 7. Teardown
      await teardownAll();
      process.exit(cancelled ? 1 : exitCode);

    } catch (err: any) {
      log.error(`Fatal error: ${err.message}`);
      if (!opts.verbose) log.info('Re-run with --verbose for full details.');
      else console.error(err.stack);
      await teardownAll();
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
// agentbox agents
// ──────────────────────────────────────────────
program
  .command('agents')
  .description('List available agent drivers')
  .action(() => {
    const agents = listAgents();
    console.log(chalk.bold('\nAvailable agents:\n'));
    for (const a of agents) {
      console.log(`  ${chalk.cyan(a.id.padEnd(16))} ${a.name}`);
    }
    console.log(chalk.gray('\n  Use --agent <id> with `agentbox run` to select an agent.'));
    console.log(chalk.gray('  Add new agents by implementing IAgent in src/agents/ and registering in src/agents/registry.ts\n'));
  });

// ──────────────────────────────────────────────
// agentbox info
// ──────────────────────────────────────────────
program
  .command('info')
  .description('Show available sandbox backends and workspace strategies')
  .action(() => {
    printPlatformInfo();
  });

// ──────────────────────────────────────────────
// agentbox clean <folder>
// ──────────────────────────────────────────────
program
  .command('clean <folder>')
  .description('Remove .sandbox-backup files left by a previous session')
  .action(async (folder: string) => {
    const projectDir = path.resolve(folder);
    const applier = new Applier();
    const count = await applier.cleanupBackups(projectDir);
    log.success(`Removed ${count} backup file(s) from ${projectDir}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`Error: ${err.message}`));
  process.exit(1);
});
