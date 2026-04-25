import * as fs from 'fs';
import * as os from 'os';
import { execa } from 'execa';
import { log } from '../utils/logger';
import type { SandboxedCommand } from '../sandbox/SandboxManager';

export interface AgentResult {
  exitCode: number;
}

// Try to load node-pty — it requires a native addon compiled for the current
// platform. If it wasn't built for this OS (e.g. npm install ran on Linux but
// the binary is running on macOS), we fall back to the `script` command which
// allocates a real PTY without any native modules.
let nodePty: typeof import('node-pty') | null = null;
try {
  nodePty = require('node-pty');
  log.debug('node-pty loaded successfully');
} catch (e: any) {
  log.debug(`node-pty not available (${e.message.split('\n')[0]}), will use script(1) PTY`);
}

/**
 * Runs a SandboxedCommand, giving the agent a proper terminal.
 *
 * Strategy A (preferred): node-pty — full PTY ownership, supports resize.
 * Strategy B (fallback):  `script` command — allocates a real PTY without
 *   native modules. Available as a standard Unix utility on macOS and Linux.
 *   macOS BSD syntax: script -q -F typescript command [args...]
 *   Linux GNU syntax: script -q -c "command args..." /dev/null
 */
export class AgentRunner {
  async run(sandboxed: SandboxedCommand): Promise<AgentResult> {
    const resolvedCommand = await this.resolveAbsolute(sandboxed.command);

    if (nodePty) {
      return this.runWithPty(resolvedCommand, sandboxed);
    } else {
      log.debug('Using `script` command for PTY allocation (run `npm run rebuild-native` to use node-pty)');
      return this.runWithScript(resolvedCommand, sandboxed);
    }
  }

  // ── Strategy A: node-pty ──────────────────────────────────────────────────

  private runWithPty(resolvedCommand: string, sandboxed: SandboxedCommand): Promise<AgentResult> {
    // Some macOS system binaries (e.g. sandbox-exec) cannot be directly
    // posix_spawnp'd by node-pty. Always wrap in /bin/sh so the shell execs
    // the real command — the shell is unrestricted.
    const shellCmd = this.buildShellInvocation(resolvedCommand, sandboxed.args);
    log.debug(`PTY: /bin/sh -c '${shellCmd.slice(0, 100)}'`);

    return new Promise((resolve, reject) => {
      const cols = process.stdout.columns || 220;
      const rows = process.stdout.rows || 50;

      let ptyProcess: import('node-pty').IPty;
      try {
        ptyProcess = nodePty!.spawn('/bin/sh', ['-c', shellCmd], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: sandboxed.cwd,
          env: sandboxed.env,
        });
      } catch (err: any) {
        // node-pty failed — fall back to script(1). Do NOT call cleanup() yet;
        // the SandboxedCommand (e.g. the .sb profile file) is still needed.
        log.debug(`node-pty spawn failed: ${err.message} — falling back to script(1)`);
        this.runWithScript(resolvedCommand, sandboxed).then(resolve).catch(reject);
        return;
      }

      ptyProcess.onData((data: string) => process.stdout.write(data));

      const onData = (data: Buffer) => ptyProcess.write(data.toString());
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
      } catch { /* stdin may not support raw mode */ }

      const onResize = () =>
        ptyProcess.resize(process.stdout.columns || cols, process.stdout.rows || rows);
      process.stdout.on('resize', onResize);

      ptyProcess.onExit(({ exitCode }) => {
        try {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.removeListener('resize', onResize);
        } catch { /* ignore */ }
        sandboxed.cleanup?.();
        resolve({ exitCode: exitCode ?? 0 });
      });
    });
  }

  // ── Strategy B: script(1) PTY ─────────────────────────────────────────────
  //
  // `script` forks a child process under a real PTY (ioctl TIOCSPTNAME /
  // openpty) without any native Node addon. The typescript log is sent to
  // /dev/null so we don't clutter the workspace.
  //
  // macOS (BSD script):
  //   script -q -F /dev/null <cmd> [args...]
  //   -q  quiet (no "Script started/done" lines)
  //   -F  flush output after every write (critical for interactive UIs)
  //
  // Linux (util-linux script):
  //   script -q -e -c "<cmd> [args...]" /dev/null
  //   -q  quiet
  //   -e  return exit code of child
  //   -c  command string

  private runWithScript(resolvedCommand: string, sandboxed: SandboxedCommand): Promise<AgentResult> {
    const isMac = os.platform() === 'darwin';
    const shellCmd = this.buildShellInvocation(resolvedCommand, sandboxed.args);

    let scriptBin: string;
    let scriptArgs: string[];

    if (isMac) {
      // BSD script: script [-q] [-F pipe] [typescript] [command [args...]]
      // Pass the full command as individual argv so BSD script execs it directly.
      scriptBin = '/usr/bin/script';
      scriptArgs = ['-q', '-F', '/dev/null', resolvedCommand, ...sandboxed.args];
    } else {
      // GNU script: script [-q] [-e] [-c command] [typescript]
      scriptBin = '/usr/bin/script';
      scriptArgs = ['-q', '-e', '-c', shellCmd, '/dev/null'];
    }

    log.debug(`script PTY: ${scriptBin} ${scriptArgs.slice(0, 4).join(' ')} ...`);

    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');

      const proc = spawn(scriptBin, scriptArgs, {
        cwd: sandboxed.cwd,
        env: {
          ...sandboxed.env,
          // Ensure script(1) itself can find stty / shell helpers
          PATH: sandboxed.env.PATH ?? process.env.PATH,
        },
        stdio: 'inherit',  // script(1) manages its own PTY; we inherit its stdio
      });

      proc.on('error', (err: Error) => {
        // script(1) not available — last-ditch stdio:inherit (Claude will likely
        // exit silently, but at least we don't crash the wrapper)
        log.warn(`script(1) failed to spawn: ${err.message} — falling back to stdio:inherit (no PTY)`);
        sandboxed.cleanup?.();
        this.runWithInherit(resolvedCommand, sandboxed).then(resolve).catch(reject);
      });

      proc.on('close', (code: number | null) => {
        sandboxed.cleanup?.();
        resolve({ exitCode: code ?? 0 });
      });
    });
  }

  // ── Strategy C: stdio inherit (last resort, no PTY) ───────────────────────

  private runWithInherit(resolvedCommand: string, sandboxed: SandboxedCommand): Promise<AgentResult> {
    log.debug(`inherit spawn: ${resolvedCommand} ${sandboxed.args.slice(0, 3).join(' ')} ...`);

    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');

      const proc = spawn(resolvedCommand, sandboxed.args, {
        cwd: sandboxed.cwd,
        env: sandboxed.env,
        stdio: 'inherit',
      });

      proc.on('error', (err: Error) => {
        sandboxed.cleanup?.();
        reject(new Error(`Failed to spawn process: ${err.message}\n  Command: ${resolvedCommand}`));
      });

      proc.on('close', (code: number | null) => {
        sandboxed.cleanup?.();
        resolve({ exitCode: code ?? 0 });
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildShellInvocation(command: string, args: string[]): string {
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    return [command, ...args].map(quote).join(' ');
  }

  private async resolveAbsolute(command: string): Promise<string> {
    if (command.startsWith('/') && fs.existsSync(command)) return command;

    try {
      const result = await execa('which', [command], { reject: false });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch { /* fall through */ }

    const knownPaths: Record<string, string[]> = {
      'sandbox-exec': ['/usr/bin/sandbox-exec'],
      'bwrap':        ['/usr/bin/bwrap', '/usr/local/bin/bwrap'],
      'docker':       ['/usr/local/bin/docker', '/usr/bin/docker'],
    };

    for (const p of knownPaths[command] ?? []) {
      if (fs.existsSync(p)) return p;
    }

    throw new Error(`Cannot find executable: "${command}". Make sure it is installed and on PATH.`);
  }
}
