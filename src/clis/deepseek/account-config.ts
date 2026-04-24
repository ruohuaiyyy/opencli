/**
 * DeepSeek account configuration — manages multiple DeepSeek accounts.
 *
 * Stores per-account metadata including the last used chat ID for --reuse support.
 * Config stored at: ~/.opencli/accounts/deepseek.json
 *
 * When --account is not specified, falls back to legacy single-file approach
 * (~/.opencli/deepseek-last-chat.json) for backward compatibility.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ACCOUNTS_DIR = path.join(os.homedir(), '.opencli', 'accounts');
const DEEPSEEK_CONFIG_PATH = path.join(ACCOUNTS_DIR, 'deepseek.json');

// Legacy single-file path for backward compatibility
const LEGACY_CHAT_ID_FILE = path.join(os.homedir(), '.opencli', 'deepseek-last-chat.json');

export interface DeepseekAccountEntry {
  /** Last chat ID used with this account */
  lastChatId?: string;
  /** Timestamp (ms) when this account was last used */
  lastUsed?: number;
}

export interface DeepseekAccountsConfig {
  /** Default account name used when --account is not specified */
  defaultAccount: string;
  /** Map of account name → account data */
  accounts: Record<string, DeepseekAccountEntry>;
}

function ensureAccountsDir(): void {
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  }
}

function loadConfig(): DeepseekAccountsConfig {
  ensureAccountsDir();
  if (!fs.existsSync(DEEPSEEK_CONFIG_PATH)) {
    return { defaultAccount: 'default', accounts: {} };
  }
  try {
    const raw = fs.readFileSync(DEEPSEEK_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as DeepseekAccountsConfig;
  } catch {
    return { defaultAccount: 'default', accounts: {} };
  }
}

function saveConfig(config: DeepseekAccountsConfig): void {
  ensureAccountsDir();
  fs.writeFileSync(DEEPSEEK_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Extract chat ID from DeepSeek URL.
 * Pattern: https://chat.deepseek.com/a/chat/s/{chatId}
 */
export function extractDeepseekChatId(url: string): string | null {
  const match = url.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
  return match?.[1] || null;
}

/**
 * Get all configured account names.
 */
export function getDeepseekAccountNames(): string[] {
  return Object.keys(loadConfig().accounts);
}

/**
 * Get account entry by name. Returns undefined if not found.
 */
export function getDeepseekAccount(name: string): DeepseekAccountEntry | undefined {
  return loadConfig().accounts[name];
}

/**
 * Get the default account name.
 */
export function getDefaultDeepseekAccount(): string {
  return loadConfig().defaultAccount;
}

/**
 * Ensure an account entry exists (creates with defaults if missing).
 * Returns the account name that should be used (handles default).
 */
export function resolveDeepseekAccount(accountName?: string): string {
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
 * Get the last chat ID for a specific account.
 * Returns null if no chat ID has been saved for this account.
 */
export function loadDeepseekLastChatId(accountName?: string): string | null {
  // Legacy path: no account specified, read from old file
  if (!accountName) {
    try {
      if (!fs.existsSync(LEGACY_CHAT_ID_FILE)) return null;
      const data = JSON.parse(fs.readFileSync(LEGACY_CHAT_ID_FILE, 'utf-8'));
      return data?.chatId || null;
    } catch {
      return null;
    }
  }

  // Account-specific path
  const account = getDeepseekAccount(accountName);
  return account?.lastChatId || null;
}

/**
 * Save a chat ID for a specific account.
 */
export function saveDeepseekLastChatId(chatId: string, accountName?: string): void {
  // Legacy path: no account specified, save to old file
  if (!accountName) {
    try {
      const dir = path.dirname(LEGACY_CHAT_ID_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        LEGACY_CHAT_ID_FILE,
        JSON.stringify({ chatId, timestamp: Date.now() }, null, 2),
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
  config.accounts[accountName].lastChatId = chatId;
  config.accounts[accountName].lastUsed = Date.now();
  saveConfig(config);
}

/**
 * Clear the saved chat ID for a specific account.
 */
export function clearDeepseekLastChatId(accountName?: string): void {
  if (!accountName) {
    try {
      if (fs.existsSync(LEGACY_CHAT_ID_FILE)) {
        fs.unlinkSync(LEGACY_CHAT_ID_FILE);
      }
    } catch {
      // Silently ignore
    }
    return;
  }

  const config = loadConfig();
  if (config.accounts[accountName]) {
    delete config.accounts[accountName].lastChatId;
    saveConfig(config);
  }
}

/**
 * Add a new account.
 */
export function addDeepseekAccount(name: string): boolean {
  const config = loadConfig();
  if (config.accounts[name]) return false;

  config.accounts[name] = {};
  if (Object.keys(config.accounts).length === 1) {
    config.defaultAccount = name;
  }
  saveConfig(config);
  return true;
}

/**
 * Remove an account by name.
 */
export function removeDeepseekAccount(name: string): boolean {
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