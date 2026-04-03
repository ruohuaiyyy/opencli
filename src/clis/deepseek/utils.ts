/**
 * Shared utilities for DeepSeek web chat automation.
 *
 * Provides: page navigation, message sending, response polling,
 * and conversation management for chat.deepseek.com.
 */

import type { IPage } from '../../types.js';

export const DEEPSEEK_DOMAIN = 'chat.deepseek.com';
export const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com';

export interface DeepseekTurn {
  Role: 'User' | 'Assistant' | 'System';
  Text: string;
}

export interface DeepseekPageState {
  url: string;
  title: string;
  isLogin: boolean | null;
  placeholder: string;
}

interface DeepseekTabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/**
 * Extract visible text lines from the chat page, filtering out UI noise.
 * Used as fallback when structured message extraction fails.
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
        'DeepSeek',
        '开启新对话',
        '内容由 AI 生成',
        'AI 创作',
        '历史对话',
        '搜索',
        '深度思考',
        '智能搜索',
      ]);

      const noisyPatterns = [
        /^window\\._SSR_DATA/,
        /^window\\._ROUTER_DATA/,
        /^\\{"namedChunks"/,
      ];

      const transcriptText = clean(root.innerText || root.textContent || '')
        .replace(/开启新对话/g, '\\n')
        .replace(/内容由 AI 生成，请仔细甄别/g, '\\n');

      return clean(transcriptText)
        .split('\\n')
        .map((line) => clean(line))
        .filter((line) => line
          && line.length <= 400
          && !stopLines.has(line)
          && !noisyPatterns.some((pattern) => pattern.test(line)));
    })()
  `;
}

/**
 * Get page state including URL, title, and login status.
 */
function getStateScript(): string {
  return `
    (() => {
      const placeholderNode = document.querySelector(
        'textarea[placeholder], [contenteditable="true"][placeholder], [aria-label*="发送消息"], [aria-label*="Message"]'
      );
      return {
        url: window.location.href,
        title: document.title || '',
        isLogin: document.cookie.length > 100 ? true : null,
        placeholder: placeholderNode?.getAttribute('placeholder')
          || placeholderNode?.getAttribute('aria-label')
          || '',
      };
    })()
  `;
}

/**
 * Extract conversation turns (User/Assistant messages) from the page.
 * Uses ARIA snapshot-friendly selectors to identify message roles.
 */
function getTurnsScript(): string {
  return `
    (() => {
      const clean = (value) => (value || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const getRole = (root) => {
        // User messages: typically contain the user's query text
        if (
          root.querySelector('[class*="user-message"], [class*="user-bubble"], [class*="question"]')
          || (root.className && root.className.includes && root.className.includes('user'))
        ) {
          return 'User';
        }
        // Assistant messages: typically contain markdown, code blocks, or AI-generated content
        if (
          root.querySelector('[class*="assistant-message"], [class*="bot-bubble"], [class*="answer"], [class*="markdown"]')
          || (root.className && root.className.includes && root.className.includes('bot'))
          || root.querySelector('strong, p')
        ) {
          return 'Assistant';
        }
        return '';
      };

      const extractText = (root) => {
        const selectors = [
          '[class*="markdown"]',
          '[class*="message-text"]',
          '[class*="message-content"]',
          '[class*="bubble-content"]',
          'p',
        ];

        const chunks = [];
        const seen = new Set();
        for (const selector of selectors) {
          const nodes = Array.from(root.querySelectorAll(selector))
            .filter((el) => isVisible(el))
            .map((el) => clean(el.innerText || el.textContent || ''))
            .filter(Boolean);
          for (const nodeText of nodes) {
            if (seen.has(nodeText)) continue;
            seen.add(nodeText);
            chunks.push(nodeText);
          }
          if (chunks.length > 0) break;
        }

        if (chunks.length > 0) return clean(chunks.join('\\n'));
        return clean(root.innerText || root.textContent || '');
      };

      // Try multiple container selectors
      const containers = [
        '[class*="message-list"]',
        '[class*="chat-list"]',
        '[class*="conversation"]',
        '[class*="message-container"]',
        '[class*="chat-container"]',
      ];

      let messageList = null;
      for (const sel of containers) {
        const el = document.querySelector(sel);
        if (el) { messageList = el; break; }
      }
      if (!messageList) return [];

      const roots = Array.from(messageList.children)
        .filter((el) => el instanceof HTMLElement && isVisible(el));

      const turns = roots
        .map((el) => {
          const role = getRole(el);
          const text = extractText(el);
          return { el, role, text };
        })
        .filter((item) => (item.role === 'User' || item.role === 'Assistant') && item.text);

      const deduped = [];
      const seen = new Set();
      for (const turn of turns) {
        const key = turn.role + '::' + turn.text;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ Role: turn.role, Text: turn.text });
      }

      if (deduped.length > 0) return deduped;
      return [];
    })()
  `;
}

/**
 * Fill the chat input with text (React-compatible value setter).
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

      const candidates = [
        'textarea[placeholder*="发送消息"]',
        'textarea[placeholder*="Message"]',
        '.chat-input textarea',
        '[class*="chat-input"] textarea',
        '[class*="input-box"] textarea',
        '[contenteditable="true"][placeholder*="发送消息"]',
        '[contenteditable="true"]',
        'textarea',
      ];

      let composer = null;
      for (const selector of candidates) {
        const node = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (node) {
          composer = node;
          break;
        }
      }

      if (!composer) throw new Error('Could not find DeepSeek input element');

      composer.focus();

      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(composer, inputText);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
        return 'text-input';
      }

      if (composer instanceof HTMLElement) {
        composer.textContent = '';
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
      }

      throw new Error('Unsupported DeepSeek input element');
    })(${JSON.stringify(text)})
  `;
}

/**
 * Fill input and click send button in one shot.
 */
function fillAndSubmitComposerScript(text: string): string {
  return `
    ((inputText) => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const candidates = [
        'textarea[placeholder*="发送消息"]',
        'textarea[placeholder*="Message"]',
        '.chat-input textarea',
        '[class*="chat-input"] textarea',
        'textarea',
      ];

      let composer = null;
      for (const selector of candidates) {
        const node = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (node) {
          composer = node;
          break;
        }
      }

      if (!(composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement)) {
        throw new Error('Could not find DeepSeek textarea input element');
      }

      composer.focus();
      const proto = composer instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(composer, inputText);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      // Find send button
      const labels = ['发送', 'Send', '发送消息'];
      const root = document.querySelector('[class*="chat-input"], [class*="input-box"]') || document.body;
      const buttons = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isVisible);

      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        if ([text, aria].some(v => labels.some(l => v.includes(l)))) {
          btn.click();
          return 'button';
        }
      }

      // Fallback: click last visible button in input area
      if (buttons.length > 0) {
        buttons[buttons.length - 1].click();
        return 'button';
      }

      return 'enter';
    })(${JSON.stringify(text)})
  `;
}

/**
 * Click the send button.
 */
function clickSendButtonScript(): string {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const labels = ['发送', 'Send', '发送消息'];
      const root = document.querySelector('[class*="chat-input"], [class*="input-box"]') || document;
      const buttons = Array.from(root.querySelectorAll('button, [role="button"]'));

      for (const button of buttons) {
        if (!isVisible(button)) continue;
        const disabled = button.getAttribute('disabled') !== null
          || button.getAttribute('aria-disabled') === 'true';
        if (disabled) continue;
        const text = (button.innerText || button.textContent || '').trim();
        const aria = (button.getAttribute('aria-label') || '').trim();
        const title = (button.getAttribute('title') || '').trim();
        const haystacks = [text, aria, title];
        if (haystacks.some((value) => labels.some((label) => value.includes(label)))) {
          button.click();
          return true;
        }
      }

      return false;
    })()
  `;
}

/**
 * Click "开启新对话" (New Chat) button.
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

      const labels = ['开启新对话', 'New Chat', '新建对话', '+'];
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));

      for (const button of buttons) {
        if (!isVisible(button)) continue;
        const text = (button.innerText || button.textContent || '').trim();
        const aria = (button.getAttribute('aria-label') || '').trim();
        const title = (button.getAttribute('title') || '').trim();
        const haystacks = [text, aria, title];
        if (haystacks.some((value) => labels.some((label) => value.includes(label)))) {
          button.click();
          return text || aria || title || 'new-chat';
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

function normalizeDeepseekTabs(rawTabs: unknown[]): DeepseekTabInfo[] {
  return rawTabs
    .map((tab, index) => {
      const record = (tab || {}) as Record<string, unknown>;
      return {
        index: typeof record.index === 'number' ? record.index : index,
        url: typeof record.url === 'string' ? record.url : '',
        title: typeof record.title === 'string' ? record.title : '',
        active: record.active === true,
      };
    })
    .filter((tab) => tab.url.includes('chat.deepseek.com'));
}

async function selectPreferredDeepseekTab(page: IPage): Promise<boolean> {
  const rawTabs = await page.tabs().catch(() => []);
  if (!Array.isArray(rawTabs) || rawTabs.length === 0) return false;

  const tabs = normalizeDeepseekTabs(rawTabs);
  if (tabs.length === 0) return false;

  const preferred = [...tabs].sort((left, right) => {
    const score = (tab: DeepseekTabInfo): number => {
      let value = tab.index;
      if (/https?:\/\/chat\.deepseek\.com\/a\/chat\/s\//.test(tab.url)) value += 1000;
      else if (tab.url.startsWith(DEEPSEEK_CHAT_URL)) value += 100;
      if (tab.active) value += 25;
      return value;
    };

    return score(right) - score(left);
  })[0];

  if (!preferred) return false;

  await page.selectTab(preferred.index);
  await page.wait(0.8);
  return true;
}

/**
 * Ensure we are on a DeepSeek chat page, navigating or switching tabs if needed.
 */
export async function ensureDeepseekChatPage(page: IPage): Promise<void> {
  let currentUrl = await page.evaluate('window.location.href').catch(() => '');
  if (typeof currentUrl === 'string' && currentUrl.includes('chat.deepseek.com')) {
    await page.wait(1);
    return;
  }

  const reusedTab = await selectPreferredDeepseekTab(page);
  if (reusedTab) {
    currentUrl = await page.evaluate('window.location.href').catch(() => '');
    if (typeof currentUrl === 'string' && currentUrl.includes('chat.deepseek.com')) {
      await page.wait(1);
      return;
    }
  }

  await page.goto(DEEPSEEK_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
  await page.wait(1.5);
}

/**
 * Get the current page state (URL, title, login status).
 */
export async function getDeepseekPageState(page: IPage): Promise<DeepseekPageState> {
  await ensureDeepseekChatPage(page);
  return await page.evaluate(getStateScript()) as DeepseekPageState;
}

/**
 * Get visible conversation turns (User/Assistant messages).
 */
export async function getDeepseekTurns(page: IPage): Promise<DeepseekTurn[]> {
  await ensureDeepseekChatPage(page);
  const turns = await page.evaluate(getTurnsScript()) as DeepseekTurn[];
  if (turns.length > 0) return turns;

  const lines = await page.evaluate(getTranscriptLinesScript()) as string[];
  return lines.map((line) => ({ Role: 'System', Text: line }));
}

/**
 * Get visible conversation turns (structured only, no fallback).
 */
export async function getDeepseekVisibleTurns(page: IPage): Promise<DeepseekTurn[]> {
  await ensureDeepseekChatPage(page);
  return await page.evaluate(getTurnsScript()) as DeepseekTurn[];
}

/**
 * Get transcript lines (full page text extraction).
 */
export async function getDeepseekTranscriptLines(page: IPage): Promise<string[]> {
  await ensureDeepseekChatPage(page);
  return await page.evaluate(getTranscriptLinesScript()) as string[];
}

/**
 * Send a message to the current chat.
 */
export async function sendDeepseekMessage(page: IPage, text: string): Promise<'button' | 'enter'> {
  await ensureDeepseekChatPage(page);
  const submittedBy = await page.evaluate(fillAndSubmitComposerScript(text)) as 'button' | 'enter';
  if (submittedBy === 'enter') {
    await page.pressKey('Enter');
  }
  await page.wait(0.8);
  return submittedBy;
}

/**
 * Wait for AI response to complete.
 */
export async function waitForDeepseekResponse(
  page: IPage,
  beforeLines: string[],
  beforeTurns: DeepseekTurn[],
  promptText: string,
  timeoutSeconds: number,
): Promise<string> {
  const beforeSet = new Set(beforeLines);
  const beforeTurnSet = new Set(
    beforeTurns
      .filter((turn) => turn.Role === 'Assistant')
      .map((turn) => `${turn.Role}::${turn.Text}`),
  );

  const sanitizeCandidate = (value: string): string => value
    .replace(promptText, '')
    .replace(/内容由 AI 生成，请仔细甄别/g, '')
    .trim();

  const getCandidate = async (): Promise<string> => {
    const turns = await getDeepseekVisibleTurns(page);
    const assistantCandidate = [...turns]
      .reverse()
      .find((turn) => turn.Role === 'Assistant' && !beforeTurnSet.has(`${turn.Role}::${turn.Text}`));
    const visibleCandidate = assistantCandidate ? sanitizeCandidate(assistantCandidate.Text) : '';

    if (visibleCandidate) return visibleCandidate;

    const lines = await getDeepseekTranscriptLines(page);
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
 * Enable internet search ("智能搜索") toggle so that references are included in responses.
 * Returns true if search was enabled (was off and got toggled, or was already on).
 */
export async function enableDeepseekInternetSearch(page: IPage): Promise<boolean> {
  return await page.evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const searchBtn = buttons.find(b =>
        (b.textContent || '').includes('智能搜索')
      );
      if (!searchBtn) return false;
      const isChecked = searchBtn.getAttribute('aria-checked') === 'true';
      if (!isChecked) {
        searchBtn.click();
        return true;
      }
      return true;
    })()
  `) as boolean;
}

/**
 * Start a new conversation.
 */
export async function startNewDeepseekChat(page: IPage): Promise<string> {
  await ensureDeepseekChatPage(page);
  const clickedLabel = await page.evaluate(clickNewChatScript()) as string;
  if (clickedLabel) {
    await page.wait(1.5);
    return clickedLabel;
  }

  await page.goto(DEEPSEEK_CHAT_URL, { waitUntil: 'load', settleMs: 2000 });
  await page.wait(1.5);
  return 'navigate';
}
