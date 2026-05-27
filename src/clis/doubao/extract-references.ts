/**
 * DOM extraction logic for Doubao web reference sources.
 *
 * Uses JS extraction from the DOM structure:
 *   div[data-plugin-identifier*="search_query_result_block"]
 *
 * UPDATED (2026-05-27):
 *   - API interception removed, pure DOM extraction only.
 *   - Multi-turn support: extract from the LAST (newest) container to avoid
 *     stale data from previous conversations.
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
 * Count existing reference containers on the page.
 * Used as a snapshot BEFORE sending a new question.
 * In multi-turn conversations, this tells us how many old containers exist.
 */
function countReferenceContainersScript(): string {
  return `
    (() => {
      return document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]').length;
    })()
  `;
}

/**
 * Check if the LAST non-empty reference container has a reference button.
 * Skips empty React artifact containers.
 */
function checkLastReferenceButtonScript(): string {
  return `
    (() => {
      const containers = Array.from(document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]'));
      if (containers.length === 0) return { found: false };

      // Find the last non-empty container
      let container = null;
      for (let i = containers.length - 1; i >= 0; i--) {
        const c = containers[i];
        if (c.innerHTML.trim().length > 0) {
          container = c;
          break;
        }
      }
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
 * Check if a NEW reference button exists beyond the old container count.
 * In multi-turn conversations, wait for a NEW container to appear first.
 * Only counts non-empty, valid containers.
 */
function checkNewReferenceButtonScript(oldContainerCount: number): string {
  return `
    (() => {
      const allContainers = Array.from(document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]'));
      // Only count non-empty containers as valid
      const containers = allContainers.filter(c => c.innerHTML.trim().length > 0 && c.querySelector('.cursor-pointer'));
      if (containers.length <= ${oldContainerCount}) return { found: false, containerCount: containers.length };

      const container = containers[containers.length - 1];
      const clickable = container.querySelector('.cursor-pointer');
      if (!clickable) return { found: false, containerCount: containers.length };

      const text = (clickable.textContent || '').trim();
      if (!text.includes('参考')) return { found: false, containerCount: containers.length };

      const match = text.match(/参考\\s*(\\d+)\\s*篇资料/);
      return { found: true, refCount: match ? parseInt(match[1], 10) : 0, containerCount: containers.length };
    })()
  `;
}

/**
 * Click the LAST non-empty container's reference button.
 * Skips empty React artifact containers.
 */
function clickLastReferenceButtonScript(): string {
  return `
    (() => {
      const containers = Array.from(document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]'));
      if (containers.length === 0) return { clicked: false, error: 'No containers found' };

      // Find the LAST container with a reference button (skip empty artifacts)
      let container = null;
      for (let i = containers.length - 1; i >= 0; i--) {
        const c = containers[i];
        if (c.querySelector('.cursor-pointer') && c.innerHTML.trim().length > 0) {
          container = c;
          break;
        }
      }
      if (!container) return { clicked: false, error: 'No valid container found' };

      const clickable = container.querySelector('.cursor-pointer');
      if (!clickable) return { clicked: false, error: 'Button not found on latest container' };

      clickable.click();
      return { clicked: true };
    })()
  `;
}

/**
 * Extract references from the LAST non-empty container with a reference button.
 * In multi-turn conversations, use querySelectorAll and take the last non-empty one.
 * Some containers may be empty React artifacts - skip those.
 *
 * DOM structure (verified 2026-05-27):
 *   a[href]
 *     ├─ SPAN → "1." (index number)
 *     └─ DIV → "北京–>南昌列车信息查询" (title)
 */
function extractLastReferencesScript(): string {
  return `
    (() => {
      const containers = Array.from(document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]'));
      if (containers.length === 0) return [];

      // Find the LAST container that has a reference button (not empty React artifacts)
      let container = null;
      for (let i = containers.length - 1; i >= 0; i--) {
        const c = containers[i];
        if (c.querySelector('.cursor-pointer') && c.innerHTML.trim().length > 0) {
          container = c;
          break;
        }
      }
      if (!container) return [];

      const links = container.querySelectorAll('a[href^="http"]');
      const refs = [];

      links.forEach((link, domIdx) => {
        const href = (link.href || '').trim();
        if (!href || !href.startsWith('http')) return;

        // DOM structure: a > SPAN("1.") + DIV(title text)
        const indexSpan = link.querySelector('span');
        const titleDiv = link.querySelector('div');

        let index = domIdx + 1;
        if (indexSpan) {
          const spanText = (indexSpan.textContent || '').trim().replace(/\\D/g, '');
          if (spanText) index = parseInt(spanText, 10);
        }

        // Get title from the DIV child (direct text, not from spans or other nested elements)
        let title = '';
        if (titleDiv) {
          title = (titleDiv.textContent || '').trim();
        }

        if (!title) {
          // Fallback: use full text but strip leading number
          title = (link.textContent || '').trim();
          title = title.replace(/^\\d+\\.\\s*/, '').trim();
        }

        title = title || 'Untitled';

        const url = href
          .replace(/&hidePublishButton=true&hideTitle=true/g, '')
          .replace(/&allianceid=\\d+/g, '')
          .replace(/&sid=\\d+/g, '')
          .replace(/\\?$/, '');

        refs.push({
          index,
          title,
          url,
          snippet: '',
          source: '',
        });
      });

      return refs.sort((a, b) => a.index - b.index);
    })()
  `;
}

/**
 * Main extraction function: pure DOM extraction from the latest container.
 * 1. Find and click the LAST reference button to expand.
 * 2. Extract references from the expanded DOM (last container only).
 */
export async function extractDoubaoReferences(page: IPage): Promise<DoubaoReference[]> {
  const btnInfo = await page.evaluate(
    checkNewReferenceButtonScript(0)
  ) as { found: boolean };

  if (!btnInfo.found) {
    return [];
  }

  // Click to expand references (last container)
  const clickResult = await page.evaluate(clickLastReferenceButtonScript()) as { clicked?: boolean; error?: string };
  if (!clickResult?.clicked) {
    return [];
  }

  // Wait for expansion
  await page.wait(2);

  // Extract from DOM (last container)
  const refs = await page.evaluate(extractLastReferencesScript()) as DoubaoReference[];

  // Retry if empty
  if (refs.length === 0) {
    for (let i = 0; i < 3; i++) {
      await page.wait(2);
      const retryRefs = await page.evaluate(extractLastReferencesScript()) as DoubaoReference[];
      if (retryRefs.length > 0) {
        return retryRefs;
      }
    }
  }

  return refs;
}

/**
 * Check if the LAST reference container has a reference button.
 */
export async function checkReferenceButton(page: IPage): Promise<{ found: boolean; refCount?: number }> {
  const result = await page.evaluate(
    checkLastReferenceButtonScript()
  ) as {
    found: boolean;
    refCount?: number;
  };
  return { found: result.found, refCount: result.refCount };
}

/**
 * Check if a NEW reference button exists beyond the old container count.
 * In multi-turn conversations, this prevents matching stale buttons.
 */
export async function checkNewReferenceButton(page: IPage, oldContainerCount: number): Promise<{ found: boolean; refCount?: number }> {
  const result = await page.evaluate(
    checkNewReferenceButtonScript(oldContainerCount)
  ) as {
    found: boolean;
    refCount?: number;
  };
  return { found: result.found, refCount: result.refCount };
}

/**
 * Get the count of existing valid reference containers BEFORE sending a new question.
 * Only counts non-empty containers that have a button.
 * This snapshot is used to detect when a NEW container appears.
 */
export async function snapshotReferenceCount(page: IPage): Promise<number> {
  return await page.evaluate(`
    (() => {
      const all = document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]');
      return Array.from(all).filter(c =>
        c.innerHTML.trim().length > 0 && c.querySelector('.cursor-pointer')
      ).length;
    })()
  `) as number;
}

/**
 * Extract search keywords from the LAST (newest) container in the expanded search_query_result_block.
 * After clicking the reference button, keywords appear in a div with
 * class "mb-8 text-sm text-dbx-neutral-400" inside the container.
 * Format: "keyword1"、"keyword2"、"keyword3"
 *
 * Must be called AFTER clicking the reference button to expand the section.
 */
function extractLastKeywordsScript(): string {
  return `
    (() => {
      const containers = Array.from(document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]'));
      if (containers.length === 0) return [];

      // Find the LAST non-empty container with content
      let container = null;
      for (let i = containers.length - 1; i >= 0; i--) {
        const c = containers[i];
        if (c.innerHTML.trim().length > 0) {
          container = c;
          break;
        }
      }
      if (!container) return [];

      const keywordDiv = container.querySelector('.mb-8.text-sm.text-dbx-neutral-400, .mb-8.text-dbx-neutral-400');
      if (!keywordDiv) return [];

      const rawText = (keywordDiv.textContent || '').trim();
      if (!rawText) return [];

      return rawText
        .split(/[\\u3001，,]+/)
        .map(k => k.replace(/[""""]/g, '').trim())
        .filter(k => k.length > 0);
    })()
  `;
}

/**
 * Extract search keywords from the page (must be called after clicking reference button).
 * Always extracts from the LAST (newest) container.
 * Returns empty array if not yet expanded or no keywords found.
 */
export async function extractDoubaoKeywords(page: IPage): Promise<string[]> {
  return await page.evaluate(extractLastKeywordsScript()) as string[];
}
