import * as fs from 'fs';
import { execa } from 'execa';
import { ISandboxBackend, SandboxRunOptions, SandboxedCommand } from '../SandboxManager';
import { log } from '../../utils/logger';

/**
 * Linux bubblewrap (bwrap) backend.
 * Returns a SandboxedCommand so AgentRunner can wrap it in a PTY.
 */
export class BubblewrapBackend implements ISandboxBackend {
  async prepare(opts: SandboxRunOptions): Promise<SandboxedCommand> {
    const {
      workspaceDir,
      fakeHomeDir,
      command,
      args = [],
      env = {},
      allowNetwork = true,
    } = opts;

    const cmdPath = await this.resolveCommand(command);

    const bwrapArgs = this.buildBwrapArgs({ workspaceDir, fakeHomeDir, allowNetwork });

    const mergedEnv: Record<string, string> = {
      HOME: '/sandbox-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TERM: process.env.TERM ?? 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      ...env,
    };

    if (process.env.ANTHROPIC_API_KEY) {
      mergedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    // Build --setenv flags
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(mergedEnv)) {
      envArgs.push('--setenv', key, value);
    }

    const fullArgs = [...bwrapArgs, ...envArgs, '--', cmdPath, ...args];

    log.debug(`bwrap: ${cmdPath} ${args.join(' ')}`);

    return {
      command: 'bwrap',
      args: fullArgs,
      env: process.env as Record<string, string>, // bwrap uses --setenv, outer env is minimal
      cwd: workspaceDir,
    };
  }

  private buildBwrapArgs(opts: {
    workspaceDir: string;
    fakeHomeDir: string;
    allowNetwork: boolean;
  }): string[] {
    const { workspaceDir, fakeHomeDir, allowNetwork } = opts;

    const args = [
      '--bind', workspaceDir, '/workspace',
      '--bind', fakeHomeDir, '/sandbox-home',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/sbin', '/sbin',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/lib32', '/lib32',
      '--tmpfs', '/etc',
      '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
      '--ro-bind-try', '/etc/hosts', '/etc/hosts',
      '--ro-bind-try', '/etc/ssl', '/etc/ssl',
      '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
      '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
      '--ro-bind-try', '/etc/timezone', '/etc/timezone',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--tmpfs', '/run',
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-ipc',
      '--unshare-cgroup-try',
      '--die-with-parent',
      '--chdir', '/workspace',
    ];

    if (!allowNetwork) args.push('--unshare-net');

    return args;
  }

  private async resolveCommand(command: string): Promise<string> {
    if (fs.existsSync(command)) return command;

    try {
      const result = await execa('which', [command], { reject: false });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch { /* fall through */ }

    const candidates = [
      `/usr/local/bin/${command}`,
      `/usr/bin/${command}`,
      `/bin/${command}`,
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    throw new Error(`Command not found: ${command}`);
  }
}
