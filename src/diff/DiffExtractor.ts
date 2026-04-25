import * as fs from 'fs';
import * as path from 'path';
import * as diffLib from 'diff';
import { FileDiff, DiffSummary, ChangeType } from './types';
import { log } from '../utils/logger';

export interface DiffExtractOptions {
  /** Real project directory */
  projectDir: string;
  /** Sandbox workspace directory (where changes are) */
  workspaceDir: string;
  /** Upper layer for overlay setups (same as workspaceDir for rsync) */
  upperDir?: string;
  /** Whether the workspace uses overlay (changes only in upperDir) */
  isOverlay?: boolean;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac',
  '.ttf', '.woff', '.woff2', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.db', '.sqlite', '.sqlite3',
  '.lock',  // treat lock files as binary for diff purposes (too noisy)
]);

export class DiffExtractor {
  async extract(opts: DiffExtractOptions): Promise<DiffSummary> {
    const { projectDir, workspaceDir, upperDir, isOverlay = false } = opts;

    log.step('Extracting changes from sandbox...');

    let changedFiles: { relativePath: string; type: ChangeType }[];

    if (isOverlay && upperDir) {
      changedFiles = this.extractFromOverlay(upperDir, projectDir);
    } else {
      changedFiles = await this.extractFromRsync(workspaceDir, projectDir);
    }

    if (changedFiles.length === 0) {
      log.info('No changes detected in sandbox.');
      return {
        files: [],
        totalAdded: 0,
        totalRemoved: 0,
        totalBinary: 0,
        newFiles: 0,
        modifiedFiles: 0,
        deletedFiles: 0,
      };
    }

    log.info(`Found ${changedFiles.length} changed file(s)`);

    // Build FileDiff for each
    const files: FileDiff[] = [];
    for (const change of changedFiles) {
      const diff = await this.buildFileDiff(change, projectDir, workspaceDir);
      files.push(diff);
    }

    // Sort: modified first, then added, then deleted
    files.sort((a, b) => {
      const order = { modified: 0, added: 1, deleted: 2 };
      return order[a.type] - order[b.type];
    });

    const summary: DiffSummary = {
      files,
      totalAdded: files.reduce((s, f) => s + f.linesAdded, 0),
      totalRemoved: files.reduce((s, f) => s + f.linesRemoved, 0),
      totalBinary: files.filter(f => f.isBinary).length,
      newFiles: files.filter(f => f.type === 'added').length,
      modifiedFiles: files.filter(f => f.type === 'modified').length,
      deletedFiles: files.filter(f => f.type === 'deleted').length,
    };

    return summary;
  }

  private extractFromOverlay(
    upperDir: string,
    projectDir: string
  ): { relativePath: string; type: ChangeType }[] {
    const results: { relativePath: string; type: ChangeType }[] = [];
    this.walkDir(upperDir, upperDir, projectDir, results);
    return results;
  }

  private walkDir(
    baseDir: string,
    dir: string,
    projectDir: string,
    results: { relativePath: string; type: ChangeType }[]
  ): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath);

      if (entry.name === 'CLAUDE.md') continue; // skip injected file

      if (entry.isCharacterDevice()) {
        // Overlay whiteout — deletion
        const cleanName = entry.name.startsWith('.wh.') ? entry.name.slice(4) : entry.name;
        results.push({ relativePath: path.join(path.dirname(relPath), cleanName), type: 'deleted' });
      } else if (entry.isDirectory()) {
        if (entry.name !== '.wh..wh..opq') {
          this.walkDir(baseDir, fullPath, projectDir, results);
        }
      } else if (entry.isFile() && !entry.name.startsWith('.wh.')) {
        const originalPath = path.join(projectDir, relPath);
        const type: ChangeType = fs.existsSync(originalPath) ? 'modified' : 'added';
        results.push({ relativePath: relPath, type });
      }
    }
  }

  private async extractFromRsync(
    workspaceDir: string,
    projectDir: string
  ): Promise<{ relativePath: string; type: ChangeType }[]> {
    const results: { relativePath: string; type: ChangeType }[] = [];
    this.compareDirectories(workspaceDir, projectDir, '', results);
    return results;
  }

  private compareDirectories(
    sandboxDir: string,
    originalDir: string,
    relBase: string,
    results: { relativePath: string; type: ChangeType }[]
  ): void {
    const sandboxEntries = fs.existsSync(sandboxDir)
      ? fs.readdirSync(sandboxDir, { withFileTypes: true })
      : [];

    for (const entry of sandboxEntries) {
      const relPath = path.join(relBase, entry.name);

      // Skip sandbox-injected files
      if (entry.name === 'CLAUDE.md' && relBase === '') continue;
      // Skip .git internals to avoid noise
      if (entry.name === '.git') continue;

      const sandboxPath = path.join(sandboxDir, entry.name);
      const origPath = path.join(originalDir, entry.name);

      if (entry.isDirectory()) {
        this.compareDirectories(sandboxPath, origPath, relPath, results);
      } else if (entry.isFile()) {
        const origExists = fs.existsSync(origPath);
        if (!origExists) {
          results.push({ relativePath: relPath, type: 'added' });
        } else {
          // Compare file contents
          const sandboxContent = fs.readFileSync(sandboxPath);
          const origContent = fs.readFileSync(origPath);
          if (!sandboxContent.equals(origContent)) {
            results.push({ relativePath: relPath, type: 'modified' });
          }
        }
      }
    }

    // Check for deletions: files in original but not in sandbox
    if (fs.existsSync(originalDir)) {
      const origEntries = fs.readdirSync(originalDir, { withFileTypes: true });
      for (const entry of origEntries) {
        if (entry.name === '.git') continue;
        const relPath = path.join(relBase, entry.name);
        const sandboxPath = path.join(sandboxDir, entry.name);
        if (!fs.existsSync(sandboxPath)) {
          results.push({ relativePath: relPath, type: 'deleted' });
        }
      }
    }
  }

  private async buildFileDiff(
    change: { relativePath: string; type: ChangeType },
    projectDir: string,
    workspaceDir: string
  ): Promise<FileDiff> {
    const { relativePath, type } = change;
    const ext = path.extname(relativePath).toLowerCase();
    const isBinary = BINARY_EXTENSIONS.has(ext);

    const sandboxPath = path.join(workspaceDir, relativePath);
    const originalPath = path.join(projectDir, relativePath);

    if (isBinary) {
      return {
        relativePath,
        type,
        unifiedDiff: null,
        linesAdded: 0,
        linesRemoved: 0,
        isBinary: true,
        sandboxPath,
        originalPath: type !== 'added' ? originalPath : null,
      };
    }

    if (type === 'deleted') {
      const origContent = fs.existsSync(originalPath)
        ? fs.readFileSync(originalPath, 'utf8')
        : '';
      const lines = origContent.split('\n').length;
      return {
        relativePath,
        type,
        unifiedDiff: diffLib.createPatch(relativePath, origContent, '', 'original', 'deleted'),
        linesAdded: 0,
        linesRemoved: lines,
        isBinary: false,
        sandboxPath,
        originalPath,
      };
    }

    const sandboxContent = fs.existsSync(sandboxPath)
      ? fs.readFileSync(sandboxPath, 'utf8')
      : '';
    const origContent = (type === 'modified' && fs.existsSync(originalPath))
      ? fs.readFileSync(originalPath, 'utf8')
      : '';

    const unifiedDiff = diffLib.createPatch(
      relativePath,
      origContent,
      sandboxContent,
      type === 'added' ? '' : 'original',
      'modified',
      { context: 3 }
    );

    // Count lines
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of unifiedDiff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }

    return {
      relativePath,
      type,
      unifiedDiff,
      linesAdded,
      linesRemoved,
      isBinary: false,
      sandboxPath,
      originalPath: type !== 'added' ? originalPath : null,
    };
  }
}
