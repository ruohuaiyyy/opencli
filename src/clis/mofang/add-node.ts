/**
 * Mofang (魔方) add-node — add workflow nodes to an activity.
 *
 * Flow:
 *   Phase 1: Drag all nodes to canvas (no fill)
 *   Phase 2: Click each node by coordinate → fill config → close drawer
 *
 * Usage (single node — backward compatible):
 *   opencli mofang add-node --component "业务直调" --x 500 --y 300
 *   opencli mofang add-node --component "业务直调" --x 500 --y 300 --config '{"url":"http://..."}'
 *
 * Usage (multiple nodes via --nodes-file JSON file — recommended for Windows/PowerShell):
 *   opencli mofang add-node --nodes-file nodes.json
 *   opencli mofang add-node --nodes '[{"component":"业务直调","x":500,"y":300}]'
 *
 * Usage (multiple nodes via --components):
 *   opencli mofang add-node --components "业务直调,端内通知,代金券" --x 500,700,900 --y 300,300,300
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// FieldConfig Types
// ─────────────────────────────────────────────────────────────────────────────

type FieldType = 'text' | 'textarea' | 'select' | 'search' | 'click' | 'switch' | 'date';

interface FieldConfig {
  type: FieldType;
  /** Field label text OR button text (for click type) */
  name: string;
  /** Field value (not needed for click type) */
  value?: string | number | boolean;
  /** For click type: clicking adds dynamic rows to fill */
  rows?: FieldConfigRow[];
}

interface FieldConfigRow {
  /** Children fields to fill in the newly added row */
  children: FieldConfig[];
}

interface MofangNode {
  component: string;
  x?: number;
  y?: number;
  /** Legacy config (simple key-value, only supports text type) */
  config?: Record<string, unknown>;
  /** New fields config (supports 7 types: text/textarea/select/search/click/switch/date) */
  fields?: FieldConfig[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Definition
// ─────────────────────────────────────────────────────────────────────────────

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
          fields: n.fields as FieldConfig[] | undefined,
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error('nodes-file 读取失败 (' + path + '): ' + msg);
      }
    } else if (kwargs.nodes) {
      // Mode 2: --nodes JSON array
      try {
        const parsed = JSON.parse(String(kwargs.nodes));
        if (!Array.isArray(parsed)) throw new Error('--nodes 必须是数组格式');
        nodes = parsed.map((n: Record<string, unknown>) => ({
          component: String(n.component ?? '').trim(),
          x: n.x !== undefined ? parseInt(String(n.x), 10) : 500,
          y: n.y !== undefined ? parseInt(String(n.y), 10) : 300,
          config: n.config && typeof n.config === 'object' ? n.config as Record<string, unknown> : {},
          fields: n.fields as FieldConfig[] | undefined,
        }));
      } catch (e) {
        throw new Error('nodes JSON 解析失败: ' + (e instanceof Error ? e.message : String(e)));
      }
    } else if (kwargs.components) {
      // Mode 3: --components + --x + --y
      const components = String(kwargs.components).split(',').map(s => s.trim()).filter(Boolean);
      const xVals = String(kwargs.x ?? '500').split(',').map(s => parseInt(s.trim(), 10) || 500);
      const yVals = String(kwargs.y ?? '300').split(',').map(s => parseInt(s.trim(), 10) || 300);

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
      // Mode 4: Single node (backward compatible)
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

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Drag all nodes to canvas (no filling)
    // ─────────────────────────────────────────────────────────────────────────

    // Track node canvas positions for Phase 2 clicking by coordinate
    const nodePositions: Array<{ component: string; canvasX: number; canvasY: number }> = [];

    for (const node of nodes) {
      const { component, x = 500, y = 300 } = node;

      // Step 1.1: Search component in left panel
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

      // Step 1.2: Find component wrapper and canvas element
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

      // Step 1.3: Drag component to canvas at target position
      const targetX = coords.canvasX! + x;
      const targetY = coords.canvasY! + y;
      await page.mouseDrag!(coords.fromX!, coords.fromY!, targetX, targetY);
      await page.wait({ time: 2 });

      // Step 1.4: Record node center position for Phase 2 coordinate-based clicking
      nodePositions.push({
        component,
        canvasX: targetX,
        canvasY: targetY,
      });

      // Step 1.5: Click node to verify it's on canvas, then close drawer (no filling in Phase 1)
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

      // Step 1.6: Close drawer (Phase 1 doesn't fill — just verify node is on canvas)
      await closeDrawer(page);

      results.push({
        status: '🚀 节点已拖拽',
        detail: `${component} → 画布(${x}, ${y})`,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Fill configs for each node (click by coordinate → fill → close)
    // ─────────────────────────────────────────────────────────────────────────

    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
      const node = nodes[nodeIdx];
      const { component, config, fields } = node;
      const pos = nodePositions[nodeIdx];

      // Step 2.1: Click node by recorded coordinate to open config drawer
      await page.mouseDown!(pos.canvasX, pos.canvasY);
      await page.mouseUp!(pos.canvasX, pos.canvasY);
      await page.wait({ time: 1.5 });

      // Step 2.2: Fill configuration
      if (fields && fields.length > 0) {
        // New fields-based config (supports 7 types)
        await fillFieldsSequentially(page, fields);
      } else if (config && Object.keys(config).length > 0) {
        // Legacy config (only supports text type)
        await fillLegacyConfig(page, config);
      }

      // Step 2.3: Close drawer (except for the last node — leave it open for review)
      if (nodeIdx < nodes.length - 1) {
        await closeDrawer(page);
      }

      results.push({
        status: '✅ 节点已配置',
        detail: `${component} 配置完成`,
      });
    }

    return results;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Close the configuration drawer by clicking the close button or pressing Escape.
 */
async function closeDrawer(page: IPage): Promise<void> {
  await page.evaluate(`
    () => {
      // Try close button first
      const closeBtn = document.querySelector('.ant-drawer-close, [class*="drawer-close"], .anticon-close, button[class*="close"]');
      if (closeBtn) {
        closeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        closeBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return;
      }
      // Fallback: press Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
  `);
  await page.wait({ time: 0.5 });
}

/**
 * Fill configuration using the new `fields` format (supports 7 types).
 * Processes fields SEQUENTIALLY using for-loop + await Promise (not forEach + setTimeout).
 * This fixes the race condition where multiple select/search fields would conflict.
 */
async function fillFieldsSequentially(page: IPage, fields: FieldConfig[]): Promise<void> {
  for (var fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
    var field = fields[fieldIdx];

    if (field.type === 'text' || field.type === 'textarea') {
      // Fill text/textarea immediately (no async waiting needed)
      await page.evaluate(`
        (() => {
          var fieldName = ${JSON.stringify(field.name)};
          var fieldValue = ${JSON.stringify(field.value ?? '')};
          var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
          if (!drawer) return;
          // Find by label or placeholder
          var items = drawer.querySelectorAll('.ant-form-item');
          for (var item of items) {
            var labelEl = item.querySelector('label');
            var labelText = labelEl ? labelEl.textContent.trim() : '';
            var inputs = item.querySelectorAll('input, textarea');
            for (var inp of inputs) {
              if (labelText === fieldName || inp.placeholder === fieldName || inp.id?.includes(fieldName)) {
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) { nativeSetter.call(inp, fieldValue); }
                else { inp.value = fieldValue; }
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }
            }
          }
        })()
      `);
      await page.wait({ time: 0.3 });
    }

    else if (field.type === 'select' || field.type === 'search') {
      // Open dropdown first
      await page.evaluate(`
        (() => {
          var fieldName = ${JSON.stringify(field.name)};
          var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
          if (!drawer) return;
          var items = drawer.querySelectorAll('.ant-form-item');
          for (var item of items) {
            var labelEl = item.querySelector('label');
            var labelText = labelEl ? labelEl.textContent.trim() : '';
            if (labelText !== fieldName) continue;
            var sel = item.querySelector('.ant-select, [class*="select"]');
            if (!sel) return;
            var opts = { bubbles: true, cancelable: true, view: window };
            sel.dispatchEvent(new MouseEvent('mousedown', opts));
            sel.dispatchEvent(new MouseEvent('click', opts));
          }
        })()
      `);
      await page.wait({ time: 0.3 });

      // Wait for dropdown to open, then select option — using polling (NOT setTimeout)
      await new Promise<void>(function(resolve) {
        var maxWait = 3000;
        var interval = 100;
        var waited = 0;
        var fieldValue = String(field.value ?? '');

        function tryFind() {
          var dropdown = document.querySelector('.ant-select-dropdown:not([style*="display:none"]), .ant-select-item-option-selected');
          if (!dropdown) {
            // Try another approach: click option by text
            var options = document.querySelectorAll('.ant-select-item-option-content, .ant-select-selection-item, [class*="option-content"]');
            for (var opt of options) {
              if (opt.textContent.trim() === fieldValue) {
                opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                clearInterval(timer);
                setTimeout(resolve, 200);
                return true;
              }
            }
          }
          return false;
        }

        if (tryFind()) return;
        var timer = setInterval(function() {
          waited += interval;
          if (tryFind()) return;
          if (waited >= maxWait) {
            clearInterval(timer);
            resolve();
          }
        }, interval);
      });
    }

    else if (field.type === 'switch') {
      // Toggle switch
      var switchValue = field.value === true || field.value === 'true' || field.value === '1';
      await page.evaluate(`
        (() => {
          var fieldName = ${JSON.stringify(field.name)};
          var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
          if (!drawer) return;
          var items = drawer.querySelectorAll('.ant-form-item');
          for (var item of items) {
            var labelEl = item.querySelector('label');
            var labelText = labelEl ? labelEl.textContent.trim() : '';
            if (labelText !== fieldName) continue;
            var sw = item.querySelector('.ant-switch, [class*="switch"]');
            if (!sw) return;
            var isChecked = sw.classList.contains('ant-switch-checked') || sw.hasAttribute('aria-checked');
            if (isChecked !== ${switchValue}) {
              var opts = { bubbles: true, cancelable: true, view: window };
              sw.dispatchEvent(new MouseEvent('mousedown', opts));
              sw.dispatchEvent(new MouseEvent('mouseup', opts));
              sw.dispatchEvent(new MouseEvent('click', opts));
            }
          }
        })()
      `);
      await page.wait({ time: 0.3 });
    }

    else if (field.type === 'date') {
      // Wait for date picker to render, then set value
      await page.evaluate(`
        (() => {
          var fieldName = ${JSON.stringify(field.name)};
          var fieldValue = ${JSON.stringify(field.value ?? '')};
          var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
          if (!drawer) return;
          var items = drawer.querySelectorAll('.ant-form-item');
          for (var item of items) {
            var labelEl = item.querySelector('label');
            var labelText = labelEl ? labelEl.textContent.trim() : '';
            if (labelText !== fieldName) continue;
            var datePicker = item.querySelector('.ant-picker, [class*="date-picker"], input[placeholder*="日期"]');
            if (!datePicker) return;
            var inp = datePicker.querySelector('input') || datePicker;
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) { nativeSetter.call(inp, fieldValue); }
            else { inp.value = fieldValue; }
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `);
      await page.wait({ time: 0.5 });
    }

    else if (field.type === 'click') {
      // Click a button (e.g., "确定", "添加数据", "新增参数")
      await page.evaluate(`
        (() => {
          var btnName = ${JSON.stringify(field.name)};
          var btns = Array.from(document.querySelectorAll('button'));
          var btn = btns.find(function(b) { return b.textContent.trim() === btnName; });
          if (!btn) return;
          var opts = { bubbles: true, cancelable: true, view: window };
          btn.dispatchEvent(new MouseEvent('mousedown', opts));
          btn.dispatchEvent(new MouseEvent('mouseup', opts));
          btn.dispatchEvent(new MouseEvent('click', opts));
        })()
      `);

      // Handle dynamic rows (click button → new row appears → fill children)
      if (field.rows && field.rows.length > 0) {
        await page.wait({ time: 0.5 });

        for (var ri = 0; ri < field.rows.length; ri++) {
          var rowConfig = field.rows[ri];

          // Click button to add a new row
          await page.evaluate(`
            (() => {
              var btnName = ${JSON.stringify(field.name)};
              var btns = Array.from(document.querySelectorAll('button'));
              var btn = btns.find(function(b) { return b.textContent.trim() === btnName; });
              if (!btn) return;
              var opts = { bubbles: true, cancelable: true, view: window };
              btn.dispatchEvent(new MouseEvent('mousedown', opts));
              btn.dispatchEvent(new MouseEvent('mouseup', opts));
              btn.dispatchEvent(new MouseEvent('click', opts));
            })()
          `);

          // Wait for new row to appear (poll until we detect new input id/placeholder)
          await new Promise<void>(function(resolve) {
            var maxWait = 3000;
            var interval = 100;
            var waited = 0;
            var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
            if (!drawer) { resolve(); return; }

            // Get all inputs before clicking
            var beforeInputs = Array.from(drawer.querySelectorAll('input, textarea, .ant-select')).map(function(e) {
              var el = e as HTMLInputElement | HTMLTextAreaElement | { id: string; placeholder?: string };
              return el.id || (el as { placeholder?: string }).placeholder;
            });

            function tryDetect() {
              var cur = (drawer as Element).querySelectorAll('input, textarea, .ant-select');
              var currentInputs = Array.from(cur).map(function(e) {
                var el = e as HTMLInputElement | HTMLTextAreaElement | { id: string; placeholder?: string };
                return el.id || (el as { placeholder?: string }).placeholder;
              });
              // Check if any new id/placeholder appeared
              var newFound = currentInputs.some(function(id) {
                return id && beforeInputs.indexOf(id) === -1;
              });
              if (newFound || waited >= maxWait) {
                clearInterval(timer);
                setTimeout(resolve, 200);
              }
            }

            tryDetect();
            var timer = setInterval(function() {
              waited += interval;
              tryDetect();
            }, interval);
          });

          // Fill children in the newly added row (use placeholder === name matching)
          if (rowConfig.children) {
            for (var ci = 0; ci < rowConfig.children.length; ci++) {
              var child = rowConfig.children[ci];
              await fillChildField(page, child);
              await page.wait({ time: 0.3 });
            }
          }
        }
      }
    }
  }
}

/**
 * Fill a child field within a dynamically added row.
 * Uses placeholder matching since dynamic rows don't have stable IDs.
 * For select/search types in children: opens dropdown then uses polling.
 */
async function fillChildField(page: IPage, child: FieldConfig): Promise<void> {
  if (child.type === 'text' || child.type === 'textarea') {
    await page.evaluate(`
      (() => {
        var childName = ${JSON.stringify(child.name)};
        var childValue = ${JSON.stringify(child.value ?? '')};
        var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
        if (!drawer) return;
        // Find the most recently added input by matching placeholder
        var allInputs = drawer.querySelectorAll('input, textarea');
        // Start from the end (most likely to be the newest row)
        for (var i = allInputs.length - 1; i >= 0; i--) {
          var inp = allInputs[i];
          if (inp.placeholder === childName || inp.id?.endsWith('_name') && childName === '属性名' ||
              inp.id?.endsWith('_desc') && childName === '属性描述') {
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) { nativeSetter.call(inp, childValue); }
            else { inp.value = childValue; }
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
        // Fallback: find by id pattern params_*_{name,desc}
        var allEls = drawer.querySelectorAll('[id]');
        for (var el of allEls) {
          var id = el.id;
          if (id && (
              (id.endsWith('_name') && childName === '属性名') ||
              (id.endsWith('_desc') && childName === '属性描述') ||
              (id.endsWith('_type') && childName === '值类型')
          )) {
            var inp2 = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : el.querySelector('input, textarea');
            if (inp2 && (inp2.tagName === 'INPUT' || inp2.tagName === 'TEXTAREA')) {
              var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              if (nativeSetter) { nativeSetter.call(inp2, childValue); }
              else { inp2.value = childValue; }
              inp2.dispatchEvent(new Event('input', { bubbles: true }));
              inp2.dispatchEvent(new Event('change', { bubbles: true }));
              return;
            }
          }
        }
      })()
    `);
  }

  else if (child.type === 'select') {
    // Open the select dropdown
    await page.evaluate(`
      (() => {
        var childName = ${JSON.stringify(child.name)};
        var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
        if (!drawer) return;
        // Find by id pattern params_*_type (值类型 uses _type suffix)
        var typeId = '';
        var allEls = drawer.querySelectorAll('[id]');
        for (var el of allEls) {
          if (el.id.endsWith('_type') && childName === '值类型') {
            typeId = el.id;
          }
        }
        if (!typeId) return;
        var selEl = document.getElementById(typeId);
        if (!selEl) return;
        // Click the select container
        var container = selEl.closest('.ant-select') || selEl;
        var opts = { bubbles: true, cancelable: true, view: window };
        container.dispatchEvent(new MouseEvent('mousedown', opts));
        container.dispatchEvent(new MouseEvent('click', opts));
      })()
    `);
    await page.wait({ time: 0.3 });

    // Select the matching option with polling
    await new Promise<void>(function(resolve) {
      var maxWait = 3000;
      var interval = 100;
      var waited = 0;
      var childValue = String(child.value ?? '');

      function tryFind() {
        var options = document.querySelectorAll('.ant-select-item-option-content, .ant-select-selection-item, [class*="option-content"]');
        for (var opt of options) {
          if (opt.textContent.trim() === childValue) {
            opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            clearInterval(timer);
            setTimeout(resolve, 200);
            return true;
          }
        }
        return false;
      }

      if (tryFind()) return;
      var timer = setInterval(function() {
        waited += interval;
        if (tryFind()) return;
        if (waited >= maxWait) {
          clearInterval(timer);
          resolve();
        }
      }, interval);
    });
  }
}

/**
 * Fill legacy config format (simple key-value, only supports text input).
 */
async function fillLegacyConfig(page: IPage, config: Record<string, unknown>): Promise<void> {
  await page.evaluate(`
    (() => {
      var config = ${JSON.stringify(config)};
      var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
      if (!drawer) return;
      var inputs = drawer.querySelectorAll('input[type="text"], textarea');
      for (var input of inputs) {
        var label = input.previousElementSibling?.textContent ||
                    input.closest('.ant-form-item')?.querySelector('label')?.textContent || '';
        for (var key in config) {
          if (label.includes(key) || input.id?.includes(key) || input.name?.includes(key)) {
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) { nativeSetter.call(input, String(config[key])); }
            else { input.value = String(config[key]); }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }
    })()
  `);
  await page.wait({ time: 0.5 });
}