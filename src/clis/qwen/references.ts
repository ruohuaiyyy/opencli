/**
 * Standalone command: ask Qwen and return answer + reference sources as JSON.
 *
 * Fully independent — implements its own: page navigation, input injection, send,
 * response polling, and reference card extraction.
 *
 * Usage:
 *   opencli qwen references "大同旅游景点推荐" -f json
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractQwenReferences } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const QWEN_CHAT_URL = 'https://www.qianwen.com/chat';

/** Inject text into Qwen chat input (contenteditable div). */
function fillInputScript(text: string): string {
  return `
    ((inputText) => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && el.getBoundingClientRect().width > 0;
      };

      const candidates = [
        '.chatTextarea-Cc1M0W',
        '[contenteditable="true"][class*="chat"]',
        '[contenteditable="true"][class*="input"]',
        'div[contenteditable="true"]',
      ];

      let input = null;
      for (const sel of candidates) {
        const node = document.querySelector(sel);
        if (node && isVisible(node)) { input = node; break; }
      }
      if (!input) return { ok: false, error: 'No input found' };

      input.focus();
      input.textContent = '';
      
      // Use execCommand for contenteditable
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, inputText);
      
      return { ok: true };
    })(${JSON.stringify(text)})
  `;
}

/** Send message - Qwen uses Enter key */
function sendScript(): string {
  return 'enter';
}

/** Extract the latest AI answer text from the page. */
function getAnswerScript(): string {
  return `
    (() => {
      const clean = (v) => (v || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // Method A: structured extraction via qk-markdown class
      const markdownEl = document.querySelector('.qk-markdown');
      if (markdownEl) {
        const text = clean(markdownEl.innerText || markdownEl.textContent || '');
        if (text && text.length > 5) return text;
      }

      // Method B: container wrapper approach
      const containerEl = document.querySelector('.containerWrap-x0TwX5, .content-MqQgCb');
      if (containerEl) {
        const text = clean(containerEl.innerText || containerEl.textContent || '');
        if (text && text.length > 5) return text;
      }

      // Method C: full-page text extraction with noise removal
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

/** Check if AI is still generating. */
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

/** Ensure we are on a Qwen chat page. */
async function ensureChatPage(page: IPage): Promise<void> {
  const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
  if (typeof currentUrl === 'string' && currentUrl.includes('qianwen.com/chat')) {
    return;
  }

  // Try to switch to an existing qianwen.com/chat tab
  const rawTabs = await page.tabs().catch(() => []) as any[];
  if (Array.isArray(rawTabs) && rawTabs.length > 0) {
    const qwenTabs = rawTabs.filter((t) =>
      typeof t?.url === 'string' && t.url.includes('qianwen.com/chat')
    );
    if (qwenTabs.length > 0) {
      await page.selectTab(qwenTabs[0].index);
      await page.wait(0.8);
      return;
    }
  }

  await page.goto(QWEN_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
}

export const referencesCommand = cli({
  site: 'qwen',
  name: 'references',
  description: 'Ask Qwen and return the answer with reference sources as JSON',
  domain: 'www.qianwen.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 300,
  args: [
    { name: 'text', required: true, positional: true, help: 'Question to ask Qwen' },
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

    // Send message (Qwen uses Enter key)
    await page.pressKey('Enter');
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

      const requiredStable = streamingDetected ? 4 : 2;
      if (stableCount >= requiredStable) break;
    }

    // Extract reference sources
    // Qwen shows references automatically (no internet search toggle needed)
    await page.wait(2);
    const references = await extractQwenReferences(page);

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
    const saveDir = outPath ? process.cwd() : join(resolvedHome, '.opencli', 'qwen_output');
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = outPath ? join(saveDir, outPath) : join(saveDir, `qwen-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    console.error(`💾 Saved to ${filePath}`);

    return result;
  },
});
