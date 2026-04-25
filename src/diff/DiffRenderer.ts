import chalk from 'chalk';
import { FileDiff, DiffSummary } from './types';

export class DiffRenderer {
  renderSummary(summary: DiffSummary): string {
    if (summary.files.length === 0) {
      return chalk.gray('No changes.');
    }

    const parts: string[] = [];
    if (summary.modifiedFiles > 0) parts.push(chalk.yellow(`${summary.modifiedFiles} modified`));
    if (summary.newFiles > 0) parts.push(chalk.green(`${summary.newFiles} added`));
    if (summary.deletedFiles > 0) parts.push(chalk.red(`${summary.deletedFiles} deleted`));

    const lineStats = chalk.gray(
      `(+${summary.totalAdded} / -${summary.totalRemoved} lines)`
    );

    return `${parts.join(', ')} ${lineStats}`;
  }

  renderFileHeader(diff: FileDiff, index: number, total: number): string {
    const typeIcon = {
      modified: chalk.yellow('~'),
      added: chalk.green('+'),
      deleted: chalk.red('-'),
    }[diff.type];

    const typeLabel = {
      modified: chalk.yellow('modified'),
      added: chalk.green('new file'),
      deleted: chalk.red('deleted'),
    }[diff.type];

    const lineStats = diff.isBinary
      ? chalk.gray('(binary)')
      : chalk.gray(`(+${diff.linesAdded} / -${diff.linesRemoved})`);

    return (
      chalk.bold(`[${index}/${total}] `) +
      typeIcon + ' ' +
      chalk.bold(diff.relativePath) + ' ' +
      typeLabel + ' ' +
      lineStats
    );
  }

  renderDiff(diff: FileDiff): string {
    if (diff.isBinary) {
      return chalk.gray('  (binary file — cannot show diff)');
    }

    if (!diff.unifiedDiff) {
      return chalk.gray('  (no diff available)');
    }

    const lines = diff.unifiedDiff.split('\n');
    const rendered: string[] = [];

    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        rendered.push(chalk.bold(chalk.gray(line)));
      } else if (line.startsWith('@@')) {
        rendered.push(chalk.cyan(line));
      } else if (line.startsWith('+')) {
        rendered.push(chalk.green(line));
      } else if (line.startsWith('-')) {
        rendered.push(chalk.red(line));
      } else {
        rendered.push(chalk.gray(line));
      }
    }

    return rendered.join('\n');
  }

  renderSeparator(): string {
    return chalk.gray('─'.repeat(60));
  }
}
