/**
 * Mofang (魔方) add-node — add workflow nodes to an activity.
 *
 * Flow:
 *   1. Navigate to the activity edit page (or reuse current page)
 *   2. Search for component in the left panel
 *   3. Drag component to canvas
 *   4. Click node to open configuration drawer
 *   5. Fill node configuration
 *
 * Usage:
 *   opencli mofang add-node --component "业务直调" --x 500 --y 300
 *   opencli mofang add-node --component "端内通知" --x 700 --y 300
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

cli({
  site: 'mofang',
  name: 'add-node',
  description: '魔方平台活动添加工作流节点',
  domain: 'mofang.beta.qunar.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'component', required: true, help: '组件名称 (如: 业务直调, 端内通知, 代金券)' },
    { name: 'x', required: false, help: '画布 X 坐标', default: '500' },
    { name: 'y', required: false, help: '画布 Y 坐标', default: '300' },
    { name: 'config', required: false, help: '节点配置 JSON (如: {"url":"http://..."})' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');
    if (!page.mouseDrag) throw new Error('当前版本不支持鼠标拖拽，请升级 opencli');

    const componentName = String(kwargs.component ?? '').trim();
    const targetX = parseInt(String(kwargs.x ?? '500'), 10);
    const targetY = parseInt(String(kwargs.y ?? '300'), 10);
    const config = kwargs.config ? JSON.parse(String(kwargs.config)) : {};

    if (!componentName) throw new Error('--component 不能为空');

    // ── Step 1: Search for component ────────────────────────────────────────
    await page.evaluate(`
      () => {
        const searchBox = document.querySelector('input[placeholder*="搜索"]');
        if (!searchBox) throw new Error('找不到组件搜索框');
        searchBox.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(searchBox, ${JSON.stringify(componentName)});
        } else {
          searchBox.value = ${JSON.stringify(componentName)};
        }
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
        searchBox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `);
    await page.wait({ time: 1 });

    // ── Step 2: Find component and canvas coordinates ──────────────────────
    const coords = await page.evaluate(`
      () => {
        const target = ${JSON.stringify(componentName)};
        const wrappers = document.querySelectorAll('.xflow-node-panel-node-wrapper');
        let componentEl = null;
        for (const w of wrappers) {
          if (w.textContent.trim() === target) {
            componentEl = w;
            break;
          }
        }
        if (!componentEl) {
          return { ok: false, error: '找不到组件: ' + target };
        }
        const canvas = document.querySelector('.xflow-canvas-root');
        if (!canvas) {
          return { ok: false, error: '找不到画布' };
        }
        const compRect = componentEl.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        return {
          ok: true,
          fromX: compRect.x + compRect.width / 2,
          fromY: compRect.y + compRect.height / 2,
          canvasX: canvasRect.x,
          canvasY: canvasRect.y,
          canvasW: canvasRect.width,
          canvasH: canvasRect.height,
        };
      }
    `);

    if (!coords.ok) {
      throw new Error(coords.error || '组件查找失败');
    }

    // ── Step 3: Drag component to canvas ───────────────────────────────────
    const toX = coords.canvasX + targetX;
    const toY = coords.canvasY + targetY;
    await page.mouseDrag!(coords.fromX, coords.fromY, toX, toY);
    await page.wait({ time: 2 });

    // ── Step 4: Click the newly added node to open config drawer ───────────
    const nodeClicked = await page.evaluate(`
      () => {
        const target = ${JSON.stringify(componentName)};
        // Find nodes on canvas (xflow-node or data-id elements inside svg)
        const svg = document.querySelector('.xflow-canvas-root svg');
        if (!svg) return { ok: false, error: '画布未渲染' };
        
        // Try to find node by text content in svg
        const texts = svg.querySelectorAll('text, tspan, .xflow-node-text, [class*="node-text"]');
        for (const t of texts) {
          if (t.textContent.trim() === target) {
            // Click the parent group/node
            let el = t;
            while (el && el.tagName !== 'g' && !el.className?.includes('node')) {
              el = el.parentElement;
            }
            if (el) {
              const opts = { bubbles: true, cancelable: true, view: window };
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
              return { ok: true, method: 'svg-text' };
            }
          }
        }
        
        // Fallback: click center of canvas
        const canvas = document.querySelector('.xflow-canvas-root');
        const rect = canvas.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window };
        canvas.dispatchEvent(new MouseEvent('mousedown', { ...opts, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 }));
        canvas.dispatchEvent(new MouseEvent('mouseup', { ...opts, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 }));
        canvas.dispatchEvent(new MouseEvent('click', { ...opts, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 }));
        return { ok: true, method: 'canvas-center' };
      }
    `);

    if (!nodeClicked.ok) {
      throw new Error(nodeClicked.error || '节点点击失败');
    }

    await page.wait({ time: 1.5 });

    // ── Step 5: Fill node configuration if provided ────────────────────────
    if (Object.keys(config).length > 0) {
      await page.evaluate(`
        () => {
          const config = ${JSON.stringify(config)};
          // Find config drawer/form on the right side
          const drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
          if (!drawer) return { ok: false, error: '配置面板未打开' };
          
          // Fill text inputs
          const inputs = drawer.querySelectorAll('input[type="text"], textarea');
          for (const input of inputs) {
            const label = input.previousElementSibling?.textContent || 
                         input.closest('.ant-form-item')?.querySelector('label')?.textContent || '';
            for (const [key, value] of Object.entries(config)) {
              if (label.includes(key) || input.id?.includes(key) || input.name?.includes(key)) {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) {
                  nativeSetter.call(input, String(value));
                } else {
                  input.value = String(value);
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }
          return { ok: true };
        }
      `);
    }

    return [
      {
        status: '✅ 节点已添加',
        detail: `${componentName} → 画布(${targetX}, ${targetY})`,
      },
    ];
  },
});
