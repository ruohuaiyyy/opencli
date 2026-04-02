/**
 * DOM extraction logic for Doubao web reference sources.
 *
 * DOM structure after expanding "参考 N 篇资料":
 *   - 1 aggregate card (.search-item-transition-FAa3Ce): contains ALL <a> links in order
 *   - N individual cards (.search-item-OXK_4I): title + summary, NO links
 *
 * The aggregate card links and individual cards are in the SAME ORDER.
 * Strategy: pair them by index.
 */

import type { IPage } from '../../types.js';

export interface DoubaoReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

function extractReferencesScript(): string {
  return `
    (() => {
      // Step 1: Get all links from the aggregate card (in order)
      // Each <a> link text structure: "title\\nsummary...\\nSourceName\\nN"
      const aggregateLinks = Array.from(
        document.querySelectorAll('.search-item-transition-FAa3Ce a.search-lIUYwC')
      );

      // Extract source names from aggregate link text
      // Source is the second-to-last line (before the index number)
      const sources = aggregateLinks.map(link => {
        const fullText = (link.innerText || '').trim();
        const lines = fullText.split('\\n').map(l => l.trim()).filter(Boolean);
        // Last line is the index number, second-to-last is the source
        if (lines.length >= 2) {
          const lastLine = lines[lines.length - 1];
          // If last line is a number, source is the line before it
          if (/^\\d+$/.test(lastLine)) {
            return lines[lines.length - 2];
          }
          // Otherwise last line might be the source itself
          return lastLine;
        }
        return '';
      });

      // Step 2: Get individual cards (in order)
      const individualCards = Array.from(
        document.querySelectorAll('.search-item-OXK_4I')
      );

      if (individualCards.length === 0) return [];

      const refs = [];

      individualCards.forEach((card, index) => {
        const titleEl = card.querySelector('.search-item-title-fLDLZw');
        const summaryEl = card.querySelector('.search-item-summary-uNyUB_');

        const title = titleEl?.innerText?.trim() || '';
        const snippet = summaryEl?.innerText?.trim() || '';

        // Match link by index (aggregate card links are in same order as individual cards)
        let url = '';
        let source = '';
        if (index < aggregateLinks.length) {
          url = aggregateLinks[index].href || '';
          source = sources[index] || '';
        }

        if (title || snippet) {
          refs.push({
            index: index + 1,
            title: title || 'Untitled',
            url,
            snippet,
            source,
          });
        }
      });

      return refs;
    })()
  `;
}

export async function extractDoubaoReferences(page: IPage): Promise<DoubaoReference[]> {
  return await page.evaluate(extractReferencesScript()) as DoubaoReference[];
}
