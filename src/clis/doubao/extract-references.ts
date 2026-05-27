/**
 * Hybrid extraction logic for Doubao web reference sources.
 *
 * STRATEGY:
 * - Plan A (API Interception): Intercept responses from /im/chain/single to get full 
 *   data (title, url, sitename, summary) from JSON body. Most robust against UI changes.
 * - Plan B (DOM Fallback): Use JS extraction from the new DOM structure 
 *   (div[data-plugin-identifier*="search_query_result_block"]) to get title and URL only.
 *
 * UPDATED (2026-05-26):
 *   - Old DOM structure (a.search-lIUYwC) is gone.
 *   - New DOM structure uses a container div with plugin identifier.
 */

import type { IPage } from '../../types.js';

export interface DoubaoReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/**
 * Inject state scanner: searches all reachable JavaScript state in the page
 * for search query result data (block_type 10025 / search_query_result_block).
 *
 * Why not monkey-patch fetch/XHR/WebSocket?
 * Doubao uses a Service Worker for network requests, which bypasses all
 * window-level monkey-patching. The data IS somewhere in the page's JS memory
 * (React state, Redux store, closure variables). This scanner brute-forces
 * common state locations.
 */
export function injectApiInterceptionScript(): string {
  return `
    (() => {
      if (window.__doubao_search_results) return;
      window.__doubao_search_results = [];

      const seen = new Set();

      function extractSearchResults(raw) {
        if (!raw || seen.has(raw)) return;
        try { seen.add(raw); } catch {}

        try {
          // Direct match: doubao API response envelope
          const messages = raw?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
          for (const msg of messages) {
            const blocks = msg.content_block || [];
            for (const block of blocks) {
              if (block.block_type === 10025) {
                const searchData = block.content?.search_query_result_block;
                if (searchData && searchData.results) {
                  for (const r of searchData.results) {
                    const tc = r.text_card;
                    if (tc) {
                      window.__doubao_search_results.push({
                        index: parseInt(tc.index) || 0,
                        title: tc.title || 'Untitled',
                        url: tc.url || '',
                        snippet: tc.summary || '',
                        source: tc.sitename || '',
                      });
                    }
                  }
                }
              }
            }
          }

          // Also try flattened format (sometimes stored differently in state)
          if (raw.search_query_result_block?.results) {
            for (const r of raw.search_query_result_block.results) {
              const tc = r.text_card;
              if (tc) {
                window.__doubao_search_results.push({
                  index: parseInt(tc.index) || 0,
                  title: tc.title || 'Untitled',
                  url: tc.url || '',
                  snippet: tc.summary || '',
                  source: tc.sitename || '',
                });
              }
            }
          }
        } catch {}
      }

      // 1. Scan window properties (global stores like React state, Redux, etc.)
      function scanWindow() {
        try {
          const keys = Object.keys(window);
          for (const key of keys) {
            try {
              const val = window[key];
              if (!val || typeof val !== 'object') continue;
              // Avoid massive objects (circular refs, DOM trees)
              if (key === 'document' || key === 'location' || key === 'window' || key === 'top' || key === 'self') continue;

              // Scan nested data stores
              if (Array.isArray(val)) {
                for (const item of val) extractSearchResults(item);
              } else {
                extractSearchResults(val);
                // One level deeper
                for (const subKey of Object.keys(val).slice(0, 50)) {
                  try {
                    const subVal = val[subKey];
                    if (subVal && typeof subVal === 'object') extractSearchResults(subVal);
                  } catch {}
                }
              }
            } catch {}
          }
        } catch {}
      }

      // 2. Scan React fiber tree for component state with search results
      function scanReactFibers() {
        try {
          const rootEl = document.getElementById('root') || document.querySelector('#__next') || document.querySelector('#app');
          if (!rootEl) return;
          const key = Object.keys(rootEl).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
          if (!key) return;

          function walkFiber(fiber, depth) {
            if (!fiber || depth > 50) return;
            // Check memoizedState (hooks state chain)
            let state = fiber.memoizedState;
            while (state) {
              if (state.queue?.lastRenderedState) {
                extractSearchResults(state.queue.lastRenderedState);
              }
              if (state.memoizedState) extractSearchResults(state.memoizedState);
              state = state.next;
            }
            // Check pendingProps / memoizedProps
            if (fiber.pendingProps) extractSearchResults(fiber.pendingProps);
            if (fiber.memoizedProps && fiber.memoizedProps !== fiber.pendingProps) extractSearchResults(fiber.memoizedProps);
            // Check stateNode for class components
            if (fiber.stateNode && fiber.stateNode.state) extractSearchResults(fiber.stateNode.state);
            // Traverse child and sibling
            if (fiber.child) walkFiber(fiber.child, depth + 1);
            if (fiber.sibling) walkFiber(fiber.sibling, depth + 1);
          }

          walkFiber(rootEl[key], 0);
        } catch {}
      }

      // 3. Scan redux/devtools stores
      function scanRedux() {
        try {
          // Redux store
          if (window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__) {
            // Redux stores are often accessible via React context
          }
          // Zustand / Pinia / other stores that expose getState
          try {
            const zustandKeys = Object.keys(window).filter(k => k.startsWith('zustand') || k.includes('store') || k.includes('Store'));
            for (const key of zustandKeys) {
              const store = window[key];
              if (store?.getState) extractSearchResults(store.getState());
              if (store?.state) extractSearchResults(store.state);
            }
          } catch {}
        } catch {}
      }

      // 4. Scan Promise state (pending fetch responses in memory)
      function scanPromises() {
        try {
          // Not directly accessible, skip
        } catch {}
      }

      // 5. Periodically re-scan (new data arrives after send)
      function scheduleScan() {
        try {
          scanWindow();
          scanReactFibers();
          scanRedux();
        } catch {}
      }

      // Initial scan
      scheduleScan();

      // Re-scan periodically (every 2s for 30s max)
      let scanCount = 0;
      const scanInterval = setInterval(function() {
        scanCount++;
        if (scanCount > 15) { clearInterval(scanInterval); return; }
        scheduleScan();
      }, 2000);
    })()
  `;
}

/**
 * Get search results from the intercepted API store.
 */
function getInterceptedResultsScript(): string {
  return `
    (() => {
      const results = window.__doubao_search_results || [];
      if (results.length === 0) return [];

      // Sort by index and deduplicate
      const sorted = results.sort((a, b) => a.index - b.index);
      const unique = [];
      const seen = new Set();
      for (const r of sorted) {
        const key = r.url;
        if (!seen.has(key) && r.url) {
          seen.add(key);
          unique.push(r);
        }
      }
      return unique;
    })()
  `;
}

/**
 * Check if API results are available.
 */
export async function checkApiResults(page: IPage): Promise<boolean> {
  const results = await page.evaluate(getInterceptedResultsScript()) as any[];
  return results && results.length > 0;
}

/**
 * Extract from intercepted API results (helper that takes raw results array)
 * Handles both:
 * - Simplified format (already scanned: {index, title, url, snippet, source})
 * - Raw format (straight from API: {text_card: {index, title, url, summary, sitename}})
 */
export function extractFromApiResultsArray(results: any[]): DoubaoReference[] {
  return results.map((r) => {
    // Already in simplified format (from state scanner)
    if (r && typeof r.index === 'number' && r.title && r.url) {
      return {
        index: r.index,
        title: r.title,
        url: r.url,
        snippet: r.snippet || '',
        source: r.source || '',
      };
    }

    // Raw format from API (text_card wrapper)
    const tc = r.text_card;
    if (!tc) {
      return null;
    }
    return {
      index: parseInt(tc.index) || 0,
      title: tc.title || 'Untitled',
      url: tc.url || '',
      snippet: tc.summary || '',
      source: tc.sitename || '',
    };
  }).filter((ref): ref is DoubaoReference => ref !== null);
}

/**
 * Extract from intercepted API results
 */
export async function extractFromApiResults(page: IPage): Promise<DoubaoReference[]> {
  const results = await page.evaluate(getInterceptedResultsScript()) as any[];
  return extractFromApiResultsArray(results);
}

/**
 * Check if reference button exists in the NEW DOM structure.
 *
 * New DOM: div[data-plugin-identifier*="search_query_result_block"]
 * The button is a div.cursor-pointer inside this container.
 */
function checkNewReferenceButtonScript(): string {
  return `
    (() => {
      // Find the container
      const container = document.querySelector('[data-plugin-identifier*="search_query_result_block"]');
      if (!container) return { found: false };

      // Find the clickable element with "参考" text
      const clickable = container.querySelector('.cursor-pointer');
      if (!clickable) return { found: false };

      const text = (clickable.textContent || '').trim();
      if (!text.includes('参考')) return { found: false };

      const match = text.match(/参考\\s*(\\d+)\\s*篇资料/);
      return { found: true, refCount: match ? parseInt(match[1], 10) : 0 };
    })()
  `;
}

/**
 * Click the reference button in the NEW DOM structure to expand the list.
 */
function clickNewReferenceButtonScript(): string {
  return `
    (() => {
      const container = document.querySelector('[data-plugin-identifier*="search_query_result_block"]');
      if (!container) return { clicked: false, error: 'Container not found' };

      const clickable = container.querySelector('.cursor-pointer');
      if (!clickable) return { clicked: false, error: 'Button not found' };

      clickable.click();
      return { clicked: true };
    })()
  `;
}

/**
 * Extract references from the NEW DOM structure (Fallback Plan B).
 *
 * Structure:
 *   div[data-plugin-identifier*="search_query_result_block"]
 *     └─ div.container-SIvZXF (expanded list)
 *          └─ a[href^="http"]
 *               ├─ span (index like "1.")
 *               └─ div (title)
 */
function extractNewDomReferencesScript(): string {
  return `
    (() => {
      const container = document.querySelector('[data-plugin-identifier*="search_query_result_block"]');
      if (!container) return [];

      const links = container.querySelectorAll('a[href^="http"]');
      const refs = [];

      links.forEach((link, domIdx) => {
        const href = (link.href || '').trim();
        if (!href || !href.startsWith('http')) return;

        // Extract index from span
        const indexSpan = link.querySelector('span');
        let index = domIdx + 1; // fallback
        if (indexSpan) {
          const spanText = (indexSpan.textContent || '').trim().replace(/[^0-9]/g, '');
          if (spanText) index = parseInt(spanText, 10);
        }

        // Extract title from the text div
        const titleDiv = link.querySelector('div');
        let title = (link.textContent || '').trim();
        if (titleDiv) title = (titleDiv.textContent || '').trim();

        // Remove the index prefix if present in title (e.g. "1. Title")
        title = title.replace(/^\\d+\\.\\s*/, '').trim() || 'Untitled';

        // Clean URL - remove tracking parameters
        const url = href
          .replace(/&hidePublishButton=true&hideTitle=true/g, '')
          .replace(/&allianceid=\\d+/g, '')
          .replace(/&sid=\\d+/g, '')
          .replace(/\\?$/, '');

        refs.push({
          index,
          title,
          url,
          snippet: '', // Not available in DOM
          source: '',  // Not available in DOM
        });
      });

      return refs.sort((a, b) => a.index - b.index);
    })()
  `;
}

/**
 * Main extraction function: Hybrid approach.
 * 1. Try API results first (full data).
 * 2. Fallback to DOM extraction (title + url only).
 */
export async function extractDoubaoReferences(page: IPage): Promise<DoubaoReference[]> {
   // Check API results first
   const results = await page.evaluate(`(() => window.__doubao_search_results || [])`) as any[];
   if (results && results.length > 0) {
     return extractFromApiResultsArray(results);
   }

   // Fallback: DOM extraction
   const btnInfo = await page.evaluate(checkNewReferenceButtonScript()) as { found: boolean };
   
   if (!btnInfo.found) {
     return [];
   }

   // Click to expand references in DOM
   const clickResult = await page.evaluate(clickNewReferenceButtonScript()) as { clicked?: boolean; error?: string };
   if (!clickResult?.clicked) {
     return [];
   }

   // Wait for expansion
   await page.wait(2);

   // Extract from DOM
   const domRefs = await page.evaluate(extractNewDomReferencesScript()) as DoubaoReference[];

   // Retry if empty
   if (domRefs.length === 0) {
     for (let i = 0; i < 3; i++) {
       await page.wait(2);
       const retryRefs = await page.evaluate(extractNewDomReferencesScript()) as DoubaoReference[];
       if (retryRefs.length > 0) {
         return retryRefs;
       }
     }
   }

   return domRefs;
 }

/**
 * Check if reference button exists (Hybrid: API or DOM).
 * Prioritizes API detection but falls back to DOM check.
 */
export async function checkReferenceButton(page: IPage): Promise<{ found: boolean; refCount?: number }> {
  // Method 1: Check API
  const apiResults = await page.evaluate(getInterceptedResultsScript()) as any[];
  if (apiResults && apiResults.length > 0) {
    return { found: true, refCount: apiResults.length };
  }

  // Method 2: Check DOM
  const result = await page.evaluate(checkNewReferenceButtonScript()) as {
    found: boolean;
    refCount?: number;
  };
  return { found: result.found, refCount: result.refCount };
}

/**
 * Extract search keywords from the expanded search_query_result_block.
 * After clicking the reference button, keywords appear in a div with
 * class "mb-8 text-sm text-dbx-neutral-400" inside the container.
 * Format: "keyword1"、"keyword2"、"keyword3"
 *
 * Must be called AFTER clicking the reference button to expand the section.
 */
function extractKeywordsScript(): string {
  return `
    (() => {
      const container = document.querySelector('[data-plugin-identifier*="search_query_result_block"]');
      if (!container) return [];

      // Keywords are in a div with text-dbx-neutral-400 class, before the references list
      const keywordDiv = container.querySelector('.mb-8.text-sm.text-dbx-neutral-400, .mb-8.text-dbx-neutral-400');
      if (!keywordDiv) return [];

      const rawText = (keywordDiv.textContent || '').trim();
      if (!rawText) return [];

      // Parse keywords from format: "K1"、"K2"、"K3"
      // Split by Chinese enumeration comma (\u3001) and clean up
      return rawText
        .split(/[\u3001，,]+/)
        .map(k => k.replace(/[""""]/g, '').trim())
        .filter(k => k.length > 0);
    })()
  `;
}

/**
 * Extract search keywords from the page (must be called after clicking reference button).
 * Returns empty array if not yet expanded or no keywords found.
 */
export async function extractDoubaoKeywords(page: IPage): Promise<string[]> {
  return await page.evaluate(extractKeywordsScript()) as string[];
}
