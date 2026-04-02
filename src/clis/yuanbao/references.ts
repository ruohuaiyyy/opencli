/**
 * Standalone command: ask Yuanbao and return answer + reference sources as JSON.
 *
 * Fully independent — does not import any existing yuanbao utils.
 * Implements its own: page navigation, input injection, send, response polling,
 * and reference card extraction.
 *
 * Usage:
 *   opencli yuanbao references "大同旅游景点推荐" -f json
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractYuanbaoReferences } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const YUANBAO_CHAT_URL = 'https://yuanbao.tencent.com/chat';

/** Inject text into Yuanbao chat input (React-compatible value setter). */
function fillInputScript(text: string): string {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && el.getBoundingClientRect().width > 0;
      };

      const selectors = [
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="Message"]',
        '.chat-input textarea',
        '[class*="chat-input"] textarea',
        '[class*="input-box"] textarea',
        'textarea[placeholder*="发消息"]',
        '[contenteditable="true"]',
        'textarea',
      ];

      let input = null;
      for (const sel of selectors) {
        const node = Array.from(document.querySelectorAll(sel)).find(isVisible);
        if (node) { input = node; break; }
      }
      if (!input) return { ok: false, error: 'No input found' };

      input.focus();
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const proto = input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.textContent = '';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand('insertText', false, ${JSON.stringify(text)});
      }
      return { ok: true };
    })()
  `;
}

/** Click send button or return 'enter' as fallback. */
function sendScript(): string {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden'
          && el.getBoundingClientRect().width > 0;
      };

      const root = document.querySelector('[class*="chat-input"], [class*="input-box"]') || document.body;
      const buttons = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isVisible);
      const labels = ['发送', 'Send', '发送消息'];

      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        if ([text, aria].some(v => labels.some(l => v.includes(l)))) {
          btn.click();
          return 'button';
        }
      }

      // Fallback: click last visible button
      const styled = [...buttons].reverse().find(b => {
        const cls = b.className || '';
        return cls.includes('send') || cls.includes('primary');
      });
      if (styled) { styled.click(); return 'button'; }

      return 'enter';
    })()
  `;
}

/** Extract the latest AI answer text from the page. */
function getAnswerScript(): string {
  return `
    (() => {
      const clean = (v) => (v || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // Method A: structured extraction - directly get AI answer content
      // 使用精确的 DOM 选择器直接提取 AI 回答
      const contentEl = document.querySelector(
        '.agent-chat__list__deepseek .agent-chat__list__content-wrapper:last-child .agent-chat__list__content'
      );

      if (contentEl) {
        const text = clean(contentEl.innerText || contentEl.textContent || '');
        if (text && text.length > 5) return text;
      }

      // Method B: fallback - try alternative selectors
      const altSelectors = [
        '.agent-chat__list__content-wrapper:last-child .agent-chat__list__content',
        '.agent-dialogue__content .agent-chat__list__content',
        '[class*="chat__list__content"]:last-child',
      ];

      for (const sel of altSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = clean(el.innerText || el.textContent || '');
          if (text && text.length > 5) return text;
        }
      }

      // Method C: last resort - full page extraction with minimal cleanup
      const root = document.body.cloneNode(true);
      [
        '[class*="sidebar"]',
        '[class*="chat-input"]',
        '[class*="input-box"]',
        '[class*="nav"]',
        '[class*="header"]',
        '[class*="reference"]',
      ].forEach(sel => {
        root.querySelectorAll(sel).forEach(n => n.remove());
      });
      root.querySelectorAll('script, style, noscript').forEach(n => n.remove());

      return clean(root.innerText || root.textContent || '');
    })()
  `;
}

/** Check if AI is still generating (streaming indicator). */
function isStreamingScript(): string {
  return `
    (() => {
      // Check for streaming indicators: typing dots, indicator elements
      const indicators = document.querySelectorAll(
        '[class*="loading"]',
        '[class*="typing"]',
        '[class*="streaming"]',
        '[class*="thinking"]',
        '[class*="searching"]',
        '[class*="cursor"]',
        '[class*="blink"]',
        '[class*="pulse"]',
      );
      if (indicators.length > 0) return true;

      // Check for "思考中" or "搜索中" text
      const allText = document.body.innerText || '';
      if (allText.includes('思考中') || allText.includes('搜索中') || allText.includes('正在生成')) {
        return true;
      }

      return false;
    })()
  `;
}

/** Ensure we are on a Yuanbao chat page, navigating or switching tabs if needed. */
async function ensureChatPage(page: IPage): Promise<void> {
  const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
  if (typeof currentUrl === 'string' && currentUrl.includes('yuanbao.tencent.com/chat')) {
    return;
  }

  // Try to switch to an existing yuanbao.tencent.com/chat tab
  const rawTabs = await page.tabs().catch(() => []) as any[];
  if (Array.isArray(rawTabs) && rawTabs.length > 0) {
    const yuanbaoTabs = rawTabs.filter((t) =>
      typeof t?.url === 'string' && t.url.includes('yuanbao.tencent.com/chat')
    );
    if (yuanbaoTabs.length > 0) {
      await page.selectTab(yuanbaoTabs[0].index);
      await page.wait(0.8);
      return;
    }
  }

  await page.goto(YUANBAO_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
}

export const referencesCommand = cli({
  site: 'yuanbao',
  name: 'references',
  description: 'Ask Yuanbao and return the answer with reference sources as JSON',
  domain: 'yuanbao.tencent.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 300,
  args: [
    { name: 'text', required: true, positional: true, help: 'Question to ask Yuanbao' },
    { name: 'timeout', required: false, help: 'Max seconds to wait (default: 300)', default: '300' },
    { name: 'output', required: false, help: 'Save result to file (e.g. my-query.json)' },
  ],
  columns: ['question', 'answer', 'references'],
  func: async (page: IPage, kwargs: any) => {
    const question = kwargs.text as string;
    const timeout = parseInt(kwargs.timeout as string, 10) || 300;

    await ensureChatPage(page);
    await page.wait(1);

    // Snapshot answer before sending
    const answerBefore = await page.evaluate(getAnswerScript()) as string;

    // Inject question into input
    const fillResult = await page.evaluate(fillInputScript(question)) as { ok: boolean; error?: string };
    if (!fillResult?.ok) {
      return [{
        question,
        answer: '',
        references: [],
        error: fillResult?.error || 'Failed to inject question',
      }];
    }
    await page.wait(0.5);

    // Enable internet search to get reference sources
    await page.evaluate(`
      (() => {
        const btn = document.querySelector('.yb-internet-search-btn');
        if (!btn) return false;
        const state = btn.getAttribute('dt-internet-search');
        if (state === 'closeInternetSearch') {
          btn.click();
          return true;
        }
        return state === 'openInternetSearch';
      })()
    `);
    await page.wait(0.5);

    // Send message
    const sendMethod = await page.evaluate(sendScript()) as string;
    if (sendMethod === 'enter') {
      await page.pressKey('Enter');
    }
    await page.wait(1);

    // Poll for response completion
    const pollInterval = 2;
    const maxPolls = Math.max(1, Math.ceil(timeout / pollInterval));
    let answer = '';
    let stableCount = 0;
    let streamingDetected = false;

    for (let i = 0; i < maxPolls; i++) {
      await page.wait(i === 0 ? 1.5 : pollInterval);
      const current = await page.evaluate(getAnswerScript()) as string;

      if (!current || current === answerBefore) continue;

      // Check if AI is still streaming/generating
      const isStreaming = await page.evaluate(isStreamingScript()) as boolean;
      if (isStreaming) {
        streamingDetected = true;
        answer = current;
        stableCount = 0;
        continue;
      }

      if (current === answer) {
        stableCount += 1;
      } else {
        answer = current;
        stableCount = 1;
      }

      // If we detected streaming before, require longer stability (4 checks = 8 seconds)
      const requiredStable = streamingDetected ? 4 : 2;
      if (stableCount >= requiredStable) break;
    }

    // Click "源" button to expand references panel
    await page.wait(1.5);
    await page.evaluate(`
      (() => {
        // Find all "源" buttons in the response area and click the last one (latest response)
        const allTexts = Array.from(document.querySelectorAll('*'));
        const yuanBtns = allTexts.filter(el => {
          if (el.children.length > 0) return false;
          const text = (el.textContent || '').trim();
          return text === '源' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE';
        });
        // Click the last "源" button (most recent response)
        const btn = yuanBtns[yuanBtns.length - 1];
        if (btn) {
          // Find the actual clickable parent
          let clickable = btn;
          for (let i = 0; i < 5 && clickable; i++) {
            if (clickable.onclick || clickable.getAttribute('role') === 'button'
              || clickable.className?.includes('cursor') || clickable.style?.cursor === 'pointer') {
              clickable.click();
              return true;
            }
            clickable = clickable.parentElement;
          }
          // Fallback: just click the element
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    await page.wait(2);

    // Extract reference sources
    const references = await extractYuanbaoReferences(page);

    const result = [{
      question,
      answer: answer || 'No response received within timeout.',
      references,
    }];

    // Save to file
    const outPath = kwargs.output as string | undefined;
    const homeDir = homedir();
    // homedir() may return '~' in some environments; fallback to env var
    const resolvedHome = homeDir === '~'
      ? (process.env.USERPROFILE || process.env.HOME || process.cwd())
      : homeDir;
    const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'yuanbao_output');
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `yuanbao-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    console.error(`💾 Saved to ${filePath}`);

    return result;
  },
});
