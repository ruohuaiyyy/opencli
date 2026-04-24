/**
 * Standalone command: ask Qwen and return answer + reference sources as JSON.
 *
 * Supports --reuse to continue the last conversation, --chat-id to resume a specific
 * chat, and --account for multi-account isolation.
 *
 * Usage:
 *   opencli qwen references "大同旅游景点推荐" -f json
 *   opencli qwen references "问题" --reuse          # 复用上次会话
 *   opencli qwen references "问题" --chat-id xxx    # 指定会话 ID
 *   opencli qwen references "问题" --account work  # 多账号隔离
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractNewQwenReferences, snapshotExistingRefUrls, type QwenReference } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getQwenTranscriptLines, sendQwenMessage, waitForQwenResponse, ensureQwenChatPage } from './utils.js';
import {
  resolveQwenAccount,
  loadQwenLastChatId,
  saveQwenLastChatId,
  clearQwenLastChatId,
  extractQwenChatId,
} from './account-config.js';

const QWEN_CHAT_URL = 'https://www.qianwen.com/chat';

/** Ensure we are on a Qwen chat page, with optional chat reuse. */
async function ensureChatPage(
  page: IPage,
  options: { reuse?: boolean; chatId?: string } = {}
): Promise<void> {
  const { reuse = false, chatId } = options;

  // If specific chat ID provided, navigate directly to it
  if (chatId) {
    const targetUrl = `${QWEN_CHAT_URL}/${chatId}`;
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

  // Fallback: use existing behavior
  await ensureQwenChatPage(page);
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
    { name: 'reuse', required: false, help: 'Reuse last conversation (default: false)', default: 'false' },
    { name: 'chat-id', required: false, help: 'Specific chat ID to use (overrides --reuse)' },
    { name: 'account', required: false, help: 'Account name for multi-account isolation' },
  ],
  columns: ['question', 'answer', 'references'],
  func: async (page: IPage, kwargs: any) => {
    const question = kwargs.text as string;
    const timeout = parseInt(kwargs.timeout as string, 10) || 60;
    const reuse = kwargs.reuse === 'true' || kwargs.reuse === true;
    const chatId = kwargs['chat-id'] as string | undefined;
    const accountName = (kwargs.account as string | undefined)?.trim() || undefined;

    // Resolve account (creates entry if needed, updates lastUsed) — separate from load/save
    resolveQwenAccount(accountName);

    // Handle reuse: load last chat ID from storage
    if (reuse) {
      const lastChatId = loadQwenLastChatId(accountName);
      if (lastChatId) {
        const targetUrl = `${QWEN_CHAT_URL}/${lastChatId}`;
        await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
        await page.wait(5);
        const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
        if (currentUrl?.includes(lastChatId)) {
          console.error(`📌 Reusing last chat: ${lastChatId}`);
        } else {
          clearQwenLastChatId(accountName);
          console.error(`⚠️ Last chat ${lastChatId} not found, cleared cache`);
          await ensureQwenChatPage(page);
        }
      } else {
        console.error('ℹ️ No saved chat found, using default flow');
        await ensureQwenChatPage(page);
      }
    } else if (chatId) {
      const targetUrl = `${QWEN_CHAT_URL}/${chatId}`;
      await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
      await page.wait(5);
      const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
      if (currentUrl?.includes(chatId)) {
        console.error(`📌 Using specified chat: ${chatId}`);
      } else {
        console.error(`⚠️ Chat ${chatId} not found, falling back to chat home`);
        await ensureQwenChatPage(page);
      }
    } else {
      await ensureQwenChatPage(page);
    }

    // Snapshot state BEFORE sending so we can distinguish new vs stale data later.
    // Qwen's page retains previous conversations, so without snapshots we'd
    // pick up old answers and old reference URLs.
    const beforeLines = await getQwenTranscriptLines(page);
    const beforeAnswer = await page.evaluate(`
      (() => {
        const els = document.querySelectorAll('.qk-markdown');
        return els.length > 0 ? (els[els.length - 1].innerText || '').trim() : '';
      })()
    `) as string;
    const beforeRefUrls = await snapshotExistingRefUrls(page);

    // Send message
    const sendMethod = await sendQwenMessage(page, question);
    await page.wait(2);

    // Wait for answer completion (skips content matching beforeAnswer)
    const answer = await waitForQwenResponse(page, beforeLines, question, timeout, beforeAnswer);

    if (!answer) {
      return [{ question, answer: `No response received within ${timeout}s.`, references: [] }];
    }

    // Expand reference panel for the LATEST answer (not a previous one).
    // Each .answerItem has its own toggle; clicking a previous one would close it.
    try {
      await page.click('.answerItem-sQ6QT6:last-of-type .link-title-igf0OC');
    } catch (_clickErr) {
      try {
        await page.click('.link-title-igf0OC');
      } catch { /* no toggle found */ }
    }
    await page.wait(1);

    // Poll for NEW source items (excluding ones that existed before we sent).
    let references: QwenReference[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.wait(2);
      references = await extractNewQwenReferences(page, beforeRefUrls);
      if (references.length > 0) break;

      // Re-attempt toggle click once if still empty after ~6s
      if (attempt === 3 && references.length === 0) {
        try {
          await page.click('.answerItem-sQ6QT6:last-of-type .link-title-igf0OC');
        } catch { /* ignore */ }
      }
    }

    const result = [{ question, answer, references }];

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

    // Save current chat ID for future reuse
    const currentUrl = await page.evaluate('window.location.href').catch(() => '') as string;
    const id = extractQwenChatId(currentUrl || '');
    if (id) {
      saveQwenLastChatId(id, accountName);
    }

    return result;
  },
});
