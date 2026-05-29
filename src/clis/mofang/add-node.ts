/**
 * Mofang (魔方) add-node — add workflow nodes to an activity.
 *
 * Flow:
 *   1. Reuse current page (from create-event)
 *   2. For each node: search component → drag to canvas → click node → fill config
 *   3. Auto-layout from left to right, top to bottom
 *
 * Usage (single node — backward compatible):
 *   opencli mofang add-node --component "业务直调" --x 500 --y 300
 *   opencli mofang add-node --component "业务直调" --x 500 --y 300 --config '{"url":"http://..."}'
 *
 * Usage (multiple nodes via --nodes-file JSON file — recommended for Windows/PowerShell):
 *   opencli mofang add-node --nodes-file nodes.json
 *   (nodes.json 内容: [{"component":"业务直调","x":500,"y":300,"config":{}},{"component":"端内通知","x":700,"y":300}])
 *   opencli mofang add-node --nodes '[{"component":"业务直调","x":500,"y":300,"config":{"url":"http://..."}},{"component":"端内通知","x":700,"y":300}]'
 *
 * Usage (multiple nodes via --components):
 *   opencli mofang add-node --components "业务直调,端内通知,代金券" --x 500,700,900 --y 300,300,300 --configs '{"业务直调":{"url":"http://..."},"端内通知":{}}'
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

interface MofangNode {
  component: string;
  x?: number;
  y?: number;
  config?: Record<string, unknown>;
}

cli({
  site: 'mofang',
  name: 'add-node',
  description: '魔方平台活动添加工作流节点（支持批量）',
  domain: 'mofang.beta.qunar.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false, // Reuse current page — do NOT navigate away from create-event page
  args: [
    // ── Mode 1: JSON file (recommended for PowerShell) ─────────────────────
    { name: 'nodes-file', required: false, help: '从 JSON 文件读取节点配置 (推荐 Windows/PowerShell 使用)，示例: nodes.json' },

    // ── Mode 2: JSON array string ──────────────────────────────────────────
    { name: 'nodes', required: false, help: '节点数组 JSON (适合 bash，PowerShell 建议用 --nodes-file)' },

    // ── Mode 3: Multi-node via --components ───────────────────────────────
    { name: 'components', required: false, help: '多个组件名称，逗号分隔 (如: 业务直调,端内通知,代金券)' },
    { name: 'x', required: false, help: '多个 X 坐标，逗号分隔 (如: 500,700,900)' },
    { name: 'y', required: false, help: '多个 Y 坐标，逗号分隔 (如: 300,300,300)' },
    { name: 'configs', required: false, help: '各组件配置 JSON (如: \'{"业务直调":{"url":"..."},"端内通知":{}}\')' },

    // ── Mode 4: Single node (backward compatible) ──────────────────────────
    { name: 'component', required: false, help: '组件名称 (单节点模式)' },
    { name: 'config', required: false, help: '节点配置 JSON (单节点模式，如: {"url":"http://..."})' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');
    if (!page.mouseDrag) throw new Error('当前版本不支持鼠标拖拽，请升级 opencli');

    // ── Determine mode and parse nodes ─────────────────────────────────────
    let nodes: MofangNode[] = [];

    if (kwargs['nodes-file']) {
      // Mode 1: Read nodes from JSON file (PowerShell friendly)
      const path = String(kwargs['nodes-file']).trim();
      const { readFileSync } = await import('fs');
      const fileContent = readFileSync(path, 'utf-8');
      try {
        const parsed = JSON.parse(fileContent);
        if (!Array.isArray(parsed)) throw new Error('--nodes-file 必须是 JSON 数组格式');
        nodes = parsed.map((n: Record<string, unknown>) => ({
          component: String(n.component ?? '').trim(),
          x: n.x !== undefined ? parseInt(String(n.x), 10) : 500,
          y: n.y !== undefined ? parseInt(String(n.y), 10) : 300,
          config: n.config && typeof n.config === 'object' ? n.config as Record<string, unknown> : {},
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error('nodes-file 读取失败 (' + path + '): ' + msg);
      }
    } else if (kwargs.nodes) {
      // Mode 1: --nodes JSON array
      try {
        const parsed = JSON.parse(String(kwargs.nodes));
        if (!Array.isArray(parsed)) throw new Error('--nodes 必须是数组格式');
        nodes = parsed.map((n: Record<string, unknown>) => ({
          component: String(n.component ?? '').trim(),
          x: n.x !== undefined ? parseInt(String(n.x), 10) : 500,
          y: n.y !== undefined ? parseInt(String(n.y), 10) : 300,
          config: n.config && typeof n.config === 'object' ? n.config as Record<string, unknown> : {},
        }));
      } catch (e) {
        throw new Error('nodes JSON 解析失败: ' + (e instanceof Error ? e.message : String(e)));
      }
    } else if (kwargs.components) {
      // Mode 2: --components + --x + --y
      const components = String(kwargs.components).split(',').map(s => s.trim()).filter(Boolean);
      const xVals = String(kwargs.x ?? '500').split(',').map(s => parseInt(s.trim(), 10) || 500);
      const yVals = String(kwargs.y ?? '300').split(',').map(s => parseInt(s.trim(), 10) || 300);

      // Parse configs JSON if provided
      let configsMap: Record<string, Record<string, unknown>> = {};
      if (kwargs.configs) {
        try {
          configsMap = JSON.parse(String(kwargs.configs));
        } catch (e) {
          throw new Error('--configs JSON 解析失败: ' + (e instanceof Error ? e.message : String(e)));
        }
      }

      nodes = components.map((component, i) => ({
        component,
        x: xVals[i] ?? 500,
        y: yVals[i] ?? 300,
        config: configsMap[component] ?? {},
      }));
    } else if (kwargs.component) {
      // Mode 3: Single node (backward compatible)
      nodes = [{
        component: String(kwargs.component).trim(),
        x: parseInt(String(kwargs.x ?? '500'), 10),
        y: parseInt(String(kwargs.y ?? '300'), 10),
        config: kwargs.config ? JSON.parse(String(kwargs.config)) : {},
      }];
    } else {
      throw new Error('必须提供 --nodes 或 --components 或 --component 参数');
    }

    if (nodes.length === 0) throw new Error('没有有效的节点配置');
    if (nodes.some(n => !n.component)) throw new Error('每个节点必须指定 component');

    const results: Array<{ status: string; detail: string }> = [];

    // ── Process each node ──────────────────────────────────────────────────
    for (const node of nodes) {
      const { component, x = 500, y = 300, config } = node;

      // Step 1: Search component
      await page.evaluate(`
        () => {
          const searchBox = document.querySelector('input[placeholder*="搜索"]');
          if (!searchBox) throw new Error('找不到组件搜索框');
          searchBox.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          const value = ${JSON.stringify(component)};
          if (nativeSetter) {
            nativeSetter.call(searchBox, value);
          } else {
            searchBox.value = value;
          }
          searchBox.dispatchEvent(new Event('input', { bubbles: true }));
          searchBox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await page.wait({ time: 1 });

      // Step 2: Find component and canvas coordinates
      const coords: { ok: boolean; fromX?: number; fromY?: number; canvasX?: number; canvasY?: number; error?: string } = await page.evaluate(`
        () => {
          const target = ${JSON.stringify(component)};
          const wrappers = document.querySelectorAll('.xflow-node-panel-node-wrapper');
          let componentEl = null;
          for (const w of wrappers) {
            if (w.textContent.trim() === target) {
              componentEl = w;
              break;
            }
          }
          if (!componentEl) return { ok: false, error: '找不到组件: ' + target };
          const canvas = document.querySelector('.xflow-canvas-root');
          if (!canvas) return { ok: false, error: '找不到画布' };
          const compRect = componentEl.getBoundingClientRect();
          const canvasRect = canvas.getBoundingClientRect();
          return {
            ok: true,
            fromX: compRect.x + compRect.width / 2,
            fromY: compRect.y + compRect.height / 2,
            canvasX: canvasRect.x,
            canvasY: canvasRect.y,
          };
        }
      `);

      if (!coords.ok || coords.fromX === undefined) {
        throw new Error(coords.error || '组件查找失败');
      }

      // Step 3: Drag component to canvas
      const targetX = coords.canvasX! + x;
      const targetY = coords.canvasY! + y;
      await page.mouseDrag!(coords.fromX!, coords.fromY!, targetX, targetY);
      await page.wait({ time: 2 });

      // Step 4: Click the newly added node to open config drawer
      await page.wait({ time: 1 });
      await page.evaluate(`
        () => {
          const target = ${JSON.stringify(component)};
          const svg = document.querySelector('.xflow-canvas-root svg');
          if (!svg) return;
          const texts = svg.querySelectorAll('text, tspan, .xflow-node-text, [class*="node-text"]');
          for (const t of texts) {
            if (t.textContent.trim() === target) {
              let el = t;
              while (el && el.tagName !== 'g' && !el.className?.includes('node')) {
                el = el.parentElement;
              }
              if (el) {
                const opts = { bubbles: true, cancelable: true, view: window };
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
              }
              break;
            }
          }
        }
      `);
      await page.wait({ time: 1.5 });

      // Step 5: Fill node configuration if provided
      if (config && Object.keys(config).length > 0) {
        await page.evaluate(`
          () => {
            const config = ${JSON.stringify(config)};
            const drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
            if (!drawer) return;
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
          }
        `);
        await page.wait({ time: 0.5 });
      }

      results.push({
        status: '✅ 节点已添加',
        detail: `${component} → 画布(${x}, ${y})`,
      });
    }

    return results;
  },
});