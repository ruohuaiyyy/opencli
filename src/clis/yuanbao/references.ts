/**
 * Standalone command: ask Yuanbao and return answer + reference sources as JSON.
 *
 * Supports --reuse to continue the last conversation, --chat-id to resume a specific
 * chat, and --account for multi-account isolation.
 *
 * Usage:
 *   opencli yuanbao references "大同旅游景点推荐" -f json
 *   opencli yuanbao references "问题" --reuse          # 复用上次会话
 *   opencli yuanbao references "问题" --chat-id "naQivTmsDa/xxx"  # 指定会话 ID
 *   opencli yuanbao references "问题" --account work  # 多账号隔离
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractYuanbaoReferences } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  resolveYuanbaoAccount,
  loadYuanbaoLastChatId,
  saveYuanbaoLastChatId,
  clearYuanbaoLastChatId,
  extractYuanbaoChatId,
} from './account-config.js';

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

      const allText = document.body.innerText || '';
      if (allText.includes('思考中') || allText.includes('搜索中') || allText.includes('正在生成')) {
        return true;
      }

      return false;
    })()
  `;
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
    { name: 'reuse', required: false, help: 'Reuse last conversation (default: false)', default: 'false' },
    { name: 'chat-id', required: false, help: 'Specific chat ID to use (overrides --reuse)' },
    { name: 'account', required: false, help: 'Account name for multi-account isolation' },
  ],
  columns: ['question', 'answer', 'references'],
  func: async (page: IPage, kwargs: any) => {
    const question = kwargs.text as string;
    const timeout = parseInt(kwargs.timeout as string, 10) || 300;
    const reuse = kwargs.reuse === 'true' || kwargs.reuse === true;
    const chatId = kwargs['chat-id'] as string | undefined;
    const accountName = (kwargs.account as string | undefined)?.trim() || undefined;

    // Resolve account (creates entry if needed, updates lastUsed) — separate from load/save
    resolveYuanbaoAccount(accountName);

    // Handle reuse: load last chat ID from storage
    if (reuse) {
      const lastChatId = loadYuanbaoLastChatId(accountName);
      if (lastChatId) {
        const targetUrl = `${YUANBAO_CHAT_URL}/${lastChatId}`;
        await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
        await page.wait(5);
        const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
        if (currentUrl?.includes(lastChatId)) {
          console.error(`📌 Reusing last chat: ${lastChatId}`);
        } else {
          clearYuanbaoLastChatId(accountName);
          console.error(`⚠️ Last chat ${lastChatId} not found, cleared cache`);
        }
      } else {
        console.error('ℹ️ No saved chat found, using default flow');
      }
    } else if (chatId) {
      const targetUrl = `${YUANBAO_CHAT_URL}/${chatId}`;
      await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
      await page.wait(5);
      const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
      if (currentUrl?.includes(chatId)) {
        console.error(`📌 Using specified chat: ${chatId}`);
      } else {
        console.error(`⚠️ Chat ${chatId} not found, falling back to chat home`);
      }
    }

    // Fallback: ensure we are on a yuanbao chat page
    const currentUrlFallback = await page.evaluate('window.location.href').catch(() => '') as string;
    if (typeof currentUrlFallback === 'string' && currentUrlFallback.includes('yuanbao.tencent.com/chat')) {
      // Stay on current page
    } else {
      const rawTabs = await page.tabs().catch(() => []) as any[];
      if (Array.isArray(rawTabs) && rawTabs.length > 0) {
        const yuanbaoTabs = rawTabs.filter((t) =>
          typeof t?.url === 'string' && t.url.includes('yuanbao.tencent.com/chat')
        );
        if (yuanbaoTabs.length > 0) {
          await page.selectTab(yuanbaoTabs[0].index);
          await page.wait(0.8);
        } else {
          await page.goto(YUANBAO_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
        }
      } else {
        await page.goto(YUANBAO_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
      }
    }

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

      const requiredStable = streamingDetected ? 4 : 2;
      if (stableCount >= requiredStable) break;
    }

    // Click "源" button to expand references panel
    await page.wait(1.5);
    await page.evaluate(`
      (() => {
        const allTexts = Array.from(document.querySelectorAll('*'));
        const yuanBtns = allTexts.filter(el => {
          if (el.children.length > 0) return false;
          const text = (el.textContent || '').trim();
          return text === '源' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE';
        });
        const btn = yuanBtns[yuanBtns.length - 1];
        if (btn) {
          let clickable = btn;
          for (let i = 0; i < 5 && clickable; i++) {
            if (clickable.onclick || clickable.getAttribute('role') === 'button'
              || clickable.className?.includes('cursor') || clickable.style?.cursor === 'pointer') {
              clickable.click();
              return true;
            }
            clickable = clickable.parentElement;
          }
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
    const resolvedHome = homeDir === '~'
      ? (process.env.USERPROFILE || process.env.HOME || process.cwd())
      : homeDir;
    const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'yuanbao_output');
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `yuanbao-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    console.error(`💾 Saved to ${filePath}`);

    // Save current chat ID for future reuse
    const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
    const id = extractYuanbaoChatId(currentUrl || '');
    if (id) {
      saveYuanbaoLastChatId(id, accountName);
    }

    return result;
  },
});