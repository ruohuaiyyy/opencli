/**
 * DOM extraction logic for Qwen web reference sources.
 *
 * DOM structures (verified via Playwright inspection, 2026-04-24):
 *
 *   Structure A (article queries - script tag hydration):
 *     <script type="application/json" data-used-by="hydrate">
 *       JSON with data.originalData.content.list[]
 *         → each item: { title, url/norm_url, author, intro }
 *
 *   Structure B (hotel/booking queries - DOM text):
 *     .deep-think-source-tyxrYL
 *       > .header-imUI9F                        ← "参考来源 (N)"
 *       > .list-XPxyL2
 *         > .source-item-mqZd08                 ← each reference card
 *           > .header-uMVjR7                    ← "数字+标题" (strip leading number for title)
 *           > .source-kRyJmz                    ← "来源名称 域名企业官网" (extract domain for URL)
 *           > .content-SeJpex                   ← 摘要文本
 *
 *   NOTE: Structure B has NO data-* attributes — URL is reconstructed from domain text.
 *   Click handlers are managed by React's internal event system, not standard <a> tags.
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

export interface QwenReferenceDebug {
  refs: QwenReference[];
  debug: {
    method1: { found: number; firstItem: any } | null;
    method2: { found: number; firstItem: any } | null;
    method3: { found: number } | null;
    method4: { itemsFound: number; panelClass: string } | null;
    allScripts: { type: string | null; usedBy: string | null; id: string; hasList: boolean; textLen: number }[];
    allDataExposures: { tag: string; class: string; hasList: boolean }[];
    deepThinkPanelFound: boolean;
  };
  beforeUrls: string[];
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
          const contentList = parsed?.data?.initialData?.content?.list || parsed?.data?.originalData?.content?.list || [];
          for (const item of contentList) {
            const url = item.url || item.norm_url || '';
            if (url) urls.add(url);
          }
        } catch (_e) { /* skip */ }
        if (urls.size > 0) break;
      }

      // Method 2: Extract from embedded JSON in data-exposure-extra (flat structure with ref_url)
      if (urls.size === 0) {
        const dataElements = document.querySelectorAll('[data-exposure-extra]');
        for (const el of dataElements) {
          const exposureData = el.getAttribute('data-exposure-extra') || '';
          if (!exposureData) continue;

          try {
            const parsed = JSON.parse(exposureData);
            // Newer format: flat structure with ref_url at top level
            const url = parsed.ref_url || parsed.url || parsed.norm_url || '';
            if (url) urls.add(url);
          } catch (_e) { /* skip */ }
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

      // Method 4: Extract from .deep-think-source-tyxrYL .source-kRyJmz domain text (verified 2026-04-24)
      if (urls.size === 0) {
        let deepThinkSource = document.querySelector('.deep-think-source-tyxrYL');
        if (!deepThinkSource) {
          const sourceLabel = Array.from(document.querySelectorAll('*')).find(function(el) {
            return (el.textContent || '').trim().match(/^\d+篇来源$/);
          });
          if (sourceLabel && sourceLabel.getAttribute('cursor') === 'pointer') {
            sourceLabel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(function() { sourceLabel && sourceLabel.click(); }, 500);
            const startTime = Date.now();
            while (Date.now() - startTime < 2000) {
              deepThinkSource = document.querySelector('.deep-think-source-tyxrYL');
              if (deepThinkSource) break;
            }
          }
        }
        if (deepThinkSource) {
          const sourceEls = deepThinkSource.querySelectorAll('.source-kRyJmz');
          sourceEls.forEach(function(el) {
            const text = (el.textContent || '').trim();
            const domainMatch = text.match(/([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/);
            if (domainMatch) {
              urls.add('https://' + domainMatch[1]);
            }
          });
        }
      }

      // Method 5: Legacy selector - items with data-click-extra JSON (backward compat)
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
 * Returns { refs, debug } where debug contains diagnostic info.
 */
function extractNewReferencesScript(): string {
  return `
    ((beforeUrls) => {
      const beforeSet = new Set(beforeUrls || []);
      const refs = [];
      const debug = {
        method1: null,
        method2: null,
        method3: null,
        method4: null,
        allScripts: [],
        allDataExposures: [],
        deepThinkPanelFound: false
      };

      // =========================================================
      // IMPORTANT: Extraction priority changed 2026-04-24
      // Web references from expanded panel (Method 2, 4) take
      // precedence over embedded video cards (Method 1).
      // =========================================================

      // ---- Method 2 (PRIMARY): Extract from expanded panel's data-exposure-extra ----
      // Note: data-exposure-extra only contains ref_url. Title and source come from DOM siblings.
      const dataElements = document.querySelectorAll('[data-exposure-extra]');
      debug.allDataExposures = Array.from(dataElements).map(el => ({
        tag: el.tagName,
        class: el.className,
        hasList: (el.getAttribute('data-exposure-extra') || '').includes('"list"')
      }));
      for (const el of dataElements) {
        const exposureData = el.getAttribute('data-exposure-extra') || '';
        if (!exposureData) continue;

        try {
          const parsed = JSON.parse(exposureData);
          // data-exposure-extra only has ref_url, no title/source
          const url = parsed.ref_url || '';

          if (url && beforeSet.has(url)) continue;

          if (url) {
            // Extract title, source, snippet from DOM within .source-item-mqZd08
            let title = '';
            let source = '';
            let snippet = '';
            const container = el.closest('.source-item-mqZd08');
            if (container) {
              // title from .header-uMVjR7 (full text, no stripping)
              const headerEl = container.querySelector('.header-uMVjR7');
              if (headerEl) {
                title = (headerEl.textContent || '').trim();
              }
              // source from .source-kRyJmz
              const sourceEl = container.querySelector('.source-kRyJmz');
              if (sourceEl) {
                source = (sourceEl.textContent || '').trim();
              }
              // snippet from .content-SeJpex
              const contentEl = container.querySelector('.content-SeJpex');
              if (contentEl) {
                snippet = (contentEl.textContent || '').trim();
              }
            }

            debug.method2 = { found: 1, firstItem: { url, title, source } };
            refs.push({
              index: refs.length + 1,
              title: title.substring(0, 300),
              url: url.substring(0, 500),
              snippet: snippet.substring(0, 500),
              source: source.substring(0, 100),
            });
          }
        } catch (_e) { /* skip invalid JSON */ }
      }

      // ---- Method 4 (SECOND): DOM text extraction from expanded panel ----
      if (refs.length === 0) {
        let deepThinkSource = document.querySelector('.deep-think-source-tyxrYL');
        if (!deepThinkSource) {
          const sourceLabel = Array.from(document.querySelectorAll('*')).find(function(el) {
            return (el.textContent || '').trim().match(/^\d+篇来源$/);
          });
          if (sourceLabel) {
            sourceLabel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            sourceLabel.click();
            var startTime = Date.now();
            while (Date.now() - startTime < 5000) {
              deepThinkSource = document.querySelector('.deep-think-source-tyxrYL');
              if (deepThinkSource) break;
            }
          }
        }
        if (deepThinkSource) {
          debug.deepThinkPanelFound = true;
          const items = deepThinkSource.querySelectorAll('.source-item-mqZd08');
          debug.method4 = { itemsFound: items.length, panelClass: deepThinkSource.className };
          items.forEach((item) => {
            const headerEl = item.querySelector('.header-uMVjR7');
            const sourceEl = item.querySelector('.source-kRyJmz');
            const contentEl = item.querySelector('.content-SeJpex');

            let title = '';
            if (headerEl) {
              const headerText = (headerEl.textContent || '').trim();
              title = headerText.replace(/^\d+\s*/, '').trim();
            }

            let source = '';
            let url = '';
            if (sourceEl) {
              const sourceText = (sourceEl.textContent || '').trim();
              const domainMatch = sourceText.match(/([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/);
              if (domainMatch) {
                url = 'https://' + domainMatch[1];
                const domainIndex = sourceText.indexOf(domainMatch[1]);
                source = domainIndex > 0 ? sourceText.substring(0, domainIndex).trim() : sourceText;
              } else {
                source = sourceText;
              }
            }

            let snippet = contentEl ? (contentEl.textContent || '').trim().substring(0, 500) : '';

            if (url && beforeSet.has(url)) return;

            if (title || source || url) {
              refs.push({
                index: refs.length + 1,
                title: title.substring(0, 300),
                url: url.substring(0, 500),
                snippet,
                source: source.substring(0, 100),
              });
            }
          });
        }
      }

      // ---- Method 1 (FALLBACK): Extract from <script type="application/json" data-used-by="hydrate"> ----
      // This extracts embedded video cards, treated as fallback since panel data is preferred.
      if (refs.length === 0) {
        const scriptTags = document.querySelectorAll('script[type="application/json"][data-used-by="hydrate"], script[id^="s-data-card_video"]');
        debug.allScripts = Array.from(scriptTags).map(s => ({
          type: s.getAttribute('type'),
          usedBy: s.getAttribute('data-used-by'),
          id: s.id,
          hasList: (s.textContent || '').includes('"list"'),
          textLen: (s.textContent || '').length
        }));
        for (const script of scriptTags) {
          const text = script.textContent || '';
          if (!text.includes('"list"')) continue;

          try {
            const parsed = JSON.parse(text);
            const contentList =
              parsed?.data?.initialData?.content?.list ||
              parsed?.data?.originalData?.content?.list ||
              [];
            debug.method1 = { found: contentList.length, firstItem: contentList[0] || null };

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

      // Method 3: New selector - items with data-* attributes (last resort)
      if (refs.length === 0) {
        const newItems = document.querySelectorAll('[data-url][data-title]');
        debug.method3 = { found: newItems.length };
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

      return { refs, debug, beforeUrls: Array.from(beforeSet) };
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
  const result = await page.evaluate(`${script}(${JSON.stringify(beforeUrls)})`) as QwenReferenceDebug;

  return result.refs;
}

/** Extract all references with debug info. */
export async function extractNewQwenReferencesWithDebug(page: IPage, beforeUrls: string[]): Promise<QwenReferenceDebug> {
  const script = extractNewReferencesScript();
  return await page.evaluate(`${script}(${JSON.stringify(beforeUrls)})`) as QwenReferenceDebug;
}

/** Extract all references (no filtering — for backward compat / debugging). */
export async function extractQwenReferences(page: IPage): Promise<QwenReference[]> {
  return await extractNewQwenReferences(page, []);
}
