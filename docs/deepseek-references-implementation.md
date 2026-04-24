# DeepSeek References 功能实现详情

> **文件路径**: `src/clis/deepseek/references.ts` + `src/clis/deepseek/extract-references.ts` + `src/clis/deepseek/utils.ts`
> **更新时间**: 2026-04-23

---

## 1. 功能概述

DeepSeek References 是一个独立的 CLI 命令，通过浏览器自动化方式向 DeepSeek AI 提问，并获取 AI 回答及其参考来源（References）。

**使用方式**:
```bash
opencli deepseek references "大同旅游景点推荐" -f json
opencli deepseek references "问题" --reuse          # 复用上次会话
opencli deepseek references "问题" --chat-id xxx    # 指定会话 ID
opencli deepseek references "问题" --account work   # 多账号隔离
```

---

## 2. 核心文件

| 文件 | 职责 |
|------|------|
| `src/clis/deepseek/references.ts` | 主命令入口：导航、输入注入、智能搜索开关、发送、内容增长轮询、参考来源提取 |
| `src/clis/deepseek/extract-references.ts` | DOM 提取逻辑：从侧面板中解析参考来源数据（含去重机制） |
| `src/clis/deepseek/utils.ts` | 共享工具函数：页面导航、智能搜索开关 |
| `src/clis/deepseek/account-config.ts` | 账号管理：多账号隔离、lastChatId 持久化 |

---

## 3. 完整执行流程

### 3.1 页面导航

```
┌─────────────────────────────────────────────────┐
│  1. --chat-id 指定 → 直接导航 + settle(2500ms)   │
│     + wait(5s)                                   │
│  2. --reuse 参数  → 加载 lastChatId + 导航       │
│     + settle(2500ms) + wait(5s)                  │
│  3. ensureDeepseekChatPage:                      │
│     - 复用已有 tab 或导航到首页                   │
│  4. 额外等待: wait(1s)                             │
└─────────────────────────────────────────────────┘
```

### 3.2 输入与发送

| 步骤 | Sleep 时间 |
|------|-----------|
| 发送前等待 | `wait(1s)` |
| 注入问题后 | `wait(0.5s)` |
| 启用智能搜索后 | `wait(0.5s)` |
| 发送消息后 | `wait(1s)` |

**智能搜索开关** (`enableDeepseekInternetSearch`):
- 查找 `.css-wvkd9r` 容器中的开关按钮
- 检查 `aria-checked` 属性
- 如果为 `false` 则点击启用

### 3.3 响应轮询（内容增长检测）

DeepSeek 采用**页面内容长度增长**作为流式检测机制，与其他三家不同:

```typescript
pollInterval = 2 秒
maxPolls = Math.max(1, Math.ceil(timeout / 2))   // timeout 默认 300 秒

baselineLength = getPageContentLength()  // 发送后获取基线长度

首次轮询: wait(1.5s)   // i === 0
后续轮询: wait(2s)
```

**增长检测逻辑**:
1. 获取当前页面内容长度 (排除侧栏/脚本)
2. 如果 `currentLength > baselineLength + 100` → 内容开始增长
3. 如果 `currentLength > previousLength` → 仍在增长，`stableCount = 0`
4. 如果长度不变 → `stableCount += 1`
5. **需要连续 5 次稳定检查**（约 10 秒）才认为完成

### 3.4 参考来源提取

| 步骤 | Sleep 时间 |
|------|-----------|
| 提取前等待 | `wait(1s)` |
| 点击参考按钮 | "N 个网页" 或 "已阅读 N 个网页" |
| 点击后等待 | `wait(3s)` |
| 提取参考 | `extractNewDeepseekReferences(page, beforeRefUrls)` |

**注意**: DeepSeek 参考来源与 Doubao 类似，需要点击按钮展开侧面板。

### 3.5 结果保存

```
输出路径: ~/.opencli/deepseek_output/deepseek-TIMESTAMP.json
格式: [{ question, answer, references: [{ index, title, url, snippet, source }] }]
```

---

## 4. Sleep/Timeout 时间汇总表

| 位置 | Sleep 时间 | 说明 |
|------|-----------|------|
| `page.goto` settle | 2500ms | 页面加载稳定 |
| goto 后等待 (chatId/reuse) | 5s | SPA 水合 + CDP 稳定 |
| 页面就绪后 | 1s | 额外缓冲 |
| 注入问题后 | 500ms | 输入生效 |
| 启用智能搜索后 | 500ms | 等待状态切换 |
| 发送消息后 | 1s | 等待响应开始 |
| 响应轮询首次 | 1.5s | 初始等待 |
| 响应轮询间隔 | 2s | 每次轮询 |
| 稳定要求 | 5 次连续 | 约 10 秒 |
| 提取前等待 | 1s | 确保内容完成 |
| 点击参考按钮后 | 3s | 等待侧面板加载 |
| 超时默认 | 300s | 命令行 `--timeout` 默认值 |

---

## 5. 参考来源提取逻辑

### 触发按钮

参考按钮文本匹配正则:
- `^\d+\s*个网页$` - 如 "10个网页"
- `已阅读` - 如 "已阅读 10 个网页"

点击策略:
1. 查找所有匹配的元素（叶子或近叶子节点）
2. 取最后一个匹配（最新回答）
3. 向上最多 8 层查找可点击元素
4. Fallback: 直接 dispatch MouseEvent

### DOM 结构（侧面板）

```
搜索结果 (heading)
  └─ <a href="..."> 卡片                    ← 每条参考
      └─ outerGeneric
          ├─ metaContainer
          │   ├─ source (来源名称)
          │   ├─ date (YYYY/MM/DD)
          │   └─ index (序号)
          ├─ title (标题)
          └─ snippet (摘要)
```

### 提取策略

1. **发送前快照**: `snapshotExistingRefUrls(page)` - 收集所有现有 `<a[href]>` 的 URL
2. **点击参考按钮**: 查找并点击 "N 个网页" 按钮
3. **等待侧面板加载**: wait(3s)
4. **提取新增参考**: `extractNewDeepseekReferences(page, beforeUrls)`
5. **去重逻辑**: 通过 base URL (去除 query 参数) 判断重复
6. **排序**: 按 index 排序后重新编号

### 接口定义

```typescript
interface DeepseekReference {
  index: number;    // 来源序号 (排序后重新编号)
  title: string;    // 文章标题
  url: string;      // 参考链接
  snippet: string;  // 内容摘要 (最大 500 字符)
  source: string;   // 来源网站
}
```

---

## 6. 答案提取详解

DeepSeek 的答案提取逻辑比较特殊:

1. **查找参考按钮**: 定位 "N个网页" 或 "已阅读 N 个网页" 元素
2. **DOM 结构分析**:
   - `p1`: 参考按钮容器
   - `p2`: `p1.parentElement` - 回答区域（包含多个子元素）
3. **提取策略**: 遍历 `p2.children` 中除最后一个（参考容器）外的所有子元素
4. **过滤噪声**: 跳过"开启新对话"、"内容由 AI 生成"、"深度思考"、手机号等

### 降级处理

如果无法找到参考按钮，采用全页面提取：
- 克隆 `document.body`
- 移除侧栏、脚本元素
- 提取剩余文本内容

---

## 7. 内容增长检测详解

这是 DeepSeek 独有的完成检测机制:

```typescript
// 基线长度计算
const baselineLength = await page.evaluate(getPageContentLengthScript());

// 每次轮询检查
const currentLength = await page.evaluate(getPageContentLengthScript());

// 判断内容是否开始增长
if (currentLength > baselineLength + 100) {
  contentStartedGrowing = true;
}

// 长度不再增加
if (currentLength <= previousLength) {
  stableCount += 1;
  if (stableCount >= 5) {  // 连续 5 次不变
    answer = await page.evaluate(getAnswerScript());
    break;
  }
}
```

与其他三家的区别:
- **不检测流式指示器** (如 loading/typing 类名)
- **不检查 AI 回答内容本身** 是否变化
- **仅依赖总页面内容长度** 作为判断标准
- 需要更长的稳定时间 (5 次 vs 2-4 次)

---

## 8. 特性对比

| 特性 | 说明 |
|------|------|
| 多账号支持 | `--account` 参数 |
| 会话复用 | `--reuse` 参数，持久化 lastChatId |
| 指定会话 | `--chat-id` 参数 |
| 智能搜索 | 自动启用 CSS `.css-wvkd9r` 中的开关 |
| 参考面板 | 需要点击 "N 个网页" 按钮展开 |
| 去重机制 | 发送前快照 + base URL 去重 |
| 流式检测 | **页面内容长度增长**（独特机制） |
| 稳定要求 | **5 次连续**（最长，约 10 秒） |
