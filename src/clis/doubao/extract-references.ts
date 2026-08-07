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

/** Inline badge reference embedded in AI answer text (e.g., "携程" small tag). */
export interface DoubaoInlineBadge {
  text: string;       // Badge display text (e.g., "携程", "Trip.com")
  title: string;      // Linked article title
  url: string;        // Linked URL
  source: string;     // Source website name (e.g., "携程")
  context: string;    // The sentence/paragraph containing this badge
  icon?: string;      // Icon URL if available
  docId?: string;     // Document ID from data prop
}

/**
 * Check if the LAST [data-message-id] has a reference button and whether links are visible.
 * Uses DOM order = temporal order (newest message is last in DOM).
 * This approach handles multi-turn conversations correctly regardless of container reuse.
 */
function checkLastReferenceButtonScript(): string {
  return `
    (() => {
      const messages = document.querySelectorAll('[data-message-id]');
      let latestBlock = null;
      let latestMsgIndex = -1;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const block = msg.querySelector('[data-plugin-identifier*="search_query_result_block"]');
        if (!block) continue;
        const btn = block.querySelector('.cursor-pointer');
        if (!btn) continue;
        const text = (btn.textContent || '').trim();
        if (!text.includes('参考')) continue;
        latestBlock = block;
        latestMsgIndex = i;
        break;
      }

      if (!latestBlock) return { found: false };

      const links = latestBlock.querySelectorAll('a[href^="http"]');
      const refMatch = (latestBlock.querySelector('.cursor-pointer')?.textContent || '').trim().match(/参考\\s*(\\d+)\\s*篇资料/);
      return {
        found: true,
        refCount: refMatch ? parseInt(refMatch[1], 10) : 0,
        linksVisible: links.length > 0,
      };
    })()
  `;
}

/**
 * Check if a NEW reference button exists beyond the old container count.
 * In multi-turn conversations, wait for a NEW container to appear first.
 * Only counts non-empty containers with "参考" text in the button.
 */
function checkNewReferenceButtonScript(oldContainerCount: number): string {
  return `
    (() => {
      const allContainers = Array.from(document.querySelectorAll('[data-plugin-identifier*="search_query_result_block"]'));
      const containers = allContainers.filter(c => {
        const btn = c.querySelector('.cursor-pointer');
        if (!btn) return false;
        const text = (btn.textContent || '').trim();
        return text.includes('参考') && c.innerHTML.trim().length > 500;
      });
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
 * Click the reference button in the LAST [data-message-id] that has one.
 * Uses DOM order = temporal order to find the newest message's ref button.
 */
function clickLastReferenceButtonScript(): string {
  return `
    (() => {
      const messages = document.querySelectorAll('[data-message-id]');

      // Find the LAST message with a valid ref block
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const block = msg.querySelector('[data-plugin-identifier*="search_query_result_block"]');
        if (!block) continue;
        const btn = block.querySelector('.cursor-pointer');
        if (!btn) continue;
        const text = (btn.textContent || '').trim();
        if (!text.includes('参考')) continue;
        btn.click();
        return { clicked: true };
      }

      return { clicked: false, error: 'No valid ref button found' };
    })()
  `;
}

/**
 * Find the reference block inside the LAST [data-message-id] that has a ref button.
 * Uses DOM order = temporal order (newest message is last in DOM).
 * This handles multi-turn conversations correctly regardless of container reuse.
 *
 * DOM hierarchy:
 *   [data-message-id]
 *     └─ [data-plugin-identifier*="search_query_result_block"]
 *           └─ .cursor-pointer (ref button)
 *           └─ a[href^="http"] (reference links)
 */
function findLatestRefBlockScript(): string {
  return `
    (() => {
      const messages = document.querySelectorAll('[data-message-id]');
      let latestBlock = null;
      let latestMsgIndex = -1;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const block = msg.querySelector('[data-plugin-identifier*="search_query_result_block"]');
        if (!block) continue;
        const btn = block.querySelector('.cursor-pointer');
        if (!btn) continue;
        const text = (btn.textContent || '').trim();
        if (!text.includes('参考')) continue;
        // Found a valid block - this is the newest because we iterate from the end
        latestBlock = block;
        latestMsgIndex = i;
        break;
      }

      if (!latestBlock) return { found: false };

      const links = latestBlock.querySelectorAll('a[href^="http"]');
      const refMatch = (latestBlock.querySelector('.cursor-pointer')?.textContent || '').trim().match(/参考\\s*(\\d+)\\s*篇资料/);
      return {
        found: true,
        msgIndex: latestMsgIndex,
        linkCount: links.length,
        refCount: refMatch ? parseInt(refMatch[1], 10) : 0,
        linksVisible: links.length > 0,
      };
    })()
  `;
}

/**
 * Extract references from the LAST valid [data-message-id] container's ref block.
 * Finds the newest message with a reference button, then extracts links from it.
 * Uses DOM order = temporal order, so newest answer is always correct.
 *
 * DOM structure (verified 2026-05-27):
 *   a[href]
 *     ├─ SPAN → "1." (index number)
 *     └─ DIV → "北京–>南昌列车信息查询" (title)
 */
function extractLastReferencesScript(): string {
  return `
    (() => {
      const messages = document.querySelectorAll('[data-message-id]');
      let container = null;

      // Find the LAST [data-message-id] that has a valid ref block
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const block = msg.querySelector('[data-plugin-identifier*="search_query_result_block"]');
        if (!block) continue;
        const btn = block.querySelector('.cursor-pointer');
        if (!btn) continue;
        const text = (btn.textContent || '').trim();
        if (!text.includes('参考')) continue;
        container = block;
        break;
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
          // Fallback: use full link text but strip leading number
          title = (link.textContent || '').trim();
          title = title.replace(/^\\d+\\.\\s*/, '').trim();
        }

        // Additional fallback: try child elements if text extraction failed
        if (!title || title.length < 2) {
          const children = Array.from(link.children);
          for (const child of children) {
            if (child.tagName === 'DIV' || child.tagName === 'SPAN') {
              const childText = child.textContent?.trim();
              if (childText && childText.length > 2 && !/^\\d+$/.test(childText)) {
                title = childText;
                break;
              }
            }
          }
        }

        if (!title || title.length < 2) {
          // Last resort fallback
          title = href.split('/').pop()?.split('?')[0]?.replace(/[_-]/g, ' ') || 'Untitled';
        }

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
 * Smart extraction: find the newest message's ref block, check if links are visible.
 * The ref button is a toggle — if already expanded, clicking will COLLAPSE it.
 *
 * Flow:
 * 1. Find the last [data-message-id] with a ref button (newest answer)
 * 2. Check if links are ALREADY visible (expanded state)
 * 3. If not, click to expand, then wait for React to render
 * 4. Extract references from that block
 */
export async function extractDoubaoReferences(page: IPage): Promise<DoubaoReference[]> {
  // Check if ref button exists in the newest message
  const btnInfo = await page.evaluate(
    checkLastReferenceButtonScript()
  ) as { found: boolean; refCount?: number; linksVisible?: boolean };

  if (!btnInfo.found) {
    return [];
  }

  // If links already visible, no click needed
  if (!btnInfo.linksVisible) {
    const clickResult = await page.evaluate(clickLastReferenceButtonScript()) as { clicked?: boolean; error?: string };
    if (!clickResult?.clicked) {
      return [];
    }
    await page.wait(3);
  } else {
    await page.wait(1);
  }

  const refs = await page.evaluate(extractLastReferencesScript()) as DoubaoReference[];

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
 * Extract search keywords from the LAST [data-message-id] container's ref block.
 * Uses DOM order = temporal order to find the newest message's keyword div.
 */
function extractLastKeywordsScript(): string {
  return `
    (() => {
      const messages = document.querySelectorAll('[data-message-id]');
      let latestBlock = null;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const block = msg.querySelector('[data-plugin-identifier*="search_query_result_block"]');
        if (!block) continue;
        const btn = block.querySelector('.cursor-pointer');
        if (!btn) continue;
        const text = (btn.textContent || '').trim();
        if (!text.includes('参考')) continue;
        latestBlock = block;
        break;
      }

      if (!latestBlock) return [];

      const keywordDiv = latestBlock.querySelector('.mb-8.text-sm.text-dbx-neutral-400, .mb-8.text-dbx-neutral-400');
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

/**
 * Extract inline reference badges from AI answer text.
 * Badges are <span class="container-sWvQla"> elements with React fiber data.
 * Not every AI answer contains inline badges — returns [] when none found.
 */
function extractInlineBadgesScript(): string {
  return `
    (() => {
      const badges = document.querySelectorAll('.container-sWvQla');
      if (!badges.length) return [];
      const results = [];

      for (const badge of badges) {
        const fiberKey = Object.keys(badge).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!fiberKey) continue;

        let current = badge[fiberKey];
        let depth = 0;
        let data = null;

        while (current && depth < 15) {
          if (current.memoizedProps && current.memoizedProps.data) {
            data = current.memoizedProps.data;
            break;
          }
          current = current.return;
          depth++;
        }

        if (!data || !data.url) continue;

        // Extract context: the sentence containing this badge from its parent element
        const parent = badge.parentElement;
        let context = '';
        if (parent) {
          let beforeText = '';
          let afterText = '';
          let found = false;
          for (const child of parent.childNodes) {
            if (child === badge) { found = true; continue; }
            if (!found) { beforeText += child.textContent || ''; }
            else { afterText += child.textContent || ''; }
          }
          context = (beforeText + afterText).trim();
        }

        results.push({
          text: (badge.textContent || '').trim(),
          title: data.title || '',
          url: data.url || '',
          source: data.website_name || data.insert_text || '',
          context,
          icon: data.icon || '',
          docId: data.doc_id || '',
        });
      }

      return results;
    })()
  `;
}

/**
 * Extract inline reference badges from the LAST AI answer message.
 * Returns [] if no badges exist (most answers don't have them).
 */
export async function extractDoubaoInlineBadges(page: IPage): Promise<DoubaoInlineBadge[]> {
  try {
    const badges = await page.evaluate(extractInlineBadgesScript()) as DoubaoInlineBadge[];
    return badges || [];
  } catch {
    return [];
  }
}
