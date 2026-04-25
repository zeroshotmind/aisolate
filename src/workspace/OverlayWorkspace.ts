import { execa } from 'execa';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';

export interface OverlayOptions {
  lowerDir: string;   // real project (read-only)
  mergedDir: string;  // what the agent sees (read-write view)
  baseDir: string;    // tmp base for upper + work dirs
  fuse?: boolean;     // use fuse-overlayfs instead of kernel overlayfs
}

export interface OverlayResult {
  upperDir: string;   // where writes land
  teardown: () => Promise<void>;
}

export class OverlayWorkspace {
  async setup(opts: OverlayOptions): Promise<OverlayResult> {
    const { lowerDir, mergedDir, baseDir, fuse = false } = opts;

    const upperDir = path.join(baseDir, 'upper');
    const workDir = path.join(baseDir, 'work');

    fs.mkdirSync(upperDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(mergedDir, { recursive: true });

    log.info(`Mounting overlay filesystem (${fuse ? 'fuse-overlayfs' : 'kernel overlay'})...`);

    if (fuse) {
      await this.mountFuse({ lowerDir, upperDir, workDir, mergedDir });
    } else {
      await this.mountKernel({ lowerDir, upperDir, workDir, mergedDir });
    }

    log.success('Overlay mounted');

    return {
      upperDir,
      teardown: async () => {
        try {
          if (fuse) {
            await execa('fusermount', ['-u', mergedDir], { stdio: 'ignore' });
          } else {
            await execa('umount', [mergedDir], { stdio: 'ignore' });
          }
          log.debug('Overlay unmounted');
        } catch (err: any) {
          log.warn(`Failed to unmount overlay: ${err.message}. May need manual cleanup.`);
        }
      },
    };
  }

  private async mountKernel(opts: {
    lowerDir: string; upperDir: string; workDir: string; mergedDir: string;
  }): Promise<void> {
    const { lowerDir, upperDir, workDir, mergedDir } = opts;
    const overlayOpts = `lowerdir=${lowerDir},upperdir=${upperDir},workdir=${workDir}`;

    try {
      // Try without sudo first (user namespaces with overlay support)
      await execa('mount', ['-t', 'overlay', 'overlay', '-o', overlayOpts, mergedDir]);
    } catch {
      log.warn('Kernel overlay mount failed without root, trying with sudo...');
      try {
        await execa('sudo', ['mount', '-t', 'overlay', 'overlay', '-o', overlayOpts, mergedDir]);
      } catch (err: any) {
        throw new Error(`Failed to mount kernel overlayfs: ${err.message}. Try running with sudo or install fuse-overlayfs.`);
      }
    }
  }

  private async mountFuse(opts: {
    lowerDir: string; upperDir: string; workDir: string; mergedDir: string;
  }): Promise<void> {
    const { lowerDir, upperDir, workDir, mergedDir } = opts;

    try {
      await execa('fuse-overlayfs', [
        `-o`, `lowerdir=${lowerDir},upperdir=${upperDir},workdir=${workDir}`,
        mergedDir,
      ]);
    } catch (err: any) {
      throw new Error(`fuse-overlayfs failed: ${err.message}`);
    }
  }

  /**
   * List files changed in the upper layer (new or modified files).
   * Whiteout entries (deletions) are detected by the special char device.
   */
  listChanges(upperDir: string): { path: string; type: 'modified' | 'added' | 'deleted' }[] {
    const results: { path: string; type: 'modified' | 'added' | 'deleted' }[] = [];
    this.walkUpper(upperDir, upperDir, results);
    return results;
  }

  private walkUpper(
    baseDir: string,
    dir: string,
    results: { path: string; type: 'modified' | 'added' | 'deleted' }[]
  ): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath);

      if (entry.isCharacterDevice()) {
        // Overlay whiteout entry — this is a deletion
        const cleanName = entry.name.startsWith('.wh.') ? entry.name.slice(4) : entry.name;
        results.push({ path: path.join(path.dirname(relPath), cleanName), type: 'deleted' });
      } else if (entry.isDirectory()) {
        // Check for opaque whiteout (directory replacement)
        const opaqueMarker = path.join(fullPath, '.wh..wh..opq');
        if (fs.existsSync(opaqueMarker)) {
          results.push({ path: relPath, type: 'modified' });
        }
        this.walkUpper(baseDir, fullPath, results);
      } else if (entry.isFile() && !entry.name.startsWith('.wh.')) {
        results.push({ path: relPath, type: 'modified' }); // could be added or modified
      }
    }
  }
}
