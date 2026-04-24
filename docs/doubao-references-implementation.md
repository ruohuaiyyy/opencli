# Doubao References 功能实现详情

> **文件路径**: `src/clis/doubao/references.ts` + `src/clis/doubao/extract-references.ts`
> **更新时间**: 2026-04-23

---

## 1. 功能概述

Doubao References 是一个独立的 CLI 命令，通过浏览器自动化方式向豆包 AI 提问，并获取 AI 回答及其参考来源（References）。

**使用方式**:
```bash
opencli doubao references "大同旅游景点推荐" -f json
opencli doubao references "问题" --reuse          # 复用上次会话
opencli doubao references "问题" --chat-id xxx   # 指定会话 ID
opencli doubao references "问题" --account work  # 多账号隔离
```

---

## 2. 核心文件

| 文件 | 职责 |
|------|------|
| `src/clis/doubao/references.ts` | 主命令入口，orchestrates 全流程：导航、输入注入、发送、响应轮询、参考来源展开与提取 |
| `src/clis/doubao/extract-references.ts` | DOM 提取逻辑：从页面中解析参考来源数据 |
| `src/clis/doubao/account-config.ts` | 账号管理：多账号隔离、lastChatId 持久化 |

---

## 3. 完整执行流程

### 3.1 页面导航 (ensureChatPage)

```
┌─────────────────────────────────────────────────┐
│  1. --chat-id 指定 → 直接导航到对应会话            │
│     settleMs: 2500ms + wait(5s)                 │
│  2. --reuse 参数  → 加载上次会话 ID              │
│     settleMs: 2500ms + wait(5s)                 │
│  3. 已在本页     → 保持当前                      │
│  4. 切换已有 tab → selectTab + wait(0.8s)        │
│                + wait(2s) CDP 稳定               │
│  5. Fallback   → 导航到 chat home               │
│     wait(5s) React SPA 水合                       │
└─────────────────────────────────────────────────┘
```

### 3.2 反降速处理

- **Visibility API 重写**: 注入脚本覆盖 `document.hidden` 和 `document.visibilityState`，防止 Chrome 后台标签页被降速
- **定期刷新**: 每 3 次轮询（约 6 秒）刷新一次标签页
- **safeEval**: CDP 断开时自动重试

### 3.3 输入与发送

| 步骤 | Sleep 时间 |
|------|-----------|
| 检查输入框就绪 | 最多轮询 15 秒（30 × 500ms） |
| 输入框就绪后缓冲 | `wait(0.5s)` |
| 注入问题后缓冲 | `wait(0.5s)` |
| 发送消息后 | `wait(10s)` 等待初始响应 |

### 3.4 响应轮询（核心）

```typescript
pollInterval = 2 秒
maxPolls = Math.max(1, Math.ceil(timeout / 2))   // timeout 默认 300 秒

首次轮询: wait(0s)   // i === 0 时不等
后续轮询: wait(2s)
```

**双稳定性检测**:
- 内容 Hash 稳定性 (simpleHash)
- DOM 节点数量稳定性
- 首次检测要求最少 **4 次稳定检查**（8 秒）
- 非流式检测要求 **3 次稳定检查**
- 最终确认等待: `wait(1.5s)`

### 3.5 参考来源展开与提取

| 步骤 | Sleep 时间 |
|------|-----------|
| 等待参考按钮出现 | `wait(2s)` + 最多 8 次轮询（每次 wait 1s） |
| 点击参考按钮 | "参考 N 篇资料" 按钮 |
| 点击后等待内容加载 | `wait(3s)` |
| 提取重试机制 | 最多 4 次重试，每次 `wait(2s)` |

### 3.6 结果保存

```
输出路径: ~/.opencli/doubao_output/doubao-TIMESTAMP.json
格式: [{ question, answer, references: [{ index, title, url, snippet, source }] }]
```

---

## 4. Sleep/Timeout 时间汇总表

| 位置 | Sleep 时间 | 说明 |
|------|-----------|------|
| `page.goto` settle | 2500ms | 页面加载稳定 |
| goto 后等待 | 5s | SPA 水合 + CDP 稳定 |
| 切换 tab 后 | 0.8s + 2s | 等待 CDP 稳定 |
| 输入框就绪检查 | 500ms × 最多 30 次 | 总计最多 15 秒 |
| 输入框就绪缓冲 | 500ms | React 组件挂载 |
| 注入问题后 | 500ms | 输入生效 |
| 发送消息后 | 10s | 等待初始响应 |
| 轮询前等待 | 0s (i=0) | 首个轮询 |
| 轮询间隔 | 2s | 每次轮询间隔 |
| CDP 重试等待 | 1.5s | CDP 断开重试 |
| 切换 tab 后 (anti-throttle) | 500ms | 等待稳定 |
| 参考按钮等待初始 | 2s | 等待按钮出现 |
| 参考按钮轮询 | 1s × 最多 8 次 | 等待按钮 |
| 点击参考按钮后 | 3s | 等待 API 内容加载 |
| 提取重试间隔 | 2s × 最多 4 次 | 确保提取成功 |
| hover 后等待 (清除聊天) | 500ms | 按钮出现 |
| 下拉菜单等待 | 1s | 菜单展开 |
| 选择模式等待 | 800ms | 转换模式 |
| 确认对话框等待 | 500ms | 对话框出现 |
| 删除完成等待 | 2s | 删除生效 |
| 超时默认 | 300s | 命令行 --timeout 默认值 |

---

## 5. 参考来源提取逻辑

### DOM 结构

```
聚合卡片 (.search-item-transition-FAa3Ce)
  └─ <a> 链接: 包含 title + summary + source + index

独立卡片 (.search-item-OXK_4I)
  ├─ .search-item-title-fLDLZw   → 标题
  └─ .search-item-summary-uNyUB_ → 摘要
```

### 提取策略

1. 从聚合卡片获取所有链接按顺序排列
2. 获取所有独立卡片按顺序排列
3. **按索引配对**: 聚合链接与独立卡片一一对应
4. 构建 `DoubaoReference` 对象: `{ index, title, url, snippet, source }`

### 接口定义

```typescript
interface DoubaoReference {
  index: number;    // 来源序号
  title: string;    // 文章标题
  url: string;      // 参考链接
  snippet: string;  // 内容摘要
  source: string;   // 来源网站
}
```

---

## 6. 聊天内容清除流程

当使用 `--clear` 参数时:

```
1. hover 最后一条 AI 消息 (显示操作按钮)
2. 点击三点 "更多" 按钮 (SVG path: M5 10.5)
3. 点击 "删除" 菜单项
4. 选择模式: 点击 "删除" → 确认对话框: 点击 "删除"
```

总耗时约 5 秒（含多次 wait）。

---

## 7. 特性对比

| 特性 | 说明 |
|------|------|
| 多账号支持 | `--account` 参数，数据存储在 `~/.opencli/accounts/doubao.json` |
| 会话复用 | `--reuse` 参数，持久化 lastChatId |
| 指定会话 | `--chat-id` 参数，直接进入指定会话 |
| 后台不降速 | 重写 Visibility API + 定期刷新标签页 |
| CDP 断开恢复 | safeEval 自动重试 |
| 流式检测 | 内容 Hash + DOM 节点双稳定性检测 |
