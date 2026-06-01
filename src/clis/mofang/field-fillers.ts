/**
 * Mofang (魔方) field fillers — type-based form field filling strategies.
 *
 * Each function performs BOTH find and fill inside page.evaluate()
 * to avoid passing DOM elements across the CDP boundary.
 *
 * IMPORTANT: All arguments must be primitives (strings, booleans) that can be
 * serialized into the JavaScript string passed to page.evaluate().
 */

import type { IPage } from '../../types.js';

/**
 * Fill a text or textarea field by id.
 */
export async function fillText(
  page: IPage,
  fieldId: string,
  value: string,
): Promise<void> {
  const valueJson = JSON.stringify(value);

  await page.evaluate(`
    (function() {
      var inp = document.getElementById(${JSON.stringify(fieldId)});
      if (!inp) return;
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(inp, ${valueJson});
      } else {
        inp.value = ${valueJson};
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
    })()
  `);
}

/**
 * Fill an Ant Design Select dropdown by: open selector → find option by text → click.
 */
export async function fillSelect(
  page: IPage,
  fieldId: string,
  value: string,
): Promise<void> {
  const fieldIdJson = JSON.stringify(fieldId);
  const valueJson = JSON.stringify(value);

  // Open dropdown
  await page.evaluate(`
    (function() {
      var sel = document.getElementById(${fieldIdJson});
      if (!sel) sel = document.querySelector('[id="${fieldIdJson}"]');
      if (!sel) {
        // Try finding by .ant-select within form-item that has this id
        var wrapper = document.querySelector('.ant-form-item[id="${fieldIdJson}"]');
        if (wrapper) sel = wrapper.querySelector('.ant-select');
      }
      if (!sel) {
        // Fallback: find by label id association
        var label = document.querySelector('label[for="${fieldIdJson}"]');
        if (label) {
          var formItem = label.closest('.ant-form-item');
          if (formItem) sel = formItem.querySelector('.ant-select');
        }
      }
      if (!sel) sel = document.querySelector('.ant-select-selector');
      if (!sel) return;
      var opts = { bubbles: true, cancelable: true, view: window };
      sel.dispatchEvent(new MouseEvent('mousedown', opts));
      sel.dispatchEvent(new MouseEvent('mouseup', opts));
      sel.dispatchEvent(new MouseEvent('click', opts));
    })()
  `);

  await page.wait({ time: 1.5 });

  // Click matching option
  const clicked = await page.evaluate(`
    (function() {
      var target = ${valueJson};
      var all = document.querySelectorAll('.ant-select-dropdown *');
      for (var i = all.length - 1; i >= 0; i--) {
        var el = all[i];
        var text = (el.textContent || '').trim();
        if (!text || text !== target) continue;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        var opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
      }
      return false;
    })()
  `);

  if (!clicked) {
    console.warn('[mofang/add-node] select option not found: ' + valueJson);
  }
}

/**
 * Fill a search select by: open → type search → click match.
 */
export async function fillSearch(
  page: IPage,
  fieldId: string,
  value: string,
): Promise<void> {
  const valueJson = JSON.stringify(value);

  // Open dropdown
  await page.evaluate(`
    (function() {
      var sel = document.querySelector('.ant-select-selector');
      if (!sel) return;
      var opts = { bubbles: true, cancelable: true, view: window };
      sel.dispatchEvent(new MouseEvent('mousedown', opts));
      sel.dispatchEvent(new MouseEvent('click', opts));
    })()
  `);

  await page.wait({ time: 1 });

  // Type search keyword
  await page.evaluate(`
    (function() {
      var inp = document.querySelector('.ant-select-selection-search-input');
      if (!inp) return;
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(inp, ${valueJson});
      } else {
        inp.value = ${valueJson};
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);

  await page.wait({ time: 1 });

  // Click matching option
  const clicked = await page.evaluate(`
    (function() {
      var target = ${valueJson};
      var all = document.querySelectorAll('.ant-select-dropdown *');
      for (var i = all.length - 1; i >= 0; i--) {
        var el = all[i];
        var text = (el.textContent || '').trim();
        if (text === target) {
          var opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          return true;
        }
      }
      return false;
    })()
  `);

  if (!clicked) {
    console.warn('[mofang/add-node] search option not found: ' + valueJson);
  }
}

/**
 * Click a button by text content within the drawer.
 */
export async function fillClick(
  page: IPage,
  fieldName: string,
): Promise<void> {
  const nameJson = JSON.stringify(fieldName);

  await page.evaluate(`
    (function() {
      var target = ${nameJson};
      var allBtns = document.querySelectorAll('button');
      for (var i = 0; i < allBtns.length; i++) {
        var btn = allBtns[i];
        if (btn.textContent.trim() === target) {
          var opts = { bubbles: true, cancelable: true, view: window };
          btn.dispatchEvent(new MouseEvent('mousedown', opts));
          btn.dispatchEvent(new MouseEvent('mouseup', opts));
          btn.dispatchEvent(new MouseEvent('click', opts));
          return true;
        }
      }
      return false;
    })()
  `);
}

/**
 * Toggle an Ant Design switch by field id.
 */
export async function fillSwitch(
  page: IPage,
  fieldId: string,
  value: boolean,
): Promise<void> {
  const fieldIdJson = JSON.stringify(fieldId);
  const valueJson = JSON.stringify(value);

  await page.evaluate(`
    (function() {
      var sw = document.getElementById(${fieldIdJson});
      if (!sw) sw = document.querySelector('.ant-switch[id="${fieldIdJson}"]');
      if (!sw) {
        // Try finding by label association
        var label = document.querySelector('label[for="${fieldIdJson}"]');
        if (label) {
          var formItem = label.closest('.ant-form-item');
          if (formItem) sw = formItem.querySelector('.ant-switch');
        }
      }
      if (!sw) sw = document.querySelector('.ant-switch');
      if (!sw) return;
      var expected = ${valueJson};
      var isChecked = sw.classList.contains('ant-switch-checked');
      if (isChecked !== expected) {
        var opts = { bubbles: true, cancelable: true, view: window };
        sw.dispatchEvent(new MouseEvent('mousedown', opts));
        sw.dispatchEvent(new MouseEvent('mouseup', opts));
        sw.dispatchEvent(new MouseEvent('click', opts));
      }
    })()
  `);
}

/**
 * Fill a date picker input and click OK by field id.
 */
export async function fillDate(
  page: IPage,
  fieldId: string,
  value: string,
): Promise<void> {
  const fieldIdJson = JSON.stringify(fieldId);
  const valueJson = JSON.stringify(value);

  // Open picker
  await page.evaluate(`
    (function() {
      var inp = document.getElementById(${fieldIdJson});
      if (!inp) {
        var label = document.querySelector('label[for="${fieldIdJson}"]');
        if (label) {
          var formItem = label.closest('.ant-form-item');
          if (formItem) inp = formItem.querySelector('input');
        }
      }
      if (!inp) return;
      var opts = { bubbles: true, cancelable: true, view: window };
      inp.dispatchEvent(new MouseEvent('mousedown', opts));
      inp.dispatchEvent(new MouseEvent('click', opts));
    })()
  `);

  await page.wait({ time: 1 });

  // Set value
  await page.evaluate(`
    (function() {
      var inp = document.getElementById(${fieldIdJson});
      if (!inp) {
        var label = document.querySelector('label[for="${fieldIdJson}"]');
        if (label) {
          var formItem = label.closest('.ant-form-item');
          if (formItem) inp = formItem.querySelector('input');
        }
      }
      if (!inp) return;
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(inp, ${valueJson});
      } else {
        inp.value = ${valueJson};
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);

  await page.wait({ time: 1 });

  // Click OK
  await page.evaluate(`
    (function() {
      var okBtn = document.querySelector('.ant-picker-ok button');
      if (okBtn) {
        var opts = { bubbles: true, cancelable: true, view: window };
        okBtn.dispatchEvent(new MouseEvent('mousedown', opts));
        okBtn.dispatchEvent(new MouseEvent('click', opts));
      }
    })()
  `);
}

/**
 * Find a form field element id by name + type within a form container.
 * Returns the element id string for use in fill functions.
 *
 * Matching priority:
 *   1. input#id == name
 *   2. label title/textContent includes name → return the input id from that form-item
 *   3. button textContent == name (click type only)
 */
export function findFieldId(
  form: Element,
  name: string,
  type: string,
): string | null {
  // click 类型：找 button by textContent — return button text as id
  if (type === 'click') {
    const btn = Array.from(form.querySelectorAll('button'))
      .find(b => b.textContent.trim() === name);
    return btn ? btn.textContent.trim() : null;
  }

  // 1) label 匹配：遍历 .ant-form-item，找 label 包含 name
  const formItems = Array.from(form.querySelectorAll('.ant-form-item'));
  const matchedItem = formItems.find(item => {
    const label = item.querySelector('.ant-form-item-label label') as HTMLElement | null;
    return label?.title?.includes(name) || label?.textContent?.includes(name);
  });

  if (matchedItem) {
    if (type === 'select' || type === 'search') {
      // Return the id of the .ant-select inside the matched item
      const selectEl = matchedItem.querySelector('.ant-select');
      return selectEl?.id || null;
    }
    if (type === 'switch') {
      const switchEl = matchedItem.querySelector('.ant-switch');
      return switchEl?.id || null;
    }
    // text, textarea, date
    const input = matchedItem.querySelector('input, textarea');
    return input?.id || null;
  }

  // 2) input id 匹配
  const byId = form.querySelector(`#${name}`);
  if (byId) return byId.id || null;

  // 3) input name 匹配
  const byName = form.querySelector(`[name="${name}"]`);
  return byName?.id || null;
}
