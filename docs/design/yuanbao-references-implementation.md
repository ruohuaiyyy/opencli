# Yuanbao References 功能实现详情

> **文件路径**: `src/clis/yuanbao/references.ts` + `src/clis/yuanbao/extract-references.ts`
> **更新时间**: 2026-04-23

---

## 1. 功能概述

Yuanbao References 是一个独立的 CLI 命令，通过浏览器自动化方式向腾讯元宝 AI 提问，并获取 AI 回答及其参考来源（References）。

**使用方式**:
```bash
opencli yuanbao references "大同旅游景点推荐" -f json
opencli yuanbao references "问题" --reuse          # 复用上次会话
opencli yuanbao references "问题" --chat-id "xxx"  # 指定会话 ID
opencli yuanbao references "问题" --account work   # 多账号隔离
```

---

## 2. 核心文件

| 文件 | 职责 |
|------|------|
| `src/clis/yuanbao/references.ts` | 主命令入口：导航、输入注入、联网搜索开关、发送、响应轮询、参考来源展开与提取 |
| `src/clis/yuanbao/extract-references.ts` | DOM 提取逻辑：从参考面板中解析参考来源数据 |
| `src/clis/yuanbao/account-config.ts` | 账号管理：多账号隔离、lastChatId 持久化 |

---

## 3. 完整执行流程

### 3.1 页面导航

```
┌─────────────────────────────────────────────────┐
│  1. --reuse 参数  → 加载 lastChatId + 导航       │
│     settleMs: 2500ms + wait(5s)                  │
│  2. --chat-id 指定 → 直接导航 + settle(2500ms)   │
│     + wait(5s)                                   │
│  3. 检查当前 URL:                                │
│     - 已在 yuanbao.tencent.com/chat → 保持       │
│     - 有 yuanbao tab → selectTab + wait(0.8s)     │
│     - Fallback → goto + settle(2500ms)           │
│  4.额外等待: wait(1s)                             │
└─────────────────────────────────────────────────┘
```

### 3.2 输入与发送

| 步骤 | Sleep 时间 |
|------|-----------|
| 发送前等待 | `wait(1s)` |
| 注入问题后 | `wait(0.5s)` |
| 启用联网搜索后 | `wait(0.5s)` |
| 发送消息后 | `wait(1s)` |

**联网搜索开关**:
- 查找 `.yb-internet-search-btn` 按钮
- 检查 `dt-internet-search` 属性
- 如果为 `closeInternetSearch` 则点击启用

### 3.3 响应轮询（核心）

```typescript
pollInterval = 2 秒
maxPolls = Math.max(1, Math.ceil(timeout / 2))   // timeout 默认 300 秒

首次轮询: wait(1.5s)   // i === 0
后续轮询: wait(2s)
```

**流式检测**:
- 检测 loading/typing/streaming/thinking/searching/cursor/blink/pulse 类名
- 检测文本包含"思考中"、"搜索中"、"正在生成"
- 检测到流式: 需要 **4 次稳定检查** 才认为完成
- 非流式: 需要 **2 次稳定检查**

### 3.4 参考来源展开与提取

| 步骤 | Sleep 时间 |
|------|-----------|
| 点击参考按钮前 | `wait(1.5s)` |
| 查找"源"按钮 | 遍历所有文本节点查找精确匹配 "源" 的元素 |
| 点击"源"按钮 | 向上最多 5 层查找可点击元素 |
| 点击后等待 | `wait(2s)` |
| 提取参考 | `extractYuanbaoReferences(page)` - 单次提取，无重试 |

### 3.5 结果保存

```
输出路径: ~/.opencli/yuanbao_output/yuanbao-TIMESTAMP.json
格式: [{ question, answer, references: [{ index, title, url, snippet, source }] }]
```

---

## 4. Sleep/Timeout 时间汇总表

| 位置 | Sleep 时间 | 说明 |
|------|-----------|------|
| `page.goto` settle | 2500ms | 页面加载稳定 |
| goto 后等待 (reuse/chatId) | 5s | SPA 水合 + CDP 稳定 |
| 切换 tab 后 | 0.8s | 等待页面加载 |
| URL 检查后等待 | 1s | 额外缓冲 |
| 发送前等待 | 1s | 确保页面就绪 |
| 注入问题后 | 500ms | 输入生效 |
| 联网搜索开关后 | 500ms | 等待状态切换 |
| 发送消息后 | 1s | 等待响应开始 |
| 响应轮询首次 | 1.5s | 初始等待 |
| 响应轮询间隔 | 2s | 每次轮询 |
| 流式稳定要求 | 4 次连续 | ~8 秒 |
| 非流式稳定要求 | 2 次连续 | ~4 秒 |
| 参考按钮等待 | 1.5s | 等待按钮可点击 |
| 参考按钮点击后 | 2s | 等待面板展开 |
| 超时默认 | 300s | 命令行 `--timeout` 默认值 |

---

## 5. 参考来源提取逻辑

### DOM 结构

```
.agent-dialogue-references                    ← 参考面板容器
  └─ ul.agent-dialogue-references__list        ← 列表容器
      └─ li.agent-dialogue-references__item    ← 每条参考
          └─ .hyc-common-markdown__ref_card [data-idx] [data-url]
              ├─ .hyc-common-markdown__ref_card-title → span → 标题
              ├─ .hyc-common-markdown__ref_card-desc → 摘要
              ├─ .hyc-common-markdown__ref_card-foot__source_txt → span → 来源
              └─ data-url → 链接
```

### 提取策略

1. 查找 `.agent-dialogue-references` 面板容器
2. 遍历 `.agent-dialogue-references__item` 列表项
3. 从 `.hyc-common-markdown__ref_card` 的 `data-url` 属性获取 URL
4. 从 DOM 元素提取 title、source、snippet
5. 构建 `YuanbaoReference` 对象: `{ index, title, url, snippet, source }`

**注意**: Yuanbao 需要在点击"源"按钮后展开参考面板，且提取为单次操作，无重试机制。

### 接口定义

```typescript
interface YuanbaoReference {
  index: number;    // 来源序号
  title: string;    // 文章标题
  url: string;      // 参考链接 (data-url 属性)
  snippet: string;  // 内容摘要
  source: string;   // 来源网站
}
```

---

## 6. "源"按钮查找逻辑

Yuanbao 的参考按钮查找采用文本匹配方式:

```javascript
// 1. 查找所有文本节点
const allTexts = Array.from(document.querySelectorAll('*'));

// 2. 过滤出叶子节点，文本精确等于 "源"
const yuanBtns = allTexts.filter(el => {
  if (el.children.length > 0) return false;
  const text = (el.textContent || '').trim();
  return text === '源' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE';
});

// 3. 取最后一个匹配的按钮
const btn = yuanBtns[yuanBtns.length - 1];

// 4. 向上最多 5 层查找可点击元素
//    检查: onclick, role="button", cursor, style.cursor
```

---

## 7. 答案提取逻辑

### 主要选择器

```css
/* Method A: 结构化提取 */
.agent-chat__list__deepseek .agent-chat__list__content-wrapper:last-child .agent-chat__list__content

/* Method B: Fallback 选择器 */
.agent-chat__list__content-wrapper:last-child .agent-chat__list__content
.agent-dialogue__content .agent-chat__list__content
[class*="chat__list__content"]:last-child

/* Method C: 全页提取 (移除侧栏/输入框) */
```

### 流式检测选择器

```css
[class*="loading"], [class*="typing"], [class*="streaming"],
[class*="thinking"], [class*="searching"], [class*="cursor"],
[class*="blink"], [class*="pulse"]
```

---

## 8. 特性对比

| 特性 | 说明 |
|------|------|
| 多账号支持 | `--account` 参数 |
| 会话复用 | `--reuse` 参数，持久化 lastChatId |
| 指定会话 | `--chat-id` 参数 |
| 联网搜索 | 自动启用 `.yb-internet-search-btn` |
| 参考面板 | 需要点击"源"按钮展开 |
| 去重机制 | 无（直接提取全部参考） |
| 提取重试 | 无（单次提取） |
