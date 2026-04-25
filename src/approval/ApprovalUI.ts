import prompts from 'prompts';
import chalk from 'chalk';
import { FileDiff, DiffSummary } from '../diff/types';
import { DiffRenderer } from '../diff/DiffRenderer';
import { log } from '../utils/logger';

export interface ApprovalResult {
  acceptedFiles: FileDiff[];
  rejectedFiles: FileDiff[];
  cancelled: boolean;
}

export class ApprovalUI {
  private renderer = new DiffRenderer();

  async run(summary: DiffSummary): Promise<ApprovalResult> {
    if (summary.files.length === 0) {
      console.log(chalk.gray('\nNo changes to review.'));
      return { acceptedFiles: [], rejectedFiles: [], cancelled: false };
    }

    console.log('\n' + chalk.bold('═'.repeat(60)));
    console.log(chalk.bold(' agentbox — Review Changes'));
    console.log(chalk.bold('═'.repeat(60)));
    console.log(`\n${this.renderer.renderSummary(summary)}\n`);

    // Ask: review one-by-one or accept/reject all?
    const { mode } = await prompts({
      type: 'select',
      name: 'mode',
      message: 'How would you like to review these changes?',
      choices: [
        { title: 'Review each file', value: 'individual', description: 'See diff for each file and decide' },
        { title: 'Accept all', value: 'accept-all', description: `Apply all ${summary.files.length} changes` },
        { title: 'Reject all', value: 'reject-all', description: 'Discard all changes' },
      ],
    });

    if (mode === undefined) {
      // Ctrl+C
      return { acceptedFiles: [], rejectedFiles: summary.files, cancelled: true };
    }

    if (mode === 'accept-all') {
      log.success(`Accepted all ${summary.files.length} changes.`);
      return { acceptedFiles: summary.files, rejectedFiles: [], cancelled: false };
    }

    if (mode === 'reject-all') {
      log.warn(`Rejected all ${summary.files.length} changes.`);
      return { acceptedFiles: [], rejectedFiles: summary.files, cancelled: false };
    }

    // Individual review
    return this.reviewIndividually(summary.files);
  }

  private async reviewIndividually(files: FileDiff[]): Promise<ApprovalResult> {
    const accepted: FileDiff[] = [];
    const rejected: FileDiff[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const header = this.renderer.renderFileHeader(file, i + 1, files.length);

      console.log('\n' + this.renderer.renderSeparator());
      console.log(header);
      console.log(this.renderer.renderSeparator());

      // Show diff preview
      if (!file.isBinary) {
        const { showDiff } = await prompts({
          type: 'confirm',
          name: 'showDiff',
          message: 'Show diff?',
          initial: true,
        });

        if (showDiff) {
          console.log('\n' + this.renderer.renderDiff(file) + '\n');
        }
      } else {
        console.log(chalk.gray('(binary file)'));
      }

      const { decision } = await prompts({
        type: 'select',
        name: 'decision',
        message: `Apply changes to ${chalk.bold(file.relativePath)}?`,
        choices: [
          { title: chalk.green('✓ Accept'), value: 'accept', description: 'Apply this change to the real project' },
          { title: chalk.red('✗ Reject'), value: 'reject', description: 'Discard this change' },
          { title: chalk.yellow('» Skip for now'), value: 'skip', description: 'Skip and decide later (counted as rejected)' },
        ],
      });

      if (decision === undefined) {
        // Ctrl+C — stop reviewing
        log.warn('Review interrupted. Pending files counted as rejected.');
        const remaining = files.slice(i);
        rejected.push(...remaining);
        return { acceptedFiles: accepted, rejectedFiles: rejected, cancelled: true };
      }

      if (decision === 'accept') {
        accepted.push(file);
        log.success(`Accepted: ${file.relativePath}`);
      } else {
        rejected.push(file);
        log.warn(`Rejected: ${file.relativePath}`);
      }
    }

    console.log('\n' + chalk.bold('═'.repeat(60)));
    console.log(
      chalk.green(`✓ ${accepted.length} accepted`) +
      chalk.gray('  ') +
      chalk.red(`✗ ${rejected.length} rejected`)
    );
    console.log(chalk.bold('═'.repeat(60)));

    if (accepted.length > 0) {
      const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: `Apply ${accepted.length} accepted change(s) to the real project?`,
        initial: true,
      });

      if (!confirm) {
        log.warn('Application cancelled — no changes written to real project.');
        return { acceptedFiles: [], rejectedFiles: files, cancelled: true };
      }
    }

    return { acceptedFiles: accepted, rejectedFiles: rejected, cancelled: false };
  }
}
