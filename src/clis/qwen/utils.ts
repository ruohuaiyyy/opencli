/**
 * Shared utilities for Qwen web chat automation.
 *
 * Provides: page navigation, message sending, response polling,
 * and conversation management for www.qianwen.com/chat.
 */

import type { IPage } from '../../types.js';

export const QWEN_DOMAIN = 'www.qianwen.com';
export const QWEN_CHAT_URL = 'https://www.qianwen.com/chat';

export interface QwenTurn {
  Role: 'User' | 'Assistant' | 'System';
  Text: string;
}

export interface QwenPageState {
  url: string;
  title: string;
  isLogin: boolean | null;
}

/**
 * Extract visible text lines from the chat page, filtering out UI noise.
 */
function getTranscriptLinesScript(): string {
  return `
    (() => {
      const clean = (value) => (value || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // Method 1: Try to get content from .qk-markdown elements (most reliable)
      const markdownEls = document.querySelectorAll('.qk-markdown');
      if (markdownEls.length > 0) {
        const lines = [];
        markdownEls.forEach((el) => {
          const text = clean(el.innerText || '');
          if (text && text.length > 10) {
            lines.push(text);
          }
        });
        if (lines.length > 0) return lines;
      }

      // Method 2: Fallback to full page extraction with aggressive noise filtering
      const root = document.body.cloneNode(true);
      const removableSelectors = [
        '[class*="sidebar"]',
        '[class*="chat-input"]',
        '[class*="input-box"]',
        '[class*="nav"]',
        '[class*="header"]',
        '[class*="toolbar"]',
        '[class*="button"]',
        'button',
        'img',
        'svg',
        '[class*="icon"]',
      ];

      for (const selector of removableSelectors) {
        root.querySelectorAll(selector).forEach((node) => node.remove());
      }

      root.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

      const noisePatterns = [
        /千问/,
        /UID：/,
        /客户端下载/,
        /退出登录/,
        /服务协议/,
        /客服中心/,
        /权益中心/,
        /我要反馈/,
        /用户调研/,
        /深色模式/,
        /新对话/,
        /内容由 AI 生成/,
        /AI 创作/,
        /历史对话/,
        /搜索/,
        /深度思考/,
        /联网搜索/,
        /任务助理/,
        /深度研究/,
        /代码/,
        /图像/,
        /更多/,
        /录音 PPT/,
        /音视频/,
        /文档发现/,
        /trigger/,
        /Qwen\\d+-千问/,
      ];

      const transcriptText = clean(root.innerText || root.textContent || '');

      return clean(transcriptText)
        .split('\\n')
        .map((line) => clean(line))
        .filter((line) => {
          if (!line || line.length < 5 || line.length > 400) return false;
          // Check against noise patterns
          for (const pattern of noisePatterns) {
            if (pattern.test(line)) return false;
          }
          return true;
        });
    })()
  `;
}

/**
 * Get page state including URL, title, and login status.
 */
function getStateScript(): string {
  return `
    (() => {
      // Check if logged in by looking for user-specific elements
      // Note: :contains() is not a valid CSS selector — use manual text matching instead
      const allButtons = Array.from(document.querySelectorAll('button'));
      const loginButton = allButtons.find(btn => (btn.textContent || '').trim() === '登录');
      const userAvatar = document.querySelector('[class*="user"], [class*="avatar"]');
      const isLoggedIn = !loginButton && !!userAvatar;

      return {
        url: window.location.href,
        title: document.title || '',
        isLogin: isLoggedIn,
      };
    })()
  `;
}

/**
 * Fill the chat input with text (contenteditable div).
 */
function fillComposerScript(text: string): string {
  return `
    ((inputText) => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      // Updated selectors based on current Qwen DOM (April 2026)
      const candidates = [
        '[role="textbox"][data-slate-editor="true"]',
        '[data-slate-editor="true"]',
        '.min-h-24px',
        'div[contenteditable="true"][aria-multiline="true"]',
      ];

      let composer = null;
      for (const selector of candidates) {
        const node = document.querySelector(selector);
        if (node && isVisible(node)) {
          composer = node;
          break;
        }
      }

      if (!composer) throw new Error('Could not find Qwen input element');

      composer.focus();
      composer.textContent = '';
      
      // Use execCommand to insert text (more reliable for contenteditable)
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, inputText);
      
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      
      return 'contenteditable';
    })(${JSON.stringify(text)})
  `;
}

/**
 * Click send button - Qwen uses Enter key primarily, but try to find button.
 */
function clickSendButtonScript(): string {
  return `
    (() => {
      // Qwen typically uses Enter to send, but let's try to find any send action
      const labels = ['发送', 'Send', '发送消息'];
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));

      for (const button of allButtons) {
        const text = (button.innerText || button.textContent || '').trim();
        const aria = (button.getAttribute('aria-label') || '').trim();
        if ([text, aria].some(v => labels.some(l => v.includes(l)))) {
          button.click();
          return 'button';
        }
      }

      return 'enter';
    })()
  `;
}

/**
 * Click "New Chat" button.
 */
function clickNewChatScript(): string {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const labels = ['新对话', 'New Chat', '新建对话', '+'];
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));

      for (const button of buttons) {
        if (!isVisible(button)) continue;
        const text = (button.innerText || button.textContent || '').trim();
        const aria = (button.getAttribute('aria-label') || '').trim();
        if (text === '新对话' || aria.includes('新对话')) {
          button.click();
          return '新对话';
        }
      }

      return '';
    })()
  `;
}

/**
 * Check if AI is still generating (streaming indicator).
 */
function isStreamingScript(): string {
  return `
    (() => {
      const indicators = document.querySelectorAll(
        '[class*="loading"]',
        '[class*="typing"]',
        '[class*="streaming"]',
        '[class*="thinking"]',
        '[class*="generating"]',
      );
      if (indicators.length > 0) return true;

      const allText = document.body.innerText || '';
      if (allText.includes('思考中') || allText.includes('生成中') || allText.includes('正在处理')) {
        return true;
      }

      return false;
    })()
  `;
}

async function selectPreferredQwenTab(page: IPage): Promise<boolean> {
  const rawTabs = await page.tabs().catch(() => []);
  if (!Array.isArray(rawTabs) || rawTabs.length === 0) return false;

  const tabs = rawTabs.filter((tab: any) => 
    typeof tab?.url === 'string' && tab.url.includes('qianwen.com/chat')
  );
  if (tabs.length === 0) return false;

  const preferred = tabs[0];
  if (!preferred) return false;

  await page.selectTab(preferred.index);
  await page.wait(0.8);
  return true;
}

/**
 * Ensure we are on a Qwen chat page, navigating or switching tabs if needed.
 */
export async function ensureQwenChatPage(page: IPage): Promise<void> {
  let currentUrl = await page.evaluate('window.location.href').catch(() => '');
  if (typeof currentUrl === 'string' && currentUrl.includes('qianwen.com/chat')) {
    await page.wait(1);
    return;
  }

  const reusedTab = await selectPreferredQwenTab(page);
  if (reusedTab) {
    currentUrl = await page.evaluate('window.location.href').catch(() => '');
    if (typeof currentUrl === 'string' && currentUrl.includes('qianwen.com/chat')) {
      await page.wait(1);
      return;
    }
  }

  await page.goto(QWEN_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
  await page.wait(1.5);
}

/**
 * Get the current page state (URL, title, login status).
 */
export async function getQwenPageState(page: IPage): Promise<QwenPageState> {
  await ensureQwenChatPage(page);
  return await page.evaluate(getStateScript()) as QwenPageState;
}

/**
 * Get transcript lines (full page text extraction).
 */
export async function getQwenTranscriptLines(page: IPage): Promise<string[]> {
  await ensureQwenChatPage(page);
  return await page.evaluate(getTranscriptLinesScript()) as string[];
}

/**
 * Send a message to the current Qwen chat.
 *
 * Strategy: Find the Slate.js editor instance via React fiber, then call
 * editor.insertText() directly. This is the ONLY reliable way to input text
 * into Qwen's Slate editor because:
 *
 *   - execCommand('insertText') creates DOM nodes but Slate's internal Value
 *     stays empty (data-slate-length="0"), so the send button stays disabled
 *   - createTextNode + dispatchEvent produces untrusted events that Slate ignores
 *   - page.typeText() wraps selectors breaking attribute selectors
 *   - Only editor.insertText() updates Slate's internal model → onChange fires
 *     → React re-renders → send button enables → click actually sends
 */
export async function sendQwenMessage(page: IPage, text: string): Promise<string> {
  await ensureQwenChatPage(page);
  await page.wait(1);

  const result = await page.evaluate(`
    (function(inputText) {
      var isVisible = function(el) {
        if (!(el instanceof HTMLElement)) return false;
        var s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden'
          && el.getBoundingClientRect().width > 0;
      };

      // Find the Slate editor DOM element
      var composer = null;
      var candidates = [
        '[role="textbox"][data-slate-editor="true"]',
        '[data-slate-editor="true"]',
        '.min-h-24px',
        'div[contenteditable="true"][aria-multiline="true"]',
      ];
      for (var i = 0; i < candidates.length; i++) {
        var node = document.querySelector(candidates[i]);
        if (node && isVisible(node)) { composer = node; break; }
      }
      if (!composer) return { ok: false, error: 'No composer found' };

      // Walk React fiber tree to find the Slate editor instance
      var fiberKey = Object.keys(composer).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (!fiberKey) return { ok: false, error: 'No React fiber found' };

      var fiber = composer[fiberKey];
      var editor = null;
      for (var depth = 0; depth < 20 && fiber; depth++) {
        if (fiber.memoizedProps && fiber.memoizedProps.editor) {
          editor = fiber.memoizedProps.editor;
          break;
        }
        fiber = fiber.return;
      }
      if (!editor) return { ok: false, error: 'No Slate editor instance found' };

      // Focus + insert text via Slate API
      composer.focus();
      editor.insertText(inputText);

      // Return info about button state for debugging
      var sendBtn = document.querySelector('.operateBtn-ehxNOr');
      return {
        ok: true,
        method: 'slate-insert',
        finalText: composer.textContent,
        btnExists: !!sendBtn,
        btnClass: sendBtn ? sendBtn.className : null,
        btnVisible: sendBtn ? isVisible(sendBtn) : null
      };
    })(${JSON.stringify(text)})
  `);

  // Wait for React to reconcile — button transitions from disabled→enabled
  await page.wait(1);

  // Click using Playwright's native click (dispatches real mousedown/mouseup/click
  // events through the browser's event system, which React's event delegation picks up)
  try {
    await page.click('.operateBtn-ehxNOr');
    await page.wait(1);
    return 'send-button-click';
  } catch (_clickErr) {
    // fallback to Enter key
  }

  // Fallback: press Enter on the focused editor
  await page.pressKey('Enter');
  await page.wait(1);
  return 'enter-key';
}

/**
 * Wait for AI response to complete.
 *
 * IMPORTANT: Uses querySelectorAll + last .qk-markdown element (not first),
 * because the page may contain .qk-markdown from previous conversations.
 * Skips content that matches beforeAnswer (snapshot taken before sending),
 * following the same pattern as Yuanbao's references command.
 */
export async function waitForQwenResponse(
  page: IPage,
  beforeLines: string[],
  promptText: string,
  timeoutSeconds: number,
  beforeAnswer?: string,
): Promise<string> {
  const beforeSet = new Set(beforeLines);

  const sanitizeCandidate = (value: string): string => value
    .replace(promptText, '')
    .replace(/内容由AI生成/g, '')
    .trim();

  const getCandidate = async (): Promise<string> => {
    // Method A: structured extraction — get the LAST (most recent) .qk-markdown element.
    // querySelector would return the FIRST match which could be from a previous conversation.
    const markdownText = await page.evaluate(`
      (() => {
        const markdownEls = document.querySelectorAll('.qk-markdown');
        if (markdownEls.length > 0) {
          const latest = markdownEls[markdownEls.length - 1];
          return (latest.innerText || '').trim();
        }
        return '';
      })()
    `) as string;

    if (markdownText && markdownText.length > 10) {
      return sanitizeCandidate(markdownText);
    }

    // Method B: fallback to transcript lines
    const lines = await getQwenTranscriptLines(page);
    const additions = lines
      .filter((line) => !beforeSet.has(line))
      .map((line) => sanitizeCandidate(line))
      .filter((line) => line && line !== promptText);

    const shortCandidate = additions.find((line) => line.length <= 120);
    return shortCandidate || additions[additions.length - 1] || '';
  };

  const pollInterval = 2;
  const maxPolls = Math.max(1, Math.ceil(timeoutSeconds / pollInterval));
  let answer = '';
  let stableCount = 0;
  let streamingDetected = false;

  for (let i = 0; i < maxPolls; i++) {
    await page.wait(i === 0 ? 1.5 : pollInterval);
    const current = await getCandidate();

    // Skip empty content
    if (!current) continue;

    // Skip content that existed BEFORE we sent the message (previous conversation's answer)
    if (beforeAnswer && current === beforeAnswer) continue;

    // Check if AI is still streaming
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

  return answer;
}

/**
 * Start a new conversation.
 */
export async function startNewQwenChat(page: IPage): Promise<string> {
  await ensureQwenChatPage(page);
  const clickedLabel = await page.evaluate(clickNewChatScript()) as string;
  if (clickedLabel) {
    await page.wait(1.5);
    return clickedLabel;
  }

  await page.goto(QWEN_CHAT_URL, { waitUntil: 'load', settleMs: 2000 });
  await page.wait(1.5);
  return 'navigate';
}
