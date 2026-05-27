/**
 * Toutiao forward — browser UI automation for forwarding articles to Toutiao.
 *
 * Flow:
 *   1. Navigate to article page
 *   2. Hover on share button (left sidebar) to open dropdown
 *   3. Click "转发到头条" in the menu
 *   4. Wait for forward modal (.ttp-modal)
 *   5. Fill forward content (optional)
 *   6. Click "确定" button to submit
 *
 * Requires: logged into www.toutiao.com in Chrome.
 *
 * Usage:
 *   opencli toutiao forward --url "https://www.toutiao.com/article/xxx" --content "转发内容"
 *   opencli toutiao forward --url "https://www.toutiao.com/article/xxx"
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

cli({
  site: 'toutiao',
  name: 'forward',
  description: '自动转发今日头条文章到头条',
  domain: 'www.toutiao.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'url', required: true, help: '文章链接' },
    { name: 'content', required: false, help: '转发内容（可选）' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const articleUrl = String(kwargs.url ?? '').trim();
    const content = String(kwargs.content ?? '').trim();
    if (!articleUrl) throw new Error('文章链接不能为空');

    // Step 1: Navigate to article
    await page.goto(articleUrl);
    await page.wait({ time: 3 });

    // Steps 2-4: All in one evaluate to avoid timing issues
    const forwardResult = await page.evaluate(`
      () => {
        return new Promise((resolve) => {
          // 2. Find share button in left sidebar
          const shareBtn = document.querySelector('.share-btn');
          if (!shareBtn || !shareBtn.offsetParent) {
            resolve({ ok: false, detail: '未找到分享按钮' });
            return;
          }

          // 3. Hover to show dropdown menu
          const sRect = shareBtn.getBoundingClientRect();
          const sx = sRect.left + sRect.width / 2;
          const sy = sRect.top + sRect.height / 2;
          shareBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx, clientY: sy }));
          shareBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          shareBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

          // 4. Wait for menu to render, then find and click "转发到头条"
          setTimeout(() => {
            const shareTools = document.querySelector('ul.share-tools');
            if (!shareTools || !shareTools.offsetParent) {
              resolve({ ok: false, detail: '分享菜单未出现' });
              return;
            }

            // Find "转发到头条" option
            const liItems = Array.from(shareTools.querySelectorAll('li'));
            let target = null;
            for (const el of liItems) {
              const text = (el.innerText || '').trim();
              if (text === '转发到头条' && el.offsetParent) {
                target = el;
                break;
              }
            }

            if (!target) {
              resolve({ ok: false, detail: '未找到"转发到头条"选项' });
              return;
            }

            // Click the target with full event dispatch
            const tRect = target.getBoundingClientRect();
            const x = tRect.left + tRect.width / 2;
            const y = tRect.top + tRect.height / 2;
            const topEl = document.elementFromPoint(x, y);

            const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
            ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(name => {
              const Ctor = name.startsWith('pointer') ? PointerEvent : MouseEvent;
              target.dispatchEvent(new Ctor(name, opts));
              if (topEl && topEl !== target) {
                topEl.dispatchEvent(new Ctor(name, opts));
              }
            });
            target.click();

            // 5. Wait for forward modal to appear - check multiple times
            let checks = 0;
            const checkModal = () => {
              checks++;
              const modal = document.querySelector('.ttp-modal') || document.querySelector('.ttp-modal-wrapper.ttp-wtt-repost-modal');
              
              if (!modal) {
                if (checks < 10) {
                  setTimeout(checkModal, 500);
                } else {
                  resolve({ ok: false, detail: '转发弹窗未出现' });
                }
                return;
              }
              
              // Modal exists - it's there!
              resolve({ ok: true });
            };
            setTimeout(checkModal, 500);

          }, 1000); // Wait 1s for menu to render
        });
      }
    `);

    if (!forwardResult.ok) {
      return [{ status: '失败', detail: forwardResult.detail }];
    }

    // Step 5: Fill forward content (if provided) or wait for modal to be ready
    if (content) {
      // Wait a bit for modal to fully render
      await page.wait({ time: 1 });
      
      const contentFilled = await page.evaluate(`
        () => {
          const text = ${JSON.stringify(content)};

          // Try multiple selectors for the input area
          const selectors = [
            '.ttp-modal-wrapper.ttp-wtt-repost-modal textarea',
            '.publish-area textarea',
            '[class*="publish"] textarea',
            '.ttp-modal textarea',
            '.forward-modal textarea',
            '[class*="forward"] textarea',
            'textarea[placeholder*="转发"]',
            'textarea[placeholder*="分享"]',
            'textarea',
          ];
          
          let textarea = null;
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent) {
              textarea = el;
              break;
            }
          }
          
          if (!textarea) {
            // Try to find any editable area in the forward modal
            const fwdModal = document.querySelector('.ttp-modal-wrapper.ttp-wtt-repost-modal') || document.querySelector('.ttp-modal');
            if (fwdModal) {
              const editable = fwdModal.querySelector('[contenteditable="true"]');
              if (editable) {
                textarea = editable;
              }
            }
          }

          if (!textarea) return { ok: false, detail: '未找到输入框' };

          textarea.click();
          textarea.focus();

          // Handle both textarea and contenteditable
          if (textarea instanceof HTMLTextAreaElement || textarea instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(textarea.constructor.prototype, 'value')?.set;
            if (setter) {
              setter.call(textarea, text);
            } else {
              textarea.value = text;
            }
          } else if (textarea.contentEditable === 'true') {
            textarea.innerText = text;
          }

          ['input', 'change'].forEach(t => {
            textarea.dispatchEvent(new Event(t, { bubbles: true }));
          });

          return { ok: true };
        }
      `);

      if (!contentFilled.ok) {
        return [{ status: '失败', detail: contentFilled.detail }];
      }

      await page.wait({ time: 0.5 });
    }

    // Step 6: Find and click "确定" button (submit-btn)
    const confirmResult = await page.evaluate(`
      () => {
        const modal = document.querySelector('.ttp-modal-wrapper.ttp-wtt-repost-modal');
        if (!modal) return { ok: false, detail: '转发弹窗已消失' };

        // The confirm button is: .publish-action > button.submit-btn
        let confirmBtn = document.querySelector('.ttp-modal-wrapper.ttp-wtt-repost-modal .publish-action .submit-btn');
        
        if (!confirmBtn) {
          confirmBtn = document.querySelector('button.submit-btn');
        }

        if (!confirmBtn) {
          const allButtons = Array.from(document.querySelectorAll('button'));
          for (const btn of allButtons) {
            const text = (btn.innerText || '').trim();
            if (text === '确定') {
              confirmBtn = btn;
              break;
            }
          }
        }

        if (!confirmBtn) {
          return { ok: false, detail: '未找到确定按钮' };
        }

        const rect = confirmBtn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        confirmBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        confirmBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        confirmBtn.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        confirmBtn.click();

        return { ok: true };
      }
    `);

    if (!confirmResult.ok) {
      return [{ status: '失败', detail: confirmResult.detail }];
    }

    // Wait for submission to complete
    await page.wait({ time: 2 });

    // Verify: Check for success indicators
    const finalStatus = await page.evaluate(`
      () => {
        const allText = document.body.innerText;
        if (allText.includes('转发成功') || allText.includes('分享成功')) {
          return { status: '成功', detail: '转发已发送成功' };
        }

        const modal = document.querySelector('.ttp-modal-wrapper.ttp-wtt-repost-modal') || document.querySelector('.ttp-modal');
        if (!modal || modal.offsetParent === null) {
          return { status: '成功', detail: '转发弹窗已关闭，疑似成功' };
        }

        return null;
      }
    `);

    if (finalStatus) {
      return [{ status: finalStatus.status, detail: finalStatus.detail }];
    }

    return [{
      status: '⚠️ 疑似失败',
      detail: '按钮已点击，但未检测到转发成功的反馈。请手动确认是否已转发。'
    }];
  },
});
