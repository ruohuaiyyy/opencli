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
import { extractYuanbaoReferences, extractYuanbaoInlineBadges } from './extract-references.js';
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

/** Inject text into Yuanbao chat input.
 *
 * New Yuanbao UI (verified 2026-08): input is a Quill editor
 * (`.ql-editor[contenteditable="true"]`), no more textarea.
 * execCommand('insertText') + input event updates Quill state correctly.
 */
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
        '.ql-editor[contenteditable="true"]',
        'textarea[placeholder*="输入"]',
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
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { ok: true };
    })()
  `;
}

/** Send the composed message.
 *
 * New Yuanbao UI (verified 2026-08): the send button
 * (`[data-new-input-control="send"]`) ignores synthetic DOM events, but a
 * synthetic Enter keydown on the focused Quill editor DOES send. Always
 * return 'enter' for the new UI; legacy button-click path kept for the
 * old textarea UI in case it is still deployed somewhere.
 */
function sendScript(): string {
  return `
    (() => {
      // New UI: Quill editor — signal caller to press Enter on the editor
      const editor = document.querySelector('.ql-editor[contenteditable="true"]');
      if (editor && editor.getBoundingClientRect().width > 0) return 'enter';

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

/** Extract the latest AI answer text from the page.
 *
 * DOM structure (confirmed via Playwright inspection):
 *   .agent-chat__list__content-wrapper
 *     └─ .agent-chat__list__content  (contains ALL messages)
 *          ├─ .agent-chat__list__item.agent-chat__list__item--human  (user msg)
 *          │    └─ .agent-chat__list__item__content
 *          ├─ .agent-chat__list__item.agent-chat__list__item--ai     (AI reply)
 *          │    └─ .agent-chat__list__item__content
 *          ├─ ... more messages ...
 *          └─ .agent-chat__list__placeholder
 *
 * We need the LAST .agent-chat__list__item--ai's .agent-chat__list__item__content.
 */
function getAnswerScript(): string {
  return `
    (() => {
      const clean = (v) => (v || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // Method A: get the LAST AI message's content.
      // Each message is .agent-chat__list__item with --human or --ai modifier.
      const aiItems = document.querySelectorAll('.agent-chat__list__item--ai');
      if (aiItems.length > 0) {
        const lastAi = aiItems[aiItems.length - 1];
        const content = lastAi.querySelector('.agent-chat__list__item__content');
        if (content) {
          const text = clean(content.innerText || content.textContent || '');
          if (text && text.length > 5) return text;
        }
      }

      // Method B: fallback - try alternative selectors
      const altSelectors = [
        '.agent-chat__list__item--last .agent-chat__list__item__content',
        '.agent-chat__list__item:last-child .agent-chat__list__item__content',
      ];

      for (const sel of altSelectors) {
        const all = document.querySelectorAll(sel);
        const el = all.length > 0 ? all[all.length - 1] : null;
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

/** Check if AI is still generating.
 *
 * New Yuanbao UI (verified 2026-08): the last conversation item carries
 * `data-conv-outputting="true"` while streaming and flips to "false" with
 * `data-conv-status="finished"/"stopped"` when done — far more reliable
 * than class-name heuristics. Legacy class checks kept as fallback.
 */
function isStreamingScript(): string {
  return `
    (() => {
      // New UI: authoritative per-message state attributes
      const items = document.querySelectorAll('.agent-chat__list__item[data-conv-speaker="ai"]');
      const lastAi = items.length > 0 ? items[items.length - 1] : null;
      if (lastAi) {
        if (lastAi.getAttribute('data-conv-outputting') === 'true') return true;
        const status = lastAi.getAttribute('data-conv-status');
        if (status === 'finished' || status === 'stopped') return false;
      }

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

    // Check if input is ready — poll up to 15 seconds
    const inputReady = await page.evaluate(`
      (() => {
        const selectors = [
          '.ql-editor[contenteditable="true"]',
          'textarea[placeholder*="输入"]',
          'textarea[placeholder*="发消息"]',
          '[contenteditable="true"]',
          'textarea',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetHeight > 0) return true;
        }
        return false;
      })()
    `) as boolean;

    if (!inputReady) {
      const maxWaits = 30;
      let ready = false;
      for (let i = 0; i < maxWaits; i++) {
        await page.wait(0.5);
        const check = await page.evaluate(`
          (() => {
            const el = document.querySelector('.ql-editor[contenteditable="true"], textarea[placeholder*="输入"], [contenteditable="true"], textarea');
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
          inline_references: [],
          error: 'Yuanbao chat input not ready after 15s. Page may have failed to load.',
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
        inline_references: [],
        error: fillResult?.error || 'Failed to inject question',
      }];
    }
    await page.wait(0.5);

    // Enable internet search to get reference sources.
    // New UI (verified 2026-08): "+" menu → 联网搜索 menuitem. Enabled state
    // shows as a chip button with aria-label="联网搜索 remove".
    await page.evaluate(`
      (() => {
        // Already enabled? (chip with remove affordance stays in the input row)
        const alreadyOn = document.querySelector('button[aria-label="${'联网搜索'} remove"]');
        if (alreadyOn) return 'already-on';

        // Open the add-tools popover
        const trigger = document.querySelector('[data-new-input-control="add-tools-trigger"]');
        if (!trigger) return 'no-trigger';
        trigger.click();
        return 'opened';
      })()
    `);
    await page.wait(1);
    await page.evaluate(`
      (() => {
        // Click the 联网搜索 menuitem (match via escaped unicode to survive transport)
        const label = String.fromCharCode(0x8054, 0x7F51, 0x641C, 0x7D22);
        const menu = document.querySelector('[data-new-input-control="add-tools"] [role="menu"]');
        if (!menu) return 'no-menu';
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        const target = items.find(el => (el.textContent || '').indexOf(label) !== -1);
        if (!target) return 'no-item';
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(t =>
          target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
        return 'clicked';
      })()
    `);
    await page.wait(0.8);

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
    // New UI (verified 2026-08): #search-guide-tool inside the LAST AI message.
    // Must scrollIntoView first — old messages keep their own 源 buttons, and
    // without scoping the panel shows the wrong (older) reference set.
    await page.wait(1.5);
    await page.evaluate(`
      (() => {
        const aiItems = document.querySelectorAll('.agent-chat__list__item--ai');
        const lastAiItem = aiItems.length > 0 ? aiItems[aiItems.length - 1] : null;

        // New UI: citation toolbar button scoped to the last AI message
        if (lastAiItem) {
          const tools = lastAiItem.querySelectorAll('#search-guide-tool');
          const tool = tools.length > 0 ? tools[tools.length - 1] : null;
          if (tool) {
            tool.scrollIntoView({ block: 'center' });
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(t =>
              tool.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
            return 'new-ui-clicked';
          }
        }

        // Legacy UI fallback: find the leaf "源" text in the last AI message
        const yuanText = String.fromCharCode(0x6E90);
        const scope = lastAiItem || document;
        const leaves = Array.from(scope.querySelectorAll('*')).filter(el =>
          el.children.length === 0
          && (el.textContent || '').trim() === yuanText
          && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
        );
        const btn = leaves[leaves.length - 1];
        if (!btn) return 'no-source-button';

        let clickable = btn;
        for (let i = 0; i < 5 && clickable; i++) {
          if (clickable.onclick || clickable.getAttribute('role') === 'button'
            || (clickable.className || '').includes('cursor') || clickable.style?.cursor === 'pointer') {
            clickable.click();
            return 'legacy-clicked';
          }
          clickable = clickable.parentElement;
        }
        btn.click();
        return 'legacy-leaf-clicked';
      })()
    `);
    await page.wait(2);

    // Extract reference sources
    const references = await extractYuanbaoReferences(page);

    // Extract inline badges from AI answer text (may be empty if no badges exist)
    const inlineBadges = await extractYuanbaoInlineBadges(page);

    const result = [{
      question,
      answer: answer || 'No response received within timeout.',
      references,
      inline_references: inlineBadges,
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