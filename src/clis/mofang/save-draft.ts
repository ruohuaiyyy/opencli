/**
 * Mofang save-draft — click the "保存草稿" button on the current
 * create/edit event page.
 *
 * Typically used after `opencli mofang create-event` fills the form.
 *
 * Usage:
 *   opencli mofang save-draft
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

cli({
  site: 'mofang',
  name: 'save-draft',
  description: '魔方平台保存当前活动为草稿',
  domain: 'mofang.beta.qunar.com',
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ['status', 'detail'],
  func: async (page: IPage | null) => {
    if (!page) throw new Error('Browser page required');

    const result = await page.evaluate(`
      () => {
        const text = document.body.innerText || '';
        if (!text.includes('编辑活动') && !text.includes('保存草稿')) {
          return {
            ok: false,
            error: '当前页面未找到活动编辑表单，请先运行 opencli mofang create-event',
          };
        }

        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const btnText = (btn.textContent || btn.innerText || '').trim();
          if (btnText === '保存草稿' && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { ok: true };
          }
        }
        return { ok: false, error: '找不到保存草稿按钮' };
      }
    `);

    if (!result.ok) {
      throw new Error(result.error || '保存失败');
    }

    await page.wait({ time: 3 });

    return [
      {
        status: '✅ 草稿已保存',
        detail: '请确认浏览器中无报错提示',
      },
    ];
  },
});
