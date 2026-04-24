/**
 * DOM extraction logic for Qwen web reference sources.
 *
 * DOM structure (verified via Playwright inspection, 2026-04-24):
 *
 *   Reference data is rendered in the .splitCardContainer below the answer:
 *
 *   .splitCardContainer
 *     > .ref-cite-wrapper-A69wZp               ← new container (was sSfK3h)
 *       > .ref-cite-item-bh0ojo                ← each reference item (was mqZd08)
 *           data-url       → "https://..."     ← direct URL attribute
 *           data-title     → "参考标题"
 *           data-source    → "来源名称"
 *           data-abstract  → "摘要内容"
 *       > .ref-cite-item-bh0ojo
 *       > ...
 *       > div                                  ← "N篇来源" label
 *
 *   NOTE: References are rendered inline with data-* attributes, not in data-click-extra JSON.
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
      const urls = new Set();
      
      // Method 1: Extract from <script type="application/json" data-used-by="hydrate">
      const scriptTags = document.querySelectorAll('script[type="application/json"][data-used-by="hydrate"], script[id^="s-data-card_video"]');
      for (const script of scriptTags) {
        const text = script.textContent || '';
        if (!text.includes('"list"')) continue;
        
        try {
          const parsed = JSON.parse(text);
          const contentList = parsed?.data?.originalData?.content?.list || [];
          for (const item of contentList) {
            const url = item.url || item.norm_url || '';
            if (url) urls.add(url);
          }
        } catch (_e) { /* skip */ }
        if (urls.size > 0) break;
      }
      
      // Method 2: Extract from embedded JSON in data-exposure-extra
      if (urls.size === 0) {
        const dataElements = document.querySelectorAll('[data-exposure-extra]');
        for (const el of dataElements) {
          const exposureData = el.getAttribute('data-exposure-extra') || '';
          if (!exposureData || !exposureData.includes('"list"')) continue;
          
          try {
            const parsed = JSON.parse(exposureData);
            const contentList = parsed?.data?.originalData?.content?.list || [];
            for (const item of contentList) {
              const url = item.url || item.norm_url || '';
              if (url) urls.add(url);
            }
          } catch (_e) { /* skip */ }
          if (urls.size > 0) break;
        }
      }
      
      // Method 3: New selector - items with data-url attribute
      if (urls.size === 0) {
        const newItems = document.querySelectorAll('[data-url][data-title]');
        newItems.forEach((item) => {
          const url = item.getAttribute('data-url') || '';
          if (url) urls.add(url);
        });
      }
      
      // Method 4: Legacy selector - items with data-click-extra JSON (backward compat)
      if (urls.size === 0) {
        const legacyItems = document.querySelectorAll('.source-item-mqZd08, [data-click-extra]');
        legacyItems.forEach((item) => {
          try {
            const extra = item.getAttribute('data-click-extra') || item.getAttribute('data-exposure-extra') || '';
            if (extra) {
              const parsed = JSON.parse(extra);
              const url = parsed.ref_url || parsed.url || '';
              if (url) urls.add(url);
            }
          } catch (_e) { /* ignore */ }
        });
      }
      
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
      const refs = [];
      
      // Method 1: Extract from <script type="application/json" data-used-by="hydrate"> (verified 2026-04-24)
      // Qwen embeds reference data as JSON in script tags for hydration
      const scriptTags = document.querySelectorAll('script[type="application/json"][data-used-by="hydrate"], script[id^="s-data-card_video"]');
      for (const script of scriptTags) {
        const text = script.textContent || '';
        if (!text.includes('"list"')) continue;
        
        try {
          const parsed = JSON.parse(text);
          const contentList = parsed?.data?.originalData?.content?.list || [];
          
          for (const item of contentList) {
            const url = item.url || item.norm_url || '';
            const title = item.title || '';
            const source = item.author || '';
            const snippet = item.intro || item.title || '';  // Fallback to title if intro is empty
            
            // Skip references that existed before
            if (url && beforeSet.has(url)) continue;
            
            if (title || url) {
              refs.push({
                index: refs.length + 1,
                title: title.substring(0, 300),
                url: url.substring(0, 500),
                snippet: snippet.substring(0, 500),
                source: source.substring(0, 100),
              });
            }
          }
        } catch (_e) { /* skip invalid JSON */ }
        
        // Stop after finding valid data to avoid duplicates
        if (refs.length > 0) break;
      }
      
      // Method 2: Extract from embedded JSON in data-exposure-extra (fallback)
      if (refs.length === 0) {
        const dataElements = document.querySelectorAll('[data-exposure-extra]');
        for (const el of dataElements) {
          const exposureData = el.getAttribute('data-exposure-extra') || '';
          if (!exposureData || !exposureData.includes('"list"')) continue;
          
          try {
            const parsed = JSON.parse(exposureData);
            const contentList = parsed?.data?.originalData?.content?.list || [];
            
            for (const item of contentList) {
              const url = item.url || item.norm_url || '';
              const title = item.title || '';
              const source = item.author || '';
              const snippet = item.intro || '';
              
              if (url && beforeSet.has(url)) continue;
              
              if (title || url) {
                refs.push({
                  index: refs.length + 1,
                  title: title.substring(0, 300),
                  url: url.substring(0, 500),
                  snippet: snippet.substring(0, 500),
                  source: source.substring(0, 100),
                });
              }
            }
          } catch (_e) { /* skip invalid JSON */ }
          
          if (refs.length > 0) break;
        }
      }
      
      // Method 3: New selector - items with data-* attributes (fallback)
      if (refs.length === 0) {
        const newItems = document.querySelectorAll('[data-url][data-title]');
        newItems.forEach((item) => {
          const url = item.getAttribute('data-url') || '';
          const title = (item.getAttribute('data-title') || '').trim();
          const source = (item.getAttribute('data-source') || '').trim();
          const snippet = (item.getAttribute('data-abstract') || '').trim();
          
          if (url && beforeSet.has(url)) return;
          
          if (title || source || url) {
            refs.push({
              index: refs.length + 1,
              title: title.substring(0, 300),
              url,
              snippet: snippet.substring(0, 500),
              source: source.substring(0, 100),
            });
          }
        });
      }
      
      // Method 4: Legacy selector - items with data-click-extra JSON (backward compat)
      if (refs.length === 0) {
        const legacyItems = document.querySelectorAll('.source-item-mqZd08');
        legacyItems.forEach((item) => {
          let url = '';
          try {
            const extra = item.getAttribute('data-click-extra') || item.getAttribute('data-exposure-extra') || '';
            if (extra) {
              const parsed = JSON.parse(extra);
              url = parsed.ref_url || parsed.url || '';
            }
          } catch (_e) { /* ignore */ }
          
          if (url && beforeSet.has(url)) return;
          
          const titleEl = item.querySelector('.title-TP9iyp');
          const title = titleEl ? (titleEl.textContent || '').trim() : '';
          const nameEl = item.querySelector('.name-o0jtvK');
          const source = nameEl ? (nameEl.textContent || '').trim() : '';
          const indexEl = item.querySelector('.index-Wqr8au');
          const rawIndex = indexEl ? (indexEl.textContent || '').trim() : '';
          const fullText = (item.textContent || '').trim();
          let snippet = fullText;
          if (title) snippet = snippet.replace(title, '').trim();
          if (source) snippet = snippet.replace(source, '').trim();
          snippet = snippet.substring(0, 500);
          
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
      }
      
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
