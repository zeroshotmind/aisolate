import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectWorkspaceStrategy, sandboxTmpBase } from '../utils/platform';
import { log } from '../utils/logger';
import { RsyncWorkspace } from './RsyncWorkspace';
import { OverlayWorkspace } from './OverlayWorkspace';

export interface WorkspacePaths {
  /** The path Claude Code will see as /workspace (or the bind-mount source) */
  workspaceDir: string;
  /** A fake HOME directory with minimal config, no secrets */
  fakeHomeDir: string;
  /** On overlay setups: the upper layer where writes land. Same as workspaceDir for rsync. */
  upperDir?: string;
  /** Cleanup function */
  teardown: () => Promise<void>;
}

export interface WorkspaceOptions {
  /** Real project folder on the host */
  projectDir: string;
  /** Patterns to exclude from workspace copy (like .sandboxignore) */
  excludePatterns?: string[];
}

export class WorkspaceManager {
  private strategy: string;

  constructor() {
    this.strategy = detectWorkspaceStrategy();
  }

  async create(opts: WorkspaceOptions): Promise<WorkspacePaths> {
    const base = sandboxTmpBase();
    fs.mkdirSync(base, { recursive: true });

    const workspaceDir = path.join(base, 'workspace');
    const fakeHomeDir = path.join(base, 'home');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(fakeHomeDir, { recursive: true });

    log.step(`Setting up sandbox workspace (strategy: ${this.strategy})`);

    let upperDir: string | undefined;
    let teardownWorkspace: () => Promise<void>;

    if (this.strategy === 'overlay' || this.strategy === 'fuse-overlay') {
      const overlay = new OverlayWorkspace();
      const result = await overlay.setup({
        lowerDir: opts.projectDir,
        mergedDir: workspaceDir,
        baseDir: base,
        fuse: this.strategy === 'fuse-overlay',
      });
      upperDir = result.upperDir;
      teardownWorkspace = result.teardown;
    } else {
      const rsync = new RsyncWorkspace();
      await rsync.setup({
        sourceDir: opts.projectDir,
        destDir: workspaceDir,
        excludePatterns: opts.excludePatterns,
      });
      upperDir = workspaceDir; // for rsync, all changes are in workspaceDir
      teardownWorkspace = async () => {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      };
    }

    // Build fakeHOME
    await this.buildFakeHome(fakeHomeDir, opts);

    log.success('Workspace ready');

    return {
      workspaceDir,
      fakeHomeDir,
      upperDir,
      teardown: async () => {
        log.step('Tearing down sandbox workspace');
        await teardownWorkspace();
        fs.rmSync(fakeHomeDir, { recursive: true, force: true });
        fs.rmSync(base, { recursive: true, force: true });
        log.success('Workspace torn down');
      },
    };
  }

  private async buildFakeHome(fakeHomeDir: string, opts: WorkspaceOptions): Promise<void> {
    const home = os.homedir();

    // Create expected dirs
    const dirs = ['.claude', '.config/git', '.npm', '.local/share', '.cache'];
    for (const d of dirs) {
      fs.mkdirSync(path.join(fakeHomeDir, d), { recursive: true });
    }

    // ── Claude Code auth ────────────────────────────────────────────────────
    //
    // Claude Code (subscription) stores auth in two places:
    //   ~/.claude.json          — OAuth session token (login credentials)
    //   ~/.claude/              — settings, keybindings, daemon state, etc.
    //
    // We copy both into fakeHOME so the agent can authenticate and use its
    // subscription without touching anything else on the host.
    //
    // We deliberately do NOT copy:
    //   ~/.claude/settings.local.json  (may have sensitive local overrides)
    //   ~/.claude/scheduled_tasks.json (host-scoped, irrelevant in sandbox)

    const claudeJson = path.join(home, '.claude.json');
    if (fs.existsSync(claudeJson)) {
      fs.copyFileSync(claudeJson, path.join(fakeHomeDir, '.claude.json'));
      log.debug('Copied ~/.claude.json (subscription auth)');
    } else if (!process.env.ANTHROPIC_API_KEY) {
      log.warn(
        'No ~/.claude.json found and ANTHROPIC_API_KEY is not set. ' +
        'Claude Code may ask you to log in inside the sandbox.'
      );
    }

    const claudeDir = path.join(home, '.claude');
    const claudeDirDst = path.join(fakeHomeDir, '.claude');
    if (fs.existsSync(claudeDir)) {
      // Copy only safe, non-sensitive files from ~/.claude/
      const SAFE_FILES = [
        'settings.json',
        'keybindings.json',
        'daemon.json',
        'catch-up-state.json',
      ];
      for (const f of SAFE_FILES) {
        const src = path.join(claudeDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(claudeDirDst, f));
          log.debug(`Copied ~/.claude/${f}`);
        }
      }
    }

    // ── Git config ──────────────────────────────────────────────────────────
    // Copy ~/.gitconfig but strip credential helpers and signing keys so the
    // agent can't make authenticated git pushes or access git credentials.
    const gitConfigPath = path.join(fakeHomeDir, '.config', 'git', 'config');
    const realGitConfig = path.join(home, '.gitconfig');
    if (fs.existsSync(realGitConfig)) {
      const raw = fs.readFileSync(realGitConfig, 'utf8');
      const sanitized = this.sanitizeGitConfig(raw);
      fs.writeFileSync(gitConfigPath, sanitized);
      log.debug('Copied sanitized ~/.gitconfig');
    } else {
      fs.writeFileSync(gitConfigPath, '[core]\n\tautocrlf = false\n');
    }

    // ── npm ─────────────────────────────────────────────────────────────────
    // Minimal npmrc — no auth tokens, scoped to public registry only.
    fs.writeFileSync(
      path.join(fakeHomeDir, '.npmrc'),
      'registry=https://registry.npmjs.org/\n'
    );
  }

  private sanitizeGitConfig(raw: string): string {
    // Remove lines that could expose credentials or allow authenticated pushes
    const BLOCKED_KEYS = ['helper', 'signingkey', 'gpgsign', 'sshcommand', 'token', 'password'];
    const lines = raw.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      const lower = line.toLowerCase().trim();
      const isBlocked = BLOCKED_KEYS.some(k => lower.startsWith(k + ' ') || lower.startsWith(k + '='));
      if (!isBlocked) out.push(line);
    }
    return out.join('\n');
  }
}
