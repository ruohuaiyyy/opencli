/**
 * DOM extraction logic for Qwen web reference sources.
 *
 * DOM structure (verified via Playwright inspection, 2026-04-02):
 *
 *   Reference data lives in a SIDE PANEL, NOT inside .reference-wrap:
 *
 *   .splitCardContainer
 *     > div[id^=":rqf:"]                          ← side panel container
 *       > .deep-think-source-tyxrXL                ← references section
 *         > .list-XPxyL2                            ← list container
 *           > .source-item-mqZd08                   ← each reference item
 *               data-click-extra   → JSON { "ref_url": "https://..." }
 *               data-exposure-extra → JSON { "ref_url": "https://..." }
 *             > .header-uMVjR7
 *                 > .index-Wqr8au                    → "1", "2", ...
 *                 > .title-TP9iyp                    → article title
 *             > .source-kRyJmz
 *                 > img.logo-vzyz1y                  → source icon
 *                 > .name-o0jtvK                     → "今日头条 www.toutiao.com"
 *
 *   The .reference-wrap-iEjeb3 element only contains the collapsed toggle button
 *   ("N篇来源") and does NOT contain reference data even after expansion.
 *   The actual data is rendered in a separate split-card side panel.
 *
 *   IMPORTANT: The side panel is SHARED across all conversations in the session.
 *   To get references for the CURRENT question only, callers must:
 *     1. Call snapshotExistingRefUrls() BEFORE sending the message
 *     2. Call extractNewQwenReferences(beforeUrls) AFTER the answer completes
 */

import type { IPage } from '../../types.js';

export interface QwenReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/**
 * Snapshot existing reference URLs from the side panel.
 * Call this BEFORE sending a new message so we can later filter out stale refs.
 */
function snapshotRefUrlsScript(): string {
  return `
    (() => {
      const items = document.querySelectorAll('.source-item-mqZd08');
      const urls = new Set();
      items.forEach((item) => {
        try {
          const extra = item.getAttribute('data-click-extra') || item.getAttribute('data-exposure-extra') || '';
          if (extra) {
            const parsed = JSON.parse(extra);
            const url = parsed.ref_url || parsed.url || '';
            if (url) urls.add(url);
          }
        } catch (_e) { /* ignore */ }
      });
      return Array.from(urls);
    })()
  `;
}

/**
 * Extract references, excluding any whose URLs were already present before the message was sent.
 */
function extractNewReferencesScript(): string {
  return `
    ((beforeUrls) => {
      const beforeSet = new Set(beforeUrls || []);
      const items = document.querySelectorAll('.source-item-mqZd08');
      if (items.length === 0) return [];

      const refs = [];
      items.forEach((item) => {
        let url = '';
        try {
          const extra = item.getAttribute('data-click-extra') || item.getAttribute('data-exposure-extra') || '';
          if (extra) {
            const parsed = JSON.parse(extra);
            url = parsed.ref_url || parsed.url || '';
          }
        } catch (_e) { /* ignore */ }

        // Skip references that existed before this question was sent
        if (url && beforeSet.has(url)) return;

        // Title
        const titleEl = item.querySelector('.title-TP9iyp');
        const title = titleEl ? (titleEl.textContent || '').trim() : '';

        // Source name (e.g., "今日头条 www.toutiao.com")
        const nameEl = item.querySelector('.name-o0jtvK');
        const source = nameEl ? (nameEl.textContent || '').trim() : '';

        // Index number
        const indexEl = item.querySelector('.index-Wqr8au');
        const rawIndex = indexEl ? (indexEl.textContent || '').trim() : '';

        // Snippet: full text minus title and source
        const fullText = (item.textContent || '').trim();
        let snippet = fullText;
        if (title) snippet = snippet.replace(title, '').trim();
        if (source) snippet = snippet.replace(source, '').trim();
        snippet = snippet.replace(/^\\d+/, '').trim().substring(0, 500);

        if (title || source || url) {
          refs.push({
            index: parseInt(rawIndex, 10) || refs.length + 1,
            title: title.substring(0, 300),
            url,
            snippet,
            source: source.substring(0, 100),
          });
        }
      });

      return refs;
    })
  `;
}

/** Snapshot current ref URLs (call BEFORE sending). */
export async function snapshotExistingRefUrls(page: IPage): Promise<string[]> {
  return await page.evaluate(snapshotRefUrlsScript()) as string[];
}

/** Extract only NEW references that weren't present at snapshot time. */
export async function extractNewQwenReferences(page: IPage, beforeUrls: string[]): Promise<QwenReference[]> {
  const script = extractNewReferencesScript();
  // Embed beforeUrls as JSON argument into the evaluated script
  return await page.evaluate(`${script}(${JSON.stringify(beforeUrls)})`) as QwenReference[];
}

/** Extract all references (no filtering — for backward compat / debugging). */
export async function extractQwenReferences(page: IPage): Promise<QwenReference[]> {
  return await extractNewQwenReferences(page, []);
}
