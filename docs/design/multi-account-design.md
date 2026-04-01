# OpenCLI 多账号管理设计方案（按平台隔离）

## 1. 需求概述

OpenCLI 小红书功能目前仅支持单一账号（复用浏览器当前登录会话），用户希望在 CLI 中管理多个小红书账号并快速切换。

**核心约束**: 账号管理按平台隔离，小红书账号仅在小红书模块下管理，不与其他平台相互影响。

---

## 2. 架构设计

### 2.1 按平台隔离的账号体系

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenCLI CLI                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │              xiaohongshu 模块                                │    │
│   │  ┌─────────────────────────────────────────────────────┐  │    │
│   │  │  xiaohongshu account add <name>                     │  │    │
│   │  │  xiaohongshu account list                           │  │    │
│   │  │  xiaohongshu account switch <id>                    │  │    │
│   │  └─────────────────────────────────────────────────────┘  │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │              bilibili 模块                                   │    │
│   │  ┌─────────────────────────────────────────────────────┐  │    │
│   │  │  bilibili account add <name>                         │  │    │
│   │  │  bilibili account list                               │  │    │
│   │  └─────────────────────────────────────────────────────┘  │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ~/.opencli/accounts/                              │
│                                                                     │
│   xiaohongshu.json    ← 小红书账号                                   │
│   bilibili.json        ← B站账号                                      │
│   twitter.json         ← Twitter账号                                 │
│   ...                                                       
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 存储结构

**配置文件位置**: `~/.opencli/accounts/{platform}.json`

```json
// ~/.opencli/accounts/xiaohongshu.json
{
  "platform": "xiaohongshu",
  "accounts": [
    {
      "id": "xhs-001",
      "name": "运营主号",
      "chromeProfile": "Profile 1",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    },
    {
      "id": "xhs-002",
      "name": "测试小号",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    }
  ],
  "activeAccount": "xhs-001"
}
```

```json
// ~/.opencli/accounts/bilibili.json
{
  "platform": "bilibili",
  "accounts": [
    {
      "id": "bilibili-001",
      "name": "B站主号",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    }
  ],
  "activeAccount": "bilibili-001"
}
```

---

## 3. CLI 命令设计

### 3.1 小红书账号管理

```bash
# 账号管理（xiaohongshu 子命令）
opencli xiaohongshu account add 运营主号 [--profile "Profile 1"]
opencli xiaohongshu account add 测试小号
opencli xiaohongshu account list
opencli xiaohongshu account remove <id>
opencli xiaohongshu account switch <id>
opencli xiaohongshu account active

# 使用指定账号执行命令
opencli xiaohongshu --account xhs-001 search 美食
opencli xiaohongshu -a xhs-001 publish "内容" --images a.jpg

# 使用默认账号（不指定时）
opencli xiaohongshu search 美食
```

### 3.2 B站账号管理

```bash
opencli bilibili account add B站主号
opencli bilibili account list
opencli bilibili account switch <id>
opencli bilibili --account bilibili-001 search 原神
```

### 3.3 命令继承关系

```
opencli <platform> <subcommand> [options]

# subcommand 可以是:
#   - 功能命令: search, publish, user 等
#   - 账号管理: account (子命令组)

# 账号管理子命令:
#   opencli xiaohongshu account add <name>
#   opencli xiaohongshu account list
#   opencli xiaohongshu account remove <id>
#   opencli xiaohongshu account switch <id>
#   opencli xiaohongshu account active
```

---

## 4. 实现方案

### 4.1 模块结构

```
src/
└── clis/
    └── xiaohongshu/
        ├── account.ts          ← 账号管理命令（新增）
        ├── account-store.ts    ← 账号存储逻辑（新增）
        ├── search.ts           ← 现有命令（修改：支持 --account）
        ├── publish.ts          ← 现有命令（修改：支持 --account）
        └── ...
```

### 4.2 账号存储模块

**文件**: `src/clis/xiaohongshu/account-store.ts`

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface XhsAccount {
  id: string;
  name: string;
  chromeProfile?: string;
  createdAt: number;
  updatedAt: number;
}

export interface XhsAccountStore {
  platform: 'xiaohongshu';
  accounts: XhsAccount[];
  activeAccount?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.opencli', 'accounts');

function getConfigPath(platform: string): string {
  return path.join(CONFIG_DIR, `${platform}.json`);
}

export async function loadStore(platform: string): Promise<XhsAccountStore> {
  const configPath = getConfigPath(platform);
  if (!fs.existsSync(configPath)) {
    return { platform, accounts: [] };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export async function saveStore(platform: string, store: XhsAccountStore): Promise<void> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(getConfigPath(platform), JSON.stringify(store, null, 2));
}

export async function addAccount(platform: string, name: string, chromeProfile?: string): Promise<XhsAccount> {
  const store = await loadStore(platform);
  const id = `${platform}-${Date.now()}`;
  const account: XhsAccount = {
    id,
    name,
    chromeProfile,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.accounts.push(account);
  if (!store.activeAccount) {
    store.activeAccount = id;
  }
  await saveStore(platform, store);
  return account;
}

export async function listAccounts(platform: string): Promise<XhsAccount[]> {
  const store = await loadStore(platform);
  return store.accounts;
}

export async function removeAccount(platform: string, id: string): Promise<void> {
  const store = await loadStore(platform);
  store.accounts = store.accounts.filter(a => a.id !== id);
  if (store.activeAccount === id) {
    store.activeAccount = store.accounts[0]?.id;
  }
  await saveStore(platform, store);
}

export async function setActiveAccount(platform: string, id: string): Promise<void> {
  const store = await loadStore(platform);
  if (!store.accounts.find(a => a.id === id)) {
    throw new Error(`Account ${id} not found`);
  }
  store.activeAccount = id;
  await saveStore(platform, store);
}

export async function getActiveAccount(platform: string): Promise<XhsAccount | undefined> {
  const store = await loadStore(platform);
  if (!store.activeAccount) return undefined;
  return store.accounts.find(a => a.id === store.activeAccount);
}

export async function getAccountById(platform: string, id: string): Promise<XhsAccount | undefined> {
  const store = await loadStore(platform);
  return store.accounts.find(a => a.id === id);
}
```

### 4.3 账号管理 CLI 命令

**文件**: `src/clis/xiaohongshu/account.ts`

```typescript
import { cli, Strategy } from '../../registry.js';
import * as store from './account-store.js';

cli({
  site: 'xiaohongshu',
  name: 'account',
  description: 'Manage Xiaohongshu accounts',
  strategy: Strategy.PUBLIC,
  args: [
    { name: 'action', required: true, positional: true, choices: ['add', 'list', 'remove', 'switch', 'active'] },
    { name: 'name', positional: true, help: 'Account name (for add action)' },
    { name: 'id', help: 'Account ID (for remove/switch action)' },
    { name: 'profile', help: 'Chrome profile name (for add action)' },
  ],
  func: async (_page, kwargs) => {
    const action = kwargs.action;
    const platform = 'xiaohongshu';

    switch (action) {
      case 'add': {
        const name = kwargs.name;
        if (!name) throw new Error('Account name is required');
        const account = await store.addAccount(platform, name, kwargs.profile);
        return [{ status: '✅ Added', id: account.id, name: account.name }];
      }
      case 'list': {
        const accounts = await store.listAccounts(platform);
        const active = await store.getActiveAccount(platform);
        return accounts.map(a => ({
          id: a.id,
          name: a.name,
          profile: a.chromeProfile || 'default',
          active: a.id === active?.id ? '✅' : '',
        }));
      }
      case 'remove': {
        const id = kwargs.id;
        if (!id) throw new Error('Account ID is required');
        await store.removeAccount(platform, id);
        return [{ status: '✅ Removed', id }];
      }
      case 'switch': {
        const id = kwargs.id;
        if (!id) throw new Error('Account ID is required');
        await store.setActiveAccount(platform, id);
        return [{ status: '✅ Switched', activeAccount: id }];
      }
      case 'active': {
        const account = await store.getActiveAccount(platform);
        if (!account) return [{ status: '⚠️ No active account', name: '(use account add to create one)' }];
        return [{ id: account.id, name: account.name, profile: account.chromeProfile || 'default' }];
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
});
```

### 4.4 命令执行时账号参数处理

**修改**: 在各功能命令中添加 `--account` / `-a` 参数

```typescript
// src/clis/xiaohongshu/search.ts（修改）
cli({
  site: 'xiaohongshu',
  name: 'search',
  // ... existing config
  args: [
    { name: 'query', required: true, positional: true, help: 'Search keyword' },
    { name: 'limit', type: 'int', default: 20, help: 'Number of results' },
    { name: 'account', alias: 'a', help: 'Account ID to use' },  // ← 新增
  ],
  func: async (page, kwargs) => {
    // 获取账号信息
    let workspace = `site:xiaohongshu`;
    if (kwargs.account) {
      const account = await store.getAccountById('xiaohongshu', kwargs.account);
      if (account) {
        workspace = `site:xiaohongshu:account:${account.id}`;
        if (account.chromeProfile) {
          // 设置 Chrome Profile
        }
      }
    }
    // ... 原有逻辑
  },
});
```

### 4.5 Workspace 映射

```
# 格式
site:{platform}                    ← 默认（当前浏览器会话）
site:{platform}:account:{id}       ← 指定账号

# 示例
site:xiaohongshu                  ← 默认
site:xiaohongshu:account:xhs-001  ← 指定账号
site:xiaohongshu:account:xhs-002  ← 另一个账号
```

---

## 5. 执行流程

### 5.1 使用指定账号执行

```bash
opencli xiaohongshu --account xhs-001 search 美食
```

```
1. 解析参数: action=search, account=xhs-001
2. 加载账号配置: 从 ~/.opencli/accounts/xiaohongshu.json 读取
3. 构建 workspace: "site:xiaohongshu:account:xhs-001"
4. 调用 BrowserBridge，传入 workspace
5. Extension 创建独立窗口（隔离）
6. 执行搜索命令
```

### 5.2 使用默认账号执行

```bash
opencli xiaohongshu search 美食
```

```
1. 解析参数: action=search, account=undefined
2. 尝试获取默认账号: 从 store 获取 activeAccount
3. 如果有默认账号 → 使用对应 workspace
4. 如果无默认账号 → 使用 "site:xiaohongshu"（现有行为）
```

---

## 6. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/clis/xiaohongshu/account-store.ts` | 新增 | 账号存储逻辑 |
| `src/clis/xiaohongshu/account.ts` | 新增 | 账号管理命令 |
| `src/clis/xiaohongshu/search.ts` | 修改 | 添加 --account 参数 |
| `src/clis/xiaohongshu/publish.ts` | 修改 | 添加 --account 参数 |
| `src/clis/xiaohongshu/user.ts` | 修改 | 添加 --account 参数 |
| `src/clis/xiaohongshu/*.ts` | 修改 | 其他需要账号支持的命令 |

---

## 7. 实施计划

### Phase 1: 账号管理基础（1天）

1. 创建 `account-store.ts` - 账号存储模块
2. 创建 `account.ts` - 账号管理命令
3. 测试 CRUD 操作

### Phase 2: 命令集成（1天）

1. 修改 `search.ts` 支持 `--account` 参数
2. 修改 `publish.ts` 支持 `--account` 参数
3. 端到端测试

### Phase 3: 其他命令（1天）

1. 修改其他小红书命令
2. 文档更新

---

## 8. 验收标准

1. ✅ 小红书账号管理与 B站/Twitter 等平台完全隔离
2. ✅ 可以添加、删除、列出、切换账号
3. ✅ `--account` 参数可以指定账号执行命令
4. ✅ 不指定账号时使用默认账号或当前浏览器会话
5. ✅ 配置文件存储在 `~/.opencli/accounts/xiaohongshu.json`
6. ✅ 兼容现有命令（不指定账号时行为不变）
