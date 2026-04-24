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
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractDoubaoReferences } from './extract-references.js';
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

/** Extract the latest AI answer text from the page. */
function getAnswerScript(): string {
  return `
    (() => {
      const clean = (v) => (v || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // ===== Method A: 精准定位 AI 回答容器 =====

      // Step 1: 新版消息结构 - [data-message-id] + .flow-markdown-body
      const messages = document.querySelectorAll('[data-message-id]');
      if (messages.length > 0) {
        // 取最后一条消息
        const lastMsg = messages[messages.length - 1];

        // AI 回答有 .flow-markdown-body class，用户消息没有
        const aiMarkdown = lastMsg.querySelector('.flow-markdown-body');
        if (aiMarkdown) {
          return clean(aiMarkdown.innerText);
        }

        // 如果最后一条是用户消息（无 markdown），向前找最近的 AI 回答
        for (let i = messages.length - 2; i >= 0; i--) {
          const markdown = messages[i].querySelector('.flow-markdown-body');
          if (markdown) return clean(markdown.innerText);
        }
      }

      // Step 2: 旧版 fallback - receive_message 容器
      const oldMsg = document.querySelectorAll('[data-testid*="receive_message"], [class*="receive-message"]');
      if (oldMsg.length > 0) {
        const lastMsg = oldMsg[oldMsg.length - 1];
        const textEl = lastMsg.querySelector(
          '[data-testid="message_text_content"], [data-testid="message_content"], .flow-markdown-body'
        );
        if (textEl) return clean(textEl.innerText);
      }

      // Method B: fallback with layered exclusion
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

      // Filter out remaining UI noise lines using regex patterns
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
      ];

      const lines = text.split('\\n')
        .map(l => clean(l))
        .filter(l => l && l.length <= 400 && !stopPatterns.some(p => p.test(l)));

      // Return the tail portion which typically contains the AI answer
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

/** Check if AI is still generating (streaming indicator). */
function isStreamingScript(): string {
  return `
    (() => {
      // Check for streaming indicators: typing dots, indicator elements, or data-show-indicator
      const indicators = document.querySelectorAll(
        '[data-testid="indicator"]',
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
    { name: 'text', required: true, positional: true, help: 'Question to ask Doubao' },
    { name: 'timeout', required: false, help: 'Max seconds to wait (default: 300)', default: '300' },
    { name: 'output', required: false, help: 'Save result to file (e.g. my-trip.json)' },
    { name: 'reuse', required: false, help: 'Reuse last conversation (default: false)', default: 'false' },
    { name: 'chat-id', required: false, help: 'Specific chat ID to use (overrides --reuse)' },
    { name: 'clear', required: false, help: 'Clear chat content after extraction (default: false)', default: 'false' },
    { name: 'account', required: false, help: 'Account name for multi-account isolation' },
  ],
  columns: ['question', 'answer', 'references'],
  func: async (page: IPage, kwargs: any) => {
    const question = kwargs.text as string;
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

    // Poll for response completion with dual stability detection
    const pollInterval = 2;
    const maxPolls = Math.max(1, Math.ceil(timeout / pollInterval));
    let answer = '';
    let stableCount = 0;
    let streamingDetected = false;
    let prevAnswerLength = 0;
    let contentGrowing = false;
    let hasPlaceholderText = false; // Track if we see placeholder like "找到 N 篇资料"
    let prevContentHash = '';
    let prevNodeCount = 0;

    // Verify CDP session is fully established before starting the polling loop.
    // When Doubao is first opened, the CDP debugger attach needs a moment to stabilize.
    // Without this, page.evaluate() can throw "Detached while handling command" on the first
    // few polls even when the tab is valid and loaded.
    try {
      await page.evaluate('document.readyState').catch(() => 'loading');
      await page.wait(1); // Extra buffer for CDP session to fully attach
    } catch {
      // Ignore — we'll detect instability in the loop itself
    }

    // Get current tab index for periodic refresh (anti-throttling)
    const rawTabs = await page.tabs().catch(() => []) as any[];
    const currentTabIndex = Array.isArray(rawTabs) && rawTabs.length > 0
      ? (rawTabs.find((t: any) => typeof t?.url === 'string' && t.url.includes('doubao.com/chat'))?.index ?? rawTabs[0]?.index)
      : null;

    // Safe evaluate wrapper: if CDP detaches during a call, wait briefly and retry once.
    // This handles the race condition where Doubao's SPA causes CDP to briefly drop
    // during initial page load (especially on first open from cold start).
    const safeEval = async <T>(scriptFn: () => string): Promise<T> => {
      try {
        return await page.evaluate(scriptFn()) as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Detached') || msg.includes('target navigated') || msg.includes('closed')) {
          await page.wait(1.5); // Give CDP time to re-attach
          return await page.evaluate(scriptFn()) as T;
        }
        throw err;
      }
    };

    for (let i = 0; i < maxPolls; i++) {
      // Anti-throttling: refresh tab visibility every 3 polls (~6 seconds)
      // This prevents Chrome from suspending JS when window is covered/minimized
      // Skip if already on the target tab to avoid unnecessary tab switch causing CDP detach
      if (i > 0 && i % 3 === 0 && currentTabIndex !== null) {
        const currentActiveTab = (await page.tabs().catch(() => []) as any[])
          .find((t: any) => t.active);
        const currentActiveIndex = currentActiveTab?.index;
        if (currentActiveIndex !== currentTabIndex) {
          await page.selectTab(currentTabIndex).catch(() => {});
          await page.wait(0.5); // Allow CDP session to stabilize after tab switch
          await safeEval(injectVisibilityOverride);
        }
      }

      await page.wait(i === 0 ? 0 : pollInterval);
      const current = await safeEval(getAnswerScript) as string;

      if (!current || current === answerBefore) continue;

      // ===== Content Quality Filter =====
      // Skip early noise (footer/sidebar text captured before AI answer loads)
      const noisePatterns = [
        /^.{0,30}下载电脑版/,
        /^.{0,30}请仔细甄别/,
        /^.{0,50}内容由 (豆包|AI) 生成/,
        /^.{0,30}在此处拖放/,
      ];
      const isLikelyNoise = noisePatterns.some(p => p.test(current.trim()));
      if (isLikelyNoise && answer.length === 0) continue; // Skip if we don't have a valid answer yet

      // Require minimum content length before accepting as valid answer
      if (answer.length === 0 && current.length < 20) continue;

      // Detect placeholder text indicating search is starting but not complete
      if (current.match(/找到\s*\d+\s*篇资料/)) {
        hasPlaceholderText = true;
        streamingDetected = true; // Force longer wait
      }

      // Compute content hash for stability detection
      const contentHash = simpleHash(current);
      const nodeCount = await safeEval(() => `
        (() => {
          const container = document.querySelector('.flow-markdown-body') || document.body;
          return container.querySelectorAll('*').length;
        })()
      `) as number;

      // Detect content growth (text still being appended)
      // Lowered threshold from 5 to 2 characters for better streaming detection
      if (answer && current.length > prevAnswerLength + 2) {
        contentGrowing = true;
        streamingDetected = true;
        answer = current;
        prevAnswerLength = current.length;
        stableCount = 0;
        prevContentHash = contentHash;
        prevNodeCount = nodeCount;
        continue;
      }
      prevAnswerLength = current.length;

      // First time we see actual content - mark streaming as detected
      // This ensures we require longer stability from the start
      if (!streamingDetected && answer === '') {
        streamingDetected = true;
      }

      // Check if AI is still streaming/generating
      const isStreaming = await safeEval(isStreamingScript) as boolean;
      if (isStreaming) {
        streamingDetected = true;
        answer = current;
        prevAnswerLength = current.length;
        stableCount = 0;
        prevContentHash = contentHash;
        prevNodeCount = nodeCount;
        continue;
      }

      // Dual stability detection: content hash + DOM node count both stable
      if (contentHash === prevContentHash && nodeCount === prevNodeCount) {
        stableCount += 1;
      } else {
        answer = current;
        prevAnswerLength = current.length;
        stableCount = 0;
      }
      prevContentHash = contentHash;
      prevNodeCount = nodeCount;

      // Always require at least 4 stable checks (8 seconds) before exiting
      const requiredStable = streamingDetected ? 4 : 3;
      if (stableCount >= requiredStable) break;
    }

    // Final confirmation wait: one more check to ensure content is truly complete
    await page.wait(1.5);
    const finalCheck = await safeEval(getAnswerScript) as string;
    const finalStreaming = await safeEval(isStreamingScript) as boolean;
    if (!finalStreaming && finalCheck && finalCheck !== answerBefore) {
      answer = finalCheck;
    }

    // Expand reference sources section (click "参考 N 篇资料" button)
    // Wait longer for the reference button to appear (it may be added to DOM after streaming ends)
    await page.wait(2);

    // Poll for reference button to appear (it can lag behind answer text by several seconds)
    let refBtnInfo = null;
    for (let i = 0; i < 8; i++) {
      refBtnInfo = await safeEval(() => `
        (() => {
          const xpath = document.evaluate(
            '//*[contains(text(), "参考") and contains(text(), "篇资料")]',
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
          );
          const refBtn = xpath.singleNodeValue;
          if (refBtn) {
            return { found: true, text: refBtn.innerText?.trim() };
          }
          return { found: false };
        })()
      `) as { found: boolean; text?: string };

      if (refBtnInfo.found) break;
      await page.wait(1);
    }

    // If no reference button exists, return empty immediately
    if (!refBtnInfo?.found) {
      const result = [{
        question,
        answer: answer || 'No response received within timeout.',
        references: [],
      }];

      // Save current chat ID for future reuse (account-aware)
      const currentUrl = await safeEval(() => 'window.location.href') as string;
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

    // Click to expand the reference section
    await safeEval(() => `
      (() => {
        const xpath = document.evaluate(
          '//*[contains(text(), "参考") and contains(text(), "篇资料")]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        const refBtn = xpath.singleNodeValue;
        if (refBtn) {
          refBtn.click();
        }
      })()
    `);

    // Wait for lazy-loaded reference content to appear (click triggers API fetch)
    await page.wait(3);

    // Poll to ensure reference content is fully loaded
    let references = await extractDoubaoReferences(page);
    const maxRetries = 4;
    let retries = 0;
    while (references.length === 0 && retries < maxRetries) {
      await page.wait(2);
      // Don't re-click (toggle behavior may close the panel), just wait and re-extract
      references = await extractDoubaoReferences(page);
      retries++;
    }

    const result = [{
      question,
      answer: answer || 'No response received within timeout.',
      references,
    }];

    // Save current chat ID for future reuse
    const currentUrl = await safeEval(() => 'window.location.href') as string;
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
