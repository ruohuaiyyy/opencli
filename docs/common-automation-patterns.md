# 浏览器自动化通用模式总结

> 从豆包 References 和小红书 Publish 等实现中提炼的可复用模式

---

## 1. 浏览器自动化核心模式

### 1.1 元素定位容错链

```
最优（data-testid / 精确选择器）
  → 次优（placeholder 模糊匹配）
    → 降级（CSS class 模糊匹配）
      → 兜底（最宽泛的选择器）
```

**适用场景：** 所有 SPA 浏览器自动化。现代前端框架经常调整 DOM 结构，仅依赖单一选择器必然失败。

### 1.2 表单输入注入

```javascript
// textarea/input — React/Vue 兼容
const setter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype, 'value'
).set;
setter.call(el, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));

// contenteditable
document.execCommand('insertText', false, text);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

### 1.3 异步等待策略

```typescript
// 通用轮询模板
const pollMs = 2000;
const maxAttempts = Math.ceil(maxWaitMs / pollMs);
let stableCount = 0;
for (let i = 0; i < maxAttempts; i++) {
  const state = await checkState();
  if (state === desired) {
    stableCount++;
    if (stableCount >= requiredStable) break;
  } else {
    stableCount = 0;
  }
  await page.wait(pollMs / 1000);
}
```

### 1.4 文件上传注入

```javascript
const dt = new DataTransfer();
dt.items.add(new File([blob], name, { type }));
Object.defineProperty(input, 'files', { value: dt.files, writable: false });
input.dispatchEvent(new Event('change', { bubbles: true }));
```

## 2. 错误处理最佳实践

1. **快速失败**：在执行前验证所有输入（文件存在性、长度限制）
2. **逐步验证**：每一步操作后验证状态，不继续执行无效状态
3. **调试截图**：失败时自动生成截图，方便排查
4. **非致命降级**：次要功能失败时继续（如话题标签未找到）
5. **明确错误信息**：包含调试文件路径和失败原因

## 3. 命令注册模板

```typescript
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

cli({
  site: 'platform-name',
  name: 'command-name',
  description: '命令描述',
  domain: 'www.platform.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'arg', required: true, help: '参数说明' },
  ],
  columns: ['列1', '列2'],
  func: async (page: IPage, kwargs) => {
    // 实现
    return [{ 列1: '值1', 列2: '值2' }];
  },
});
```
