/**
 * DOM extraction logic for Doubao web reference sources.
 *
 * UPDATED (2026-05-19):
 *   - References are INLINE in the answer content (in a sidebar/panel)
 *   - Each reference: a.search-lIUYwC with text = "title\nsnippet\nsource\nindex"
 *   - The "参考 N 篇资料" button EXPANDS/COLLAPSES the references panel
 *   - Index is the LAST LINE of the link text (not a separate element)
 *
 * DOM structure:
 *   container (after clicking reference button)
 *     └─ a.search-lIUYwC (link with href=URL)
 *          └─ div.w-full (content container)
 *               ├─ Title (first line)
 *               ├─ Snippet (middle lines)
 *               ├─ Source name (short line before index, e.g., "手机搜狐网")
 *               └─ Index number (last line, e.g., "1")
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
 *     - innerText = title + snippet + source + index (all on separate lines)
 *
 * Link text format:
 *   "Title\nSnippet content...\nSourceName\nIndex"
 *
 * Example:
 *   "端午游北京，古都底蕴与民俗风情一站式全攻略_故宫_长城_传统\n
 *    一、端午限定·民俗体验不能错过...\n
 *    手机搜狐网\n
 *    1"
 */
function extractInlineReferencesScript(): string {
  return `
    (() => {
      const links = document.querySelectorAll('a.search-lIUYwC');
      const refs = [];

      links.forEach((link, idx) => {
        const href = (link.href || '').trim();
        // Skip invalid URLs
        if (!href || href.startsWith('javascript:') || href === '#' || !href.startsWith('http')) {
          return;
        }

        // Parse full text to extract title, snippet, source, index
        const fullText = (link.innerText || '').trim();
        const lines = fullText.split('\\n').map(l => l.trim()).filter(Boolean);

        if (lines.length === 0) return;

        // Index is ALWAYS the last line (it's a number like "1", "2", etc.)
        let index = idx + 1; // fallback
        let source = '';
        const lastLine = lines[lines.length - 1];
        if (/^\\d+$/.test(lastLine)) {
          index = parseInt(lastLine, 10);
        }

        // Title is the first line
        const title = lines[0] || 'Untitled';

        // Source is the second-to-last line (short text before index)
        // Look backwards for the first line that is:
        // - Not a URL
        // - Not a number (index)
        // - Short enough to be a source name (< 50 chars)
        // - Starts with Chinese letter or ASCII letter (not punctuation)
        for (let i = lines.length - 2; i >= 0; i--) {
          const line = lines[i];
          if (!line.startsWith('http') &&
              !/^\\d+$/.test(line) &&
              line.length < 50 &&
              line.length > 0 &&
              /^[\\u4e00-\\u9fa5a-zA-Z]/.test(line)) {
            source = line;
            break;
          }
        }

        // Snippet is content between title and source
        // Find position of source line, take everything between title and source
        let snippet = '';
        let sourceIdx = lines.indexOf(source);
        if (sourceIdx <= 0) sourceIdx = lines.length - 1;

        if (lines.length > 2 && sourceIdx > 1) {
          // Get lines between title (index 0) and source (index sourceIdx)
          snippet = lines.slice(1, sourceIdx).join(' ').substring(0, 300);
        } else if (lines.length > 1) {
          // Fallback: lines between first and last
          snippet = lines.slice(1, lines.length - 1).join(' ').substring(0, 300);
        }

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
  // First check if button exists and get its status
  const btnInfo = await page.evaluate(checkReferenceButtonScript()) as {
    found: boolean;
    refCount?: number;
    method?: string;
    refsVisible?: boolean;
  };

  // If no button found, return empty
  if (!btnInfo.found) {
    return [];
  }

  // Always click the button to ensure we get CURRENT answer's references
  // If refs were already visible (from previous question), clicking toggles and refreshes
  // If refs were hidden, clicking reveals them
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