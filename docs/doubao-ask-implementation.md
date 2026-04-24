# 豆包 (Doubao) Ask 功能实现详解

> 本文档详细说明项目中 doubao 相关的 ask 功能实现，包括 web 版和 desktop (CDP) 版

---

## 1. 功能概述与组件

项目中有多个与豆包 AI 相关的 ask 功能实现：

| 组件 | 路径 | 说明 |
|------|------|------|
| `doubao` (Web) | `src/clis/doubao/` | 豆包网页版 AI 聊天适配器 |
| `doubao-app` (Desktop) | `src/clis/doubao-app/` | 豆包桌面版 ( Electron ) 通过 CDP 控制 |

### 可用命令

```bash
# Web 版 - 豆包
opencli doubao ask "问题"              # 发送问题并等待回答
opencli doubao new                 # 新建对话
opencli doubao read                # 读取对话历史
opencli doubao send "消息"          # 仅发送消息 (不等回复)
opencli doubao status              # 检查登录状态

# Desktop 版 - 豆包桌面应用
opencli doubao-app ask "问题"        # 通过 CDP 控制桌面版
opencli doubao-app new
opencli doubao-app send "消息"
opencli doubao-app read
opencli doubao-app status
opencli doubao-app screenshot
opencli doubao-app dump
```

---

## 2. 文件结构

```
src/clis/doubao/
├── ask.ts                 # 基础问答命令 (使用 utils.ts)
├── extract-references.ts # 引用来源 DOM 提取
├── utils.ts              # 共享工具函数
├── send.ts              # 仅发送消息
├── read.ts              # 读取对话历史
├── new.ts              # 新建对话
└── status.ts           # 登录状态检查

src/clis/doubao-app/
├── ask.ts              # 桌面版 CDP 问答
├── utils.ts           # CDP 工具脚本
├── send.ts
├── read.ts
├── new.ts
├── status.ts
├── screenshot.ts
└── dump.ts
```

---

## 3. Ask 命令实现

### 3.1 Web 版 - 基础 Ask (`doubao/ask.ts`)

**文件**: `src/clis/doubao/ask.ts` (40 行)

核心逻辑：

```typescript
// 1. 获取发送前的对话状态 (用于差分检测)
const beforeTurns = await getDoubaoVisibleTurns(page);
const beforeLines = await getDoubaoTranscriptLines(page);

// 2. 发送消息
await sendDoubaoMessage(page, text);

// 3. 等待响应 (轮询检测)
const response = await waitForDoubaoResponse(page, beforeLines, beforeTurns, text, timeout);
```

**特点**：
- 使用 `utils.ts` 共享工具
- 支持自定义超时 (默认 60 秒)
- 返回角色分发的对话列表

### 3.2 Web 版 - 带参考来源 (`doubao/references.ts`)

**文件**: `src/clis/doubao/references.ts` (591 行)

独立实现，不依赖 `utils.ts`：

- 输入注入 (React 原型链 setter)
- 发送按钮定位 (4 级兜底)
- 流式响应检测 (多维度)
- 参考资料提取 (混合 DOM 策略)
- 结果保存 JSON 文件

**输出示例**：

```json
[
  {
    "question": "大同旅游景点推荐",
    "answer": "1. 云冈石窟...\n2. 悬空寺...",
    "references": [
      {
        "index": 1,
        "title": "大同旅游必去景点TOP10",
        "url": "https://...",
        "snippet": "云冈石窟是世界文化遗产...",
        "source": "马蜂窝"
      }
    ]
  }
]
```

### 3.3 Desktop 版 - CDP Ask (`doubao-app/ask.ts`)

**文件**: `src/clis/doubao-app/ask.ts` (60 行)

通过 Chrome DevTools Protocol (CDP) 控制 Electron 桌面应用：

```typescript
const beforeCount = await page.evaluate(
  `document.querySelectorAll('${SEL.MESSAGE}').length`
);

// 注入文本 + 发送
const injected = await page.evaluate(injectTextScript(text));
await page.wait(0.5);
const clicked = await page.evaluate(clickSendScript());

// 轮询响应
for (let i = 0; i < maxPolls; i++) {
  await page.wait(pollInterval);
  const result = await page.evaluate(pollResponseScript(beforeCount));
  if (result?.phase === 'done' && result.text) {
    response = result.text;
    break;
  }
}
```

---

## 4. 核心工具实现

### 4.1 Utils (`doubao/utils.ts` - 619 行)

**导出函数**：

| 函数 | 用途 |
|------|------|
| `ensureDoubaoChatPage()` | 导航到聊天页 (标签页复用) |
| `getDoubaoPageState()` | 获取页面状态 (URL, 登录, placeholder) |
| `getDoubaoTurns()` | 获取对话轮次 (结构化) |
| `getDoubaoVisibleTurns()` | 获取可见对话 |
| `getDoubaoTranscriptLines()` | 获取对话文本行 |
| `sendDoubaoMessage()` | 发送消息 |
| `waitForDoubaoResponse()` | 等待响应 (轮询) |
| `startNewDoubaoChat()` | 新建对话 |

**关键技术**：

1. **React 输入注入** - 原型链 setter：
```typescript
const proto = composer instanceof HTMLTextAreaElement
  ? window.HTMLTextAreaElement.prototype
  : window.HTMLInputElement.prototype;
const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
setter?.call(composer, inputText);
composer.dispatchEvent(new Event('input', { bubbles: true }));
composer.dispatchEvent(new Event('change', { bubbles: true }));
```

2. **发送按钮定位** - 4 级兜底：
   - 文本匹配 ("发送", "Send")
   - ARIA 标签匹配
   - CSS class 样式匹配
   - 降级为 Enter 键

3. **响应等待** - 轮询检测：
```typescript
for (let index = 0; index < maxPolls; index += 1) {
  await page.wait(index === 0 ? 1.5 : pollIntervalSeconds);
  const candidate = await getCandidate();

  if (candidate === lastCandidate) {
    stableCount += 1;  // 内容稳定后退出
  } else {
    lastCandidate = candidate;
    stableCount = 1;
  }

  if (stableCount >= 2 || index === maxPolls - 1) {
    return candidate;
  }
}
```

4. **页面复用** - 标签页优先级：
```typescript
if (/https:\/\/www\.doubao\.com\/chat\/[A-Za-z0-9_-]+/.test(tab.url))
  value += 1000;  // 具体对话页
else if (tab.url.startsWith(DOUBAO_CHAT_URL))
  value += 100;   // 聊天首页
if (tab.active) value += 25;  // 当前激活标签
```

### 4.2 引用提取 (`doubao/extract-references.ts`)

提取展开"参考 N 篇资料"后的网页链接：

- **聚合卡片** (`.search-item-transition-*`): 包含全部 `<a>` 链接
- **独立卡片** (`.search-item-*`): 包含标题 + 摘要
- **按索引配对**: 合并链接、标题、摘要

```typescript
// 步骤 1: 提取所有链接
const aggregateLinks = Array.from(
  document.querySelectorAll('.search-item-transition-FAa3Ce a.search-lIUYwC')
);

// 步骤 2: 提取独立卡片标题/摘要
const individualCards = Array.from(
  document.querySelectorAll('.search-item-OXK_4I')
);

// 步骤 3: 按索引配对
individualCards.forEach((card, index) => {
  const title = card.querySelector('.search-item-title-*')?.innerText;
  const url = aggregateLinks[index]?.href;
  refs.push({ index: index + 1, title, url, ... });
});
```

---

## 5. CDP 桌面版工具脚本

### 5.1 工具脚本 (`doubao-app/utils.ts`)

**常量**：
```typescript
export const SEL = {
  MESSAGE: '[data-message-id], [class*="message"]',
  INPUT: 'textarea[data-testid="chat_input_input"], textarea',
  SEND_BUTTON: 'button:has-text("发送"), [class*="send"]',
};
```

**脚本函数**：

| 函数 | 用途 |
|------|------|
| `injectTextScript(text)` | 注入输入文本 |
| `clickSendScript()` | 点击发送按钮 |
| `pollResponseScript(beforeCount)` | 轮询响应 |

### 5.2 轮询脚本实现

```typescript
function pollResponseScript(beforeCount: number): string {
  return `
    (() => {
      const messages = document.querySelectorAll('${SEL.MESSAGE}');
      if (messages.length <= ${beforeCount}) return null;

      const latest = messages[messages.length - 1];
      const markdown = latest.querySelector('.flow-markdown-body');
      if (!markdown) return null;

      const text = markdown.innerText?.trim();
      // 检测是否还在生成 (streaming)
      const loading = latest.querySelector('[class*="loading"], [class*="streaming"]');

      return {
        phase: loading ? 'streaming' : 'done',
        text: text || null
      };
    })()
  `;
}
```

---

## 6. 流式响应检测 (References 版本)

References 命令的流式检测更加复杂 (`doubao/references.ts`)：

### 6.1 多维度检测

- **内容增长检测**: 长度变化 > 2 字符
- **流式指示器**: `loading`, `typing`, `streaming` class
- **关键词匹配**: "深度思考中", "搜索中", "正在搜索"
- **占位符检测**: "找到 N 篇资料"

### 6.2 自适应稳定阈值

| 场景 | 稳定次数 | 等待时间 |
|------|---------|---------|
| 普通回答 | 3 次 | ~6 秒 |
| 检测到流式 | 4 次 | ~8 秒 |
| 搜索占位符 | 6 次 | ~12 秒 |

### 6.3 防节流机制

```typescript
// 每 3 次轮询切换标签页 (防止 Chrome 暂停后台 tab 的 JS)
if (i > 0 && i % 3 === 0 && currentTabIndex !== null) {
  await page.selectTab(currentTabIndex);
  // 重新注入 visibility override
  await page.evaluate(injectVisibilityOverride());
}

// Override Chrome 背景标签节流
Object.defineProperty(document, 'hidden', {
  get: function() { return false; },
  configurable: true
});
```

---

## 7. 输出格式

### 7.1 Ask 命令

```bash
$ opencli doubao ask "什么是TypeScript"

 Role     | Text
---------|---------------------------------
 User    | 什么是TypeScript
 Assistant| TypeScript 是微软开发的...
```

### 7.2 References 命令

```bash
$ opencli doubao references "大同旅游" -f json

[
  {
    "question": "大同旅游",
    "answer": "大同市的主要景点包括：\n1. 云冈石窟...\n2. 悬空寺...",
    "references": [
      {
        "index": 1,
        "title": "大同旅游必去景点TOP10",
        "url": "https://...",
        "snippet": "云冈石窟是世界文化遗产...",
        "source": "马蜂窝"
      }
    ]
  }
]

# 保存到文件
$ opencli doubao references "大同旅游" --output my-trip.json
💾 Saved to C:\Users\xxx\.opencli\doubao_output\my-trip.json
```

---

## 8. 关键技术点总结

| 技术点 | 实现方案 | 适用场景 |
|--------|---------|----------|
| React 输入注入 | 原型链 setter + event dispatch | React/Vue 聊天应用 |
| 按钮定位 | 文本 → ARIA → 样式 → Enter 降级 | 动态渲染 SPA |
| 流式检测 | 内容增长 + 指示器 + 关键词 | AI 流式输出 |
| DOM 噪声过滤 | 克隆 + 选择器移除 + 正则 | 富文本页面 |
| 懒加载处理 | 轮询 + re-click + 滚动 | 延迟渲染内容 |
| 页面复用 | URL 检测 → 标签页切换 → 导航 | 多 tab 场景 |
| CDP 控制 | Puppeteer 脚本注入 | Electron 桌面应用 |
| 防节流 | visibilityOverride + 标签页切换 | 后台运行 |

---

## 9. 参考文档

- [豆包 References 实现参考](./doubao-references-implementation.md) - 详细的技术实现文档
- [桌面应用适配器指南](./guide/electron-app-cli.md)
- [CDP 协议文档](https://chromedevtools.github.io/devtools-protocol/)