# 小红书 Publish 功能实现参考

> 可作为实现类似内容平台发布功能的参考文档

---

## 1. 功能概述

`opencli xiaohongshu publish` 命令通过小红书创作者中心的 UI 自动化，完成图文笔记的发布流程。支持设置标题、正文、话题标签、草稿保存。

**适用场景：** 内容创作者批量发布、自媒体自动化运营。

## 2. 文件结构

```
src/clis/xiaohongshu/
├── publish.ts             # 主命令：图文笔记发布流程
├── publish.test.ts        # 发布功能测试
├── download.ts            # 下载笔记媒体
├── search.ts              # 搜索笔记
├── feed.yaml              # 首页推荐（YAML）
├── notifications.yaml     # 通知列表（YAML）
├── user.ts                # 查看用户信息
├── creator-*.ts           # 创作者相关命令
├── comments.ts            # 评论管理
└── account-*.ts           # 多账号管理
```

## 3. 核心实现流程

```
验证输入参数 → 读取本地图片 → 导航到创作中心
    → 选择"图文"笔记类型 → 上传图片（DataTransfer 注入）
    → 等待上传完成 → 等待编辑表单渲染
    → 填充标题 → 填充正文 → 添加话题标签
    → 点击发布/草稿 → 验证发布结果 → 可选关闭标签页
```

## 4. 详细步骤解析

### 4.1 输入验证

```typescript
// 标题限制
if (title.length > 20) throw new Error('标题最多 20 字');

// 图片限制
if (imagePaths.length > 9) throw new Error('最多 9 张图片');

// 必须有图片（创作者中心现在要求先上传图片才能显示编辑器）
if (imagePaths.length === 0) throw new Error('必须提供图片');
```

### 4.2 图片预处理

在导航之前读取所有本地图片，提前发现文件不存在的错误：

```typescript
function readImageFile(filePath: string): ImagePayload {
  const ext = path.extname(absPath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'
  };
  const base64 = fs.readFileSync(absPath).toString('base64');
  return { name: path.basename(absPath), mimeType, base64 };
}
```

### 4.3 图文/视频 Tab 选择

小红书创作中心默认可能打开视频发布页，需要切换到图文页：

```javascript
// 优先级排序的文本匹配
const targets = ['上传图文', '图文', '图片'];

// 遍历所有可见元素查找匹配文本
for (const target of targets) {
  for (const node of nodes) {
    if (!isVisible(node)) continue;
    const text = normalize(node.innerText);
    if (text.includes(target) && !text.includes('视频')) {
      const clickable = node.closest('button, [role="tab"]') || node;
      clickable.click();
      return { ok: true };
    }
  }
}
```

**页面状态检测器（PublishSurfaceInspection）：**
```typescript
type PublishSurfaceState = 'video_surface' | 'image_surface' | 'editor_ready';

interface PublishSurfaceInspection {
  state: PublishSurfaceState;
  hasTitleInput: boolean;    // 是否存在标题输入框
  hasImageInput: boolean;    // 是否存在图片文件输入
  hasVideoSurface: boolean;  // 是否显示视频上传区域
}
```

采用轮询等待机制（最多 5 秒），确认已切换到图文页面后再进行上传。

### 4.4 图片上传——DataTransfer 注入（核心技术）

**为什么不用 `send_file` 协议？** 小红书上传使用 XHR/Fetch 方式，非标准表单提交。直接注入文件到 `<input type="file">` 的 `files` 属性是最可靠的方法。

```javascript
// 1. 找到图片专用的 file input（避免误用视频上传）
const inputs = document.querySelectorAll('input[type="file"]');
const input = inputs.find(el => {
  const accept = el.getAttribute('accept') || '';
  return accept.includes('image') || accept.includes('.jpg') ...;
});

// 2. 创建 DataTransfer 实例
const dt = new DataTransfer();
for (const img of images) {
  const binary = atob(img.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: img.mimeType });
  dt.items.add(new File([blob], img.name, { type: img.mimeType }));
}

// 3. 替换 input.files 属性（默认是只读的）
Object.defineProperty(input, 'files', { value: dt.files, writable: false });

// 4. 触发 change 和 input 事件，通知框架
input.dispatchEvent(new Event('change', { bubbles: true }));
input.dispatchEvent(new Event('input', { bubbles: true }));
```

**base64 → Blob → File 转换：**  
由于 `evaluate()` 在浏览器上下文中执行，无法直接访问 Node.js 文件。因此先在 Node.js 侧读取图片为 base64，注入页面后通过 `atob()` 还原为二进制数据。

### 4.5 上传完成等待

**轮询等待上传进度消失：**
```javascript
// 检测上传进度指示器
const uploading = document.querySelector(
  '[class*="upload"][class*="progress"], [class*="uploading"], [class*="loading"][class*="image"]'
);
// 每 2 秒轮询一次，最多 30 秒
```

**等待编辑表单渲染：**
小红书创作者中心在图片上传完成后才会渲染标题/正文编辑区域。等待标题输入框出现（最多 10 秒）。

### 4.6 标题填充（多选择器优先级策略）

小红书创作者中心会不定期更新 UI，因此采用**带优先级排序的多选择器策略**：

```typescript
const TITLE_SELECTORS = [
  'input[placeholder*="填写标题"]',       // 最具体：新 UI (2026-03)
  'input[placeholder*="更多赞"]',         // 新 UI 变体
  'input[placeholder*="标题"]',           // 通用中文
  'input[placeholder*="title" i]',        // 通用英文
  'input.d-text',                        // 小红书设计系统类名
  'input[class*="title"]',               // 模糊匹配
  'input[maxlength="20"]',               // 属性特征
  '.title-input input',                  // 容器类名
  '.note-title input',
  'input[maxlength]',                    // 最宽泛
];
```

填充值时还引入了**优先级评分机制**：匹配到特定 placeholder 文本的元素获得更高分数，避免选中 Vue/React 绑定产生的隐藏 input。

```javascript
let priority = 0;
if (placeholder.includes('填写')) priority = 100;
else if (placeholder.includes('标题')) priority = 80;
else if (placeholder.includes('赞')) priority = 70;
```

**React/Vue 兼容的输入注入：**
```javascript
// 方案 A：原生 input 元素
const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value'
).set;
nativeSetter.call(el, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));

// 方案 B：contenteditable 元素
el.innerText = '';
el.dispatchEvent(new Event('input', { bubbles: true }));
const range = document.createRange();
range.selectNodeContents(el);
range.collapse(false);
window.getSelection().removeAllRanges();
window.getSelection().addRange(range);
range.deleteContents();
range.insertNode(document.createTextNode(text));
el.dispatchEvent(new Event('input', { bubbles: true }));
```

### 4.7 话题标签添加

三步流程：查找"添加话题"按钮 → 输入话题名称 → 点击自动补全建议

```javascript
// 步骤 1：点击添加话题按钮
document.querySelectorAll('*').forEach(el => {
  const text = (el.innerText || '').trim();
  if (text === '添加话题' || text === '# 话题' && el.children.length === 0) {
    el.click();
  }
});

// 步骤 2：在话题搜索输入中输入名称
input.focus();
document.execCommand('insertText', false, topicName);
input.dispatchEvent(new Event('input', { bubbles: true }));

// 步骤 3：点击第一个补全建议
document.querySelector('[class*="topic-item"], [class*="hashtag-item"]')?.click();
```

### 4.8 发布/草稿提交

**兼容多种点击方式（Vue/React 双重兼容）：**
```javascript
btn.click();
btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
```

**发布成功验证：**
```javascript
// 验证方法 1：URL 跳转（发布成功会离开 /publish/publish 路径）
const navigatedAway = !finalUrl.includes('/publish/publish');

// 验证方法 2：检测成功提示文本
const successMsg = [...document.querySelectorAll('*')]
  .find(el => el.children.length === 0 &&
    el.innerText.includes('发布成功') ||
    el.innerText.includes('草稿已保存') ||
    el.innerText.includes('暂存成功')
  );
```

## 5. 完整错误处理体系

每个关键步骤都有截图调试功能，失败时生成调试截图到 `/tmp/`：

| 步骤 | 失败条件 | 调试截图路径 |
|------|---------|------------|
| Tab 选择 | 仍在视频发布页 | `/tmp/xhs_publish_tab_debug.png` |
| 图片上传 | file input 注入失败 | `/tmp/xhs_publish_upload_debug.png` |
| 编辑表单 | 上传图片后表单未出现 | `/tmp/xhs_publish_form_debug.png` |
| 标题填充 | 找不到标题输入框 | `/tmp/xhs_publish_title_debug.png` |
| 正文填充 | 找不到正文编辑器 | `/tmp/xhs_publish_content_debug.png` |
| 发布按钮 | 找不到"发布"按钮 | `/tmp/xhs_publish_submit_debug.png` |

## 6. 参数规范

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `--title` | 是 | string | 笔记标题，≤ 20 字 |
| `<content>` | 是 | string（位置参数） | 笔记正文 |
| `--images` | 是 | string（逗号分隔） | 图片本地路径，最多 9 张 |
| `--topics` | 否 | string（逗号分隔） | 话题标签（不含 # 号） |
| `--draft` | 否 | bool | 保存为草稿（默认直接发布） |
| `--close-after` | 否 | number | 发布后关闭标签页的秒数（默认 5，-1 不关闭） |

## 7. 关键技术点总结

| 技术 | 实现方案 | 适用范围 |
|------|---------|---------|
| 图片上传 | DataTransfer + File 对象 + 原生 value setter | 所有基于 file input 的上传场景 |
| 多版本兼容 | 优先级排序的多选择器链 + 优先级评分 | UI 频繁变更的内容平台 |
| 框架兼容 | 原型链 setter + execCommand + Range API | React / Vue / 原生 JS |
| 等待机制 | Polling + 状态检测器 + 自适应超时 | 所有异步 UI 渲染场景 |
| 页面状态判定 | 三态有限状态机（video/image/editor） | 多标签页/多模式创作者平台 |
| 调试友好 | 每步失败自动截图 | 所有浏览器自动化调试 |
| 双重事件分发 | `.click()` + `MouseEvent` | 确保 Vue/React 事件监听都能触发 |
