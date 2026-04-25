export type ChangeType = 'added' | 'modified' | 'deleted';

export interface FileDiff {
  /** Relative path within the project */
  relativePath: string;
  /** Type of change */
  type: ChangeType;
  /** Unified diff string (null for added binary files or deletions) */
  unifiedDiff: string | null;
  /** Line counts */
  linesAdded: number;
  linesRemoved: number;
  /** Whether this appears to be a binary file */
  isBinary: boolean;
  /** Full path in sandbox workspace (for reading content) */
  sandboxPath: string;
  /** Full path in real project (for reading original) */
  originalPath: string | null;
}

export interface DiffSummary {
  files: FileDiff[];
  totalAdded: number;
  totalRemoved: number;
  totalBinary: number;
  newFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
}
