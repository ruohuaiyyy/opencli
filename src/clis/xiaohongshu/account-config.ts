/**
 * Xiaohongshu account configuration — manages multiple creator accounts.
 *
 * All accounts share the default daemon port (19825). Serial operation only:
 * switch Chrome Profile → execute commands → switch to next Profile.
 *
 * Config stored at: ~/.opencli/accounts/xiaohongshu.json
 *
 * IMPORTANT: This module is scoped to xiaohongshu only and does NOT
 * affect any other site adapters or global daemon behavior.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ACCOUNTS_DIR = path.join(os.homedir(), '.opencli', 'accounts');
const XHS_CONFIG_PATH = path.join(ACCOUNTS_DIR, 'xiaohongshu.json');

export interface XhsAccountConfig {
  /** Display name for this account (e.g. "main", "backup") */
  name: string;
  /** Chrome profile directory path (user-data-dir) */
  chromeProfileDir?: string;
  /** Account nickname from XHS creator center (auto-detected) */
  nickname?: string;
  /** When this account was added */
  addedAt: string;
}

export interface XhsAccountsConfig {
  /** Default account name used when --account is not specified */
  defaultAccount: string;
  accounts: XhsAccountConfig[];
}

function ensureAccountsDir(): void {
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  }
}

function loadConfig(): XhsAccountsConfig {
  ensureAccountsDir();
  if (!fs.existsSync(XHS_CONFIG_PATH)) {
    return { defaultAccount: 'default', accounts: [] };
  }
  try {
    const raw = fs.readFileSync(XHS_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as XhsAccountsConfig;
  } catch {
    return { defaultAccount: 'default', accounts: [] };
  }
}

function saveConfig(config: XhsAccountsConfig): void {
  ensureAccountsDir();
  fs.writeFileSync(XHS_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get all configured accounts.
 */
export function getXhsAccounts(): XhsAccountConfig[] {
  return loadConfig().accounts;
}

/**
 * Get a specific account by name.
 */
export function getXhsAccount(name: string): XhsAccountConfig | undefined {
  return loadConfig().accounts.find((a) => a.name === name);
}

/**
 * Get the default account name.
 */
export function getDefaultXhsAccount(): string {
  return loadConfig().defaultAccount;
}

/**
 * Set the default account.
 */
export function setDefaultXhsAccount(name: string): boolean {
  const config = loadConfig();
  if (!config.accounts.find((a) => a.name === name)) {
    return false;
  }
  config.defaultAccount = name;
  saveConfig(config);
  return true;
}

/**
 * Add a new account. Returns the created config or null if name exists.
 */
export function addXhsAccount(opts: {
  name: string;
  chromeProfileDir?: string;
}): XhsAccountConfig | null {
  const config = loadConfig();

  if (config.accounts.find((a) => a.name === opts.name)) {
    return null;
  }

  const account: XhsAccountConfig = {
    name: opts.name,
    chromeProfileDir: opts.chromeProfileDir,
    addedAt: new Date().toISOString(),
  };

  config.accounts.push(account);

  // First account becomes default
  if (config.accounts.length === 1) {
    config.defaultAccount = account.name;
  }

  saveConfig(config);
  return account;
}

/**
 * Remove an account by name.
 */
export function removeXhsAccount(name: string): boolean {
  const config = loadConfig();
  const idx = config.accounts.findIndex((a) => a.name === name);
  if (idx === -1) return false;

  config.accounts.splice(idx, 1);

  // If we removed the default, pick a new one
  if (config.defaultAccount === name) {
    config.defaultAccount = config.accounts[0]?.name ?? 'default';
  }

  saveConfig(config);
  return true;
}

/**
 * Update account nickname (auto-detected from creator center).
 */
export function updateXhsAccountNickname(name: string, nickname: string): boolean {
  const config = loadConfig();
  const account = config.accounts.find((a) => a.name === name);
  if (!account) return false;

  account.nickname = nickname;
  saveConfig(config);
  return true;
}

/**
 * Resolve the daemon port for a given account.
 * All xiaohongshu accounts share the default port (serial operation).
 */
export function resolveXhsDaemonPort(_accountName?: string): number {
  return 19825;
}
