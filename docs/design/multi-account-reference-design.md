# 多账号管理功能参考设计

本文档为其他功能/平台实现多账号管理提供参考。描述了两种多账号管理模式的实现方式和关键设计决策。

---

## 1. 两种多账号管理模式

### 浏览器会话隔离型 (以小红书为例)

**适用场景**: 需要完全浏览器隔离的功能，如多账号发布、评论、查看不同账号的数据等。

**隔离方式**: 每个账号对应一个独立的 Chrome Profile 目录

**特点**:
- 不同账号使用不同的 Chrome 浏览器环境
- Cookie、Session、登录状态完全隔离
- 适合需要高隔离级别的操作

**代表平台**: 小红书

### 模式 B: 会话数据隔离型 (以豆包/文心为例)

**适用场景**: 只需要追踪会话历史的功能，如 AI 对话机器人的多账号支持。

**隔离方式**: 通过账号名称 + 最后使用的会话 ID (lastChatId) 追踪

**特点**:
- 所有账号共享同一个浏览器环境
- 仅通过 lastChatId 追踪不同账号的对话历史
- 适合只需要会话历史隔离的操作

**代表平台**: 豆包 (Doubao)、文心 (Qwen)、元宝 (Yuanbao)、DeepSeek

---

## 2. 模式 A 实现指南 (浏览器会话隔离型)

### 2.1 核心组件

需要创建以下文件 (以 `xiaohongshu` 为例):

```
src/clis/<platform>/
├── account-config.ts    ← 账号配置管理模块
├── accounts.ts          ← 账号管理 CLI 命令
└── *.ts                 ← 功能命令 (添加 --account 支持)
```

### 2.2 account-config.ts 模板

```typescript
/**
 * {Platform} account configuration — manages multiple {platform} accounts.
 *
 * Config stored at: ~/.opencli/accounts/{platform}.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ACCOUNTS_DIR = path.join(os.homedir(), '.opencli', 'accounts');
const CONFIG_PATH = path.join(ACCOUNTS_DIR, '{platform}.json');

export interface AccountConfig {
  /** 账号唯一标识名称 */
  name: string;
  /** Chrome Profile 目录路径 (可选) */
  chromeProfileDir?: string;
  /** 账号昵称 (可选) */
  nickname?: string;
  /** 添加时间 */
  addedAt: string;
}

export interface AccountsConfig {
  /** 默认账号名称 */
  defaultAccount: string;
  /** 账号列表 */
  accounts: AccountConfig[];
}

// ─── 内部函数 ───────────────────────────────────────────────

function ensureAccountsDir(): void {
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  }
}

function loadConfig(): AccountsConfig {
  ensureAccountsDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { defaultAccount: 'default', accounts: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as AccountsConfig;
  } catch {
    return { defaultAccount: 'default', accounts: [] };
  }
}

function saveConfig(config: AccountsConfig): void {
  ensureAccountsDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// ─── 公共 API ────────────────────────────────────────────────

/**
 * 获取所有账号
 */
export function getAccounts(): AccountConfig[] {
  return loadConfig().accounts;
}

/**
 * 获取指定账号
 */
export function getAccount(name: string): AccountConfig | undefined {
  return loadConfig().accounts.find((a) => a.name === name);
}

/**
 * 获取默认账号名称
 */
export function getDefaultAccount(): string {
  return loadConfig().defaultAccount;
}

/**
 * 设置默认账号
 */
export function setDefaultAccount(name: string): boolean {
  const config = loadConfig();
  if (!config.accounts.find((a) => a.name === name)) {
    return false;
  }
  config.defaultAccount = name;
  saveConfig(config);
  return true;
}

/**
 * 添加新账号
 */
export function addAccount(opts: { name: string; chromeProfileDir?: string }): AccountConfig | null {
  const config = loadConfig();

  if (config.accounts.find((a) => a.name === opts.name)) {
    return null; // 账号已存在
  }

  const account: AccountConfig = {
    name: opts.name,
    chromeProfileDir: opts.chromeProfileDir,
    addedAt: new Date().toISOString(),
  };

  config.accounts.push(account);

  // 第一个账号自动成为默认账号
  if (config.accounts.length === 1) {
    config.defaultAccount = account.name;
  }

  saveConfig(config);
  return account;
}

/**
 * 删除账号
 */
export function removeAccount(name: string): boolean {
  const config = loadConfig();
  const idx = config.accounts.findIndex((a) => a.name === name);
  if (idx === -1) return false;

  config.accounts.splice(idx, 1);

  // 如果删除的是默认账号，切换到第一个剩余账号
  if (config.defaultAccount === name) {
    config.defaultAccount = config.accounts[0]?.name ?? 'default';
  }

  saveConfig(config);
  return true;
}

/**
 * 解析 Daemon 端口 (如果需要不同账号用不同端口)
 */
export function resolveDaemonPort(_accountName?: string): number {
  return 19825; // 默认端口
}
```

### 2.3 accounts.ts 模板

```typescript
/**
 * {Platform} account management CLI
 *
 * Usage:
 *   opencli {platform} accounts list
 *   opencli {platform} accounts add --name <name>
 *   opencli {platform} accounts remove --name <name>
 *   opencli {platform} accounts switch --name <name>
 */

import chalk from 'chalk';
import {
  addAccount,
  removeAccount,
  getAccounts,
  getDefaultAccount,
  setDefaultAccount,
  type AccountConfig,
} from './account-config.js';

function renderAccountTable(accounts: AccountConfig[], defaultName: string): void {
  if (accounts.length === 0) {
    console.log(chalk.dim('  No accounts configured.'));
    return;
  }

  console.log();
  console.log(chalk.bold('  {Platform} Accounts'));
  console.log();
  console.log(`  ${chalk.cyan('Name'.padEnd(16))} ${chalk.cyan('Nickname'.padEnd(20))}`);
  console.log(`  ${'─'.repeat(60)}`);

  for (const acc of accounts) {
    const isDefault = acc.name === defaultName;
    const name = isDefault ? `${acc.name} ${chalk.green('(default)')}` : acc.name;
    const nickname = acc.nickname || '—';
    console.log(`  ${name.padEnd(20)} ${chalk.gray(nickname)}`);
  }
  console.log();
}

export function handleAccountsCommand(subcommand?: string, options?: Record<string, unknown>): void {
  const cmd = subcommand || 'list';
  const opts = options || {};

  switch (cmd) {
    case 'list': {
      const accounts = getAccounts();
      const defaultName = getDefaultAccount();
      renderAccountTable(accounts, defaultName);
      break;
    }

    case 'add': {
      const name = String(opts.name || '').trim();
      if (!name) {
        console.error(chalk.red('Error: --name is required'));
        process.exitCode = 1;
        return;
      }
      const result = addAccount({ name });
      if (!result) {
        console.error(chalk.red(`Error: Account "${name}" already exists`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`✅ Account "${name}" added`));
      break;
    }

    case 'remove': {
      const name = String(opts.name || '').trim();
      if (!name) {
        console.error(chalk.red('Error: --name is required'));
        process.exitCode = 1;
        return;
      }
      if (!removeAccount(name)) {
        console.error(chalk.red(`Error: Account "${name}" not found`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`✅ Account "${name}" removed`));
      break;
    }

    case 'switch': {
      const name = String(opts.name || '').trim();
      if (!name) {
        console.error(chalk.red('Error: --name is required'));
        process.exitCode = 1;
        return;
      }
      if (!setDefaultAccount(name)) {
        console.error(chalk.red(`Error: Account "${name}" not found`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`✅ Default account switched to "${name}"`));
      break;
    }

    default:
      console.log(`Usage: opencli {platform} accounts <command>`);
      break;
  }
}
```

### 2.4 CLI 适配器修改

在 `src/commanderAdapter.ts` 中，为目标平台添加 `--account` 参数支持:

```typescript
// 在 registerCommandToProgram 函数中，找到对应的平台判断逻辑
if (cmd.site === '<platform>' && cmd.name !== 'accounts') {
  subCmd.option('--account <name>', '{Platform} account name');
}
```

---

## 3. 配置文件结构

### 3.1 存储位置

所有平台的账号配置统一存储在:

```
~/.opencli/accounts/
├── xiaohongshu.json    ← 小红书
├── doubao.json         ← 豆包
├── qwen.json           ← 文心
├── yuanbao.json        ← 元宝
└── deepseek.json       ← DeepSeek
```

### 3.2 模式 A 配置示例 (小红书)

```json
{
  "defaultAccount": "main",
  "accounts": [
    {
      "name": "main",
      "chromeProfileDir": "~/.opencli/profiles/xhs-main",
      "nickname": "运营主号",
      "addedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### 3.3 模式 B 配置示例 (豆包)

```json
{
  "defaultAccount": "default",
  "accounts": {
    "default": {
      "lastChatId": "abc123",
      "lastUsed": 1704067200000
    },
    "work": {
      "lastChatId": "def456",
      "lastUsed": 1704153600000
    }
  }
}
```

---

## 4. 关键设计决策

### 4.1 选择隔离模式

| 问题 | 模式 A (浏览器隔离) | 模式 B (会话追踪) |
|------|---------------------|-------------------|
| 账号需要完全独立的浏览器环境吗？ | 是 → 选择模式 A | 否 → 选择模式 B |
| 不同账号需要同时登录吗？ | 不需要 → 模式 A 可行 | 需要 → 模式 A |
| 只需要追踪会话历史吗？ | 否 → 模式 B 可能更合适 | 是 → 选择模式 B |

### 4.2 账号命名

- **建议**: 使用有意义的名称，如 `main`、`backup`、`work`、`personal`
- **约束**: 账号名称在同一平台内必须唯一
- **特殊值**: `default` 保留作为无账号配置时的回退值

### 4.3 默认账号

- 第一个添加的账号自动成为默认账号
- 删除默认账号后，自动切换到第一个剩余账号
- 如果没有剩余账号，`defaultAccount` 设为字符串 `"default"`

---

## 5. CLI 使用方式

### 5.1 账号管理命令

```bash
# 列出所有账号
opencli <platform> accounts list

# 添加账号
opencli <platform> accounts add --name <name>

# 删除账号
opencli <platform> accounts remove --name <name>

# 切换默认账号
opencli <platform> accounts switch --name <name>
```

### 5.2 功能命令使用

```bash
# 使用默认账号
opencli <platform> <command> <args>

# 使用指定账号
opencli <platform> --account <name> <command> <args>

# 或在支持的位置参数
opencli <platform> <command> --account <name> <args>
```

---

## 6. 错误处理

### 6.1 常见错误

| 错误场景 | 错误信息 | 处理建议 |
|----------|----------|----------|
| 账号不存在 | `Error: Account "xxx" not found` | 提示使用 `accounts list` 查看可用账号 |
| 账号已存在 | `Error: Account "xxx" already exists` | 提示使用其他名称 |
| 未提供必填参数 | `Error: --name is required` | 显示帮助信息 |
| 配置文件损坏 | 回退到默认配置 | 使用空配置 `{}` |

### 6.2 配置文件损坏处理

```typescript
function loadConfig(): AccountsConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as AccountsConfig;
  } catch {
    // 配置文件损坏时，返回默认配置
    return { defaultAccount: 'default', accounts: [] };
  }
}
```

---

## 7. 参考实现

以下平台的账号管理实现可作为参考:

| 平台 | 模式 | 文件路径 |
|------|------|----------|
| 小红书 | A (浏览器隔离) | `src/clis/xiaohongshu/account-config.ts` |
| 豆包 | B (会话追踪) | `src/clis/doubao/account-config.ts` |
| 文心 | B (会话追踪) | `src/clis/qwen/account-config.ts` |
| 元宝 | B (会话追踪) | `src/clis/yuanbao/account-config.ts` |
| DeepSeek | B (会话追踪) | `src/clis/deepseek/account-config.ts` |

---

## 8. 注意事项

1. **向后兼容**: 如果功能之前没有账号管理，确保 `--account` 参数是可选的，不指定时使用现有行为
2. **配置文件迁移**: 如果需要从旧格式迁移，提供迁移脚本并保持兼容性
3. **并发安全**: 多账号场景下注意文件读写的原子性
4. **清理机制**: 考虑添加清理长期不使用账号的功能
