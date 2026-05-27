/**
 * Standalone command: ask Doubao and return answer + reference sources as JSON.
 *
 * Fully independent — does not import any existing doubao utils.
 * Implements its own: page navigation, input injection, send, response polling,
 * and reference card extraction.
 *
 * Usage:
 *   opencli doubao references "大同旅游景点推荐" -f json
 *   opencli doubao references "问题" --reuse          # 复用上次会话
 *   opencli doubao references "问题" --chat-id xxx   # 指定会话 ID
 *   opencli doubao references --content-file ./question.txt  # 从文件读取问题
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractDoubaoReferences, extractDoubaoKeywords, checkReferenceButton } from './extract-references.js';
import {
  resolveDoubaoAccount,
  loadDoubaoLastChatId,
  saveDoubaoLastChatId,
  clearDoubaoLastChatId,
} from './account-config.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat';

/** Extract chat ID from URL if present. */
function extractChatId(url: string): string | null {
  const match = url.match(/\/chat\/([A-Za-z0-9_-]+)$/);
  return match?.[1] || null;
}

/** Inject text into Doubao chat input (React-compatible value setter). */
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
        'textarea[data-testid="chat_input_input"]',
        '.chat-input textarea',
        'textarea[placeholder*="发消息"]',
        'textarea[placeholder*="Message"]',
        'textarea',
        '[contenteditable="true"]',
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

      const root = document.querySelector('[data-testid="chat_input"], .chat-input') || document.body;
      const buttons = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isVisible);
      const labels = ['发送', 'Send', '发消息'];

      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        if ([text, aria].some(v => labels.some(l => v.includes(l)))) {
          btn.click();
          return 'button';
        }
      }

      const styled = [...buttons].reverse().find(b => {
        const cls = b.className || '';
        return cls.includes('bg-dbx-text-highlight')
          || cls.includes('bg-dbx-fill-highlight')
          || cls.includes('text-dbx-text-static-white-primary');
      });
      if (styled) { styled.click(); return 'button'; }

      return 'enter';
    })()
  `;
}

/** Extract the latest AI answer text from the page.
 *  NEW DOM structure (2026-05): Answer is in .flex.flex-col.gap-2.w-full header container
 *  No more .flow-markdown-body, .search-item-transition-FAa3Ce, [data-testid*="receive_message"]
 */
function getAnswerScript(): string {
  return `
    (() => {
      const clean = (v) => (v || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // ===== NEW: Header container approach (2026-05) =====

      // Step 1: Find the header container with .flex.flex-col.gap-2.w-full
      // This contains the answer text and reference counts like "搜索 N 个关键词，参考 M 篇资料"
      const headerContainer = document.querySelector('.flex.flex-col.gap-2.w-full');
      if (headerContainer) {
        // Get all text content minus the reference count line
        const fullText = clean(headerContainer.innerText);
        // Remove the "搜索 N 个关键词，参考 M 篇资料" line if present (it's metadata, not answer)
        const answerText = fullText
          .replace(/搜索\\s*\\d+\\s*个关键词，?/g, '')
          .replace(/参考\\s*\\d+\s*篇资料，?/g, '')
          .trim();
        if (answerText.length >= 10) {
          return answerText;
        }
        // If only reference line, try body as fallback below
        if (answerText.length > 0 && answerText.length < 10) {
          // Use body fallback below
        } else if (answerText.length >= 10) {
          return answerText;
        }
      }

      // Step 2: Fallback - scan all [data-message-id] divs for the latest AI response
      // AI messages have text content, user messages may be empty or just their question
      const messages = document.querySelectorAll('[data-message-id]');
      if (messages.length > 0) {
        // Iterate from the end (latest) backwards to find a message with substantive content
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const text = clean(msg.innerText);
          // Skip if only reference metadata or too short
          if (text.length < 10) continue;
          if (/^搜索\\s*\\d+\\s*个关键词/.test(text)) continue;
          if (text === '参考 N 篇资料' || /^参考\\s*\\d+\\s*篇资料$/.test(text)) continue;
          // Found substantive answer
          return text;
        }
      }

      // Step 3: Legacy fallback - clone body, strip nav/aside/sidebar/chat-input
      const root = document.body.cloneNode(true);
      [
        'nav, aside',
        '[data-testid*="sidebar"]',
        '[data-testid*="navigation"]',
        '[data-testid="flow_chat_sidebar"]',
        '[data-testid="chat_input"]',
        '[data-testid="flow_chat_guidance_page"]',
        '[class*="sidebar"]',
        '[class*="left-side"]',
        '[class*="flow_chat_sidebar"]',
        '[class*="chat-input"]',
        '[class*="guidance"]',
      ].forEach(sel => {
        try { root.querySelectorAll(sel).forEach(n => n.remove()); } catch(e) {}
      });
      root.querySelectorAll('script, style, noscript').forEach(n => n.remove());

      const text = clean(root.innerText || root.textContent || '')
        .replace(/新对话/g, '\\n')
        .replace(/内容由豆包 AI 生成/g, '\\n')
        .replace(/在此处拖放文件/g, '\\n')
        .replace(/文件数量：[^\\n]*/g, '')
        .replace(/文件类型：[^\\n]*/g, '');

      const stopPatterns = [
        /^豆包$/,
        /^新对话$/,
        /^历史对话/,
        /^手机版对话/,
        /^快速$/,
        /^超能模式/,
        /^Beta$/,
        /^PPT 生成/,
        /^图像生成/,
        /^帮我写作/,
        /^AI 创作$/,
        /^搜索\\s*\\d+\\s*个关键词/,
        /^参考\\s*\\d+\\s*篇资料$/,
      ];

      const lines = text.split('\\n')
        .map(l => clean(l))
        .filter(l => l && l.length <= 400 && !stopPatterns.some(p => p.test(l)));

      const tail = lines.slice(-30).join('\\n');
      return tail || clean(root.innerText || root.textContent || '');
    })()
  `;
}

/** Inject script to override Chrome's background tab throttling. */
function injectVisibilityOverride(): string {
  return `
    (() => {
      Object.defineProperty(document, 'hidden', {
        get: function() { return false; },
        configurable: true
      });
      Object.defineProperty(document, 'visibilityState', {
        get: function() { return 'visible'; },
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    })()
  `;
}

/** Check if AI is still generating (streaming indicator).
 *  NEW indicators (2026-05): No more [data-testid="indicator"]
 *  Use text-based detection and class patterns.
 */
function isStreamingScript(): string {
  return `
    (() => {
      // Check for streaming indicators: typing dots, indicator elements, or class patterns
      const indicators = document.querySelectorAll(
        '[data-show-indicator="true"]',
        '[class*="loading"]',
        '[class*="typing"]',
        '[class*="streaming"]',
        '[class*="thinking"]',
        '[class*="searching"]',
      );
      if (indicators.length > 0) return true;

      // Check for "深度思考中" or "搜索中" text
      const allText = document.body.innerText || '';
      if (allText.includes('深度思考中') || allText.includes('搜索中') || allText.includes('正在搜索')) {
        return true;
      }

      // NEW (2026-05): Check for "正在思考" or "思考中" (new labels)
      if (allText.includes('正在思考') || allText.includes('思考中')) {
        return true;
      }

      return false;
    })()
  `;
}

/** Simple string hash for content stability detection. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/** Ensure we are on a Doubao chat page, with optional chat reuse. */
async function ensureChatPage(
  page: IPage,
  options: { reuse?: boolean; chatId?: string; account?: string } = {}
): Promise<void> {
  const { reuse = false, chatId, account } = options;

  // If specific chat ID provided, navigate directly to it
  if (chatId) {
    const targetUrl = `https://www.doubao.com/chat/${chatId}`;
    await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
    await page.wait(5); // Wait for SPA hydration + CDP stabilization
    const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
    if (currentUrl?.includes(chatId)) {
      console.error(`📌 Using specified chat: ${chatId}`);
      return;
    }
    // If navigation failed (invalid chat ID), fall through to normal flow
    console.error(`⚠️ Chat ${chatId} not found (may be deleted), falling back to chat home`);
  }

  // If reuse requested, try to load last chat ID (account-aware)
  if (reuse) {
    const lastChatId = loadDoubaoLastChatId(account);
    if (lastChatId) {
      const targetUrl = `https://www.doubao.com/chat/${lastChatId}`;
      await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
      await page.wait(5); // Wait for SPA hydration + CDP stabilization
      const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
      if (currentUrl?.includes(lastChatId)) {
        console.error(`📌 Reusing last chat: ${lastChatId} (account: ${account ?? 'legacy'})`);
        return;
      }
      // Chat no longer exists - clear saved ID and fall back
      clearDoubaoLastChatId(account);
      console.error(`⚠️ Last chat ${lastChatId} not found (may be deleted), cleared cache and falling back`);
    } else {
      console.error('ℹ️ No saved chat found, using default flow');
    }
  }

  // Check if already on a chat page (prefer specific chat over home)
  const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
  if (typeof currentUrl === 'string' && currentUrl.includes('doubao.com/chat')) {
    // If already on a specific chat page, stay here
    if (extractChatId(currentUrl)) {
      return;
    }
    // On chat home, will try to switch to a specific chat below
  }

  // Try to switch to an existing doubao.com/chat tab (prefer specific chats)
  const rawTabs = await page.tabs().catch(() => []) as any[];
  if (Array.isArray(rawTabs) && rawTabs.length > 0) {
    const doubaoTabs = rawTabs
      .filter((t) => typeof t?.url === 'string' && t.url.includes('doubao.com/chat'))
      .sort((a, b) => {
        // Score tabs: specific chat > chat home, active > inactive
        const score = (t: any) => {
          let value = t.index || 0;
          if (/https:\/\/www\.doubao\.com\/chat\/[A-Za-z0-9_-]+$/.test(t.url)) value += 1000;
          else if (t.url.startsWith(DOUBAO_CHAT_URL)) value += 100;
          if (t.active) value += 25;
          return value;
        };
        return score(b) - score(a);
      });

    if (doubaoTabs.length > 0) {
      await page.selectTab(doubaoTabs[0].index);
      await page.wait(0.8);
      // Wait for CDP session to fully stabilize after tab switch (prevents Detached errors)
      await page.wait(2);
      return;
    }
  }

  // Fallback: navigate to chat home
  await page.goto(DOUBAO_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
  // Wait 5s for Doubao's React SPA to fully hydrate and CDP session to stabilize.
  // Without this, subsequent page.evaluate() calls (including safeEval retries) can
  // throw "Detached while handling command" on first cold-open because the CDP attach
  // is still settling while React is rendering.
  await page.wait(5);
}

/**
 * Clear all chat content from the current Doubao conversation.
 *
 * Deletion flow (5 steps):
 *   1. Hover over the last AI message to reveal action buttons (critical!)
 *   2. Click three-dot "more" button (SVG path contains "M5 10.5")
 *   3. Click "删除" menuitem in dropdown
 *   4. Selection mode: click "删除" → confirm dialog: click "删除"
 */
async function clearChatContent(page: IPage): Promise<boolean> {
  try {
    // Step 0: Hover over the last AI message to reveal hidden action buttons
    // This is critical - the three-dot button is only visible on hover
    const hovered = await page.evaluate(`
      (() => {
        const msgs = document.querySelectorAll('[data-message-id]');
        if (msgs.length === 0) return false;

        const lastMsg = msgs[msgs.length - 1];
        const rect = lastMsg.getBoundingClientRect();

        // Scroll the message into view first
        lastMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Create hover events
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height - 20;

        const mouseEnter = new MouseEvent('mouseenter', { bubbles: true, clientX: centerX, clientY: centerY });
        const mouseOver = new MouseEvent('mouseover', { bubbles: true, clientX: centerX, clientY: centerY });

        lastMsg.dispatchEvent(mouseEnter);
        lastMsg.dispatchEvent(mouseOver);

        return true;
      })()
    `) as boolean;

    if (!hovered) {
      return false;
    }

    // Small wait for buttons to appear after hover
    await page.wait(0.5);

    // Step 1: Find and click the "more" (three dots) button
    // Use position-based detection: find buttons near the bottom of message
    const moreClicked = await page.evaluate(`
      (() => {
        const msgs = document.querySelectorAll('[data-message-id]');
        if (msgs.length === 0) return false;

        const lastMsg = msgs[msgs.length - 1];
        const msgRect = lastMsg.getBoundingClientRect();

        // Find all visible buttons and look for three-dot button near message
        const buttons = document.querySelectorAll('button');

        for (const btn of buttons) {
          const rect = btn.getBoundingClientRect();
          // Button should be small (20-40px) and near message bottom
          if (rect.width >= 20 && rect.width <= 40 && rect.height >= 20 && rect.height <= 40) {
            // Check if button is positioned near message bottom
            if (Math.abs(rect.top - (msgRect.top + msgRect.height - 50)) < 80) {
              // Check for three-dot SVG path
              const path = btn.querySelector('svg path');
              if (path && path.getAttribute('d')?.includes('M5 10.5')) {
                btn.click();
                return true;
              }
            }
          }
        }

        // Fallback: try XPath anyway
        const xpath = document.evaluate(
          '//button[.//svg//path[contains(@d, "M5 10.5")]]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        const moreBtn = xpath.singleNodeValue;
        if (moreBtn) {
          moreBtn.click();
          return true;
        }

        return false;
      })()
    `) as boolean;

    if (!moreClicked) {
      return false;
    }

    // Wait for dropdown
    await page.wait(1);

    // Step 2: Click "删除" menuitem
    const deleteClicked = await page.evaluate(`
      (() => {
        // Try role="menuitem" first
        let xpath = document.evaluate(
          '//*[contains(text(), "删除") and @role="menuitem"]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        let delItem = xpath.singleNodeValue;
        if (delItem) {
          delItem.click();
          return true;
        }

        // Fallback: any element with 删除 text that's clickable
        xpath = document.evaluate(
          '//*[contains(text(), "删除")]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        delItem = xpath.singleNodeValue;
        if (delItem) {
          delItem.click();
          return true;
        }

        return false;
      })()
    `) as boolean;

    if (!deleteClicked) {
      return false;
    }

    // Wait for selection mode
    await page.wait(0.8);

    // Step 3: Click 删除 button in selection toolbar
    const selDelClicked = await page.evaluate(`
      (() => {
        const xpath = document.evaluate(
          '//button[contains(text(), "删除")]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        const delBtn = xpath.singleNodeValue;
        if (delBtn) {
          delBtn.click();
          return true;
        }
        return false;
      })()
    `) as boolean;

    if (!selDelClicked) {
      // Selection mode might not appear if only one message
      return true;
    }

    // Wait for confirm dialog
    await page.wait(0.5);

    // Step 4: Confirm deletion
    const confirmed = await page.evaluate(`
      (() => {
        const xpath = document.evaluate(
          '//*[contains(text(), "删除") and (@role="button" or @role="confirm")]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        const confirmBtn = xpath.singleNodeValue;
        if (confirmBtn) {
          confirmBtn.click();
          return true;
        }
        return false;
      })()
    `) as boolean;

    if (!confirmed) {
      // Continue anyway
    }

    await page.wait(2);
    return true;
  } catch (err) {
    return false;
  }
}

export const referencesCommand = cli({
  site: 'doubao',
  name: 'references',
  description: 'Ask Doubao and return the answer with reference sources as JSON',
  domain: 'www.doubao.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 300,
  args: [
    { name: 'text', required: false, positional: true, help: 'Question to ask Doubao（与 --content-file 二选一）' },
    { name: 'content-file', required: false, help: 'Read question from file（优先于 text）' },
    { name: 'timeout', required: false, help: 'Max seconds to wait (default: 300)', default: '300' },
    { name: 'output', required: false, help: 'Save result to file (e.g. my-trip.json)' },
    { name: 'reuse', required: false, help: 'Reuse last conversation (default: false)', default: 'false' },
    { name: 'chat-id', required: false, help: 'Specific chat ID to use (overrides --reuse)' },
    { name: 'clear', required: false, help: 'Clear chat content after extraction (default: false)', default: 'false' },
    { name: 'account', required: false, help: 'Account name for multi-account isolation' },
  ],
  columns: ['question', 'answer', 'references'],
  func: async (page: IPage, kwargs: any) => {
    let question: string;
    if (kwargs['content-file']) {
      const contentFilePath = path.resolve(String(kwargs['content-file']));
      if (!fs.existsSync(contentFilePath)) {
        throw new Error(`Question file not found: ${contentFilePath}`);
      }
      question = fs.readFileSync(contentFilePath, 'utf8').trim();
    } else {
      question = String(kwargs.text ?? '').trim();
    }
    if (!question) {
      throw new Error('Question is required: provide text or --content-file');
    }
    const timeout = parseInt(kwargs.timeout as string, 10) || 300;
    const reuse = kwargs.reuse === 'true' || kwargs.reuse === true;
    const chatId = kwargs['chat-id'] as string | undefined;
    const clear = kwargs.clear === 'true' || kwargs.clear === true;
    const accountName = (kwargs.account as string | undefined)?.trim() || undefined;

    // Resolve account (creates entry if needed, updates lastUsed)
    const account = resolveDoubaoAccount(accountName);

    await ensureChatPage(page, { reuse, chatId, account: accountName });

    // ===== Anti-throttling: Override Visibility API =====
    // Prevents Chrome background tab throttling from suspending Doubao's JS execution.
    // Without this: when window is covered/minimized, AI responses freeze until tab is visible.
    await page.evaluate(injectVisibilityOverride());

    // Wait for chat input to be ready (replaces fixed 1s wait)
    // Doubao is a React SPA that needs time to hydrate and render components
    const inputReady = await page.evaluate(`
      (() => {
        const selectors = [
          'textarea[data-testid="chat_input_input"]',
          '.chat-input textarea',
          'textarea[placeholder*="发消息"]',
          'textarea[placeholder*="Message"]',
          'textarea',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetHeight > 0) return true;
        }
        return false;
      })()
    `) as boolean;

    // If input not ready, poll up to 15 seconds
    if (!inputReady) {
      const maxWaits = 30; // 30 * 500ms = 15s
      let ready = false;
      for (let i = 0; i < maxWaits; i++) {
        await page.wait(0.5);
        const check = await page.evaluate(`
          (() => {
            const el = document.querySelector('textarea[data-testid="chat_input_input"], textarea[placeholder*="发消息"], textarea');
            return el && el.offsetHeight > 0;
          })()
        `) as boolean;
        if (check) { ready = true; break; }
      }
      if (!ready) {
        return [{
          question,
          answer: '',
          references: [],
          error: 'Doubao chat input not ready after 15s. Page may have failed to load.',
        }];
      }
    }

    // Small buffer to ensure React components are fully mounted
    await page.wait(0.5);

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

    // Send message
    const sendMethod = await page.evaluate(sendScript()) as string;
    if (sendMethod === 'enter') {
      await page.pressKey('Enter');
    }
    await page.wait(10);

    // Wait 5 seconds before starting detection to allow initial response generation
    await page.wait(5);

    // Get current tab index for periodic refresh (anti-throttling)
    const rawTabs = await page.tabs().catch(() => []) as any[];
    const currentTabIndex = Array.isArray(rawTabs) && rawTabs.length > 0
      ? (rawTabs.find((t: any) => typeof t?.url === 'string' && t.url.includes('doubao.com/chat'))?.index ?? rawTabs[0]?.index)
      : null;

    // Safe evaluate wrapper: if CDP detaches during a call, wait briefly and retry once.
    const safeEval = async <T>(scriptFn: () => string): Promise<T> => {
      try {
        return await page.evaluate(scriptFn()) as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Detached') || msg.includes('target navigated') || msg.includes('closed')) {
          await page.wait(1.5);
          return await page.evaluate(scriptFn()) as T;
        }
        throw err;
      }
    };

    // Function to get answer directly from [data-message-id] - more reliable than header container
    const getAnswerFromMessage = async (): Promise<string> => {
      return await page.evaluate(`
        (function() {
          const clean = (v) => (v || '')
            .replace(/\\u00a0/g, ' ')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();

          const messages = document.querySelectorAll('[data-message-id]');
          if (messages.length > 0) {
            // Iterate from the end (latest) backwards to find AI message with substantive content
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              const text = clean(msg.innerText || '');
              // Skip user messages (just question) and metadata-only messages
              if (text.length < 20) continue;
              if (/^搜索\\s*\\d+\\s*个关键词$/.test(text)) continue;
              if (/^参考\\s*\\d+\\s*篇资料$/.test(text)) continue;
              // Skip if text matches the input area content (user message)
              const inputEl = document.querySelector('textarea[data-testid="chat_input_input"], textarea[placeholder*="发消息"]');
              if (inputEl && inputEl.value && text.trim() === inputEl.value.trim()) continue;
              // Found the AI response
              return text;
            }
          }
          return '';
        })()
      `) as string;
    };

    // Helper to check reference button
    const checkRefButton = async (): Promise<{ found: boolean; refCount?: number }> => {
      return await checkReferenceButton(page);
    };

    // Polling state
    let answer = '';
    let stableCount = 0;
    let prevAnswerLength = 0;
    let prevContentHash = '';
    let lastRefCheckTime = 0;
    let refButtonFound = false;

    // Polling loop: wait for reference button OR timeout
    // Strategy: wait for reference button to appear (indicates AI completed response)
    // If timeout reached, capture whatever answer we have
    const pollInterval = 1; // Check every second
    const maxTotalTime = timeout * 1000; // convert to ms
    const startTime = Date.now();

    // Track last time content was seen growing, to detect AI completion
    let lastContentChangeTime = startTime;
    const aiCompletionThreshold = 8000; // 8s of no content growth = AI likely done

    for (let i = 0; i < Math.ceil(maxTotalTime / pollInterval); i++) {
      // Anti-throttling: refresh tab visibility every 15 seconds (reduced from 6s to avoid interrupting rendering)
      if (i > 0 && i % 15 === 0 && currentTabIndex !== null) {
        const currentActiveTab = (await page.tabs().catch(() => []) as any[])
          .find((t: any) => t.active);
        const currentActiveIndex = currentActiveTab?.index;
        if (currentActiveIndex !== currentTabIndex) {
          await page.selectTab(currentTabIndex).catch(() => {});
          await page.wait(0.5);
        }
      }

      // Check if reference button has appeared
      const refBtnInfo = await checkRefButton();

      if (refBtnInfo.found) {
        refButtonFound = true;
        // Reference button found - AI has completed. Get answer now.
        answer = await getAnswerFromMessage();
        break;
      }

      // Get current answer from message
      const current = await getAnswerFromMessage();
      const contentHash = simpleHash(current);

      // Check if content is still growing
      if (current.length > prevAnswerLength + 2) {
        // Content still growing - reset stability counter and track change time
        stableCount = 0;
        answer = current;
        prevAnswerLength = current.length;
        prevContentHash = contentHash;
        lastContentChangeTime = Date.now();
      } else if (contentHash === prevContentHash && current.length > 0) {
        // Content stable
        stableCount++;
        if (stableCount >= 3) {
          // Content stable for 3 checks - capture answer
          if (!answer) answer = current;
        }
      } else if (current.length > 0) {
        answer = current;
        prevAnswerLength = current.length;
        prevContentHash = contentHash;
        stableCount = 0;
        lastContentChangeTime = Date.now();
      }

      // Exit early if AI appears to have completed response but no reference button exists
      // This prevents 300s timeout when answer is ready but has no references
      const elapsedSinceChange = Date.now() - lastContentChangeTime;
      if (answer && answer.length > 10 && stableCount >= 3 && elapsedSinceChange >= aiCompletionThreshold) {
        // Double-check: verify AI is not still streaming/thinking
        const isStreaming = await page.evaluate(isStreamingScript()) as boolean;
        if (!isStreaming) {
          break;
        }
        // Still streaming, reset stability to keep waiting
        stableCount = 0;
      }

      // Check for timeout
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxTotalTime) {
        // Timeout reached - capture whatever answer we have
        if (!answer) answer = current;
        break;
      }

      await page.wait(pollInterval);
    }

    // Final answer retrieval if not already captured
    if (!answer) {
      answer = await getAnswerFromMessage();
    }

    // Click reference button to expand references (if found)
    await page.wait(2);

    // Poll for reference button to appear (it can lag behind answer text by several seconds)
    let refBtnInfo = null;
    for (let i = 0; i < 8; i++) {
      refBtnInfo = await checkRefButton();

      if (refBtnInfo.found) break;
      await page.wait(1);
    }

    // If no reference button exists, return answer only (no references)
    if (!refBtnInfo?.found) {
      const result = [{
        question,
        answer: answer || 'No response received within timeout.',
        references: [],
        keywords: [],
      }];

      // Save current chat ID for future reuse (account-aware)
      const currentUrl = await page.evaluate(`window.location.href`) as string;
      const currentChatId = extractChatId(currentUrl || '');
      if (currentChatId) {
saveDoubaoLastChatId(currentChatId, accountName);
      }

      // Save result
      const outPath = kwargs.output as string | undefined;
      const homeDir = homedir();
      const resolvedHome = homeDir === '~'
        ? (process.env.USERPROFILE || process.env.HOME || process.cwd())
        : homeDir;
      const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'doubao_output');
      mkdirSync(saveDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `doubao-${timestamp}.json`);
      writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
      console.error(`💾 Saved to ${filePath}`);

      // Clear chat content if requested
      if (clear) {
        await clearChatContent(page);
      }

      return result;
    }

    // Click to expand the reference section - use extractDoubaoReferences which handles clicking
    // extractDoubaoReferences already clicks the button and extracts references
    await page.wait(2);

    // Poll to ensure reference content is fully loaded
    let references = await extractDoubaoReferences(page);
    const maxRetries = 4;
    let retries = 0;
    while (references.length === 0 && retries < maxRetries) {
      await page.wait(2);
      references = await extractDoubaoReferences(page);
      retries++;
    }

    // Extract search keywords from the expanded section
    const keywords = await extractDoubaoKeywords(page);

    const result = [{
      question,
      answer: answer || 'No response received within timeout.',
      references,
      keywords,
    }];

    // Save current chat ID for future reuse
    const currentUrl = await page.evaluate(`window.location.href`) as string;
    const currentChatId = extractChatId(currentUrl || '');
    if (currentChatId) {
      saveDoubaoLastChatId(currentChatId, accountName);
    }

    // Save to file
    const outPath = kwargs.output as string | undefined;
    const homeDir = homedir();
    // homedir() may return '~' in some environments; fallback to env var
    const resolvedHome = homeDir === '~'
      ? (process.env.USERPROFILE || process.env.HOME || process.cwd())
      : homeDir;
    const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'doubao_output');
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `doubao-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    console.error(`💾 Saved to ${filePath}`);

    // Clear chat content if requested (deletes messages but keeps the conversation)
    if (clear) {
      await clearChatContent(page);
    }

    return result;
  },
});
