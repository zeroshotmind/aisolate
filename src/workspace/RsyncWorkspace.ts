import { execa } from 'execa';
import * as fs from 'fs';
import { log } from '../utils/logger';

export interface RsyncOptions {
  sourceDir: string;
  destDir: string;
  excludePatterns?: string[];
}

const DEFAULT_EXCLUDES = [
  '.git/objects',   // keep .git dir but skip the big objects blob for speed
  '*.pyc',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
];

export class RsyncWorkspace {
  async setup(opts: RsyncOptions): Promise<void> {
    const { sourceDir, destDir, excludePatterns = [] } = opts;

    const allExcludes = [...DEFAULT_EXCLUDES, ...excludePatterns];

    // Read .sandboxignore if it exists in the project
    const sandboxIgnore = `${sourceDir}/.sandboxignore`;
    const fileExcludes: string[] = [];
    if (fs.existsSync(sandboxIgnore)) {
      const lines = fs.readFileSync(sandboxIgnore, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      fileExcludes.push(...lines);
      log.debug(`Loaded ${lines.length} patterns from .sandboxignore`);
    }

    const excludeArgs: string[] = [...allExcludes, ...fileExcludes]
      .flatMap(p => ['--exclude', p]);

    // rsync with --link-dest: unchanged files are hardlinked (fast, no disk waste)
    // Source needs trailing slash so rsync copies contents, not the dir itself
    const src = sourceDir.endsWith('/') ? sourceDir : `${sourceDir}/`;

    log.info(`Syncing project into sandbox workspace...`);

    const args = [
      '-a',              // archive mode (perms, symlinks, times, etc.)
      '--link-dest', src, // hardlink unchanged files back to source
      ...excludeArgs,
      src,
      destDir,
    ];

    try {
      await execa('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      log.success('Workspace synced');
    } catch (err: any) {
      log.error(`rsync failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Re-sync after a session to update the workspace (used if running multiple sessions).
   */
  async resync(opts: RsyncOptions): Promise<void> {
    return this.setup(opts);
  }
}
