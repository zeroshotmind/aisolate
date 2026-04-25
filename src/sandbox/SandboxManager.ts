import { detectSandboxBackend, SandboxBackendType } from '../utils/platform';
import { log } from '../utils/logger';
import { BubblewrapBackend } from './backends/BubblewrapBackend';
import { SandboxExecBackend } from './backends/SandboxExecBackend';
import { DockerBackend } from './backends/DockerBackend';

export interface SandboxRunOptions {
  /** Path that the agent will see as its working directory */
  workspaceDir: string;
  /** Fake HOME dir with minimal config */
  fakeHomeDir: string;
  /** Command to run (e.g. '/usr/local/bin/claude') */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Whether to allow outbound network access */
  allowNetwork?: boolean;
}

/**
 * What a backend produces: the outer command+args that should be spawned,
 * plus the environment to pass to it. The PTY layer wraps this result.
 *
 * e.g. for sandbox-exec:
 *   command: 'sandbox-exec'
 *   args:    ['-f', '/tmp/agentbox-1234.sb', '/Users/roy/.local/bin/claude']
 *   env:     { HOME: '/tmp/agentbox-1234/home', PATH: '...', ... }
 *   cwd:     '/tmp/agentbox-1234/workspace'
 *
 * For bubblewrap:
 *   command: 'bwrap'
 *   args:    ['--bind', ..., '--', '/usr/local/bin/claude']
 *   ...
 *
 * For passthrough (no isolation):
 *   command: '/usr/local/bin/claude'
 *   args:    []
 */
export interface SandboxedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Optional cleanup to run after the process exits (e.g. delete temp profile) */
  cleanup?: () => void;
}

export interface ISandboxBackend {
  /**
   * Prepare the sandboxed command. Does NOT spawn a process.
   * The caller (AgentRunner) spawns it in a PTY.
   */
  prepare(opts: SandboxRunOptions): Promise<SandboxedCommand>;
}

export class SandboxManager {
  private backendType: SandboxBackendType;
  private backend: ISandboxBackend;

  constructor(forceBackend?: SandboxBackendType) {
    this.backendType = forceBackend ?? detectSandboxBackend();
    log.info(`Using sandbox backend: ${this.backendType}`);

    switch (this.backendType) {
      case 'bubblewrap':    this.backend = new BubblewrapBackend();    break;
      case 'sandbox-exec':  this.backend = new SandboxExecBackend();   break;
      case 'docker':        this.backend = new DockerBackend();         break;
      case 'none':
        log.warn('No sandbox backend — running WITHOUT isolation. This is unsafe!');
        this.backend = new PassthroughBackend();
        break;
      default:
        throw new Error(`Unknown backend: ${this.backendType}`);
    }
  }

  async prepare(opts: SandboxRunOptions): Promise<SandboxedCommand> {
    return this.backend.prepare(opts);
  }

  getBackendType(): SandboxBackendType {
    return this.backendType;
  }
}

class PassthroughBackend implements ISandboxBackend {
  async prepare(opts: SandboxRunOptions): Promise<SandboxedCommand> {
    return {
      command: opts.command,
      args: opts.args ?? [],
      env: {
        ...process.env as Record<string, string>,
        HOME: opts.fakeHomeDir,
        ...opts.env,
      },
      cwd: opts.workspaceDir,
    };
  }
}
