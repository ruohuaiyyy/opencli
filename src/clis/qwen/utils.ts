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

      const root = document.body.cloneNode(true);
      const removableSelectors = [
        '[class*="sidebar"]',
        '[class*="chat-input"]',
        '[class*="input-box"]',
        '[class*="nav"]',
        '[class*="header"]',
      ];

      for (const selector of removableSelectors) {
        root.querySelectorAll(selector).forEach((node) => node.remove());
      }

      root.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

      const stopLines = new Set([
        '千问',
        '新对话',
        '内容由AI生成',
        'AI创作',
        '历史对话',
        '搜索',
        '深度思考',
        '联网搜索',
      ]);

      const transcriptText = clean(root.innerText || root.textContent || '')
        .replace(/新对话/g, '\\n')
        .replace(/内容由AI生成/g, '\\n');

      return clean(transcriptText)
        .split('\\n')
        .map((line) => clean(line))
        .filter((line) => line && line.length <= 400 && !stopLines.has(line));
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
      const loginButton = document.querySelector('button:contains("登录")');
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

      // Qwen uses contenteditable div, not textarea
      const candidates = [
        '.chatTextarea-Cc1M0W',
        '[contenteditable="true"][class*="chat"]',
        '[contenteditable="true"][class*="input"]',
        '.inputOutWrap-_hjFu_ [contenteditable]',
        'div[contenteditable="true"]',
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
 * Send a message to the current chat.
 */
export async function sendQwenMessage(page: IPage, text: string): Promise<string> {
  await ensureQwenChatPage(page);
  await page.evaluate(fillComposerScript(text));
  await page.pressKey('Enter');
  await page.wait(0.8);
  return 'enter';
}

/**
 * Wait for AI response to complete.
 */
export async function waitForQwenResponse(
  page: IPage,
  beforeLines: string[],
  promptText: string,
  timeoutSeconds: number,
): Promise<string> {
  const beforeSet = new Set(beforeLines);

  const sanitizeCandidate = (value: string): string => value
    .replace(promptText, '')
    .replace(/内容由AI生成/g, '')
    .trim();

  const getCandidate = async (): Promise<string> => {
    // Method A: structured extraction - get latest AI response
    const markdownEl = document.querySelector('.qk-markdown') as HTMLElement | null;
    if (markdownEl) {
      const text = sanitizeCandidate(markdownEl.innerText || '');
      if (text && text.length > 10) return text;
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

    if (!current) continue;

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
