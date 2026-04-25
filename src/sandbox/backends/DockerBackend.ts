import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execa } from 'execa';
import { ISandboxBackend, SandboxRunOptions, SandboxedCommand } from '../SandboxManager';
import { log } from '../../utils/logger';

const DOCKER_IMAGE = 'node:20-slim';

/**
 * Docker backend — gives the agent a completely isolated filesystem.
 *
 * From Claude's perspective:
 *   /workspace  ← the project (bind-mounted read-write from workspaceDir)
 *   /root       ← the fake home (bind-mounted from fakeHomeDir)
 *   /           ← minimal Debian image; nothing else from the host is visible
 *
 * Claude cannot see ~/.ssh, ~/.aws, other repos, or anything outside the
 * project folder. The container filesystem IS Claude's entire universe.
 *
 * Claude is installed inside the container on first run and cached in
 * fakeHomeDir/.local so subsequent runs skip the install step.
 */
export class DockerBackend implements ISandboxBackend {
  async prepare(opts: SandboxRunOptions): Promise<SandboxedCommand> {
    const {
      workspaceDir,
      fakeHomeDir,
      args = [],
      env = {},
      allowNetwork = true,
    } = opts;

    await this.ensureDockerAvailable();

    // Write a tiny shell entrypoint that (lazily) installs claude, then runs it
    const entrypoint = this.writeEntrypoint();

    const mergedEnv: Record<string, string> = {
      TERM: process.env.TERM ?? 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      ...env,
      // Force HOME to /root — must always point inside the container
      HOME: '/root',
    };

    // Pass through Claude / Anthropic env vars (API key, debug flags, etc.)
    for (const [k, v] of Object.entries(process.env)) {
      if ((k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) && v) {
        mergedEnv[k] = v;
      }
    }

    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(mergedEnv)) {
      envArgs.push('-e', `${key}=${value}`);
    }

    // Extra claude args (e.g. a prompt passed via `agentbox run . -- "fix the bug"`)
    const claudeExtraArgs = args.map(a => this.shellQuote(a)).join(' ');

    const dockerArgs: string[] = [
      'run', '--rm', '--interactive', '--tty',
      // Project folder → /workspace (read-write so edits land here)
      '-v', `${workspaceDir}:/workspace`,
      // Fake home → /root (auth, gitconfig, etc.; also caches claude install)
      '-v', `${fakeHomeDir}:/root`,
      // Entrypoint script
      '-v', `${entrypoint}:/agentbox-entrypoint.sh:ro`,
      // Working directory is the project root
      '-w', '/workspace',
      // Drop all Linux capabilities
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      ...envArgs,
    ];

    if (!allowNetwork) dockerArgs.push('--network', 'none');

    // Pass extra claude args as a single string to the entrypoint
    dockerArgs.push(DOCKER_IMAGE, 'sh', '/agentbox-entrypoint.sh', claudeExtraArgs);

    log.debug(`Docker: ${workspaceDir} → /workspace, ${fakeHomeDir} → /root`);

    return {
      command: 'docker',
      args: dockerArgs,
      env: process.env as Record<string, string>,
      cwd: workspaceDir,
      cleanup: () => {
        try { fs.unlinkSync(entrypoint); } catch { /* ignore */ }
      },
    };
  }

  /**
   * Writes a shell script that:
   *  1. Installs @anthropic-ai/claude-code into /root/.local if not already present
   *     (cached across runs because /root is bind-mounted from fakeHomeDir)
   *  2. Execs `claude` with any extra args
   */
  private writeEntrypoint(): string {
    const p = path.join(os.tmpdir(), `agentbox-entry-${process.pid}.sh`);

    const script = `#!/bin/sh
set -e
CLAUDE_BIN="/root/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  echo "[agentbox] Installing Claude Code inside container (cached for next run)..."
  npm install -g @anthropic-ai/claude-code --prefix /root/.local --loglevel warn
  mkdir -p /root/.local/bin
  # npm puts the bin in prefix/bin; create a wrapper if the symlink is missing
  if [ ! -x "$CLAUDE_BIN" ]; then
    FOUND=$(find /root/.local -name "claude" -not -type d 2>/dev/null | head -1)
    [ -n "$FOUND" ] && cp "$FOUND" "$CLAUDE_BIN" && chmod +x "$CLAUDE_BIN"
  fi
  echo "[agentbox] Claude Code ready."
fi
export PATH="/root/.local/bin:$PATH"
exec claude $1
`;

    fs.writeFileSync(p, script, { mode: 0o755 });
    return p;
  }

  private async ensureDockerAvailable(): Promise<void> {
    const result = await execa('docker', ['info'], { reject: false, stdio: 'pipe' });
    if (result.exitCode !== 0) {
      throw new Error(
        'Docker is not running or not installed.\n' +
        'Install Docker Desktop from https://www.docker.com/products/docker-desktop/ ' +
        'or use --backend sandbox-exec on macOS / --backend bubblewrap on Linux.'
      );
    }
  }

  private shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
