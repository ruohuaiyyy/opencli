/**
 * Standalone command: ask DeepSeek and return answer + reference sources as JSON.
 *
 * Supports --reuse to continue the last conversation, --chat-id to resume a specific
 * chat, and --account for multi-account isolation.
 *
 * Usage:
 *   opencli deepseek references "大同旅游景点推荐" -f json
 *   opencli deepseek references "问题" --reuse          # 复用上次会话
 *   opencli deepseek references "问题" --chat-id xxx    # 指定会话 ID
 *   opencli deepseek references "问题" --account work  # 多账号隔离
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractNewDeepseekReferences, snapshotExistingRefUrls, type DeepseekReference } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDeepseekChatPage, enableDeepseekInternetSearch } from './utils.js';
import {
  resolveDeepseekAccount,
  loadDeepseekLastChatId,
  saveDeepseekLastChatId,
  clearDeepseekLastChatId,
  extractDeepseekChatId,
} from './account-config.js';

const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com';

/** Ensure we are on a DeepSeek chat page, with optional chat reuse. */
async function ensureChatPage(
  page: IPage,
  options: { reuse?: boolean; chatId?: string } = {}
): Promise<void> {
  const { reuse = false, chatId } = options;

  // If specific chat ID provided, navigate directly to it
  if (chatId) {
    const targetUrl = `https://chat.deepseek.com/a/chat/s/${chatId}`;
    await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
    await page.wait(5);
    const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
    if (currentUrl?.includes(chatId)) {
      console.error(`📌 Using specified chat: ${chatId}`);
      return;
    }
    console.error(`⚠️ Chat ${chatId} not found, falling back to chat home`);
  }

  // If reuse requested, try to load last chat ID
  if (reuse) {
    console.error('ℹ️ No saved chat found, using default flow');
  }

  // Fallback: use existing behavior (reuse tab or go to chat home)
  await ensureDeepseekChatPage(page);
}

/** Inject text into DeepSeek chat input (React-compatible value setter). */
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
        'textarea[placeholder*="发送消息"]',
        'textarea[placeholder*="Message"]',
        '.chat-input textarea',
        '[class*="chat-input"] textarea',
        '[class*="input-box"] textarea',
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

      // Find the LAST "N个网页" or "已阅读 N 个网页" element (most recent AI response)
      const refButtons = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = (el.textContent || '').trim();
        return text.match(/^\\d+\\s*个网页$/) || text.includes('已阅读');
      });

      if (refButtons.length > 0) {
        const lastRefBtn = refButtons[refButtons.length - 1];

        // DOM structure (confirmed via Playwright):
        //   p3 (DIV, response wrapper)
        //     └─ p2 (DIV, AI response area, 3 children)
        //         ├─ [0]: user message header
        //         ├─ [1]: AI response content (paragraphs, headings, tables, lists)
        //         └─ [2]: p1 (ref button container with "N个网页")
        const p1 = lastRefBtn.parentElement;
        const p2 = p1 ? p1.parentElement : null;

        if (p2 && p2.children.length >= 2) {
          const texts = [];
          // Extract from all children EXCEPT the last one (ref button container)
          for (let i = 0; i < p2.children.length - 1; i++) {
            const child = p2.children[i];
            const contentEls = child.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, strong, td');
            contentEls.forEach(el => {
              const text = clean(el.innerText || el.textContent || '');
              if (text && text.length > 2) {
                // Skip UI noise
                if (text.includes('开启新对话') || text.includes('内容由 AI 生成') ||
                    text.includes('深度思考') || text.includes('智能搜索') ||
                    text.includes('193******')) return;
                // Skip reference number patterns like "- 10"
                if (/^[-\\s]*\\d+\\s*$/.test(text)) return;
                texts.push(text);
              }
            });
          }

          if (texts.length > 0) {
            return clean(texts.join('\\n'));
          }
        }
      }

      // Fallback: full body with sidebar removal
      const root = document.body.cloneNode(true);
      root.querySelectorAll('[class*="sidebar"]').forEach(n => n.remove());
      root.querySelectorAll('script, style, noscript').forEach(n => n.remove());
      return clean(root.innerText || root.textContent || '');
    })()
  `;
}

/** Check if the "Stop" button is present (AI is still streaming). */
function isStreamingScript(): string {
  return `
    (() => {
      // Strategy 1: Check for "Stop" / "停止" button (appears during streaming)
      const buttons = Array.from(document.querySelectorAll('button'));
      const hasStopButton = buttons.some(b => {
        const text = (b.textContent || '').trim();
        return text.includes('停止') || text.includes('Stop');
      });
      if (hasStopButton) return true;

      // Strategy 2: Check for streaming CSS indicators
      const indicators = document.querySelectorAll(
        '[class*="loading"]',
        '[class*="typing"]',
        '[class*="streaming"]',
        '[class*="thinking"]',
        '[class*="searching"]',
        '[class*="cursor"]',
        '[class*="blink"]',
        '[class*="pulse"]',
        '[class*="animate"]',
        '[class*="wave"]',
      );
      if (indicators.length > 0) return true;

      // Strategy 3: Check for streaming text indicators
      const allText = document.body.innerText || '';
      if (allText.includes('思考中') || allText.includes('搜索中') || allText.includes('正在生成')) {
        return true;
      }

      return false;
    })()
  `;
}

/** Get the full page text excluding sidebar and input area. Used for completion detection. */
function getPageContentLengthScript(): string {
  return `
    (() => {
      const root = document.body.cloneNode(true);
      root.querySelectorAll('[class*="sidebar"], [class*="nav"]').forEach(n => n.remove());
      root.querySelectorAll('script, style, noscript').forEach(n => n.remove());
      return (root.innerText || root.textContent || '').length;
    })()
  `;
}

/** Check if the "Stop" button is present in the input area. */
function hasStopButtonScript(): string {
  return `
    (() => {
      const textarea = document.querySelector('textarea[placeholder*="发送消息"], textarea[placeholder*="Message"]');
      if (!textarea) return false;
      const container = textarea.closest('[class*="chat-input"], [class*="input-box"]')
        || textarea.parentElement;
      if (!container) return false;
      const btns = container.querySelectorAll('button');
      return Array.from(btns).some(b => {
        const text = (b.textContent || '').trim();
        return text.includes('停止') || text.includes('Stop');
      });
    })()
  `;
}

export const referencesCommand = cli({
  site: 'deepseek',
  name: 'references',
  description: 'Ask DeepSeek and return the answer with reference sources as JSON',
  domain: 'chat.deepseek.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 300,
  args: [
    { name: 'text', required: true, positional: true, help: 'Question to ask DeepSeek' },
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
    resolveDeepseekAccount(accountName);

// Handle reuse: load last chat ID from storage
    if (reuse) {
      const lastChatId = loadDeepseekLastChatId(accountName);
      if (lastChatId) {
        const targetUrl = `https://chat.deepseek.com/a/chat/s/${lastChatId}`;
        await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
        await page.wait(5);
        const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
        if (currentUrl?.includes(lastChatId)) {
          console.error(`📌 Reusing last chat: ${lastChatId}`);
        } else {
          clearDeepseekLastChatId(accountName);
          console.error(`⚠️ Last chat ${lastChatId} not found, cleared cache`);
          await ensureDeepseekChatPage(page);
        }
      } else {
        console.error('ℹ️ No saved chat found, using default flow');
        await ensureDeepseekChatPage(page);
      }
    } else if (chatId) {
      const targetUrl = `https://chat.deepseek.com/a/chat/s/${chatId}`;
      await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
      await page.wait(5);
      const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
      if (currentUrl?.includes(chatId)) {
        console.error(`📌 Using specified chat: ${chatId}`);
      } else {
        console.error(`⚠️ Chat ${chatId} not found, falling back to chat home`);
        await ensureDeepseekChatPage(page);
      }
    } else {
      await ensureDeepseekChatPage(page);
    }
    await page.wait(1);

    // Snapshot answer before sending
    const answerBefore = await page.evaluate(getAnswerScript()) as string;
    const beforeRefUrls = await snapshotExistingRefUrls(page);

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
    await enableDeepseekInternetSearch(page);
    await page.wait(0.5);

    // Send message
    const sendMethod = await page.evaluate(sendScript()) as string;
    if (sendMethod === 'enter') {
      await page.pressKey('Enter');
    }
    await page.wait(1);

    // Poll for response completion using content length growth detection.
    // After sending, the total page content length increases as AI streams.
    // When length stops growing for N consecutive checks → AI is done.
    const pollInterval = 2;
    const maxPolls = Math.max(1, Math.ceil(timeout / pollInterval));
    let answer = '';
    let stableCount = 0;
    let previousLength = 0;
    let contentStartedGrowing = false;

    // Get baseline page content length
    const baselineLength = await page.evaluate(getPageContentLengthScript()) as number;

    for (let i = 0; i < maxPolls; i++) {
      await page.wait(i === 0 ? 1.5 : pollInterval);

      // Get current page content length
      const currentLength = await page.evaluate(getPageContentLengthScript()) as number;

      // Check if content has started growing (AI is responding)
      if (currentLength > baselineLength + 100) {
        contentStartedGrowing = true;
      }

      if (!contentStartedGrowing) continue;

      if (currentLength > previousLength) {
        // Content is still growing — AI is streaming
        previousLength = currentLength;
        stableCount = 0;
        continue;
      }

      // Content length didn't change — check stability
      stableCount += 1;

      // Require 5 consecutive stable checks (10 seconds) before declaring done
      if (stableCount >= 5) {
        // Final answer extraction
        answer = await page.evaluate(getAnswerScript()) as string;
        await page.wait(1);
        break;
      }
    }

    // Extract references (no click needed — DeepSeek embeds references inline in the response)
    await page.wait(1);
    const references = await extractNewDeepseekReferences(page, beforeRefUrls);

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
    const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'deepseek_output');
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `deepseek-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    console.error(`💾 Saved to ${filePath}`);

    // Save current chat ID for future reuse
    const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
    const id = extractDeepseekChatId(currentUrl || '');
    if (id) {
      saveDeepseekLastChatId(id, accountName);
    }

    return result;
  },
});
