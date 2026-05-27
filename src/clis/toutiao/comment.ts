/**
 * Toutiao comment — browser UI automation for commenting on articles.
 *
 * Flow:
 *   1. Navigate to article page
 *   2. Click comment bubble icon (left side) to open panel (right side)
 *   3. Fill comment content in the input box (placeholder: "说点什么吧")
 *   4. Click submit button (activates after input)
 *
 * Requires: logged into www.toutiao.com in Chrome.
 *
 * Usage:
 *   opencli toutiao comment --url "https://www.toutiao.com/article/xxx" --content "评论内容"
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

cli({
  site: 'toutiao',
  name: 'comment',
  description: '自动评论今日头条文章',
  domain: 'www.toutiao.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'url', required: true, help: '文章链接' },
    { name: 'content', required: true, help: '评论内容' },
    { name: 'wait-for-panel', type: 'number', default: '1500', help: '等待评论面板出现的毫秒数' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const articleUrl = String(kwargs.url ?? '').trim();
    const content = String(kwargs.content ?? '').trim();
    const waitTime = Number(kwargs['wait-for-panel'] ?? 1500);

    if (!articleUrl) throw new Error('文章链接不能为空');
    if (!content) throw new Error('评论内容不能为空');

    // Step 1: Navigate to article
    await page.goto(articleUrl);
    await page.wait({ time: 3 });

    // Step 2: Click the comment bubble icon on the left side
    // Strategy: Look for elements related to comments. 
    // Since we don't have the exact class, we use a broad search for comment-related UI elements.
    const entryClicked = await page.evaluate(`
      () => {
        // 1. Try specific selectors first
        const specificSelectors = [
          'div[class*="comment-btn"]',
          'div[class*="comment-icon"]',
          'div[class*="comment-float"]',
          '[aria-label*="评论"]',
          '[title*="评论"]',
          '.article-comment-float' 
        ];
        
        for (const sel of specificSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el && el.offsetParent !== null && el.clientWidth > 0) {
              const rect = el.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const target = document.elementFromPoint(x, y);
              if (target) {
                target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
                target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
                target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
                return true;
              }
            }
          }
        }

        // 2. Fallback: Look for any visible element on the left side that looks like a bubble button
        const allEls = Array.from(document.querySelectorAll('div, span, button'));
        for (const el of allEls) {
          if (el.offsetParent === null) continue;
          const rect = el.getBoundingClientRect();
          // Left side of screen, reasonable button size
          if (rect.left < window.innerWidth * 0.2 && 
              rect.width > 20 && rect.width < 100 && 
              rect.height > 20 && rect.height < 100) {
            
            // Check for text or aria content containing "comment" or the icon shape
            const textContent = (el.textContent || '').trim();
            const ariaLabel = el.getAttribute('aria-label') || '';
            
            // Simple heuristic: if it's a small clickable area on the left, try clicking it.
            // To avoid clicking navigation links, we prioritize elements that are likely buttons or icons.
            if (ariaLabel.includes('评论') || textContent.includes('评论')) {
               el.click();
               return true;
            }
            // As a broad fallback, we could click the first suitable element, 
            // but that's risky. Let's stick to text/aria matching or common icon patterns.
          }
        }

        return false;
      }
    `);

    if (!entryClicked) {
      return [{ status: '失败', detail: '未找到评论入口图标' }];
    }

    // Wait for the panel to slide out and poll for input readiness
    // Use a loop to handle slow loading of the comment panel
    let contentFilled = false;
    let inputError = '未找到输入框';

    for (let i = 0; i < 6; i++) {
      await page.wait({ time: 0.5 });

      const result = await page.evaluate(`
        () => {
          const text = ${JSON.stringify(content)};

          let target = null;

          // Priority 1: Search by placeholder text "说点什么"
          const byPlaceholder = document.querySelector('textarea[placeholder*="说点什么"], input[placeholder*="说点什么"]');
          if (byPlaceholder && byPlaceholder.offsetParent !== null && byPlaceholder.clientWidth > 0) {
            target = byPlaceholder;
          } else {
            // Priority 2: Locate by position (Comment panel on the right side)
            // Search for textarea or contenteditable on the right half of the screen
            const candidates = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]'));
            for (const el of candidates) {
              if (el.offsetParent === null) continue;
              const rect = el.getBoundingClientRect();
              // Check if it's on the right half of the screen
              if (rect.left > window.innerWidth * 0.5 && rect.width > 50) {
                target = el;
                break;
              }
            }
          }

          if (!target) return { ok: false, msg: 'No input element visible' };

          // Interact
          target.click();
          target.focus();

          // Set Value Logic
          if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(
              target.constructor.prototype, 'value')?.set;
            if (setter) {
              setter.call(target, text);
            } else {
              target.value = text;
            }
          } else {
            target.innerText = text;
          }

          // Dispatch events
          ['input', 'change', 'keydown', 'keyup'].forEach(t => {
            target.dispatchEvent(new Event(t, { bubbles: true }));
          });

          return { ok: true };
        }
      `);

      if (result.ok) {
        contentFilled = true;
        break;
      }
      inputError = result.msg || inputError;
    }

    if (!contentFilled) {
      return [{ status: '失败', detail: `无法输入评论内容 (${inputError})` }];
    }

    // Allow UI to react to input (un-grey the button) - wait 1s explicitly
    await page.wait({ time: 1 });

    // Step 4: Click the submit button
    const submitClicked = await page.evaluate(`
      () => {
        const findSubmitBtn = () => {
          // Strategy 1: Look by class name (submit-btn but NOT disabled)
          const classSelectors = [
            'button.submit-btn:not(.disable)',
            'button[class*="submit"]:not([disabled]):not(.disable)',
            'button[class*="SendBtn"]',
            'button[class*="comment-btn"]',
          ];
          for (const sel of classSelectors) {
            const els = Array.from(document.querySelectorAll(sel));
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              if (el.offsetParent && rect.left > window.innerWidth * 0.5 && rect.width > 20) {
                return el;
              }
            }
          }

          // Strategy 2: Look by button text (评论/发送/发布) - must NOT have disable class
          const allButtons = Array.from(document.querySelectorAll('button'));
          for (const el of allButtons) {
            const rect = el.getBoundingClientRect();
            if (!el.offsetParent || rect.left < window.innerWidth * 0.5 || rect.width < 20) continue;
            if (el.classList.contains('disable') || el.hasAttribute('disabled')) continue;
            
            const text = ((el.innerText || el.textContent) || '').trim();
            if (text === '评论' || text === '发送' || text === '发布') {
              return el;
            }
          }

          return null;
        };

        const btn = findSubmitBtn();
        
        if (!btn) return { ok: false, detail: '未找到可点击的评论按钮' };
        if (btn.classList.contains('disable') || btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') {
          return { ok: false, detail: '按钮处于禁用状态，可能评论内容格式不符' };
        }

        const rect = btn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        // Simulate click using pointer events
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        
        // Fallback native click
        btn.click(); 

        return { ok: true, detail: 'Success' };
      }
    `);

    if (!submitClicked.ok) {
      return [{ status: '失败', detail: submitClicked.detail || '未知错误' }];
    }

    // Wait for network request/result
    await page.wait({ time: 2 });

    // Verify: Check if comment was actually sent
    // Since the panel may close or reset after submission, check multiple indicators
    const finalStatus = await page.evaluate(`
      () => {
        const content = ${JSON.stringify(content)};
        
        // Check 1: Look for success toast/message anywhere on page
        const allText = document.body.innerText;
        if (allText.includes('评论成功') || allText.includes('发布成功')) {
          return { status: '成功', detail: '评论已发送成功' };
        }
        
        // Check 2: Look for the content in the comment list (our comment appeared)
        const allElements = Array.from(document.querySelectorAll('*'));
        const commentInList = allElements.find(el => {
          const text = (el.innerText || '').trim();
          return text === content && el.children.length === 0;
        });
        if (commentInList) {
          return { status: '成功', detail: '评论已出现在评论列表中' };
        }
        
        // Check 3: Input cleared (panel may have reset)
        const textAreas = Array.from(document.querySelectorAll('textarea'));
        const mainInput = textAreas.find(ta => ta.getBoundingClientRect().left > window.innerWidth * 0.5);
        if (mainInput && mainInput.value === '') {
          return { status: '成功', detail: '评论疑似发送成功（输入框已清空）' };
        }
        
        // Check 4: Submit button back to disabled state (indicates submission attempted)
        const submitBtn = Array.from(document.querySelectorAll('button.submit-btn'))
                              .find(el => el.offsetParent && el.getBoundingClientRect().left > window.innerWidth * 0.5);
        if (submitBtn && (submitBtn.classList.contains('disable') || submitBtn.hasAttribute('disabled'))) {
          return { status: '成功', detail: '评论按钮已恢复禁用状态，疑似发送成功' };
        }
        
        return null;
      }
    `);

    if (finalStatus) {
      return [{ status: finalStatus.status, detail: finalStatus.detail }];
    }

    return [{
      status: '⚠️ 疑似失败',
      detail: '按钮已点击，但未检测到发送成功的反馈。请手动确认是否已发送。'
    }];
  },
});
