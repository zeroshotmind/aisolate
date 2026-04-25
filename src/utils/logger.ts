import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let _level: LogLevel = 'info';

const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function setLevel(level: LogLevel): void {
  _level = level;
}

function shouldLog(level: LogLevel): boolean {
  return order.indexOf(level) >= order.indexOf(_level);
}

export const log = {
  debug: (msg: string) => {
    if (shouldLog('debug')) console.debug(chalk.gray(`[debug] ${msg}`));
  },
  info: (msg: string) => {
    if (shouldLog('info')) console.log(chalk.cyan(`  ${msg}`));
  },
  success: (msg: string) => {
    if (shouldLog('info')) console.log(chalk.green(`✓ ${msg}`));
  },
  warn: (msg: string) => {
    if (shouldLog('warn')) console.warn(chalk.yellow(`⚠ ${msg}`));
  },
  error: (msg: string) => {
    if (shouldLog('error')) console.error(chalk.red(`✗ ${msg}`));
  },
  step: (msg: string) => {
    if (shouldLog('info')) console.log(chalk.bold(`\n→ ${msg}`));
  },
  separator: () => {
    if (shouldLog('info')) console.log(chalk.gray('─'.repeat(60)));
  },
};
