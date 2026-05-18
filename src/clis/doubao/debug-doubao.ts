/**
 * Debug script to inspect Doubao DOM structure
 * Run: opencli doubao references "端午去重庆怎么样？" --reuse
 * Then check .opencli/explore/doubao/debug-*.json
 */

import type { IPage } from '../../types.js';

export interface DoubaoReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

function debugExtractScript(): string {
  return `
    (() => {
      const result = {
        // 1. Header container
        headerContainer: null as any,
        headerContainerText: '',
        headerContainerChildren: [] as string[],

        // 2. All [data-message-id] messages
        messages: [] as any[],

        // 3. Complementary element
        complementary: null as any,
        complementaryHTML: '',

        // 4. Reference button candidates
        refButtons: [] as any[],

        // 5. Sidebar/alternative selectors
        altSidebars: [] as any,
      };

      // Header container
      const headerContainer = document.querySelector('.flex.flex-col.gap-2.w-full');
      if (headerContainer) {
        result.headerContainer = {
          tagName: headerContainer.tagName,
          className: headerContainer.className,
          id: headerContainer.id,
        };
        result.headerContainerText = headerContainer.innerText;
        result.headerContainerChildren = Array.from(headerContainer.children).map(c => ({
          tagName: c.tagName,
          className: c.className,
          innerText: c.innerText?.slice(0, 100),
        }));
      }

      // All messages
      const messages = document.querySelectorAll('[data-message-id]');
      result.messages = Array.from(messages).slice(-5).map((m, i) => ({
        index: messages.length - 5 + i,
        dataMessageId: m.getAttribute('data-message-id'),
        className: m.className?.slice(0, 100),
        innerText: m.innerText?.slice(0, 300),
        childCount: m.children.length,
      }));

      // Complementary element
      const complementary = document.querySelector('complementary');
      if (complementary) {
        result.complementary = {
          tagName: complementary.tagName,
          className: complementary.className,
          childCount: complementary.children.length,
        };
        result.complementaryHTML = complementary.outerHTML?.slice(0, 2000);
      }

      // Reference buttons
      const allDivs = Array.from(document.querySelectorAll('div'));
      result.refButtons = allDivs.filter(el => {
        const text = (el.innerText || '').trim();
        return /^参考\\s*\\d+\\s*篇资料$/.test(text);
      }).map(el => ({
        text: el.innerText?.trim(),
        className: el.className,
        parentClass: el.parentElement?.className?.slice(0, 100),
        grandparentClass: el.parentElement?.parentElement?.className?.slice(0, 100),
      }));

      // Alternative sidebars
      const altSelectors = [
        '[class*="reference-sidebar"]',
        '[class*="citation-sidebar"]',
        'aside[class*="reference"]',
        '[class*="sidebar"]',
        'aside',
      ];
      result.altSidebars = {};
      altSelectors.forEach(sel => {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          result.altSidebars[sel] = Array.from(els).slice(0, 3).map(el => ({
            tagName: el.tagName,
            className: el.className?.slice(0, 100),
            innerText: el.innerText?.slice(0, 200),
          }));
        }
      });

      return result;
    })()
  `;
}

export async function debugDoubaoDOM(page: IPage): Promise<any> {
  const debug = await page.evaluate(debugExtractScript());
  return debug;
}