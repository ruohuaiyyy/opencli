/**
 * Standalone command: ask Doubao and return answer + reference sources as JSON.
 *
 * Fully independent — does not import any existing doubao utils.
 * Implements its own: page navigation, input injection, send, response polling,
 * and reference card extraction.
 *
 * Usage:
 *   opencli doubao references "大同旅游景点推荐" -f json
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractDoubaoReferences } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat';

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

      // Method A: structured extraction via receive_message containers
      const messages = document.querySelectorAll(
        '[data-testid*="receive_message"], [class*="receive-message"]'
      );
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const textEl = lastMsg.querySelector(
          '[data-testid="message_text_content"], [data-testid="message_content"]'
        );
        if (textEl) return clean(textEl.innerText || textEl.textContent || '');
      }

      // Method B: full-page text extraction with noise removal
      const root = document.body.cloneNode(true);
      [
        '[data-testid="flow_chat_sidebar"]',
        '[data-testid="chat_input"]',
        '[data-testid="flow_chat_guidance_page"]',
      ].forEach(sel => {
        root.querySelectorAll(sel).forEach(n => n.remove());
      });
      root.querySelectorAll('script, style, noscript').forEach(n => n.remove());

      const text = clean(root.innerText || root.textContent || '')
        .replace(/新对话/g, '\\n')
        .replace(/内容由豆包 AI 生成/g, '\\n')
        .replace(/在此处拖放文件/g, '\\n')
        .replace(/文件数量：[^\\n]*/g, '')
        .replace(/文件类型：[^\\n]*/g, '');

      const stopLines = new Set([
        '豆包', '新对话', '内容由豆包 AI 生成', 'AI 创作', '云盘', '更多',
        '历史对话', '手机版对话', '快速', '超能模式', 'Beta',
        'PPT 生成', '图像生成', '帮我写作',
      ]);

      const lines = text.split('\\n')
        .map(l => clean(l))
        .filter(l => l && l.length <= 400 && !stopLines.has(l));

      // Return the tail portion which typically contains the AI answer
      const tail = lines.slice(-30).join('\\n');
      return tail || clean(root.innerText || root.textContent || '');
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

/** Ensure we are on a Doubao chat page, navigating or switching tabs if needed. */
async function ensureChatPage(page: IPage): Promise<void> {
  const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
  if (typeof currentUrl === 'string' && currentUrl.includes('doubao.com/chat')) {
    return;
  }

  // Try to switch to an existing doubao.com/chat tab
  const rawTabs = await page.tabs().catch(() => []) as any[];
  if (Array.isArray(rawTabs) && rawTabs.length > 0) {
    const doubaoTabs = rawTabs.filter((t) =>
      typeof t?.url === 'string' && t.url.includes('doubao.com/chat')
    );
    if (doubaoTabs.length > 0) {
      await page.selectTab(doubaoTabs[0].index);
      await page.wait(0.8);
      return;
    }
  }

  await page.goto(DOUBAO_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
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

    // Expand reference sources section (click "参考 N 篇资料" button)
    await page.wait(1);
    await page.evaluate(`
      (() => {
        // Doubao uses a generic element (not <button>) for the reference toggle
        const xpath = document.evaluate(
          '//*[contains(text(), "参考") and contains(text(), "篇资料")]',
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        const refBtn = xpath.singleNodeValue;
        if (refBtn) {
          refBtn.click();
          return true;
        }
        return false;
      })()
    `);
    await page.wait(1.5);

    // Extract reference sources
    const references = await extractDoubaoReferences(page);

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
    const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'doubao_output');
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `doubao-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    console.error(`💾 Saved to ${filePath}`);

    return result;
  },
});
