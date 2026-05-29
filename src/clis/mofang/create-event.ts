/**
 * Mofang (魔方) create-event — browser UI automation for creating
 * real-time marketing events on the Mofang platform.
 *
 * Flow:
 *   1. Navigate to create event page
 *   2. Select business line (业务线)
 *   3. Fill event code, name, description
 *   4. Set start/end dates
 *   5. Set optional fields (owner, frequency, grayscale users)
 *   6. Save as draft or save + grayscale
 *
 * Requires: logged into mofang.beta.qunar.com in Chrome.
 *
 * Usage:
 *   opencli mofang create-event --business-line 机票 --code test_event --name "测试活动" --start 2026-06-01 --end 2027-06-01
 *   opencli mofang create-event --business-line 公共 --code my_event --name "我的活动" --desc "活动描述" --start 2026-07-01 --end 2027-07-01 --grayscale zhenjie.liu
 *   opencli mofang create-event --business-line 机票 --code test_v1 --name "测试" --start 2026-06-01 --end 2027-06-01 --action draft
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const CREATE_URL = 'https://mofang.beta.qunar.com/rock/page/34274?type=create&from=list';

cli({
  site: 'mofang',
  name: 'create-event',
  description: '魔方平台新建实时营销活动',
  domain: 'mofang.beta.qunar.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'business-line', required: true, help: '业务线 (如: 机票, 酒店, 公共 等)' },
    { name: 'code', required: true, help: '活动唯一标识，建议仅字母和下划线' },
    { name: 'name', required: true, help: '活动名称' },
    { name: 'desc', required: false, help: '活动描述' },
    { name: 'start', required: true, help: '开始时间 (YYYY-MM-DD 格式)' },
    { name: 'end', required: true, help: '结束时间 (YYYY-MM-DD 格式)' },
    { name: 'owner', required: false, help: '负责人' },
    { name: 'frequency', required: false, help: '频次控制', default: '活动期间仅一次' },
    { name: 'grayscale', required: false, help: '灰度用户(测试用)，多个用逗号分隔' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const businessLine = String(kwargs['business-line'] ?? '').trim();
    const code = String(kwargs.code ?? '').trim();
    const name = String(kwargs.name ?? '').trim();
    const desc = kwargs.desc ? String(kwargs.desc).trim() : '';
    const startDate = String(kwargs.start ?? '').trim();
    const endDate = String(kwargs.end ?? '').trim();
    const owner = kwargs.owner ? String(kwargs.owner).trim() : '';
    const frequency = String(kwargs.frequency ?? '活动期间仅一次').trim();
    const grayscale = kwargs.grayscale ? String(kwargs.grayscale).trim() : '';

    // Validate inputs
    if (!businessLine) throw new Error('--business-line 不能为空');
    if (!code) throw new Error('--code 不能为空');
    if (!/^[a-zA-Z0-9_]+$/.test(code)) throw new Error('--code 仅支持字母、数字和下划线');
    if (!name) throw new Error('--name 不能为空');
    if (!startDate || !endDate) throw new Error('--start 和 --end 必须设置');

    // ── Step 1: Navigate to create page ─────────────────────────────────────
    await page.goto(CREATE_URL);
    await page.wait({ time: 5 });

    // Verify we're on the right page
    const pageUrl: string = await page.evaluate('() => location.href');
    if (!pageUrl.includes('type=create')) {
      throw new Error('页面跳转异常，可能未登录或权限不足。当前URL: ' + pageUrl);
    }

    // ── Step 2: Select business line (业务线) ───────────────────────────────
    // Ant Design Select listens to mousedown (not click), so we must dispatch
    // MouseEvent('mousedown') rather than calling .click().
    await page.wait({ time: 1.5 });

    // Step A: open the dropdown via mousedown on .ant-select-selector
    await page.evaluate(`
      () => {
        const firstSelect = document.querySelector('.ant-select');
        if (!firstSelect) throw new Error('找不到业务线下拉框');
        const selector = firstSelect.querySelector('.ant-select-selector');
        if (!selector) throw new Error('找不到选择器');
        const opts = { bubbles: true, cancelable: true, view: window };
        selector.dispatchEvent(new MouseEvent('mousedown', opts));
        selector.dispatchEvent(new MouseEvent('mouseup',   opts));
        selector.dispatchEvent(new MouseEvent('click',     opts));
      }
    `);

    // Step B: wait for React portal to render
    await page.wait({ time: 2 });

    // Step C: find visible option by text and click it (also via mousedown)
    const bizClickResult = await page.evaluate(`
      () => {
        const target = ${JSON.stringify(businessLine)};
        const allElements = document.querySelectorAll('*');
        for (let i = allElements.length - 1; i >= 0; i--) {
          const el = allElements[i];
          const text = (el.textContent || '').trim();
          if (!text || text.indexOf(target) === -1) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('mouseup',   opts));
          el.dispatchEvent(new MouseEvent('click',     opts));
          return { ok: true, value: target };
        }
        return { ok: false, error: '找不到业务线选项: ' + target };
      }
    `);
    if (!bizClickResult.ok) {
      throw new Error(bizClickResult.error || '业务线选择失败');
    }

    await page.wait({ time: 1 });

    // ── Step 3: Fill event code ─────────────────────────────────────────────
    const codeFilled = await page.evaluate(`
      () => {
        const inputs = document.querySelectorAll('input[type="text"], input[type=""], input:not([type])');
        for (const input of inputs) {
          const placeholder = (input.getAttribute('placeholder') || '').trim();
          if (
            placeholder.includes('标识') ||
            placeholder.includes('唯一') ||
            placeholder.includes('code') ||
            (input.previousElementSibling && input.previousElementSibling.textContent.includes('活动code'))
          ) {
            if (input.offsetParent !== null) {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set;
              if (nativeSetter) {
                nativeSetter.call(input, ${JSON.stringify(code)});
              } else {
                input.value = ${JSON.stringify(code)};
              }
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }
          }
        }
        return { ok: false, error: '找不到活动code输入框' };
      }
    `);
    if (!codeFilled.ok) {
      throw new Error(codeFilled.error || '活动code填写失败');
    }
    await page.wait({ time: 0.5 });

    // ── Step 4: Fill event name ─────────────────────────────────────────────
    const nameFilled = await page.evaluate(`
      () => {
        const inputs = document.querySelectorAll('input[type="text"], input[type=""], input:not([type])');
        for (const input of inputs) {
          const placeholder = (input.getAttribute('placeholder') || '').trim();
          const label = input.previousElementSibling?.textContent || '';
          if (
            placeholder.includes('自定义') ||
            placeholder.includes('名称') ||
            label.includes('活动名称')
          ) {
            if (input.offsetParent !== null) {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set;
              if (nativeSetter) {
                nativeSetter.call(input, ${JSON.stringify(name)});
              } else {
                input.value = ${JSON.stringify(name)};
              }
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }
          }
        }
        return { ok: false, error: '找不到活动名称输入框' };
      }
    `);
    if (!nameFilled.ok) {
      throw new Error(nameFilled.error || '活动名称填写失败');
    }
    await page.wait({ time: 0.5 });

    // ── Step 5: Fill description (optional) ─────────────────────────────────
    if (desc) {
      await page.evaluate(`
        () => {
          const textareas = document.querySelectorAll('textarea');
          for (const ta of textareas) {
            const placeholder = (ta.getAttribute('placeholder') || '').trim();
            if (placeholder.includes('请输入') && ta.offsetParent !== null) {
              // Check if this is the description textarea (has larger height)
              const rect = ta.getBoundingClientRect();
              if (rect.height > 50) {
                ta.value = ${JSON.stringify(desc)};
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }
          return false;
        }
      `);
      await page.wait({ time: 0.5 });
    }

    // ── Step 6: Set start date ──────────────────────────────────────────────
    const startDateSet = await setDatePicker(page, '开始', startDate);
    if (!startDateSet.ok) {
      throw new Error(startDateSet.error || '开始时间设置失败');
    }
    await page.wait({ time: 1 });

    // ── Step 7: Set end date ────────────────────────────────────────────────
    const endDateSet = await setDatePicker(page, '结束', endDate);
    if (!endDateSet.ok) {
      throw new Error(endDateSet.error || '结束时间设置失败');
    }
    await page.wait({ time: 1 });

    // ── Step 8: Fill owner (optional) ──────────────────────────────────────
    if (owner) {
      await page.evaluate(`
        () => {
          const inputs = document.querySelectorAll('input[type="text"], input[type=""], input:not([type])');
          for (const input of inputs) {
            const label = input.previousElementSibling?.textContent || '';
            if (label.includes('负责人') && input.offsetParent !== null) {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set;
              if (nativeSetter) {
                nativeSetter.call(input, ${JSON.stringify(owner)});
              } else {
                input.value = ${JSON.stringify(owner)};
              }
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }
      `);
      await page.wait({ time: 0.5 });
    }

    // ── Step 9: Set frequency control (optional, has default) ───────────────
    if (frequency && frequency !== '活动期间仅一次') {
      // Step A: open the frequency dropdown via mousedown
      await page.evaluate(`
        () => {
          const selects = document.querySelectorAll('.ant-select');
          for (const s of selects) {
            if (s.textContent.includes('期间仅一次') || s.textContent.includes('频次')) {
              const selector = s.querySelector('.ant-select-selector');
              if (!selector) return false;
              const opts = { bubbles: true, cancelable: true, view: window };
              selector.dispatchEvent(new MouseEvent('mousedown', opts));
              selector.dispatchEvent(new MouseEvent('mouseup',   opts));
              selector.dispatchEvent(new MouseEvent('click',     opts));
              return true;
            }
          }
          return false;
        }
      `);

      // Step B: wait for the portal to render
      await page.wait({ time: 2 });

      // Step C: find visible option by text and click it (also via mousedown)
      await page.evaluate(`
        () => {
          const target = ${JSON.stringify(frequency)};
          const allElements = document.querySelectorAll('*');
          for (let i = allElements.length - 1; i >= 0; i--) {
            const el = allElements[i];
            const text = (el.textContent || '').trim();
            if (!text || text.indexOf(target) === -1) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup',   opts));
            el.dispatchEvent(new MouseEvent('click',     opts));
            return true;
          }
          return false;
        }
      `);
      await page.wait({ time: 1 });
    }

    // ── Step 10: Fill grayscale users (optional) ───────────────────────────
    if (grayscale) {
      await page.evaluate(`
        () => {
          const textareas = document.querySelectorAll('textarea');
          for (const ta of textareas) {
            const placeholder = (ta.getAttribute('placeholder') || '').trim();
            if (placeholder.includes('username') && ta.offsetParent !== null) {
              ta.value = ${JSON.stringify(grayscale)};
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }
      `);
      await page.wait({ time: 0.5 });
    }

    return [
      {
        status: '✅ 表单已填写，请执行以下命令保存',
        detail: [
          `opencli mofang save-draft`,
          `opencli mofang save-grayscale`,
        ].join('\n'),
      },
    ];
  },
});

/**
 * Set a date picker field by typing the datetime string and clicking OK.
 * The input accepts format like "2026-05-29 05:06:06".
 */
async function setDatePicker(
  page: IPage,
  labelKeyword: string,
  dateStr: string,
): Promise<{ ok: boolean; error?: string }> {
  // Step 1: focus the input, set value, and dispatch events
  const setResult = await page.evaluate(`
    (() => {
      const label = ${JSON.stringify(labelKeyword)};
      const dateStr = ${JSON.stringify(dateStr)};

      // Strategy: find input by id (beginDate/endDate) or by label proximity
      let input = null;

      // 1) Try id directly
      if (label === '开始') {
        input = document.getElementById('beginDate');
      } else if (label === '结束') {
        input = document.getElementById('endDate');
      }

      // 2) Fallback: find by placeholder and label text
      if (!input) {
        const allInputs = document.querySelectorAll('input[placeholder*="日期"]');
        for (const el of allInputs) {
          const wrapper = el.closest('div');
          const labelEl = wrapper?.previousElementSibling || wrapper?.parentElement?.querySelector('label, span, div');
          const labelText = (labelEl?.textContent || '').trim();
          if (labelText.includes(label) && el.offsetParent !== null) {
            input = el;
            break;
          }
        }
      }

      if (!input) {
        return { ok: false, error: '找不到' + label + '时间输入框' };
      }

      // Focus the input to open the picker dropdown
      const opts = { bubbles: true, cancelable: true, view: window };
      input.dispatchEvent(new MouseEvent('mousedown', opts));
      input.dispatchEvent(new MouseEvent('mouseup', opts));
      input.dispatchEvent(new MouseEvent('click', opts));

      // Set the value directly
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(input, dateStr);
      } else {
        input.value = dateStr;
      }

      // Dispatch input/change events so React picks up the new value
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));

      return { ok: true };
    })()
  `);

  if (!setResult.ok) {
    return setResult;
  }

  // Step 2: wait for the picker dropdown to render, then click OK
  await page.wait({ time: 1.5 });

  const clickOkResult = await page.evaluate(`
    (() => {
      const dropdowns = document.querySelectorAll('.ant-picker-dropdown');
      if (dropdowns.length === 0) {
        return { ok: true }; // dropdown already closed, nothing to do
      }
      // Click the OK button on all visible dropdowns
      for (const dropdown of dropdowns) {
        const okBtn = dropdown.querySelector('.ant-picker-ok button');
        if (okBtn) {
          const opts = { bubbles: true, cancelable: true, view: window };
          okBtn.dispatchEvent(new MouseEvent('mousedown', opts));
          okBtn.dispatchEvent(new MouseEvent('mouseup', opts));
          okBtn.dispatchEvent(new MouseEvent('click', opts));
        }
      }
      return { ok: true };
    })()
  `);

  return clickOkResult;
}
