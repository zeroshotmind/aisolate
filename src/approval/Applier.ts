import * as fs from 'fs';
import * as path from 'path';
import { FileDiff } from '../diff/types';
import { log } from '../utils/logger';

export interface ApplyOptions {
  /** Real project directory to write changes to */
  projectDir: string;
  /** Files to apply */
  files: FileDiff[];
  /** Create a backup of modified files before overwriting */
  backup?: boolean;
}

export interface ApplyResult {
  applied: string[];
  failed: { path: string; error: string }[];
}

export class Applier {
  async apply(opts: ApplyOptions): Promise<ApplyResult> {
    const { projectDir, files, backup = true } = opts;
    const applied: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const file of files) {
      try {
        await this.applyFile(file, projectDir, backup);
        applied.push(file.relativePath);
        log.success(`Applied: ${file.relativePath}`);
      } catch (err: any) {
        failed.push({ path: file.relativePath, error: err.message });
        log.error(`Failed to apply ${file.relativePath}: ${err.message}`);
      }
    }

    if (applied.length > 0) {
      log.success(`\n${applied.length} file(s) applied to ${projectDir}`);
    }

    if (failed.length > 0) {
      log.error(`${failed.length} file(s) failed to apply`);
    }

    return { applied, failed };
  }

  private async applyFile(file: FileDiff, projectDir: string, backup: boolean): Promise<void> {
    const destPath = path.join(projectDir, file.relativePath);

    if (file.type === 'deleted') {
      if (fs.existsSync(destPath)) {
        if (backup) {
          this.createBackup(destPath);
        }
        fs.unlinkSync(destPath);
        // Remove empty parent directories
        this.pruneEmptyDirs(path.dirname(destPath), projectDir);
      }
      return;
    }

    // For added/modified: copy sandbox file to real project
    if (!fs.existsSync(file.sandboxPath)) {
      throw new Error(`Sandbox file not found: ${file.sandboxPath}`);
    }

    if (backup && fs.existsSync(destPath)) {
      this.createBackup(destPath);
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Copy with original permissions preserved
    fs.copyFileSync(file.sandboxPath, destPath);

    // Preserve executable bit if set in sandbox
    try {
      const sandboxStat = fs.statSync(file.sandboxPath);
      fs.chmodSync(destPath, sandboxStat.mode);
    } catch {
      // non-fatal
    }
  }

  private createBackup(filePath: string): void {
    const backupPath = `${filePath}.sandbox-backup`;
    try {
      fs.copyFileSync(filePath, backupPath);
      log.debug(`Backup created: ${backupPath}`);
    } catch (err: any) {
      log.warn(`Failed to create backup for ${filePath}: ${err.message}`);
    }
  }

  private pruneEmptyDirs(dir: string, stopAt: string): void {
    if (dir === stopAt || !dir.startsWith(stopAt)) return;
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        this.pruneEmptyDirs(path.dirname(dir), stopAt);
      }
    } catch {
      // non-fatal
    }
  }

  /** Remove all .sandbox-backup files from a project directory */
  async cleanupBackups(projectDir: string): Promise<number> {
    let count = 0;
    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
          walk(p);
        } else if (entry.isFile() && entry.name.endsWith('.sandbox-backup')) {
          fs.unlinkSync(p);
          count++;
        }
      }
    };
    walk(projectDir);
    return count;
  }
}
