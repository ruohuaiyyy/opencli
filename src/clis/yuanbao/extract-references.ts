/**
 * DOM extraction logic for Yuanbao web reference sources.
 *
 * DOM structure (confirmed via Playwright inspection):
 *   - Reference panel: .agent-dialogue-references
 *   - List: ul.agent-dialogue-references__list
 *   - Each item: li.agent-dialogue-references__item
 *     - Card: .hyc-common-markdown__ref_card [data-idx] [data-url]
 *       - Source: .hyc-common-markdown__ref_card-foot__source_txt span
 *       - Title: .hyc-common-markdown__ref_card-title span
 *       - Snippet: .hyc-common-markdown__ref_card-desc
 *
 * Unlike Doubao, Yuanbao requires clicking the "源" button to expand references.
 */

import type { IPage } from '../../types.js';

export interface YuanbaoReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

function extractReferencesScript(): string {
  return `
    (() => {
      // Reference panel container
      const panel = document.querySelector('.agent-dialogue-references');
      if (!panel) return [];

      // Reference list items
      const items = panel.querySelectorAll('.agent-dialogue-references__item');
      if (items.length === 0) return [];

      const refs = [];
      items.forEach((item, index) => {
        const card = item.querySelector('.hyc-common-markdown__ref_card');
        if (!card) return;

        const url = card.getAttribute('data-url') || '';
        const sourceEl = card.querySelector('.hyc-common-markdown__ref_card-foot__source_txt span')
          || card.querySelector('.hyc-common-markdown__ref_card-foot__source_txt');
        const titleEl = card.querySelector('.hyc-common-markdown__ref_card-title span')
          || card.querySelector('.hyc-common-markdown__ref_card-title');
        const snippetEl = card.querySelector('.hyc-common-markdown__ref_card-desc');

        const source = sourceEl?.textContent?.trim() || '';
        const title = titleEl?.textContent?.trim() || '';
        const snippet = snippetEl?.textContent?.trim() || '';

        if (title || source) {
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

export async function extractYuanbaoReferences(page: IPage): Promise<YuanbaoReference[]> {
  return await page.evaluate(extractReferencesScript()) as YuanbaoReference[];
}
