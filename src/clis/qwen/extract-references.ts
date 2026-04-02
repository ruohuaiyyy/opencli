/**
 * DOM extraction logic for Qwen web reference sources.
 *
 * DOM structure:
 *   - Reference container: .reference-wrap-iEjeb3
 *   - Click "N篇来源" button to expand
 *   - Each reference is in the expanded panel with:
 *     - Index number
 *     - Source title (e.g., "携程移动版 m.ctrip.com")
 *     - Date
 *     - Summary content
 *
 * Unlike Yuanbao, Qwen automatically shows references (no internet search toggle needed).
 */

import type { IPage } from '../../types.js';

export interface QwenReference {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/**
 * Click the "N篇来源" button to expand references panel.
 */
function expandReferencesScript(): string {
  return `
    (() => {
      // Find the reference toggle button (shows "N篇来源")
      const refButtons = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = (el.textContent || '').trim();
        return text.match(/\\d+篇来源/);
      });
      
      if (refButtons.length > 0) {
        // Click the last one (most recent response)
        const btn = refButtons[refButtons.length - 1];
        
        // Find clickable parent
        let clickable = btn;
        for (let i = 0; i < 5 && clickable; i++) {
          if (clickable.onclick || clickable.getAttribute('role') === 'button'
            || clickable.className?.includes('cursor')) {
            clickable.click();
            return true;
          }
          clickable = clickable.parentElement;
        }
        btn.click();
        return true;
      }
      return false;
    })()
  `;
}

function extractReferencesScript(): string {
  return `
    (() => {
      // First try to find already expanded reference panel
      let refPanel = document.querySelector('[class*="reference-wrap"]');
      
      // If not expanded, try to find and click the toggle button
      if (!refPanel || refPanel.textContent?.includes('篇来源')) {
        const refButtons = Array.from(document.querySelectorAll('*')).filter(el => {
          const text = (el.textContent || '').trim();
          return text.match(/\\d+篇来源/);
        });
        
        if (refButtons.length > 0) {
          const btn = refButtons[refButtons.length - 1];
          btn.click();
          // Wait briefly for panel to expand
        }
      }
      
      // Try again after potential click
      refPanel = document.querySelector('[class*="reference-wrap"]');
      if (!refPanel) return [];
      
      // Get the reference list - look for expanded content
      const listContainer = Array.from(refPanel.querySelectorAll('div')).find(el => {
        const text = el.textContent || '';
        return text.includes('参考来源') || text.includes('来源 (');
      });
      
      if (!listContainer) return [];
      
      // Find all reference items - they typically have numbered indices
      const items = Array.from(listContainer.querySelectorAll('div')).filter(el => {
        const text = el.textContent || '';
        return /^\\s*\\d+\\s*$/.test(text.trim()) || el.querySelector('[class*="source"]');
      });
      
      // Alternative: look for links or structured content in the reference area
      const links = Array.from(listContainer.querySelectorAll('a, [href]'));
      const refDivs = Array.from(listContainer.querySelectorAll('div')).filter(el => {
        const cls = el.className || '';
        return cls.includes('reference') || cls.includes('source');
      });
      
      const refs = [];
      
      // Try to extract from structured elements
      if (refDivs.length > 0) {
        refDivs.forEach((div, index) => {
          const text = (div.textContent || '').trim();
          if (text.length < 10) return; // Skip empty/short elements
          
          // Extract source name (typically a domain or website name)
          const sourceMatch = text.match(/(?:^|\\n)([a-zA-Z0-9.-]+\\.[a-zA-Z]+|[^\\n]{2,20})(?:\\n|$)/);
          const source = sourceMatch ? sourceMatch[1].trim() : '';
          
          // Extract title (usually contains the article title)
          const lines = text.split('\\n').filter(l => l.trim());
          const title = lines[0] || source;
          
          // Get URL if available
          const linkEl = div.querySelector('a') || div.closest('a');
          const url = linkEl?.href || '';
          
          // Summary is usually the rest of the text
          let snippet = text;
          if (source) snippet = snippet.replace(source, '').trim();
          if (title && title !== source) snippet = snippet.replace(title, '').trim();
          snippet = snippet.replace(/^\\d+\\s*/, '').trim().substring(0, 500);
          
          if (title || source) {
            refs.push({
              index: index + 1,
              title: title.substring(0, 200),
              url,
              snippet: snippet.substring(0, 500),
              source: source.substring(0, 100),
            });
          }
        });
      }
      
      // Fallback: try to parse from links
      if (refs.length === 0 && links.length > 0) {
        links.forEach((link, index) => {
          const href = link.href || '';
          const text = (link.textContent || '').trim();
          
          if (href || text) {
            refs.push({
              index: index + 1,
              title: text.substring(0, 200) || 'Untitled',
              url: href,
              snippet: '',
              source: new URL(href || 'http://example.com').hostname.substring(0, 100),
            });
          }
        });
      }
      
      return refs;
    })()
  `;
}

export async function extractQwenReferences(page: IPage): Promise<QwenReference[]> {
  // First try to expand references
  await page.evaluate(expandReferencesScript());
  await page.wait(1.5);
  
  return await page.evaluate(extractReferencesScript()) as QwenReference[];
}
