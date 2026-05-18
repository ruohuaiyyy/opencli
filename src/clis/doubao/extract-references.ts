/**
 * DOM extraction logic for Doubao web reference sources.
 *
 * UPDATED (2026-05-18):
 *   - References are INLINE in the answer content (NOT in a sidebar)
 *   - Each reference item: a.search-lIUYwC (link) + span.footer-citation-PN73AP (index)
 *   - The "参考 N 篇资料" button EXPANDS/COLLAPSES the inline references
 *   - When expanded: references are visible inline in the answer
 *   - When collapsed: references are hidden (display:none)
 *
 * DOM structure:
 *   div.search-item-transition-FAa3Ce (reference card)
 *     └─ a.search-lIUYwC (link with href=URL, text=title+snippet)
 *     └─ div.search-item-footer-b0INFL (footer with citation)
 *          └─ span.footer-citation-PN73AP (index number like "1", "2", etc.)
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
 * Check if the reference button exists and get its status.
 *
 * The button has text "参考 N 篇资料" and is clickable.
 * After clicking, the inline references in the answer become visible.
 */
function checkReferenceButtonScript(): string {
  return `
    (() => {
      let btn = null;
      let method = '';

      // Strategy 1: span with class containing "entry-btn-title" and exact text
      const spans = Array.from(document.querySelectorAll('span[class*="entry-btn-title"]'));
      btn = spans.find(el => {
        const text = (el.innerText || '').trim();
        return /^参考\\s*\\d+\\s*篇资料$/.test(text);
      });
      method = 'span-entry-btn-title';

      // Strategy 2: button with class containing "entry-btn"
      if (!btn) {
        const buttons = Array.from(document.querySelectorAll('button[class*="entry-btn"]'));
        btn = buttons.find(el => {
          const text = (el.innerText || '').trim();
          return /^参考\\s*\\d+\\s*篇资料$/.test(text);
        });
        method = 'button-entry-btn';
      }

      // Strategy 3: Any span with exact text match
      if (!btn) {
        const allSpans = Array.from(document.querySelectorAll('span'));
        btn = allSpans.find(el => {
          const text = (el.innerText || '').trim();
          return /^参考\\s*\\d+\\s*篇资料$/.test(text);
        });
        method = 'span-exact-text';
      }

      if (!btn) {
        return { found: false };
      }

      const text = (btn.innerText || '').trim();
      const match = text.match(/参考\\s*(\\d+)\\s*篇资料/);
      const refCount = match ? parseInt(match[1], 10) : 0;

      // Check if references are already visible (expanded)
      const firstRefLink = document.querySelector('a.search-lIUYwC');
      const refsVisible = firstRefLink ? firstRefLink.offsetHeight > 0 : false;

      return {
        found: true,
        refCount,
        method,
        refsVisible
      };
    })()
  `;
}

/**
 * Click the reference button to expand/show inline references.
 */
function clickReferenceButtonScript(): string {
  return `
    (() => {
      let btn = null;

      // Strategy 1: span with class containing "entry-btn-title" and exact text
      const spans = Array.from(document.querySelectorAll('span[class*="entry-btn-title"]'));
      btn = spans.find(el => {
        const text = (el.innerText || '').trim();
        return /^参考\\s*\\d+\\s*篇资料$/.test(text);
      });

      // Strategy 2: button with class containing "entry-btn"
      if (!btn) {
        const buttons = Array.from(document.querySelectorAll('button[class*="entry-btn"]'));
        btn = buttons.find(el => {
          const text = (el.innerText || '').trim();
          return /^参考\\s*\\d+\\s*篇资料$/.test(text);
        });
      }

      // Strategy 3: Any span with exact text match
      if (!btn) {
        const allSpans = Array.from(document.querySelectorAll('span'));
        btn = allSpans.find(el => {
          const text = (el.innerText || '').trim();
          return /^参考\\s*\\d+\\s*篇资料$/.test(text);
        });
      }

      if (btn && btn instanceof HTMLElement) {
        btn.click();
        return { clicked: true };
      }

      return { clicked: false, error: 'Button not found' };
    })()
  `;
}

/**
 * Extract reference sources from inline content.
 *
 * Each reference is structured as:
 *   a.search-lIUYwC (link element)
 *     - href = URL
 *     - innerText = title + snippet + source
 *   span.footer-citation-PN73AP (inside div.search-item-footer-b0INFL)
 *     - innerText = index number
 */
function extractInlineReferencesScript(): string {
  return `
    (() => {
      const links = document.querySelectorAll('a.search-lIUYwC');
      const refs = [];

      links.forEach((link) => {
        const href = (link.href || '').trim();
        // Skip invalid URLs
        if (!href || href.startsWith('javascript:') || href === '#' || !href.startsWith('http')) {
          return;
        }

        // Get the index from the citation span sibling
        const footer = link.querySelector('div.search-item-footer-b0INFL, [class*="search-item-footer"]');
        let index = refs.length + 1;
        if (footer) {
          const citation = footer.querySelector('span.footer-citation-PN73AP, [class*="footer-citation"]');
          if (citation) {
            const idxText = (citation.innerText || '').trim();
            const idxMatch = idxText.match(/^(\\d+)$/);
            if (idxMatch) {
              index = parseInt(idxMatch[1], 10);
            }
          }
        }

        // Parse full text to extract title, snippet, source
        const fullText = (link.innerText || '').trim();
        const lines = fullText.split('\\n').map(l => l.trim()).filter(Boolean);

        // Clean URL - remove tracking parameters
        const url = href
          .replace(/&hidePublishButton=true&hideTitle=true/g, '')
          .replace(/&allianceid=\\d+/g, '')
          .replace(/&sid=\\d+/g, '')
          .replace(/\\?$/, '');

        // Title is typically the first non-empty line
        let title = lines[0] || 'Untitled';
        let snippet = '';
        let source = '';

        // Find the last line that looks like a source (short, not a URL)
        for (let i = lines.length - 1; i > 0; i--) {
          const line = lines[i];
          if (!line.startsWith('http') && line.length < 50 && !/^\\d+$/.test(line)) {
            source = line;
            break;
          }
        }

        // Snippet is content between title and source
        if (lines.length > 2) {
          snippet = lines.slice(1, lines.length - 1).join(' ').substring(0, 300);
        }

        refs.push({
          index,
          title,
          url,
          snippet,
          source
        });
      });

      // Sort by index
      if (refs.length > 0) {
        refs.sort((a, b) => a.index - b.index);
      }

      return refs;
    })()
  `;
}

export async function extractDoubaoReferences(page: IPage): Promise<DoubaoReference[]> {
  // First check if button exists and if refs are already visible
  const btnInfo = await page.evaluate(checkReferenceButtonScript()) as {
    found: boolean;
    refCount?: number;
    method?: string;
    refsVisible?: boolean;
  };

  // If refs already visible, extract them directly
  if (btnInfo.refsVisible) {
    const refs = await page.evaluate(extractInlineReferencesScript()) as DoubaoReference[];
    if (refs.length > 0) return refs;
  }

  // If no button found, return empty
  if (!btnInfo.found) {
    return [];
  }

  // Click the button to expand references
  const clickResult = await page.evaluate(clickReferenceButtonScript()) as { clicked?: boolean; error?: string };
  if (!clickResult?.clicked) {
    return [];
  }

  // Wait for references to become visible (animation/transition)
  await page.wait(2);

  // Extract references from inline content
  const refs = await page.evaluate(extractInlineReferencesScript()) as DoubaoReference[];

  // If empty, retry a few times
  if (refs.length === 0) {
    for (let i = 0; i < 3; i++) {
      await page.wait(2);
      const retryRefs = await page.evaluate(extractInlineReferencesScript()) as DoubaoReference[];
      if (retryRefs.length > 0) {
        return retryRefs;
      }
    }
  }

  return refs;
}

/**
 * Check if reference button exists without clicking.
 */
export async function checkReferenceButton(page: IPage): Promise<{ found: boolean; refCount?: number; refsVisible?: boolean }> {
  const result = await page.evaluate(checkReferenceButtonScript()) as {
    found: boolean;
    refCount?: number;
    refsVisible?: boolean;
  };
  return { found: result.found, refCount: result.refCount, refsVisible: result.refsVisible };
}