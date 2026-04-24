# Qwen References 功能实现详情

> **文件路径**: `src/clis/qwen/references.ts` + `src/clis/qwen/extract-references.ts` + `src/clis/qwen/utils.ts`
> **更新时间**: 2026-04-23

---

## 1. 功能概述

Qwen References 是一个独立的 CLI 命令，通过浏览器自动化方式向通义千问 AI 提问，并获取 AI 回答及其参考来源（References）。

**使用方式**:
```bash
opencli qwen references "大同旅游景点推荐" -f json
opencli qwen references "问题" --reuse          # 复用上次会话
opencli qwen references "问题" --chat-id xxx    # 指定会话 ID
opencli qwen references "问题" --account work   # 多账号隔离
```

---

## 2. 核心文件

| 文件 | 职责 |
|------|------|
| `src/clis/qwen/references.ts` | 主命令入口：导航、发送、等待回答、展开参考面板、提取参考来源 |
| `src/clis/qwen/extract-references.ts` | DOM 提取逻辑：从侧面板中解析参考来源数据（含去重机制） |
| `src/clis/qwen/utils.ts` | 共享工具函数：页面导航、消息发送（Slate 编辑器）、响应轮询 |
| `src/clis/qwen/account-config.ts` | 账号管理：多账号隔离、lastChatId 持久化 |

---

## 3. 完整执行流程

### 3.1 页面导航

```
┌─────────────────────────────────────────────────┐
│  1. --chat-id 指定 → 直接导航 + settle(2500ms)   │
│     + wait(5s)                                   │
│  2. --reuse 参数  → 加载 lastChatId + 导航       │
│     + settle(2500ms) + wait(5s)                  │
│  3. ensureQwenChatPage:                          │
│     - 已在聊天页 → wait(1s)                      │
│     - 复用已有 tab → selectTab + wait(0.8s)       │
│       + 再次确认 + wait(1s)                      │
│     - Fallback → goto + wait(1.5s)               │
└─────────────────────────────────────────────────┘
```

### 3.2 发送消息 (Slate 编辑器特殊处理)

Qwen 使用 **Slate.js** 富文本编辑器，需要特殊处理:

1. 通过 React fiber tree 查找 Slate 编辑器实例
2. 调用 `editor.insertText()` 直接更新 Slate 内部模型
3. 触发 `onChange` → React 重新渲染 → 发送按钮启用

```typescript
// waitForQwenResponse 中的轮询参数
pollInterval = 2 秒
maxPolls = Math.max(1, Math.ceil(timeoutSeconds / pollInterval))

首次轮询: wait(1.5s)   // i === 0
后续轮询: wait(2s)
```

**流式检测**:
- 检测 `.qk-markdown` 元素的 streaming 状态
- `isStreamingScript()`: 查找 loading/typing/streaming/thinking/generating 类名
- 检测到流式: 需要 **4 次稳定检查** 才认为完成
- 非流式: 需要 **2 次稳定检查**

### 3.3 参考来源展开与提取

| 步骤 | Sleep 时间 |
|------|-----------|
| 发送后缓冲 | `wait(2s)` |
| 点击参考面板切换 | 尝试 `:last-of-type .link-title-igf0OC` → fallback `.link-title-igf0OC` |
| 点击后等待 | `wait(1s)` |
| 提取轮询 | `wait(2s)` × 最多 10 次 |
| 第 4 次重试时 | 再次点击切换按钮 |

**去重机制**:
1. 发送前调用 `snapshotExistingRefUrls(page)` 记录已有 URL
2. 提取时仅返回新增的参考来源
3. 通过 `data-click-extra` / `data-exposure-extra` 中的 `ref_url` 判断重复

### 3.4 结果保存

```
输出路径: ~/.opencli/qwen_output/qwen-TIMESTAMP.json
格式: [{ question, answer, references: [{ index, title, url, snippet, source }] }]
```

---

## 4. Sleep/Timeout 时间汇总表

| 位置 | Sleep 时间 | 说明 |
|------|-----------|------|
| `page.goto` settle | 2500ms | 页面加载稳定 |
| goto 后等待 (chatId/reuse) | 5s | SPA 水合 + CDP 稳定 |
| 确保在聊天页 (已在) | 1s | 页面稳定 |
| 切换 tab 后 | 0.8s | 等待页面加载 |
| 切换 tab 确认后 | 1s | 再次确认 |
| Fallback goto 后 | 1.5s | 等待页面加载 |
| 发送消息前 | 1s | 确保编辑器就绪 |
| Slate 插入后 | 1s | React 协调 |
| 点击发送按钮后 | 1s | 等待响应开始 |
| Enter fallback 后 | 1s | 等待响应开始 |
| 响应轮询首次 | 1.5s | 初始等待 |
| 响应轮询间隔 | 2s | 每次轮询 |
| 响应稳定要求 (流式) | 4 次连续 | ~8 秒 |
| 响应稳定要求 (非流式) | 2 次连续 | ~4 秒 |
| 发送后参考面板前 | 2s | 等待回答完成 |
| 展开参考面板后 | 1s | 等待面板渲染 |
| 参考提取轮询 | 2s × 最多 10 次 | 确保参考加载 |
| 新对话等待 | 1.5s | 导航后 |
| 超时默认 | 300s | 命令行 `--timeout` 默认值 |
| 超时解析默认 | 60s | 代码中 `parseInt(kwargs.timeout)` fallback |

---

## 5. 参考来源提取逻辑

### DOM 结构

```
.side-panel (独立侧面板，非 .reference-wrap-iEjeb3 内)
  └─ .deep-think-source-tyxrXL
      └─ .list-XPxyL2
          └─ .source-item-mqZd08           ← 每条参考
              ├─ data-click-extra          → JSON {"ref_url": "..."}
              ├─ data-exposure-extra       → JSON {"ref_url": "..."}
              ├─ .header-uMVjR7
              │   ├─ .index-Wqr8au         → 序号
              │   └─ .title-TP9iyp         → 标题
              └─ .source-kRyJmz
                  └─ .name-o0jtvK          → 来源名称
```

### 提取策略

1. **发送前快照**: `snapshotExistingRefUrls()` - 收集所有现有 `.source-item-mqZd08` 中的 URL
2. **回答完成后提取**: `extractNewQwenReferences(page, beforeUrls)` - 仅返回新增参考
3. **去重逻辑**: 比较 URL 是否在 beforeUrls 集合中
4. **字段解析**: 从 `data-click-extra` JSON 中获取 `ref_url`，从 DOM 中提取 title/source/snippet

### 接口定义

```typescript
interface QwenReference {
  index: number;    // 来源序号
  title: string;    // 文章标题 (最大 300 字符)
  url: string;      // 参考链接
  snippet: string;  // 内容摘要 (最大 500 字符)
  source: string;   // 来源网站 (最大 100 字符)
}
```

---

## 6. 消息发送详解 (Slate 编辑器)

这是 Qwen 特有的复杂部分:

```
1. 找到 [data-slate-editor="true"] 编辑器元素
2. 通过 Object.keys 查找 __reactFiber 属性
3. 沿 React fiber tree 向上最多 20 层查找 memoizedProps.editor
4. 调用 editor.insertText(text) 更新 Slate 内部模型
5. 等待 1 秒让 React 协调 (按钮从 disabled→enabled)
6. 尝试点击 .operateBtn-ehxNOr 发送按钮
7. Fallback: 使用 Enter 键
```

---

## 7. 响应轮询详解

`waitForQwenResponse` 函数:

1. **排除旧内容**: 跳过与 `beforeAnswer` 相同的内容
2. **优先取最后一条**: `querySelectorAll('.qk-markdown')` 取最后一个元素（避免获取历史对话）
3. **流式检测**: 调用 `isStreamingScript()` 检查加载/打字指示器
4. **稳定性判断**:
   - 流式: `stableCount >= 4` 才退出
   - 非流式: `stableCount >= 2` 即退出
5. **内容清洗**: 移除 promptText 和 "内容由AI生成" 字样

---

## 8. 特性对比

| 特性 | 说明 |
|------|------|
| 多账号支持 | `--account` 参数 |
| 会话复用 | `--reuse` 参数，持久化 lastChatId |
| 指定会话 | `--chat-id` 参数 |
| 去重机制 | 发送前快照 + 仅返回新增参考 |
| Slate 编辑器 | 通过 React fiber tree 操作 |
| 流式检测 | CSS 类名 + 文本内容检测 |
| 参考面板位置 | 独立侧面板 (非嵌入内容区) |
