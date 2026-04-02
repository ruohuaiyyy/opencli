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

    return result;
  },
});
