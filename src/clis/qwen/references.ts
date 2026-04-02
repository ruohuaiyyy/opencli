/**
 * Standalone command: ask Qwen and return answer + reference sources as JSON.
 *
 * Uses shared utilities from utils.ts for consistent behavior.
 *
 * Usage:
 *   opencli qwen references "大同旅游景点推荐" -f json
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { extractNewQwenReferences, snapshotExistingRefUrls, type QwenReference } from './extract-references.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getQwenTranscriptLines, sendQwenMessage, waitForQwenResponse } from './utils.js';

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
    const timeout = parseInt(kwargs.timeout as string, 10) || 60;

    console.error('📍 Step 1: Getting transcript lines before sending...');
    const beforeLines = await getQwenTranscriptLines(page);
    console.error(`📍 Found ${beforeLines.length} lines before sending`);

    // Snapshot existing answer text so we don't pick up a previous conversation's response.
    // Qwen's page can have multiple .qk-markdown elements from history;
    // without this snapshot, waitForQwenResponse may return stale content.
    const beforeAnswer = await page.evaluate(`
      (() => {
        const els = document.querySelectorAll('.qk-markdown');
        return els.length > 0 ? (els[els.length - 1].innerText || '').trim() : '';
      })()
    `) as string;
    console.error(`📍 Snapshotted beforeAnswer (${beforeAnswer.length} chars)`);

    // Snapshot existing reference URLs so we can filter out stale ones later.
    // The side panel is shared across all conversations.
    const beforeRefUrls = await snapshotExistingRefUrls(page);
    console.error(`📍 Snapshotted ${beforeRefUrls.length} existing ref URLs`);

    console.error('📍 Step 2: Sending message...');
    const sendMethod = await sendQwenMessage(page, question);
    console.error(`📍 Message sent via: ${sendMethod}`);
    await page.wait(2);

    // Debug: Check what's on the page after sending
    const debugAfterSend = await page.evaluate(`
      (() => {
        const textbox = document.querySelector('[role="textbox"]');
        const markdownEls = document.querySelectorAll('.qk-markdown');
        return {
          textboxContent: textbox?.textContent?.substring(0, 50) || 'empty',
          markdownCount: markdownEls.length,
          hasSendBtn: !!document.querySelector('.operateBtn-ehxNOr'),
        };
      })()
    `) as any;
    console.error('📍 Page state after send:', debugAfterSend);

    console.error(`📍 Step 3: Waiting for response (timeout: ${timeout}s)...`);
    const answer = await waitForQwenResponse(page, beforeLines, question, timeout, beforeAnswer);
    console.error(`📍 Answer received: ${answer ? answer.substring(0, 100) + '...' : 'NONE'}`);

    console.error('📍 Step 4: Expanding reference panel...');
    // CRITICAL: Each answerItem has its own .reference-wrap > .link-title-igf0OC toggle.
    // page.click('.link-title-igf0OC') would click the FIRST match (a PREVIOUS answer's toggle),
    // which would CLOSE an already-open panel instead of opening the current answer's refs.
    // Solution: scope the selector to the LAST (most recent) answerItem.
    try {
      await page.click('.answerItem-sQ6QT6:last-of-type .link-title-igf0OC');
      console.error('📍 Clicked latest answer\'s reference toggle');
    } catch (_clickErr) {
      console.error('📍 Latest toggle not found, trying any visible toggle...');
      // Fallback: try clicking any toggle (for single-conversation or new-chat scenario)
      try {
        await page.click('.link-title-igf0OC');
        console.error('📍 Clicked fallback toggle button');
      } catch (_e) {
        console.error('📍 No reference toggle found (refs may auto-load or question has no search results)');
      }
    }

    // Small pause after click to let the side panel populate
    await page.wait(1);

    // Poll for NEW source items (excluding ones that existed before we sent).
    // Qwen loads references into the shared side panel AFTER the answer completes,
    // and the toggle may need time to fetch/render data.
    let references: QwenReference[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.wait(2);
      references = await extractNewQwenReferences(page, beforeRefUrls);
      if (references.length > 0) break;

      // If still no refs after 6s, try clicking again (panel may have been in wrong state)
      if (attempt === 3 && references.length === 0) {
        try {
          await page.click('.answerItem-sQ6QT6:last-of-type .link-title-igf0OC');
          console.error('📍 Re-attempted toggle click (attempt 2)');
        } catch { /* ignore */ }
      }
    }
    console.error(`📍 Found ${references.length} NEW references (filtered out ${beforeRefUrls.length} stale, polled ${Math.min(10, 10) * 2}s max)`);

    const result = [{
      question,
      answer: answer || `No response received within ${timeout}s.`,
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
