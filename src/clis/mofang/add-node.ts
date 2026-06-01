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

type FieldType = 'text' | 'textarea' | 'select' | 'search' | 'click' | 'switch' | 'date' | 'code';

interface FieldConfig {
  type: FieldType;
  /** Field label text OR button text (for click type) */
  name: string;
  /** Field value (not needed for click type) */
  value?: string | number | boolean;
  /** For click type: clicking adds dynamic rows to fill */
  rows?: FieldConfigRow[];
  /**
   * For click type: target section to scope the button search.
   * e.g. 'output' → restricts button search to the 输出参数 collapse panel.
   */
  section?: string;
}

interface FieldConfigRow {
  /** Children fields to fill in the newly added row */
  children: FieldConfig[];
  /**
   * Row mode: if 'context', switch the radio group to "上下文获取" mode
   * before filling children (the 属性值 field becomes a combobox in context mode).
   */
  mode?: string;
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

      // DEBUG: check if stale dropdown exists before filling node
      const beforeFill = await page.evaluate(`
        () => {
          let dd = document.querySelector('.ant-select-dropdown');
          if (!dd) return 'NO_DROPDOWN';
          let style = window.getComputedStyle(dd);
          return 'VISIBLE: display=' + style.display + ' visibility=' + style.visibility + ' rect:' + JSON.stringify(dd.getBoundingClientRect());
        }
      `);
      console.log('[DEBUG] Before filling node ' + nodeIdx + ' (' + component + '), dropdown: ' + beforeFill);

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
        // DEBUG: check if 下步节点 value was actually rendered before closing
        const beforeCloseVal = await page.evaluate(`
          () => {
            let items = document.querySelectorAll('.ant-form-item');
            for (let item of items) {
              let lbl = item.querySelector('label');
              if (!lbl) continue;
              let txt = lbl.textContent.trim();
              if (txt.includes('下步节点') || txt.includes('* 下步节点')) {
                let selItem = item.querySelector('.ant-select-selection-item');
                if (selItem) return 'HAS_VALUE: ' + selItem.textContent.trim();
                let tags = item.querySelectorAll('.ant-tag');
                if (tags.length > 0) return 'TAGS: ' + Array.from(tags).map(t => t.textContent.trim()).join(', ');
                return 'NO_VALUE_YET';
              }
            }
            return 'FIELD_NOT_FOUND';
          }
        `);
        console.log('[DEBUG] Before closeDrawer (node ' + nodeIdx + '), 下步节点 value: ' + beforeCloseVal);
        await closeDrawer(page);
      }

      // DEBUG: check if dropdown is still open after closeDrawer
      const dropdownStillOpen = await page.evaluate(`
        () => {
          let dd = document.querySelector('.ant-select-dropdown');
          if (!dd) return 'NO_DROPDOWN';
          let style = window.getComputedStyle(dd);
          return 'VISIBLE: display=' + style.display + ' visibility=' + style.visibility + ' rect:' + JSON.stringify(dd.getBoundingClientRect());
        }
      `);
      console.log('[DEBUG] After closeDrawer (node ' + nodeIdx + '), dropdown state: ' + dropdownStillOpen);

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
 * Waits for drawer to actually close before returning.
 */
/**
 * Close the drawer by clicking the canvas area (outside the drawer).
 * This is the normal way mofang closes the drawer and saves the config.
 */
async function closeDrawer(page: IPage): Promise<void> {
   // Click a point on the canvas (far left, outside drawer) to close drawer and save
  // Drawer occupies the right side; canvas is on the left
  await page.mouseDown!(50, 300);
  await page.mouseUp!(50, 300);

  // Wait for drawer to close
  let drawerMaxWait = 3000;
  let drawerInterval = 100;
  let drawerWaited = 0;

  while (drawerWaited < drawerMaxWait) {
    const isClosed = await page.evaluate(`
      () => {
        let drawer = document.querySelector('.ant-drawer-content-wrapper, [class*="drawer-content-wrapper"]');
        if (!drawer) return true;
        let style = drawer.getAttribute('style') || '';
        if (style.includes('display: none') || style.includes('display:none')) return true;
        return false;
      }
    `);
    if (isClosed) return;
    await page.wait({ time: drawerInterval / 1000 });
    drawerWaited += drawerInterval;
  }
}

/**
 * Wait for any open dropdown to close before opening a new one.
 * Prevents race conditions when multiple select/search fields are processed.
 */
async function waitForDropdownClosed(page: IPage): Promise<void> {
  let maxWait = 2000;
  let interval = 50;
  let waited = 0;

  while (waited < maxWait) {
    const isClosed = await page.evaluate(`
      () => {
        let dropdown = document.querySelector('.ant-select-dropdown:not([style*="display: none"]):not([style*="display:none"])');
        return !dropdown;
      }
    `);
    if (isClosed) return;
    await page.wait({ time: interval / 1000 });
    waited += interval;
  }
}

/**
 * Fill configuration using the new `fields` format (supports 7 types).
 * Processes fields SEQUENTIALLY using for-loop + await Promise (not forEach + setTimeout).
 * This fixes the race condition where multiple select/search fields would conflict.
 */
async function fillFieldsSequentially(page: IPage, fields: FieldConfig[]): Promise<void> {
  for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
    const field = fields[fieldIdx];

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
      // Wait for any previous dropdown to close (prevents race condition)
      await waitForDropdownClosed(page);

      const fieldValue = String(field.value ?? '');
      const fieldName = String(field.name);

      // Multi-select dropdowns (e.g. "下步节点") do NOT auto-close after selection.
      // We must close them manually before closing the drawer.
      const isMultiSelect = fieldName.includes('下步节点');

      // Strategy 0: Find by label[for] — most direct, works for both wrapped and unwrapped selects
      const inputId = await page.evaluate(`
        (() => {
          var fieldName = ${JSON.stringify(fieldName)};
          var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
          if (!drawer) return null;
          var items = drawer.querySelectorAll('.ant-form-item');
          for (var item of items) {
            var labelEl = item.querySelector('label');
            var labelText = labelEl ? labelEl.textContent.trim() : '';
            // Match label text (strip leading * and trailing :)
            var cleanLabel = labelText.trim();
            if (cleanLabel.startsWith('*')) cleanLabel = cleanLabel.substring(1).trim();
            if (cleanLabel.endsWith(':')) cleanLabel = cleanLabel.substring(0, cleanLabel.length - 1).trim();
            if (cleanLabel === fieldName || labelText === fieldName) {
              return labelEl.getAttribute('for');
            }
          }
          return null;
        })()
      `);

      if (inputId) {
        // Found inputId via label[for] — use it to open dropdown and build listboxId
        await page.evaluate(`
          (() => {
            var inp = document.getElementById(${JSON.stringify(inputId)});
            if (!inp) return;
            var opts = { bubbles: true, cancelable: true, view: window };
            inp.dispatchEvent(new MouseEvent('mousedown', opts));
            inp.dispatchEvent(new MouseEvent('mouseup', opts));
            inp.dispatchEvent(new MouseEvent('click', opts));
          })
        `);

        // Poll for option selection via listboxId (no global search)
        let dropdownMaxWait = 5000;
        let dropdownInterval = 100;
        let dropdownWaited = 0;
        const targetListboxId = inputId + '_list';

        while (dropdownWaited < dropdownMaxWait) {
          const found = await page.evaluate(`
            (() => {
              var listboxId = ${JSON.stringify(targetListboxId)};
              var targetVal = ${JSON.stringify(fieldValue)};
              var listbox = document.getElementById(listboxId);
              if (!listbox) return false;
              var dropdown = listbox.closest('.ant-select-dropdown');
              if (!dropdown) return false;
              var r = dropdown.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return false;
              var options = dropdown.querySelectorAll('[role="option"], .ant-select-item-option-content, .ant-select-item-option');
              for (var opt of options) {
                if (opt.textContent.trim() === targetVal) {
                  var opts2 = { bubbles: true, cancelable: true, view: window };
                  opt.dispatchEvent(new MouseEvent('mousedown', opts2));
                  opt.dispatchEvent(new MouseEvent('mouseup', opts2));
                  opt.dispatchEvent(new MouseEvent('click', opts2));
                  // Multi-select: click the label text to defocus dropdown and confirm selection
                  var inpId = listboxId.replace('_list', '');
                  var lbl = document.querySelector('label[for="' + inpId + '"]');
                  if (lbl) {
                    var lblText = lbl.querySelector('.ant-form-item-label label') || lbl;
                    lblText.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  }
                  return true;
                }
              }
              return false;
            })()
          `);
          if (found) {
            if (isMultiSelect) {
              // Multi-select: manually close dropdown before drawer closes
              await page.pressKey('Escape');
              await waitForDropdownClosed(page);
            }
            break;
          }
          await page.wait({ time: dropdownInterval / 1000 });
          dropdownWaited += dropdownInterval;
        }
        // Wait 1s after selecting option, letting drawer re-render
        await page.wait({ time: 1 });
      } else {
        // Fallback: original label-text + .ant-select strategy
        await page.evaluate(`
          (() => {
            var fieldName = ${JSON.stringify(fieldName)};
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
              sel.dispatchEvent(new MouseEvent('mouseup', opts));
              sel.dispatchEvent(new MouseEvent('click', opts));
            }
          })()
        `);
        await page.wait({ time: 0.3 });

        let dropdownMaxWait = 5000;
        let dropdownInterval = 100;
        let dropdownWaited = 0;

        while (dropdownWaited < dropdownMaxWait) {
          const found = await page.evaluate(`
            (() => {
              let dropdown = document.querySelector('.ant-select-dropdown:not([style*="display: none"]):not([style*="display:none"])');
              if (!dropdown) return false;
              let options = dropdown.querySelectorAll('.ant-select-item-option-content, .ant-select-item-option, [role="option"]');
                           for (let opt of options) {
                if (opt.textContent.trim() === ${JSON.stringify(fieldValue)}) {
                  let opts2 = { bubbles: true, cancelable: true, view: window };
                  opt.dispatchEvent(new MouseEvent('mousedown', opts2));
                  opt.dispatchEvent(new MouseEvent('mouseup', opts2));
                  opt.dispatchEvent(new MouseEvent('click', opts2));
                  // Multi-select: click the label text to defocus dropdown and confirm selection
                  var allItems = document.querySelectorAll('.ant-form-item');
                  for (var li of allItems) {
                    var ll = li.querySelector('label');
                    if (ll && ll.textContent.trim() === ${JSON.stringify(fieldName)}) {
                      var llText = ll.querySelector('.ant-form-item-label label') || ll;
                      llText.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                      break;
                    }
                  }
                  return true;
                }
              }
              return false;
            })()
          `);
          if (found) {
            if (isMultiSelect) {
              await page.pressKey('Escape');
              await waitForDropdownClosed(page);
            }
            break;
          }
          await page.wait({ time: dropdownInterval / 1000 });
          dropdownWaited += dropdownInterval;
        }
        // Wait 1s after selecting option
        await page.wait({ time: 1 });
      }
    }

    else if (field.type === 'switch') {
      // Toggle switch
      let switchValue = field.value === true || field.value === 'true' || field.value === '1';
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

    else if (field.type === 'code') {
      // Monaco editor: click to focus first, then use Monaco API to set value directly
      const codeValue = String(field.value ?? '');
      await page.evaluate(`
        (() => {
          var monaco = document.querySelector('.monaco-editor');
          if (!monaco) return;
          var opts = { bubbles: true, cancelable: true, view: window };
          monaco.dispatchEvent(new MouseEvent('mousedown', opts));
          monaco.dispatchEvent(new MouseEvent('mouseup', opts));
          monaco.dispatchEvent(new MouseEvent('click', opts));
        })()
      `);
      await page.wait({ time: 0.3 });
      // Use Monaco's API directly: getEditors()[0].getModel().setValue()
      const setOk = await page.evaluate(`
        (() => {
          var code = ${JSON.stringify(codeValue)};
          if (!window.monaco) return false;
          var editors = window.monaco.editor.getEditors();
          if (!editors || editors.length === 0) return false;
          var model = editors[0].getModel();
          if (!model) return false;
          model.setValue(code);
          return true;
        })()
      `);
      console.log('[DEBUG] Monaco setValue: ' + setOk);
      // Verify
      const afterVal = await page.evaluate(`
        () => {
          var lines = document.querySelector('.lines-content');
          return lines ? lines.textContent.trim() : '';
        }
      `);
      console.log('[DEBUG] Monaco code after setValue: ' + afterVal.substring(0, 80));
    }

    else if (field.type === 'click') {
      // Handle dynamic rows (click button → new row appears → fill children)
      if (field.rows && field.rows.length > 0) {
        for (let ri = 0; ri < field.rows.length; ri++) {
          const rowConfig = field.rows[ri];

          // Click button to add a new row
          // If section is specified (e.g. 'output'), restrict search to that collapse panel
          await page.evaluate(`
            (() => {
              var btnName = ${JSON.stringify(field.name)};
              var section = ${JSON.stringify(field.section || '')};
              var targetBtn = null;

              if (section) {
                // Find the collapse panel for the target section
                var sectionLabel = section === 'output' ? '输出参数' : '输入参数';
                var allBtns = Array.from(document.querySelectorAll('button'));
                var sectionBtn = null;
                for (var b of allBtns) {
                  if (b.textContent.trim().includes(sectionLabel)) {
                    sectionBtn = b;
                    break;
                  }
                }
                if (sectionBtn) {
                  var panel = sectionBtn.closest('.ant-collapse');
                  if (panel) {
                    var panelBtns = panel.querySelectorAll('button');
                    for (var b of panelBtns) {
                      if (b.textContent.trim() === btnName) {
                        targetBtn = b;
                        break;
                      }
                    }
                  }
                }
              } else {
                // Default: find first matching button in the drawer
                var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
                if (drawer) {
                  var btns = Array.from(drawer.querySelectorAll('button'));
                  targetBtn = btns.find(function(b) { return b.textContent.trim() === btnName; });
                }
              }

              if (!targetBtn) return;
              var opts = { bubbles: true, cancelable: true, view: window };
              targetBtn.dispatchEvent(new MouseEvent('mousedown', opts));
              targetBtn.dispatchEvent(new MouseEvent('mouseup', opts));
              targetBtn.dispatchEvent(new MouseEvent('click', opts));
            })()
          `);

          // Wait for new row to appear (poll until we detect new input id/placeholder)
          let rowMaxWait = 5000;
          let rowInterval = 100;
          let rowWaited = 0;

          while (rowWaited < rowMaxWait) {
            const newFound = await page.evaluate(`
              (() => {
                let drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
                if (!drawer) return true;
                let beforeInputs = Array.from(drawer.querySelectorAll('input, textarea, .ant-select')).map(function(e) {
                  return e.id || e.placeholder;
                });
                let currentInputs = Array.from(drawer.querySelectorAll('input, textarea, .ant-select')).map(function(e) {
                  return e.id || e.placeholder;
                });
                return currentInputs.some(function(id) {
                  return id && beforeInputs.indexOf(id) === -1;
                });
              })()
            `);
            if (newFound) break;
            await page.wait({ time: rowInterval / 1000 });
            rowWaited += rowInterval;
          }

          // ── FIX: 如果 row 配置了 context mode，先切换到"上下文获取"模式 ──
          // 切换前：属性值是 textbox；切换后：属性值变成 combobox 下拉框
          // 必须通过 params_${ri}_type 定位到当前行（第 ri 行）的 radio group，
          // 而不是全局搜索，否则会点到上一行的 radio group
          if (rowConfig.mode === 'context') {
            const targetRgId = 'params_' + ri + '_type';
            await page.evaluate(`
              (() => {
                var rg = document.getElementById(${JSON.stringify(targetRgId)});
                if (!rg) return;
                var labels = rg.querySelectorAll('label');
                for (var lbl of labels) {
                  if (lbl.textContent.trim() === '上下文获取') {
                    lbl.click();
                    return;
                  }
                }
              })()
            `);
            await page.wait({ time: 0.3 });
          }

          // Fill children in the newly added row
          if (rowConfig.children) {
            for (let ci = 0; ci < rowConfig.children.length; ci++) {
              const child = rowConfig.children[ci];
              await fillChildField(page, child, ri, ci, field.section);
              await page.wait({ time: 0.3 });
            }
          }
        }
      } else {
        // No rows: just click the button once (e.g., "确定", "提交")
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
      }
    }
  }
}

/**
 * Fill a child field within a dynamically added row.
 * Uses placeholder matching since dynamic rows don't have stable IDs.
 * For select/search types in children: opens dropdown then uses polling.
 */
async function fillChildField(page: IPage, child: FieldConfig, rowIndex: number, childIndex: number, parentSection?: string): Promise<void> {
  if (child.type === 'text' || child.type === 'textarea') {
    await page.evaluate(`
      (() => {
        var childName = ${JSON.stringify(child.name)};
        var childValue = ${JSON.stringify(child.value ?? '')};
        var childIdx = ${childIndex};
        var drawer = document.querySelector('.ant-drawer-body, .ant-form, [class*="config-panel"]');
        if (!drawer) return;

        // Find all items matching the label, then pick the childIdx-th one
        var matchedItems = [];
        var items = drawer.querySelectorAll('.ant-form-item');
        for (var item of items) {
          var labelEl = item.querySelector('label');
          var labelText = labelEl ? labelEl.textContent.trim() : '';
          if (labelText === childName) matchedItems.push(item);
        }
        var targetItem = matchedItems[childIdx];
        if (targetItem) {
          var inp = targetItem.querySelector('input, textarea');
          if (inp) {
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) { nativeSetter.call(inp, childValue); }
            else { inp.value = childValue; }
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Fallback: find by id pattern (try multiple prefixes: params_, contexts_, customData_)
        var allEls = drawer.querySelectorAll('[id]');
        var suffixMap = { '属性名': '_name', '属性描述': '_desc', '值类型': '_type', '属性值': '_value' };
        var section = ${JSON.stringify(child.section || parentSection || '')};
        var idPrefix = section === 'output' ? 'contexts_' : 'params_';
        var suffix = suffixMap[childName];
        if (suffix) {
          var prefixes = [idPrefix, 'customData_'];
          var found = false;
          outer: for (var pi = 0; pi < prefixes.length && !found; pi++) {
            var targetId = prefixes[pi] + ${rowIndex} + suffix;
            for (var el of allEls) {
              if (el.id === targetId) {
                var inp2 = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : el.querySelector('input, textarea');
                if (inp2) {
                  var ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                  if (ns) { ns.call(inp2, childValue); }
                  else { inp2.value = childValue; }
                  inp2.dispatchEvent(new Event('input', { bubbles: true }));
                  inp2.dispatchEvent(new Event('change', { bubbles: true }));
                }
                found = true;
                break outer;
              }
            }
          }
        }
      })()
    `);
  }

    else if (child.type === 'select') {
    let childName = child.name;
    let childValue = String(child.value ?? '');

    // 通过稳定的 ID 打开下拉框（rowIndex + childName 映射到 ID）
    // 尝试多个 prefix: params_, contexts_, customData_
    var idMap: Record<string, string> = {
      '值类型': '_type',
      '属性名': '_name',
      '属性描述': '_desc',
      '属性值': '_value',
    };
    var section = child.section || parentSection || '';
    var idPrefix = section === 'output' ? 'contexts_' : 'params_';
    var suffix = idMap[childName] ?? '';
    var prefixes = [idPrefix, 'customData_'];

    var targetId = '';
    var foundId = false;
    for (var pi = 0; pi < prefixes.length; pi++) {
      targetId = prefixes[pi] + rowIndex + suffix;
      var exists = await page.evaluate(
        'document.getElementById("' + targetId + '") !== null'
      );
      if (exists) {
        foundId = true;
        break;
      }
    }
    if (!foundId) return;

    await page.evaluate(`
      (() => {
        var inp = document.getElementById(${JSON.stringify(targetId)});
        if (!inp) return;
        var opts = { bubbles: true, cancelable: true, view: window };
        inp.dispatchEvent(new MouseEvent('mousedown', opts));
        inp.dispatchEvent(new MouseEvent('mouseup', opts));
        inp.dispatchEvent(new MouseEvent('click', opts));
      })
    `);

    // 等待 dropdown 出现后选值
    // 关键修复：通过 listboxId 直接定位到正确行的 dropdown，不做全局搜索
    var targetListboxId = targetId + '_list';

    let childSelectMaxWait = 5000;
    let childSelectInterval = 100;
    let childSelectWaited = 0;
    const targetValue = childValue;

    while (childSelectWaited < childSelectMaxWait) {
      const found = await page.evaluate(`
        (() => {
          var listboxId = ${JSON.stringify(targetListboxId)};
          var targetVal = ${JSON.stringify(targetValue)};
          // 通过 listboxId 直接找到对应 dropdown（不用全局 querySelector）
          var listbox = document.getElementById(listboxId);
          if (!listbox) return false;
          var dropdown = listbox.closest('.ant-select-dropdown');
          if (!dropdown) return false;
          // 检查 dropdown 是否可见
          var r = dropdown.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          var options = dropdown.querySelectorAll('[role="option"], .ant-select-item-option-content, .ant-select-item-option');
          for (var opt of options) {
            if (opt.textContent.trim() === targetVal) {
              var opts2 = { bubbles: true, cancelable: true, view: window };
              opt.dispatchEvent(new MouseEvent('mousedown', opts2));
              opt.dispatchEvent(new MouseEvent('mouseup', opts2));
              opt.dispatchEvent(new MouseEvent('click', opts2));
              return true;
            }
          }
          return false;
        })()
      `);
      if (found) break;
      await page.wait({ time: childSelectInterval / 1000 });
      childSelectWaited += childSelectInterval;
    }
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