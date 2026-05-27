/**
 * DOM extraction logic for Doubao web reference sources.
 *
 * Uses JS extraction from the DOM structure:
 *   div[data-plugin-identifier*="search_query_result_block"]
 *
 * UPDATED (2026-05-27):
 *   - API interception removed, pure DOM extraction only.
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
 * Check if reference button exists in the DOM structure.
 *
 * DOM: div[data-plugin-identifier*="search_query_result_block"]
 * The button is a div.cursor-pointer inside this container.
 */
function checkReferenceButtonScript(): string {
  return `
    (() => {
      const container = document.querySelector('[data-plugin-identifier*="search_query_result_block"]');
      if (!container) return { found: false };

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
 * Click the reference button to expand the list.
 */
function clickReferenceButtonScript(): string {
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
 * Extract references from the DOM structure.
 *
 * Structure:
 *   div[data-plugin-identifier*="search_query_result_block"]
 *     └─ div.container-SIvZXF (expanded list)
 *          └─ a[href^="http"]
 *               ├─ span (index like "1.")
 *               └─ div (title)
 */
function extractReferencesScript(): string {
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
 * Main extraction function: pure DOM extraction.
 * 1. Find and click the reference button to expand.
 * 2. Extract references from the expanded DOM.
 */
export async function extractDoubaoReferences(page: IPage): Promise<DoubaoReference[]> {
  const btnInfo = await page.evaluate(checkReferenceButtonScript()) as { found: boolean };

  if (!btnInfo.found) {
    return [];
  }

  // Click to expand references
  const clickResult = await page.evaluate(clickReferenceButtonScript()) as { clicked?: boolean; error?: string };
  if (!clickResult?.clicked) {
    return [];
  }

  // Wait for expansion
  await page.wait(2);

  // Extract from DOM
  const refs = await page.evaluate(extractReferencesScript()) as DoubaoReference[];

  // Retry if empty
  if (refs.length === 0) {
    for (let i = 0; i < 3; i++) {
      await page.wait(2);
      const retryRefs = await page.evaluate(extractReferencesScript()) as DoubaoReference[];
      if (retryRefs.length > 0) {
        return retryRefs;
      }
    }
  }

  return refs;
}

/**
 * Check if reference button exists.
 */
export async function checkReferenceButton(page: IPage): Promise<{ found: boolean; refCount?: number }> {
  const result = await page.evaluate(checkReferenceButtonScript()) as {
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

      const keywordDiv = container.querySelector('.mb-8.text-sm.text-dbx-neutral-400, .mb-8.text-dbx-neutral-400');
      if (!keywordDiv) return [];

      const rawText = (keywordDiv.textContent || '').trim();
      if (!rawText) return [];

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
