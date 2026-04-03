/**
 * DOM extraction logic for DeepSeek web reference sources.
 *
 * DOM structure (confirmed via Playwright MCP inspection, 2026-04-03):
 *
 *   After clicking "N 个网页" button, a side panel appears with heading "搜索结果".
 *   Each reference is a structured card inside a <link> element:
 *
 *   link "大同新闻 2026/03/21 1 标题 摘要"
 *     - /url: http://epaper.dtnews.cn/...
 *     - generic [ref=e814]:
 *       - generic [ref=e815]:
 *         - img
 *         - generic: 大同新闻          ← source
 *         - generic: 2026/03/21        ← date
 *         - generic: "1"               ← index
 *       - generic [ref=e821]: 标题      ← title
 *       - generic [ref=e822]: 摘要      ← snippet
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
 * Extract references from the side panel that appears after clicking "N 个网页".
 * The panel has heading "搜索结果" followed by structured link cards.
 */
function extractReferencesFromPanelScript(): string {
  return `
    ((beforeUrls) => {
      const beforeSet = new Set(beforeUrls || []);
      const refs = [];

      // Find the "搜索结果" heading
      const allEls = Array.from(document.querySelectorAll('*'));
      const heading = allEls.find(el => (el.textContent || '').trim() === '搜索结果');
      if (!heading) return [];

      // Find the container that holds the reference cards
      // The heading is inside a generic, and the cards are in a sibling generic
      const headingContainer = heading.parentElement;
      if (!headingContainer) return [];

      const parentContainer = headingContainer.parentElement;
      if (!parentContainer) return [];

      // Find all link elements with external URLs in the panel
      const links = parentContainer.querySelectorAll('a[href]');
      
      links.forEach((link) => {
        const url = link.href || link.getAttribute('href') || '';
        if (!url || url.startsWith('#')) return;
        if (url.includes('deepseek.com')) return;
        
        // Dedup by base URL
        const baseUrl = url.split('?')[0];
        if (beforeSet.has(baseUrl)) return;
        beforeSet.add(baseUrl);

        // Extract structured data from the link's child generics
        // Structure: link > generic > [generic(source/date/index), generic(title), generic(snippet)]
        const outerGeneric = link.querySelector(':scope > generic, :scope > div, :scope > span');
        if (!outerGeneric) return;

        // Direct children of outerGeneric: [meta, title, snippet]
        const children = outerGeneric.querySelectorAll(':scope > generic, :scope > div, :scope > span');
        if (children.length < 2) return;

        // First child contains: source, date, index
        const metaContainer = children[0];
        const metaChildren = metaContainer.querySelectorAll(':scope > generic, :scope > div, :scope > span');
        
        let source = '';
        let index = 0;

        metaChildren.forEach((child) => {
          const text = (child.textContent || '').trim();
          // Skip date patterns (YYYY/MM/DD or YYYY-MM-DD) — not needed
          if (/^\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2}$/.test(text)) return;
          // Check if it's a number (index)
          if (/^\\d+$/.test(text) && text.length <= 2) {
            index = parseInt(text, 10);
            return;
          }
          // Otherwise it's the source
          if (text && text.length < 50 && !source) {
            source = text;
          }
        });

        // Second child is the title
        const titleEl = children[1];
        const title = (titleEl?.textContent || '').trim();

        // Third child (if exists) is the snippet
        const snippetEl = children[2];
        const snippet = (snippetEl?.textContent || '').trim();

        if (title || source) {
          refs.push({
            index: index || refs.length + 1,
            title: title || 'Untitled',
            url: url,
            snippet: snippet.substring(0, 500),
            source: source,
          });
        }
      });

      // Sort by index
      refs.sort((a, b) => a.index - b.index);
      // Re-index sequentially
      refs.forEach((ref, i) => { ref.index = i + 1; });

      return refs;
    })
  `;
}

/**
 * Click the "N 个网页" button to expand the references panel.
 * Returns true if button was found and clicked.
 */
function clickRefButtonScript(): string {
  return `
    (() => {
      // Find all elements with "N个网页" or "已阅读 N 个网页" text
      const allEls = Array.from(document.querySelectorAll('*'));
      const candidates = allEls.filter(el => {
        const text = (el.textContent || '').trim();
        // Match leaf or near-leaf elements
        if (el.children.length > 5) return false;
        return text.match(/^\\d+\\s*个网页$/) || text.includes('已阅读');
      });

      if (candidates.length === 0) return false;

      // Click the LAST matching element (most recent response)
      const target = candidates[candidates.length - 1];

      // Walk up to find a clickable ancestor
      let clickable = target;
      for (let i = 0; i < 8 && clickable; i++) {
        const style = window.getComputedStyle(clickable);
        if (clickable.onclick != null ||
            clickable.getAttribute('role') === 'button' ||
            clickable.tagName === 'BUTTON' ||
            clickable.tagName === 'A' ||
            style.cursor === 'pointer' ||
            clickable.getAttribute('tabindex') !== null) {
          clickable.click();
          return true;
        }
        clickable = clickable.parentElement;
      }

      // Fallback: dispatch click event
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()
  `;
}

/** Snapshot current ref base URLs (call BEFORE sending). */
export async function snapshotExistingRefUrls(page: IPage): Promise<string[]> {
  return await page.evaluate(`
    (() => {
      const urls = [];
      const allLinks = document.querySelectorAll('a[href]');
      allLinks.forEach(link => {
        const href = link.href || link.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !href.includes('deepseek.com')) {
          urls.push(href.split('?')[0]);
        }
      });
      return [...new Set(urls)];
    })()
  `) as string[];
}

/** Click the ref button and extract references from the side panel. */
export async function extractNewDeepseekReferences(page: IPage, beforeUrls: string[]): Promise<DeepseekReference[]> {
  // Click the "N 个网页" button
  await page.evaluate(clickRefButtonScript());
  await page.wait(3);

  // Extract from the panel
  const script = extractReferencesFromPanelScript();
  return await page.evaluate(`${script}(${JSON.stringify(beforeUrls)})`) as DeepseekReference[];
}

/** Extract all references (no filtering). */
export async function extractDeepseekReferences(page: IPage): Promise<DeepseekReference[]> {
  return await extractNewDeepseekReferences(page, []);
}
