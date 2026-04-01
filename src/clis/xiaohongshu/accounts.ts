/**
 * Xiaohongshu account management CLI — add/list/remove/switch accounts.
 *
 * This command is scoped strictly to xiaohongshu and does NOT affect
 * any other site adapters or global daemon behavior.
 *
 * Usage:
 *   opencli xiaohongshu accounts list
 *   opencli xiaohongshu accounts add --name main
 *   opencli xiaohongshu accounts remove --name backup
 *   opencli xiaohongshu accounts switch --name main
 *
 * All accounts share the default daemon port (19825). Serial operation:
 * switch Chrome Profile → execute commands → switch to next Profile.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  addXhsAccount,
  removeXhsAccount,
  getXhsAccounts,
  getDefaultXhsAccount,
  setDefaultXhsAccount,
  type XhsAccountConfig,
} from './account-config.js';

function renderAccountTable(accounts: XhsAccountConfig[], defaultName: string): void {
  if (accounts.length === 0) {
    console.log(chalk.dim('  No accounts configured.'));
    console.log();
    console.log(chalk.dim('  Add an account:'));
    console.log(chalk.dim('    opencli xiaohongshu accounts add --name main'));
    console.log();
    return;
  }

  console.log();
  console.log(chalk.bold('  Xiaohongshu Accounts'));
  console.log();

  // Header
  const defaultLabel = chalk.green('(default)');
  console.log(
    `  ${chalk.cyan('Name'.padEnd(16))} ${chalk.cyan('Nickname'.padEnd(20))} ${chalk.cyan('Profile Dir')}`,
  );
  console.log(`  ${'─'.repeat(70)}`);

  for (const acc of accounts) {
    const isDefault = acc.name === defaultName;
    const name = isDefault ? `${acc.name} ${defaultLabel}` : acc.name;
    const nickname = (acc.nickname || '—').padEnd(20);
    const profileDir = acc.chromeProfileDir || '—';
    console.log(`  ${chalk.white(name.padEnd(16 + (isDefault ? 10 : 0)))} ${chalk.gray(nickname)} ${chalk.dim(profileDir)}`);
  }

  console.log();
  console.log(chalk.dim(`  ${accounts.length} account(s) configured`));
  console.log();
}

function renderAddHelp(): void {
  console.log();
  console.log(chalk.bold('  Add an account'));
  console.log();
  console.log(chalk.dim('  opencli xiaohongshu accounts add --name <name>'));
  console.log();
  console.log(chalk.dim('  Options:'));
  console.log(chalk.dim('    --name          Account name (e.g. main, backup)'));
  console.log();
  console.log(chalk.dim('  Example:'));
  console.log(chalk.dim('    opencli xiaohongshu accounts add --name main'));
  console.log();
  console.log(chalk.dim('  Then start Chrome with:'));
  console.log(chalk.dim('    chrome --user-data-dir=~/.opencli/profiles/xhs-main'));
  console.log();
}

function renderUsage(): void {
  console.log();
  console.log(chalk.bold('  Xiaohongshu Account Management'));
  console.log();
  console.log(chalk.dim('  Usage:'));
  console.log(chalk.dim('    opencli xiaohongshu accounts <command> [options]'));
  console.log();
  console.log(chalk.dim('  Commands:'));
  console.log(chalk.dim('    list              List all configured accounts'));
  console.log(chalk.dim('    add               Add a new account'));
  console.log(chalk.dim('    remove            Remove an account'));
  console.log(chalk.dim('    switch            Set default account'));
  console.log();
  console.log(chalk.dim('  Examples:'));
  console.log(chalk.dim('    opencli xiaohongshu accounts list'));
  console.log(chalk.dim('    opencli xiaohongshu accounts add --name main'));
  console.log(chalk.dim('    opencli xiaohongshu accounts switch --name main'));
  console.log(chalk.dim('    opencli xiaohongshu publish --account main --title "标题" "正文" --images a.jpg'));
  console.log();
}

/**
 * Generate a suggested Chrome profile directory path.
 */
function suggestProfileDir(name: string): string {
  return path.join(os.homedir(), '.opencli', 'profiles', 'xhs-' + name);
}

export function handleAccountsCommand(subcommand?: string, options?: Record<string, unknown>): void {
  const cmd = subcommand || 'list';
  const opts = options || {};

  switch (cmd) {
    case 'list': {
      const accounts = getXhsAccounts();
      const defaultName = getDefaultXhsAccount();
      renderAccountTable(accounts, defaultName);
      break;
    }

    case 'add': {
      const name = String(opts.name || '').trim();

      if (!name) {
        console.error(chalk.red('Error: --name is required'));
        renderAddHelp();
        process.exitCode = 1;
        return;
      }

      const result = addXhsAccount({
        name,
        chromeProfileDir: suggestProfileDir(name),
      });

      if (!result) {
        console.error(chalk.red(`Error: Account "${name}" already exists`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`✅ Account "${name}" added`));
      console.log();
      console.log(chalk.dim('  Next steps:'));
      console.log(chalk.dim(`    1. Start Chrome with profile:`));
      console.log(chalk.dim(`       chrome --user-data-dir="${result.chromeProfileDir}"`));
      console.log(chalk.dim(`    2. Log in to creator.xiaohongshu.com in that Chrome`));
      console.log(chalk.dim(`    3. Load the OpenCLI extension in that Chrome`));
      console.log(chalk.dim(`    4. Use the account:`));
      console.log(chalk.dim(`       opencli xiaohongshu publish --account ${name} --title "标题" "正文" --images a.jpg`));
      console.log();
      break;
    }

    case 'remove': {
      const name = String(opts.name || '').trim();
      if (!name) {
        console.error(chalk.red('Error: --name is required'));
        process.exitCode = 1;
        return;
      }

      const success = removeXhsAccount(name);
      if (!success) {
        console.error(chalk.red(`Error: Account "${name}" not found`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`✅ Account "${name}" removed`));
      console.log();
      break;
    }

    case 'switch': {
      const name = String(opts.name || '').trim();
      if (!name) {
        console.error(chalk.red('Error: --name is required'));
        process.exitCode = 1;
        return;
      }

      const success = setDefaultXhsAccount(name);
      if (!success) {
        console.error(chalk.red(`Error: Account "${name}" not found`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`✅ Default account switched to "${name}"`));
      console.log();
      break;
    }

    default:
      renderUsage();
      break;
  }
}
