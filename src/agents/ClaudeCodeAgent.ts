import * as fs from 'fs';
import * as path from 'path';
import { execa } from 'execa';
import { log } from '../utils/logger';
import { IAgent, AgentSetupOptions, AgentSetup } from './IAgent';

const SANDBOX_NOTICE = `
<!-- AGENT SANDBOX NOTICE (auto-injected) -->
## Sandbox Environment

You are running inside agentbox. Important constraints:
- You can only read and write files inside /workspace (this directory)
- Do NOT attempt to access ~/.ssh, ~/.aws, ~/.gnupg, or any path outside /workspace
- All your file changes will be reviewed by the user before being applied to the real project
- Network access is available for npm, pip, and API calls
- Git operations are scoped to /workspace only
<!-- END SANDBOX NOTICE -->
`;

/**
 * Claude Code agent driver. Implements IAgent.
 *
 * Handles:
 * - Finding the claude binary
 * - Copying subscription auth from ~/.claude.json into fakeHOME
 * - Building a clean, minimal env (no host secrets)
 * - Injecting a sandbox notice into CLAUDE.md
 */
export class ClaudeCodeAgent implements IAgent {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  async setup(opts: AgentSetupOptions): Promise<AgentSetup> {
    const { workspaceDir, fakeHomeDir, agentArgs: claudeArgs = [], injectNotice = true } = opts;

    // Find claude binary
    const claudePath = await this.findClaude();
    log.debug(`Found claude at: ${claudePath}`);

    // Inject sandbox notice into CLAUDE.md if requested
    if (injectNotice) {
      await this.injectSandboxNotice(workspaceDir);
    }

    // Build a clean environment — do NOT spread process.env wholesale.
    // We allow only the vars Claude Code needs to function, keeping host
    // secrets (AWS keys, GitHub tokens, etc.) out of the sandbox process.
    const env: Record<string, string> = {
      // Core process vars
      HOME: fakeHomeDir,
      USER: process.env.USER ?? 'user',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'user',
      SHELL: '/bin/sh',
      TERM: process.env.TERM ?? 'xterm-256color',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TMPDIR: process.env.TMPDIR ?? '/tmp',

      // XDG dirs pointing at fakeHOME
      XDG_CONFIG_HOME: path.join(fakeHomeDir, '.config'),
      XDG_DATA_HOME: path.join(fakeHomeDir, '.local', 'share'),
      XDG_CACHE_HOME: path.join(fakeHomeDir, '.cache'),

      // npm scoped to fakeHOME
      npm_config_cache: path.join(fakeHomeDir, '.npm'),
      npm_config_userconfig: path.join(fakeHomeDir, '.npmrc'),

      // Node.js
      NODE_ENV: process.env.NODE_ENV ?? 'development',
    };

    // Claude Code subscription auth: if ~/.claude.json was copied into fakeHOME,
    // the agent will find it via HOME. If the user also has an API key, pass it
    // through (API key takes precedence over OAuth session in Claude Code).
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      log.debug('ANTHROPIC_API_KEY passed through to sandbox');
    }

    return {
      command: claudePath,
      args: claudeArgs,
      env,
    };
  }

  private async findClaude(): Promise<string> {
    // Try which first
    try {
      const result = await execa('which', ['claude'], { reject: false });
      if (result.stdout?.trim()) return result.stdout.trim();
    } catch {
      // fall through
    }

    // Common installation paths
    const candidates = [
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      `${process.env.HOME}/.local/bin/claude`,
      `${process.env.HOME}/.npm/bin/claude`,
      '/opt/homebrew/bin/claude',
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // Try npx as last resort
    try {
      await execa('npx', ['--yes', '@anthropic-ai/claude-code', '--version'], {
        stdio: 'pipe',
        reject: false,
      });
      return 'npx';
    } catch {
      // fall through
    }

    throw new Error(
      'Claude Code not found. Install it with: npm install -g @anthropic-ai/claude-code'
    );
  }

  private async injectSandboxNotice(workspaceDir: string): Promise<void> {
    const claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');

    const marker = '<!-- AGENT SANDBOX NOTICE (auto-injected) -->';

    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      if (content.includes(marker)) {
        log.debug('CLAUDE.md already has sandbox notice');
        return;
      }
      // Prepend the notice
      fs.writeFileSync(claudeMdPath, SANDBOX_NOTICE + '\n' + content);
    } else {
      // Create a new CLAUDE.md with just the notice
      fs.writeFileSync(claudeMdPath, SANDBOX_NOTICE.trim() + '\n');
    }

    log.debug('Injected sandbox notice into CLAUDE.md');
  }

  /**
   * Remove the sandbox notice from CLAUDE.md (called after session ends).
   * We don't want to permanently modify the user's CLAUDE.md.
   */
  async cleanup(workspaceDir: string): Promise<void> {
    const claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) return;

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    const marker = '<!-- AGENT SANDBOX NOTICE (auto-injected) -->';
    const endMarker = '<!-- END SANDBOX NOTICE -->';

    if (!content.includes(marker)) return;

    const startIdx = content.indexOf(marker);
    const endIdx = content.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) return;

    const cleaned = (
      content.slice(0, startIdx) +
      content.slice(endIdx + endMarker.length)
    ).replace(/^\n+/, '').trim();

    if (cleaned) {
      fs.writeFileSync(claudeMdPath, cleaned + '\n');
    } else {
      fs.unlinkSync(claudeMdPath);
    }

    log.debug('Removed sandbox notice from CLAUDE.md');
  }
}
