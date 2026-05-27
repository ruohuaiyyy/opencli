/**
 * Toutiao account configuration — manages multiple Toutiao accounts.
 *
 * Stores per-account metadata including the last publish timestamp for account activity tracking.
 * Config stored at: ~/.opencli/accounts/toutiao.json
 *
 * When --account is not specified, falls back to legacy single-file approach
 * (~/.opencli/toutiao-last-publish.json) for backward compatibility.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ACCOUNTS_DIR = path.join(os.homedir(), '.opencli', 'accounts');
const TOUTIAO_CONFIG_PATH = path.join(ACCOUNTS_DIR, 'toutiao.json');

// Legacy single-file path for backward compatibility
const LEGACY_PUBLISH_TIME_FILE = path.join(os.homedir(), '.opencli', 'toutiao-last-publish.json');

export interface ToutiaoAccountEntry {
  /** Last publish timestamp (ms) for this account */
  lastPublishTime?: number;
  /** Timestamp (ms) when this account was last used */
  lastUsed?: number;
}

export interface ToutiaoAccountsConfig {
  /** Default account name used when --account is not specified */
  defaultAccount: string;
  /** Map of account name → account data */
  accounts: Record<string, ToutiaoAccountEntry>;
}

function ensureAccountsDir(): void {
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  }
}

function loadConfig(): ToutiaoAccountsConfig {
  ensureAccountsDir();
  if (!fs.existsSync(TOUTIAO_CONFIG_PATH)) {
    return { defaultAccount: 'default', accounts: {} };
  }
  try {
    const raw = fs.readFileSync(TOUTIAO_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as ToutiaoAccountsConfig;
  } catch {
    return { defaultAccount: 'default', accounts: {} };
  }
}

function saveConfig(config: ToutiaoAccountsConfig): void {
  ensureAccountsDir();
  fs.writeFileSync(TOUTIAO_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get all configured account names.
 */
export function getToutiaoAccountNames(): string[] {
  return Object.keys(loadConfig().accounts);
}

/**
 * Get account entry by name. Returns undefined if not found.
 */
export function getToutiaoAccount(name: string): ToutiaoAccountEntry | undefined {
  return loadConfig().accounts[name];
}

/**
 * Get the default account name.
 */
export function getDefaultToutiaoAccount(): string {
  return loadConfig().defaultAccount;
}

/**
 * Ensure an account entry exists (creates with defaults if missing).
 * Returns the account name that should be used (handles default).
 */
export function resolveToutiaoAccount(accountName?: string): string {
  const config = loadConfig();
  const name = accountName?.trim() || config.defaultAccount;

  if (!config.accounts[name]) {
    config.accounts[name] = {};
    saveConfig(config);
  }

  // Update last-used timestamp
  config.accounts[name].lastUsed = Date.now();
  saveConfig(config);

  return name;
}

/**
 * Get the last publish timestamp for a specific account.
 * Returns null if no timestamp has been saved for this account.
 *
 * When accountName is undefined, falls back to legacy single-file path
 * for backward compatibility with existing workflows.
 */
export function loadToutiaoLastPublishTime(accountName?: string): number | null {
  // Legacy path: no account specified, read from old file
  if (!accountName) {
    try {
      if (!fs.existsSync(LEGACY_PUBLISH_TIME_FILE)) return null;
      const data = JSON.parse(fs.readFileSync(LEGACY_PUBLISH_TIME_FILE, 'utf-8'));
      return data?.timestamp || null;
    } catch {
      return null;
    }
  }

  // Account-specific path
  const account = getToutiaoAccount(accountName);
  return account?.lastPublishTime || null;
}

/**
 * Save a publish timestamp for a specific account.
 *
 * When accountName is undefined, saves to legacy single file
 * for backward compatibility.
 */
export function saveToutiaoLastPublishTime(timestamp: number, accountName?: string): void {
  // Legacy path: no account specified, save to old file
  if (!accountName) {
    try {
      const dir = path.dirname(LEGACY_PUBLISH_TIME_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        LEGACY_PUBLISH_TIME_FILE,
        JSON.stringify({ timestamp, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8'
      );
    } catch {
      // Silently ignore
    }
    return;
  }

  // Account-specific path
  const config = loadConfig();
  if (!config.accounts[accountName]) {
    config.accounts[accountName] = {};
  }
  config.accounts[accountName].lastPublishTime = timestamp;
  config.accounts[accountName].lastUsed = Date.now();
  saveConfig(config);
}

/**
 * Clear the saved publish timestamp for a specific account.
 */
export function clearToutiaoLastPublishTime(accountName?: string): void {
  if (!accountName) {
    try {
      if (fs.existsSync(LEGACY_PUBLISH_TIME_FILE)) {
        fs.unlinkSync(LEGACY_PUBLISH_TIME_FILE);
      }
    } catch {
      // Silently ignore
    }
    return;
  }

  const config = loadConfig();
  if (config.accounts[accountName]) {
    delete config.accounts[accountName].lastPublishTime;
    saveConfig(config);
  }
}

/**
 * Add a new account (pre-creates entry so it shows up in list).
 */
export function addToutiaoAccount(name: string): boolean {
  const config = loadConfig();
  if (config.accounts[name]) return false;

  config.accounts[name] = {};
  // First account becomes default
  if (Object.keys(config.accounts).length === 1) {
    config.defaultAccount = name;
  }
  saveConfig(config);
  return true;
}

/**
 * Remove an account by name.
 */
export function removeToutiaoAccount(name: string): boolean {
  const config = loadConfig();
  if (!config.accounts[name]) return false;

  delete config.accounts[name];

  if (config.defaultAccount === name) {
    const remaining = Object.keys(config.accounts);
    config.defaultAccount = remaining[0] ?? 'default';
  }
  saveConfig(config);
  return true;
}