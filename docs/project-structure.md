# OpenCLI 项目结构分析

> 版本: 1.5.0 | 最后更新: 2026-04-13

---

## 1. 项目概述

**OpenCLI** 是一个 AI 驱动的通用 CLI 工具，能将**任意网站**、**Electron 桌面应用**或**本地 CLI 工具**转换为命令行接口。项目采用 TypeScript 开发，基于 Commander.js 构建命令行框架，通过浏览器桥接扩展（Chrome Extension + 轻量 Daemon）实现浏览器会话复用。

**核心特性：**
- 🔌 **50+ 网站适配器**（Bilibili、Zhihu、小红书、Twitter、Reddit 等）
- 🖥️ **Electron 桌面应用控制**（Cursor、Codex、Antigravity、ChatGPT 等）
- 🌐 **外部 CLI Hub**（gh、docker、obsidian 等透传执行）
- 🧩 **插件系统**（YAML/TS 适配器热加载）
- 🤖 **AI Agent 友好**（Explore → Synthesize → Generate 工作流）

---

## 2. 顶层目录结构

```
opencli/
├── src/                    # 核心源代码（TypeScript）
├── dist/                   # 编译产物
├── tests/                  # 测试代码
│   ├── e2e/               # 端到端测试
│   └── smoke/             # 冒烟测试
├── docs/                   # 项目文档（VitePress）
├── extension/              # Chrome 浏览器桥接扩展
├── scripts/               # 构建和辅助脚本
├── .opencli/              # 本地运行时配置
├── .agents/               # AI Agent 技能配置
├── .github/               # GitHub 工作流
├── logs/                  # 运行时日志
├── package.json           # 项目元数据与依赖
├── tsconfig.json          # TypeScript 编译配置
├── vitest.config.ts       # Vitest 测试配置
├── README.md              # 英文文档
├── README.zh-CN.md        # 中文文档
├── CHANGELOG.md           # 版本变更日志
├── TESTING.md             # 测试指南
├── CONTRIBUTING.md        # 贡献指南
├── PRIVACY.md             # 隐私说明
├── SKILL.md               # AI Agent 指令
├── CLI-EXPLORER.md        # CLI 探索器指南
└── CLI-ONESHOT.md         # 一键生成 CLI 指南
```

---

## 3. 核心源码结构（src/）

### 3.1 入口与 CLI 框架

| 文件 | 职责 |
|------|------|
| `main.ts` | **CLI 入口点**。初始化系统路径、发现内置 CLI 和插件、启动命令行解析 |
| `cli.ts` | **命令行定义**。使用 Commander.js 注册所有内置命令（list、validate、explore、plugin 等），调度动态适配器 |
| `constants.ts` | 全局常量定义 |
| `version.ts` | 版本信息 |

### 3.2 命令注册与执行

| 文件 | 职责 |
|------|------|
| `registry.ts` | **命令注册中心**。定义 `cli()` 函数、`CliCommand` 接口、策略枚举（PUBLIC/COOKIE/HEADER/INTERCEPT/UI）、全局注册表 |
| `commanderAdapter.ts` | 动态适配器桥接。将 YAML/TS 适配器转换为 Commander 子命令 |
| `discovery.ts` | **命令发现器**。扫描 `clis/` 目录和插件目录，自动注册命令 |
| `execution.ts` | 命令执行引擎。负责策略路由、浏览器会话管理、流水线执行 |
| `runtime.ts` | 运行时抽象。浏览器工厂、会话管理 |
| `external.ts` | 外部 CLI 管理（gh、docker 等透传执行与自动安装） |

### 3.3 浏览器引擎

| 文件 | 职责 |
|------|------|
| `browser/index.ts` | 浏览器模块入口 |
| `browser/cdp.ts` | Chrome DevTools Protocol 通信 |
| `browser/daemon-client.ts` | Daemon 客户端（与 Chrome 扩展通信） |
| `browser/page.ts` | 页面操作抽象（IPage 接口实现） |
| `browser/dom-snapshot.ts` | DOM 快照采集 |
| `browser/dom-helpers.ts` | DOM 辅助工具 |
| `browser/discover.ts` | 浏览器 API 发现 |
| `browser/stealth.ts` | 反检测策略 |
| `browser/tabs.ts` | 标签页管理 |
| `browser/mcp.ts` | MCP（Model Context Protocol）集成 |

### 3.4 适配器（src/clis/）

**72 个网站/应用的适配器目录**，每个子目录包含该平台的命令实现：

| 分类 | 示例 |
|------|------|
| **中文平台** | `bilibili/`、`zhihu/`、`xiaohongshu/`、`weibo/`、`douban/`、`v2ex/`、`xueqiu/`、`smzdm/` 等 |
| **国际社交** | `twitter/`、`reddit/`、`instagram/`、`tiktok/`、`facebook/`、`linkedin/` |
| **新闻/内容** | `hackernews/`、`medium/`、`substack/`、`bbc/`、`bloomberg/`、`reuters/` |
| **AI 工具** | `cursor/`、`chatgpt/`、`codex/`、`antigravity/`、`chatwise/`、`notion/` |
| **电商/搜索** | `jd/`、`coupang/`、`youtube/`、`google/`、`wikipedia/`、`arxiv/` |
| **其他** | `stackoverflow/`、`pixiv/`、`weread/`、`jike/` 等 |

**适配器实现方式：**
- **YAML 声明式**：配置化数据管道，如 `bilibili/hot.yaml`
- **TypeScript 编程式**：复杂逻辑的 TS 模块，如 `bilibili/me.ts`
- **混合模式**：两者共存

### 3.5 流水线引擎（Pipeline）

YAML 声明式适配器的执行引擎：

| 文件 | 职责 |
|------|------|
| `pipeline/index.ts` | 流水线模块入口 |
| `pipeline/registry.ts` | 流水线步骤注册 |
| `pipeline/executor.ts` | 流水线执行器 |
| `pipeline/template.ts` | 模板渲染 |
| `pipeline/transform.ts` | 数据转换 |
| `pipeline/steps/browser.ts` | 浏览器操作步 |
| `pipeline/steps/fetch.ts` | HTTP 请求步 |
| `pipeline/steps/download.ts` | 下载步 |
| `pipeline/steps/intercept.ts` | 网络拦截步 |
| `pipeline/steps/tap.ts` | 点击/交互步 |
| `pipeline/steps/transform.ts` | 数据变换步 |

### 3.6 核心功能模块

| 文件 | 职责 |
|------|------|
| `output.ts` | 多格式输出渲染（table/json/yaml/md/csv） |
| `errors.ts` | 错误定义与处理 |
| `logger.ts` | 日志模块 |
| `hooks.ts` | 生命周期钩子（onStartup 等） |
| `validation.ts` | 命令定义校验 |
| `verify.ts` | 验证 + 冒烟测试 |
| `explore.ts` | 网站探索（发现 API、推理能力） |
| `synthesize.ts` | 从探索产物合成适配器 |
| `generate.ts` | 一键生成（explore → synthesize → register） |
| `cascade.ts` | 策略级联（自动探测最短路径可用策略） |
| `record.ts` | 录制浏览器 API 调用并生成 YAML 候选 |
| `completion.ts` | Shell 自动补全（bash/zsh/fish） |
| `doctor.ts` | 浏览器桥接连接诊断 |
| `plugin.ts` | 插件管理（install/uninstall/update/list） |
| `plugin-manifest.ts` | 插件清单解析 |
| `plugin-scaffold.ts` | 插件脚手架生成 |
| `update-check.ts` | 版本更新检查 |
| `daemon.ts` | 守护进程管理 |
| `runtime-detect.ts` | 运行时检测（Node.js / Bun） |
| `serialization.ts` | 命令序列化 |
| `yaml-schema.ts` | YAML 适配器 schema 定义 |
| `utils.ts` | 通用工具函数 |
| `analysis.ts` | 数据分析 |

### 3.7 下载模块

| 文件 | 职责 |
|------|------|
| `download/index.ts` | 下载模块入口 |
| `download/media-download.ts` | 媒体下载（图片、视频） |
| `download/article-download.ts` | 文章下载（Markdown 导出） |
| `download/progress.ts` | 下载进度追踪 |

---

## 4. 浏览器桥接扩展（extension/）

独立的 Chrome 扩展项目，负责：

| 文件/目录 | 职责 |
|-----------|------|
| `src/` | 扩展源代码 |
| `dist/` | 编译产物 |
| `manifest.json` | 扩展清单 |
| `popup.html/js` | 扩展弹窗 UI |
| `icons/` | 扩展图标 |
| `store-assets/` | Chrome Web Store 素材 |
| `scripts/` | 构建脚本 |
| `vite.config.ts` | Vite 构建配置 |

**通信架构：**
```
CLI (Node.js) ←→ Daemon ←→ WebSocket ←→ Chrome Extension ←→ 网页
```

---

## 5. 文档系统（docs/）

项目使用 **VitePress** 构建文档站点：

| 目录/文件 | 内容 |
|-----------|------|
| `index.md` | 文档首页 |
| `.vitepress/` | VitePress 配置 |
| `guide/` | 用户指南（安装、入门、插件、故障排除） |
| `adapters/` | 适配器文档（浏览器/桌面应用适配器） |
| `advanced/` | 高级主题（Electron 集成等） |
| `design/` | 设计文档 |
| `developer/` | 开发者指南 |
| `zh/` | 中文翻译文档 |
| `comparison.md` | 与同类工具对比（Browser-Use、Crawl4AI 等） |

---

## 6. 测试结构（tests/）

| 目录 | 类型 | 说明 |
|------|------|------|
| `e2e/` | 端到端测试 | 真实浏览器环境下的集成测试 |
| `smoke/` | 冒烟测试 | 命令可用性快速验证 |

**测试脚本：**
```bash
npm run test          # 单元测试（Vitest）
npm run test:all      # 全部测试
npm run test:e2e      # E2E 测试
npm run test:adapter  # 适配器测试
```

**内联测试：** 核心模块旁附带同名 `.test.ts` 文件，如 `browser.test.ts`、`registry.test.ts`。

---

## 7. 构建与工程化

### 7.1 构建流程

```bash
npm run build
  → clean-dist       # 清理 dist/
  → tsc              # TypeScript 编译
  → clean-yaml       # 清理编译产物中的 YAML
  → copy-yaml        # 将 YAML 适配器复制到 dist/
  → build-manifest   # 生成命令清单
```

### 7.2 技术栈

| 类别 | 技术 |
|------|------|
| **语言** | TypeScript 5+ |
| **运行时** | Node.js ≥ 20.0 / Bun ≥ 1.0 |
| **CLI 框架** | Commander.js 14 |
| **测试** | Vitest 4 |
| **文档** | VitePress |
| **浏览器通信** | WebSocket (ws) |
| **构建** | TypeScript Compiler (tsc) |
| **开发时** | tsx（TS 直接运行） |
| **输出渲染** | cli-table3（表格）、chalk（着色） |
| **数据处理** | js-yaml、turndown（HTML → Markdown） |

### 7.3 npm 脚本速查

```bash
npm run dev          # 开发模式（tsx 热加载）
npm run dev:bun      # 开发模式（Bun）
npm run start        # 生产模式（dist/main.js）
npm run typecheck    # 类型检查
npm run lint         # 代码检查
npm run docs:dev     # 文档开发服务器
```

---

## 8. 架构总览

```
                    ┌─────────────────────────┐
                    │    User / AI Agent      │
                    │     CLI 命令行          │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │        main.ts          │
                    │   - discoverClis()      │
                    │   - discoverPlugins()   │
                    │   - runCli()            │
                    └──────────┬──────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
 ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
 │  内置适配器      │  │  插件适配器      │  │  外部 CLI       │
 │  src/clis/      │  │  ~/.opencli/    │  │  gh, docker,    │
 │  72 个站点       │  │  plugins/       │  │  obsidian, ...  │
 └────────┬────────┘  └────────┬────────┘  └────────┬────────┘
          │                    │                    │
          └────────────────────┼────────────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │    Execution Engine     │
                    │  - Strategy Routing     │
                    │  - Pipeline Executor    │
                    │  - Browser Session Mgmt │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │    Browser Bridge       │
                    │  Daemon ↔ Chrome Ext    │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │     Target Website /    │
                    │     Electron App        │
                    └─────────────────────────┘
```

---

## 9. 命令发现与注册机制

1. **启动时**：`main.ts` 调用 `discoverClis()` 扫描 `src/clis/` 目录
2. **YAML 适配器**：通过 `pipeline/` 引擎解析执行
3. **TS 适配器**：通过 `commanderAdapter.ts` 动态注册
4. **插件**：`discoverPlugins()` 扫描 `~/.opencli/plugins/` 目录
5. **外部 CLI**：从 `external-clis.yaml` 加载并透传执行
6. **用户自定义**：`~/.opencli/clis/` 目录下的 `.ts`/`.yaml` 文件自动注册

---

## 10. 策略体系（Strategy）

命令执行的认证策略，按复杂度从低到高：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **PUBLIC** | 无需认证，直接请求 | 公开 API |
| **COOKIE** | 复用 Chrome Cookie | 已登录的网站 |
| **HEADER** | 注入自定义 Header | 需要 Token 的 API |
| **INTERCEPT** | 拦截网络请求 | 动态加载内容 |
| **UI** | 模拟用户界面操作 | 无 API 的复杂页面 |

---

## 11. 关键路径

- **入口**：`src/main.ts` → `src/cli.ts`
- **注册表**：`src/registry.ts`（全局单例 `globalThis.__opencli_registry__`）
- **命令发现**：`src/discovery.ts`
- **执行引擎**：`src/execution.ts`
- **浏览器操作**：`src/browser/` → `src/runtime.ts`
- **流水线**：`src/pipeline/executor.ts`
- **输出格式化**：`src/output.ts`

---

*本文档由项目结构分析自动生成，可作为后续开发参考。*
