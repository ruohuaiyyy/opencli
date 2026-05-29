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
    { name: 'action', required: false, help: '保存动作', choices: ['draft', 'grayscale'], default: 'draft' },
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
    const action = String(kwargs.action ?? 'draft').trim();

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
    const bizLineSelected = await page.evaluate(`
      () => {
        const target = ${JSON.stringify(businessLine)};

        // Click to open dropdown
        const selects = document.querySelectorAll('.ant-select');
        let bizSelect = null;
        for (const s of selects) {
          if (s.textContent.includes('请选择') || s.textContent.includes('业务线')) {
            if (s.offsetParent !== null) {
              bizSelect = s;
              break;
            }
          }
        }
        if (!bizSelect) return { ok: false, error: '找不到业务线下拉框' };
        bizSelect.click();
        return { ok: true };
      }
    `);
    if (!bizLineSelected.ok) {
      throw new Error(bizLineSelected.error || '业务线选择失败');
    }
    await page.wait({ time: 1 });

    // Select the business line option — the dropdown renders via React portal
    // so we need to search the full document for the text node and click its parent
    await page.wait({ time: 0.5 });
    const bizLineChosen = await page.evaluate(`
      () => {
        const target = ${JSON.stringify(businessLine)};

        // Strategy 1: search for leaf text nodes matching the target
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.trim() === target) {
            const parent = node.parentElement;
            if (parent && parent.offsetParent !== null) {
              // Find the closest clickable ancestor
              let clickable = parent;
              for (let i = 0; i < 5; i++) {
                if (!clickable || clickable === document.body) break;
                const role = clickable.getAttribute('role') || '';
                const cls = clickable.className || '';
                if (role.includes('option') || cls.includes(' ant-select-item') || cls.includes('-item-option')) {
                  clickable.click();
                  return { ok: true, value: target };
                }
                clickable = clickable.parentElement;
              }
              // Fallback: click the text element itself
              parent.click();
              return { ok: true, value: target };
            }
          }
        }

        // Strategy 2: look for elements with aria-label matching the target
        const byLabel = document.querySelector('[aria-label="' + target + '"], [title="' + target + '"]');
        if (byLabel && byLabel.offsetParent !== null) {
          byLabel.click();
          return { ok: true, value: target };
        }

        return { ok: false, error: '找不到业务线选项: ' + target + '，请确认业务线名称是否正确' };
      }
    `);
    if (!bizLineChosen.ok) {
      throw new Error(bizLineChosen.error || '业务线选择失败');
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
      // Open frequency dropdown
      await page.evaluate(`
        () => {
          const selects = document.querySelectorAll('.ant-select');
          for (const s of selects) {
            if (s.textContent.includes('期间仅一次') || s.textContent.includes('频次')) {
              s.click();
              return true;
            }
          }
          return false;
        }
      `);
      await page.wait({ time: 1 });
      // Select the desired frequency option using TreeWalker
      await page.evaluate(`
        () => {
          const target = ${JSON.stringify(frequency)};
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent.trim() === target) {
              const parent = node.parentElement;
              if (parent && parent.offsetParent !== null) {
                parent.click();
                return true;
              }
            }
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

    // ── Step 11: Save ──────────────────────────────────────────────────────
    const saveBtnText = action === 'grayscale' ? '保存并灰度' : '保存草稿';
    const saved = await page.evaluate(`
      () => {
        const target = ${JSON.stringify(saveBtnText)};
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.textContent || btn.innerText || '').trim();
          if (text === target && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { ok: true };
          }
        }
        return { ok: false, error: '找不到${saveBtnText}按钮' };
      }
    `);
    if (!saved.ok) {
      throw new Error(saved.error || '保存失败');
    }

    // ── Step 12: Wait and verify ───────────────────────────────────────────
    await page.wait({ time: 3 });

    // Check for success/error messages
    const result = await page.evaluate(`
      () => {
        const text = document.body.innerText || '';

        // Check common success/error indicators
        if (text.includes('保存成功') || text.includes('成功') || text.includes('success')) {
          return { status: '✅ 保存成功' };
        }
        if (text.includes('失败') || text.includes('error') || text.includes('异常')) {
          return { status: '❌ 保存失败，请在浏览器中查看详细信息' };
        }
        return { status: '⚠️ 操作完成，请在浏览器中确认' };
      }
    `);

    return [
      {
        status: result.status,
        detail: [
          `业务线: ${businessLine}`,
          `code: ${code}`,
          `名称: ${name}`,
          desc ? `描述: ${desc}` : '',
          `时间: ${startDate} ~ ${endDate}`,
          action === 'grayscale' ? '已保存为灰度' : '已保存为草稿',
        ]
          .filter(Boolean)
          .join(' | '),
      },
    ];
  },
});

/**
 * Set a date picker field. Opens the calendar, sets the date via JS.
 */
async function setDatePicker(
  page: IPage,
  labelKeyword: string,
  dateStr: string,
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(`
    (() => {
      const label = ${JSON.stringify(labelKeyword)};
      const dateStr = ${JSON.stringify(dateStr)};

      // Find the date input by looking for label "开始" or "结束"
      const dateInputs = document.querySelectorAll('input[placeholder*="日期"], input[readonly]');
      for (const input of dateInputs) {
        const prev = input.previousElementSibling;
        const parent = input.parentElement?.parentElement;

        let labelText = '';
        if (prev && prev.textContent) labelText = prev.textContent;
        if (parent && parent.textContent && parent.textContent.includes(label)) {
          labelText = parent.textContent;
        }

        if (labelText.includes(label) && input.offsetParent !== null) {
          // Open date picker by clicking
          input.click();
          return { ok: true };
        }
      }

      // Fallback: set value directly on the input
      const allInputs = document.querySelectorAll('input[type="text"], input[type=""]');
      for (const input of allInputs) {
        const placeholder = (input.getAttribute('placeholder') || '').trim();
        if (placeholder.includes('日期') && input.offsetParent !== null) {
          const parent = input.closest('div[class*="form-item"], div[style*="margin"]');
          if (parent && parent.textContent.includes(label)) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(input, dateStr);
            } else {
              input.value = dateStr;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            return { ok: true };
          }
        }
      }

      return { ok: false, error: '找不到' + label + '时间输入框' };
    })()
  `);
}
