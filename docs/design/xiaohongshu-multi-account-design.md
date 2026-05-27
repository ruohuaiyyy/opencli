# 小红书多账号管理功能设计方案总结

## 1. 概述

小红书多账号管理功能允许用户在 CLI 中管理多个小红书账号并快速切换，支持为每个账号绑定独立的 Chrome Profile，实现账号间的完全隔离。

### 核心特性

- **按平台隔离**: 小红书账号仅在小红书模块下管理，不与其他平台相互影响
- **Chrome Profile 隔离**: 每个账号对应一个独立的 Chrome Profile 目录
- **共享 Daemon 端口**: 所有账号共享默认端口 (19825)，串行操作
- **易于切换**: 通过 `--account` 参数或 `accounts switch` 命令切换默认账号

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        OpenCLI CLI                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────────────────────────────────────────────────┐   │
│   │              xiaohongshu 模块                         │   │
│   │  ┌────────────────────────────────────────────────┐  │   │
│   │  │  xiaohongshu accounts add <name>               │  │   │
│   │  │  xiaohongshu accounts list                     │  │   │
│   │  │  xiaohongshu accounts remove <name>            │  │   │
│   │  │  xiaohongshu accounts switch <name>            │  │   │
│   │  └────────────────────────────────────────────────┘  │   │
│   │                                                       │   │
│   │  ┌────────────────────────────────────────────────┐  │   │
│   │  │  功能命令 (支持 --account 参数)                  │  │   │
│   │  │  xiaohongshu search --account <name> <query>   │  │   │
│   │  │  xiaohongshu publish --account <name> ...       │  │   │
│   │  │  xiaohongshu user --account <name> <user-id>    │  │   │
│   │  └────────────────────────────────────────────────┘  │   │
│   └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  ~/.opencli/accounts/                        │
│                                                              │
│   xiaohongshu.json    ← 小红书账号配置                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 配置文件存储

**存储位置**: `~/.opencli/accounts/xiaohongshu.json`

**配置结构**:

```json
{
  "defaultAccount": "main",
  "accounts": [
    {
      "name": "main",
      "chromeProfileDir": "~/.opencli/profiles/xhs-main",
      "nickname": "运营主号",
      "addedAt": "2024-01-01T00:00:00.000Z"
    },
    {
      "name": "backup",
      "chromeProfileDir": "~/.opencli/profiles/xhs-backup",
      "nickname": "测试小号",
      "addedAt": "2024-01-02T00:00:00.000Z"
    }
  ]
}
```

---

## 3. 核心模块设计

### 3.1 目录结构

```
src/clis/xiaohongshu/
├── account-config.ts    ← 账号配置管理 (配置加载/保存/CRUD)
├── accounts.ts          ← 账号管理 CLI 命令 (list/add/remove/switch)
├── search.ts            ← 搜索命令 (已支持 --account)
├── publish.ts          ← 发布命令 (已支持 --account)
├── user.ts              ← 用户信息命令 (已支持 --account)
├── download.ts          ← 下载命令
├── comments.ts          ← 评论命令
└── creator-*.ts         ← 创作者相关命令
```

### 3.2 account-config.ts — 账号配置核心模块

**文件路径**: `src/clis/xiaohongshu/account-config.ts`

**核心接口**:

```typescript
// 账号配置
interface XhsAccountConfig {
  name: string;              // 账号名称 (唯一标识)
  chromeProfileDir?: string;  // Chrome Profile 目录路径
  nickname?: string;         // 小红书创作者昵称 (自动检测)
  addedAt: string;           // 添加时间
}

// 账号配置集合
interface XhsAccountsConfig {
  defaultAccount: string;     // 默认账号名称
  accounts: XhsAccountConfig[];
}
```

**核心函数**:

| 函数 | 作用 |
|------|------|
| `getXhsAccounts()` | 获取所有账号列表 |
| `getXhsAccount(name)` | 获取指定账号 |
| `getDefaultXhsAccount()` | 获取默认账号名称 |
| `setDefaultXhsAccount(name)` | 设置默认账号 |
| `addXhsAccount(opts)` | 添加新账号 |
| `removeXhsAccount(name)` | 删除账号 |
| `resolveXhsDaemonPort(name)` | 解析账号对应的 daemon 端口 |
| `updateXhsAccountNickname(name, nickname)` | 更新账号昵称 |

**关键设计决策**:

1. **共享 Daemon 端口**: 所有账号共享 19825 端口，串行执行操作
2. **Chrome Profile 隔离**: 通过不同的 Chrome Profile 目录实现账号隔离
3. **自动创建**: 第一个添加的账号自动成为默认账号
4. **安全删除**: 删除账号时，如果删除的是默认账号，自动切换到第一个剩余账号

### 3.3 accounts.ts — CLI 命令处理

**文件路径**: `src/clis/xiaohongshu/accounts.ts`

**子命令**:

| 命令 | 说明 |
|------|------|
| `list` | 列出所有账号 |
| `add --name <name>` | 添加新账号 |
| `remove --name <name>` | 删除指定账号 |
| `switch --name <name>` | 切换默认账号 |

**使用示例**:

```bash
# 列出所有账号
opencli xiaohongshu accounts list

# 添加账号
opencli xiaohongshu accounts add --name main

# 切换默认账号
opencli xiaohongshu accounts switch --name backup

# 删除账号
opencli xiaohongshu accounts remove --name backup
```

**输出示例**:

```
  Xiaohongshu Accounts

  Name             Nickname              Profile Dir
  ───────────────────────────────────────────────────────
  main     (default)  运营主号            ~/.opencli/profiles/xhs-main
  backup                测试小号           ~/.opencli/profiles/xhs-backup

  2 account(s) configured
```

---

## 4. 命令集成设计

### 4.1 --account 参数注入

在 `commanderAdapter.ts` 中，为小红书的所有命令（除 `accounts` 命令外）自动添加 `--account` 选项：

```typescript
// src/commanderAdapter.ts (第 73-78 行)
if (cmd.site === 'xiaohongshu' && cmd.name !== 'accounts') {
  subCmd.option('--account <name>', 'Xiaohongshu account name (see: opencli xiaohongshu accounts list)');
}
```

### 4.2 功能命令中的账号使用

以 `publish.ts` 为例，命令函数通过 `kwargs.account` 获取指定账号：

```typescript
// 命令定义 (已由 commanderAdapter 自动添加 --account 参数)
cli({
  site: 'xiaohongshu',
  name: 'publish',
  // ...
  func: async (page, kwargs) => {
    // 通过 kwargs.account 获取账号名称
    const accountName = kwargs.account as string | undefined;
    // ... 后续逻辑使用 accountName
  },
});
```

**使用示例**:

```bash
# 使用默认账号发布
opencli xiaohongshu publish --title "标题" "正文" --images a.jpg

# 使用指定账号发布
opencli xiaohongshu publish --account main --title "标题" "正文" --images a.jpg
```

---

## 5. 账号解析流程

### 5.1 账号解析顺序

```
1. 检查是否指定 --account 参数
   │
   ├─ 是 → 使用指定的账号
   │
   └─ 否 → 使用默认账号 (从 xiaohongshu.json 读取)
              │
              ├─ 有默认账号 → 使用默认账号
              │
              └─ 无默认账号 → 使用 null (降级到当前浏览器会话)
```

### 5.2 Chrome Profile 切换流程

由于所有账号共享同一个 Daemon 端口，切换账号需要：

1. **用户手动切换 Chrome Profile**: 关闭当前 Chrome，用新 Profile 重新打开
2. **Extension 重新连接**: 新的 Chrome Profile 需要加载 OpenCLI Extension

**配置示例**:

```bash
# 启动主号 Chrome
chrome --user-data-dir=~/.opencli/profiles/xhs-main

# 启动小号 Chrome
chrome --user-data-dir=~/.opencli/profiles/xhs-backup
```

---

## 6. 错误处理

### 6.1 常见错误及处理

| 场景 | 错误信息 | 处理方式 |
|------|----------|----------|
| 账号不存在 | `Error: Account "xxx" not found` | 提示用户使用 `accounts list` 查看可用账号 |
| 账号已存在 | `Error: Account "xxx" already exists` | 提示用户使用其他名称 |
| 未指定必填参数 | `Error: --name is required` | 显示帮助信息 |

### 6.2 帮助信息

每个子命令都提供详细的帮助信息：

```bash
# 查看账号管理帮助
opencli xiaohongshu accounts

# 查看添加账号帮助
opencli xiaohongshu accounts add
```

---

## 7. 与其他平台的对比

### 7.1 小红书 vs 豆包/文心/元宝

| 特性 | 小红书 | 豆包/文心/元宝 |
|------|--------|----------------|
| 隔离方式 | Chrome Profile 目录 | 仅账号名追踪 |
| Daemon 端口 | 共享 19825 | 共享 (聊天ID追踪) |
| 状态追踪 | Profile + 最后使用时间 | 最后聊天ID |
| 适用场景 | 需要完全浏览器隔离 | 只需要聊天历史隔离 |

### 7.2 账号配置结构差异

**小红书** (基于数组 + Chrome Profile):

```typescript
interface XhsAccountConfig {
  name: string;
  chromeProfileDir?: string;
  nickname?: string;
  addedAt: string;
}
```

**豆包/文心** (基于 Map + Chat ID):

```typescript
interface DoubaoAccountEntry {
  lastChatId?: string;
  lastUsed?: number;
}
```

---

## 8. 文件清单

| 文件路径 | 说明 |
|----------|------|
| `src/clis/xiaohongshu/account-config.ts` | 账号配置核心模块 |
| `src/clis/xiaohongshu/accounts.ts` | 账号管理 CLI 命令 |
| `src/commanderAdapter.ts` | CLI 适配器 (注入 --account 参数) |
| `docs/design/multi-account-design.md` | 多账号设计文档 |

---

## 9. 未来扩展方向

1. **自动化 Chrome Profile 切换**: 不需要用户手动重启 Chrome
2. **账号状态监控**: 检测每个账号的登录状态
3. **批量操作**: 支持同时对多个账号执行相同操作
4. **跨平台账号迁移**: 支持导入/导出账号配置
