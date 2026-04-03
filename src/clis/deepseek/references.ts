/**
 * Standalone command: ask DeepSeek and return answer + reference sources as JSON.
 *
 * Fully independent — implements its own page navigation, input injection, send,
 * response polling, and reference card extraction.
 *
 * Usage:
 *   opencli deepseek references "大同旅游景点推荐" -f json
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractNewDeepseekReferences, snapshotExistingRefUrls, type DeepseekReference } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDeepseekChatPage, enableDeepseekInternetSearch } from './utils.js';

const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com';

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

      // Method A: structured extraction - get AI response paragraphs
      // DeepSeek places AI responses in containers with paragraphs
      const paragraphs = document.querySelectorAll('p, [class*="markdown"], [class*="message-content"]');
      if (paragraphs.length > 0) {
        const texts = Array.from(paragraphs)
          .map(p => clean(p.innerText || p.textContent || ''))
          .filter(t => t && t.length > 5);
        if (texts.length > 0) return clean(texts.join('\\n'));
      }

      // Method B: full page extraction with minimal cleanup
      const root = document.body.cloneNode(true);
      [
        '[class*="sidebar"]',
        '[class*="chat-input"]',
        '[class*="input-box"]',
        '[class*="nav"]',
        '[class*="header"]',
        '[class*="搜索结果"]',
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
  ],
  columns: ['question', 'answer', 'references'],
  func: async (page: IPage, kwargs: any) => {
    const question = kwargs.text as string;
    const timeout = parseInt(kwargs.timeout as string, 10) || 300;

    await ensureDeepseekChatPage(page);
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

    return result;
  },
});
