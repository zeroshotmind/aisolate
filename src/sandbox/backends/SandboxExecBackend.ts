import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execa } from 'execa';
import { ISandboxBackend, SandboxRunOptions, SandboxedCommand } from '../SandboxManager';
import { log } from '../../utils/logger';

/**
 * macOS sandbox-exec (Seatbelt) backend.
 * Generates a sandbox profile at runtime then returns the sandbox-exec
 * invocation as a SandboxedCommand so AgentRunner can wrap it in a PTY.
 */
export class SandboxExecBackend implements ISandboxBackend {
  private profileTemplatePath: string;

  constructor() {
    this.profileTemplatePath = path.join(
      __dirname, '..', 'profiles', 'macos-seatbelt.sb.template'
    );
  }

  async prepare(opts: SandboxRunOptions): Promise<SandboxedCommand> {
    const {
      workspaceDir,
      fakeHomeDir,
      command,
      args = [],
      env = {},
      allowNetwork = true,
    } = opts;

    // Verify sandbox-exec is available
    const sandboxExecPath = await this.findSandboxExec();

    // Resolve the agent binary's real path so the profile can allow it
    const resolvedCommand = await this.resolveCommandPath(command);

    // Write the profile to a temp file
    const profilePath = path.join(os.tmpdir(), `agentbox-${process.pid}.sb`);
    await this.generateProfile(profilePath, {
      workspacePath: workspaceDir,
      homePath: fakeHomeDir,
      commandPath: resolvedCommand,
      allowNetwork,
    });

    const mergedEnv: Record<string, string> = {
      HOME: fakeHomeDir,
      // Pass through the real PATH so child processes find npm, git, etc.
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TERM: process.env.TERM ?? 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      ...env,
    };

    if (process.env.ANTHROPIC_API_KEY) {
      mergedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    log.debug(`sandbox-exec:  ${sandboxExecPath}`);
    log.debug(`profile:       ${profilePath}`);
    log.debug(`agent binary:  ${resolvedCommand}`);

    return {
      command: sandboxExecPath,
      args: ['-f', profilePath, resolvedCommand, ...args],
      env: mergedEnv,
      cwd: workspaceDir,
      cleanup: () => {
        try { fs.unlinkSync(profilePath); } catch { /* ignore */ }
      },
    };
  }

  private async generateProfile(
    outputPath: string,
    opts: { workspacePath: string; homePath: string; commandPath: string; allowNetwork: boolean }
  ): Promise<void> {
    let template: string;

    if (fs.existsSync(this.profileTemplatePath)) {
      template = fs.readFileSync(this.profileTemplatePath, 'utf8');
    } else {
      template = this.getInlineTemplate();
    }

    let profile = template
      .replace(/WORKSPACE_PATH/g, opts.workspacePath)
      .replace(/HOME_PATH/g, opts.homePath);

    // Inject read access for the agent binary and its surrounding directories.
    // Required for binaries outside /usr (e.g. ~/.local/bin/claude, /opt/homebrew/bin/claude)
    const extraPaths = this.collectReadPaths(opts.commandPath);
    const extraRules = extraPaths
      .map(p => `(allow file-read* (subpath ${JSON.stringify(p)}))`)
      .join('\n');

    profile = profile.trimEnd() +
      '\n\n; ── Agent binary paths (auto-generated) ──────────────────────────\n' +
      extraRules + '\n';

    if (!opts.allowNetwork) {
      profile = profile.replace(/^\(allow network-[^\n]+$/mg, '; $& ; disabled by --no-network');
    }

    fs.writeFileSync(outputPath, profile);
    log.debug(`Generated sandbox profile: ${outputPath}`);
  }

  private collectReadPaths(commandPath: string): string[] {
    const paths = new Set<string>();
    const home = os.homedir();

    const addWithParents = (p: string) => {
      paths.add(p);
      // Walk up but stop at home dir itself (we don't want to allow all of ~)
      let dir = path.dirname(p);
      while (dir !== home && dir !== path.dirname(dir)) {
        paths.add(dir);
        dir = path.dirname(dir);
      }
    };

    addWithParents(commandPath);

    // Resolve symlinks — the real binary may be elsewhere (e.g. node_modules/.bin/claude)
    try {
      const real = fs.realpathSync(commandPath);
      if (real !== commandPath) {
        addWithParents(real);
        // Also allow the lib/node_modules next to the bin dir
        const binDir = path.dirname(real);
        const libDir = path.resolve(binDir, '..', 'lib');
        if (fs.existsSync(libDir)) paths.add(libDir);
      }
    } catch { /* ignore */ }

    return [...paths];
  }

  private async findSandboxExec(): Promise<string> {
    // sandbox-exec is a macOS system tool — always at /usr/bin/sandbox-exec
    const fixed = '/usr/bin/sandbox-exec';
    if (fs.existsSync(fixed)) return fixed;

    // Fallback: search PATH (shouldn't be needed but just in case)
    try {
      const result = await execa('which', ['sandbox-exec'], { reject: false });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch { /* fall through */ }

    throw new Error(
      'sandbox-exec not found at /usr/bin/sandbox-exec.\n' +
      'This tool is built into macOS. If you are on Linux, use --backend bubblewrap instead.'
    );
  }

  private async resolveCommandPath(command: string): Promise<string> {
    if (path.isAbsolute(command) && fs.existsSync(command)) return command;

    try {
      const result = await execa('which', [command], { reject: false });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch { /* fall through */ }

    throw new Error(
      `Cannot resolve path for agent command: "${command}". Is it installed and on PATH?`
    );
  }

  private getInlineTemplate(): string {
    return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow file-read*
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/System/Library")
  (subpath "/Library/Apple")
  (subpath "/Library/Developer/CommandLineTools")
  (subpath "/private/etc/resolv.conf")
  (subpath "/private/etc/hosts")
  (subpath "/private/etc/ssl")
  (subpath "/private/var/db/timezone")
  (subpath "/private/var/db/dyld")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
)
(allow file-read* file-write* file-ioctl
  (literal "/dev/tty")
  (literal "/dev/ptmx")
  (subpath "/dev/pts")
  (subpath "/dev/ttys")
  (regex #"^/dev/ttys[0-9]+$")
)
(allow file-read* file-write* (subpath "WORKSPACE_PATH"))
(allow file-read* file-write* (subpath "HOME_PATH"))
(allow file-read* file-write* (subpath "/private/tmp"))
(allow file-read* file-write* (subpath "/private/var/folders"))
(allow ipc-posix-shm ipc-posix-sem)
(allow mach-lookup)
(allow mach-register)
(allow sysctl-read)
(allow network-outbound)
(allow network-inbound (local ip))
(allow network-inbound (local tcp))
`;
  }
}
