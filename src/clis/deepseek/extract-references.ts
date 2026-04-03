/**
 * DOM extraction logic for DeepSeek web reference sources.
 *
 * DOM structure (confirmed via Playwright MCP inspection, 2026-04-03):
 *
 *   DeepSeek does NOT use a separate reference panel.
 *   References are INLINE links embedded in the AI response text.
 *
 *   Each reference appears as a <a> element within paragraphs, table cells, etc:
 *     link "- 10" [ref=e224]:
 *       /url: https://www.sohu.com/a/1004961036_...
 *       - generic: "-"
 *       - generic: "10"
 *
 *   The reference number (e.g., "10") is the citation index.
 *   The same URL may appear multiple times in the text (same ref number).
 *   There is NO "搜索结果" heading or side panel — clicking "N个网页" 
 *   does NOT expand anything visible in the ARIA tree.
 *
 *   Strategy: Extract all unique external URLs from the page, 
 *   deduplicate by base URL, and collect context for each.
 */

import type { IPage } from '../../types.js';

export interface DeepseekReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/**
 * Extract all external reference URLs from the page.
 * DeepSeek embeds references as inline links in the AI response text.
 * We collect unique URLs and their surrounding context.
 */
function extractReferencesScript(): string {
  return `
    ((beforeUrls) => {
      const beforeSet = new Set(beforeUrls || []);
      const urlMap = new Map(); // url -> { index, url, context, source }

      // Find all link elements with external URLs
      const allLinks = document.querySelectorAll('a[href]');
      
      allLinks.forEach(link => {
        const url = link.href || link.getAttribute('href') || '';
        if (!url || url.startsWith('#')) return;
        // Skip internal DeepSeek links
        if (url.includes('deepseek.com') || url.includes('chat.deepseek')) return;
        // Skip URLs that existed before this question
        if (beforeSet.has(url)) return;

        // Get the reference number from the link text (e.g., "10" from "- 10")
        const linkText = (link.textContent || '').trim();
        const refNum = parseInt(linkText.replace(/^[-\\s]*/, ''), 10);

        // Get surrounding context from the closest paragraph/cell
        const parent = link.closest('p, td, th, li, blockquote');
        const context = parent ? (parent.textContent || '').trim() : '';

        // Use base URL (without query params) as the dedup key
        const baseUrl = url.split('?')[0];

        if (urlMap.has(baseUrl)) {
          const existing = urlMap.get(baseUrl);
          // Keep the highest ref number and longest context
          if (!isNaN(refNum) && refNum > existing.index) existing.index = refNum;
          if (context.length > existing.snippet.length) existing.snippet = context;
        } else {
          // Try to extract source from URL domain
          let source = '';
          try {
            const urlObj = new URL(url);
            source = urlObj.hostname.replace(/^www\\./, '').replace(/^m\\./, '');
          } catch { /* ignore */ }

          urlMap.set(baseUrl, {
            index: isNaN(refNum) ? urlMap.size + 1 : refNum,
            url: url,
            snippet: context,
            source: source,
          });
        }
      });

      // Convert to array and sort by index
      const refs = Array.from(urlMap.values())
        .sort((a, b) => a.index - b.index)
        .map((ref, i) => ({
          index: i + 1,
          title: ref.snippet.substring(0, 100).replace(/-\\s*\\d+\\s*$/g, '').trim() || 'Untitled',
          url: ref.url,
          snippet: ref.snippet.substring(0, 500),
          source: ref.source,
        }));

      return refs;
    })
  `;
}

/** Snapshot current ref URLs (call BEFORE sending). */
export async function snapshotExistingRefUrls(page: IPage): Promise<string[]> {
  return await page.evaluate(`
    (() => {
      const urls = [];
      const allLinks = document.querySelectorAll('a[href]');
      allLinks.forEach(link => {
        const href = link.href || link.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !href.includes('deepseek.com') && !href.includes('chat.deepseek')) {
          urls.push(href.split('?')[0]); // Use base URL for comparison
        }
      });
      return [...new Set(urls)];
    })()
  `) as string[];
}

/** Extract only NEW references that weren't present at snapshot time. */
export async function extractNewDeepseekReferences(page: IPage, beforeUrls: string[]): Promise<DeepseekReference[]> {
  const script = extractReferencesScript();
  return await page.evaluate(`${script}(${JSON.stringify(beforeUrls)})`) as DeepseekReference[];
}

/** Extract all references (no filtering — for backward compat / debugging). */
export async function extractDeepseekReferences(page: IPage): Promise<DeepseekReference[]> {
  return await extractNewDeepseekReferences(page, []);
}
