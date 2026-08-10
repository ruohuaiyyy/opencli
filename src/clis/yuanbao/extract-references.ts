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

/** Inline badge reference embedded in AI answer text. */
export interface YuanbaoInlineBadge {
  text: string;
  title: string;
  url: string;
  source: string;
  context: string;
  icon?: string;
  docId?: string;
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

/**
 * Extract inline reference badges from AI answer text.
 * Badges are .hyc-common-markdown__ref-list__trigger elements with data-idx-list.
 * Data comes from React fiber tree's docList prop.
 * Returns [] if no badges exist.
 */
function extractInlineBadgesScript(): string {
  return `
    (() => {
      const triggers = document.querySelectorAll('.hyc-common-markdown__ref-list__trigger');
      if (!triggers.length) return [];
      const results = [];

      for (const trigger of triggers) {
        const idxListStr = trigger.getAttribute('data-idx-list');
        if (!idxListStr) continue;
        const idxList = idxListStr.split(',').map(Number);

        const fiberKey = Object.keys(trigger).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!fiberKey) continue;

        let current = trigger[fiberKey];
        let depth = 0;
        let docList = null;

        while (current && depth < 15) {
          if (current.memoizedProps && current.memoizedProps.docList) {
            docList = current.memoizedProps.docList;
            break;
          }
          current = current.return;
          depth++;
        }

        if (!docList) continue;

        // Extract context from the trigger's parent text content
        const parent = trigger.parentElement;
        let context = '';
        if (parent) {
          let beforeText = '';
          let afterText = '';
          let found = false;
          for (const child of parent.childNodes) {
            if (child === trigger) { found = true; continue; }
            if (!found) { beforeText += child.textContent || ''; }
            else { afterText += child.textContent || ''; }
          }
          context = (beforeText + afterText).trim();
        }

        for (const idx of idxList) {
          const doc = docList[idx - 1];
          if (!doc) continue;

          results.push({
            text: doc.web_site_name || doc.title || '',
            title: doc.title || '',
            url: doc.url || '',
            source: doc.web_site_name || '',
            context,
            icon: doc.icon_url || '',
            docId: doc.docId || '',
          });
        }
      }

      return results;
    })()
  `;
}

export async function extractYuanbaoInlineBadges(page: IPage): Promise<YuanbaoInlineBadge[]> {
  try {
    const badges = await page.evaluate(extractInlineBadgesScript()) as YuanbaoInlineBadge[];
    return badges || [];
  } catch {
    return [];
  }
}

