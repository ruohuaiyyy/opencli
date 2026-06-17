import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

/**
 * Click the "下一页" link in the current page to navigate to the next page.
 * Returns true if a next-page link was found and clicked, false otherwise.
 */
async function clickNextPage(page: IPage): Promise<boolean> {
  return await page.evaluate(`
    (() => {
      const links = Array.from(document.querySelectorAll('a'));
      const nextLink = links.find(a => a.textContent.trim() === '下一页');
      if (nextLink) {
        nextLink.click();
        return true;
      }
      return false;
    })()
  `);
}

/**
 * Ensure the target category tab is selected.
 * Since Toutiao channel tabs don't respond to synthetic clicks,
 * we navigate to search results for the category instead.
 */
async function selectCategory(page: IPage, category: string): Promise<void> {
  const currentUrl = await page.evaluate('window.location.href');
  console.log(`  📍 当前页面 URL: ${currentUrl}`);

  // 1. Normalize common aliases
  const ALIAS_MAP: Record<string, string> = {
    '旅行': '旅游',
  };
  const realCategory = ALIAS_MAP[category] || category;
  console.log(`\n  🎯 正在寻找分类: "${category}"${category !== realCategory ? ` (匹配为 "${realCategory}")` : ''}...`);

  // 2. Try to navigate directly to the category search page
  // Use the "资讯" (news) tab which has article results
  const searchUrl = `https://so.toutiao.com/search/?dvpf=pc&keyword=${encodeURIComponent(realCategory)}&pd=information`;
  console.log(`  🔄 导航到搜索页(资讯标签): ${searchUrl}`);
  await page.goto(searchUrl);
  // Search results need more time to render (API fetch + render)
  await page.wait({ time: 8 });

  const postUrl = await page.evaluate('window.location.href');
  console.log(`  📍 导航后 URL: ${postUrl}`);
}

cli({
  site: 'toutiao',
  name: 'extractList',
  description: '提取今日头条文章/视频列表数据，支持按分类筛选',
  domain: 'www.toutiao.com',
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: 'limit', type: 'int', default: '20', help: '返回文章数量' },
    {
      name: 'output',
      type: 'string',
      default: '',
      help: '输出文件的路径/目录，留空则打印到终端',
    },
    { name: 'category', required: false, help: '指定分类标签以提取特定内容，例如 "旅行"、"科技"' },
  ],
  columns: ['title', 'link'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    await page.goto('https://www.toutiao.com');
    // Wait for initial render including channel tabs
    await page.wait({ time: 5 });

    if (kwargs.category) {
      const catText = String(kwargs.category).trim();
      if (catText) {
        await selectCategory(page, catText);
      }
    }

    console.log('  📝 开始提取列表内容...');

    // Helper to extract articles from the current page
    const extractArticlesFromPage = async (): Promise<Array<{ title: string; link: string }>> => {
      return await page.evaluate(`
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const results = [];
          const seen = new Set();
          
          // Try multiple selectors for search result cards
          const cardSelectors = [
            '[class*="result-item"]',
            '[class*="article-card"]',
            '[class*="news-item"]',
            '[class*="feed-item"]',
            '[class*="card-content"]',
            '[class*="search-result"]',
            'a[class*="link"]',
            'a[class*="title"]',
            'a[href*="article"]',
            'a[href*="/a/"]',
          ];
          
          const allElements = document.querySelectorAll(cardSelectors.join(', '));
          console.log('Found elements:', allElements.length);
          
          for (const el of Array.from(allElements)) {
            let href = el.getAttribute('href') || '';
            if (!href) {
              // Look for link within the card
              const link = el.querySelector('a[href*="article"], a[href*="/w/"], a[href*="/video/"]');
              if (link) href = link.getAttribute('href') || '';
            }
            
            if (!href) {
              // Try to find href in the element
              const links = el.querySelectorAll('a');
              for (const a of links) {
                const ahref = a.getAttribute('href');
                if (ahref && (ahref.includes('/article/') || ahref.includes('/w/') || ahref.includes('/video/') || ahref.startsWith('http'))) {
                  href = ahref;
                  break;
                }
              }
            }
            
            // Extract title - look for title elements with cleaner text
            let title = '';
            const titleEls = el.querySelectorAll('h2, h3, h4, [class*="title"], [class*="header"]');
            for (const t of Array.from(titleEls)) {
              const txt = t.textContent?.trim();
              if (txt && txt.length > 4 && txt.length < 100) {
                title = txt;
                break;
              }
            }
            if (!title) {
              // Fallback: get first line of text (titles are usually the first line)
              const fullText = (el.textContent || '').replace(/\s+/g, ' ').trim();
              // Split on common Chinese punctuation to get first sentence
              const firstPart = fullText.split(/[。！!?]/)[0];
              title = firstPart.length > 150 ? firstPart.substring(0, 150) : firstPart;
              // If still too long, trim aggressively
              if (title.length > 80) {
                title = title.substring(0, 80);
              }
            }
            
            if (href && !href.startsWith('javascript')) {
              if (!href.startsWith('http')) href = 'https://www.toutiao.com' + href;
              const normalizedHref = href.split('#')[0];
              if (seen.has(normalizedHref)) continue;
              
              if (title && title.length > 4 && !/评论|分享|关注|点赞|共.*条/.test(title)) {
                seen.add(normalizedHref);
                // Extract real article URL from search jump URLs
                let realLink = href;
                if (href.includes('sou.toutiao.com/search/jump') || href.includes('search/jump')) {
                  try {
                    const decodedUrl = decodeURIComponent(href);
                    const ttRegex = new RegExp('https?://www\\.toutiao\\.com/(article|a|video|w)/[\\w]+');
                    const ttMatch = decodedUrl.match(ttRegex);
                    if (ttMatch) {
                      realLink = 'https://www.toutiao.com/' + ttMatch[1] + '/' + ttMatch[0].split('/').pop();
                    }
                    const idRegex = new RegExp('toutiao\\.com/(article|a|video|w)(\\d+)');
                    const idMatch = decodedUrl.match(idRegex);
                    if (idMatch) {
                      realLink = 'https://www.toutiao.com/' + idMatch[1] + '/' + idMatch[2] + '/';
                    }
                  } catch {
                    // Keep original href if decode fails
                  }
                }
                results.push({ title, link: realLink });
              }
            }
            
            if (results.length >= 50) break;
          }
          
          // Fallback: try to find any clickable title in the results area
          if (results.length === 0) {
            const searchResultArea = document.querySelector('[class*="result"], [class*="feed"], [class*="list"]');
            if (searchResultArea) {
              const allAnchors = searchResultArea.querySelectorAll('a');
              for (const a of Array.from(allAnchors)) {
                const ahref = a.getAttribute('href');
                const txt = (a.textContent || '').trim();
                if (ahref && txt && txt.length > 8 && txt.length < 200 && 
                    !ahref.includes('javascript') && !ahref.includes('search?') &&
                    !/评论|分享|关注|点赞|登录/.test(txt)) {
                  let fullHref = ahref;
                  if (!fullHref.startsWith('http')) fullHref = 'https://www.toutiao.com' + fullHref;
                  const normHref = fullHref.split('#')[0];
                  if (seen.has(normHref)) continue;
                  seen.add(normHref);
                  results.push({ title: txt, link: fullHref });
                }
                if (results.length >= 50) break;
              }
            }
          }
          
          return results;
        })()
      `);
    };

    const limit = Number(kwargs.limit) || 20;
    const pageSize = 10;
    const pagesNeeded = Math.ceil(limit / pageSize);
    
    const allResults: Array<{ title: string; link: string }> = [];
    const seen = new Set<string>();

    for (let pageNum = 0; pageNum < pagesNeeded; pageNum++) {
      if (pageNum > 0) {
        console.log(`  🔄 点击翻页到第 ${pageNum + 1} 页...`);
        const clicked = await clickNextPage(page);
        if (!clicked) {
          console.log('  ⚠️ 未找到"下一页"按钮，停止翻页');
          break;
        }
        // Wait for new page to render
        await page.wait({ time: 5 });
      }

      console.log(`  📄 提取第 ${pageNum + 1} 页...`);
      const articles = await extractArticlesFromPage();
      const pageArticles = Array.isArray(articles) ? articles : [];
      console.log(`  ✅ 第 ${pageNum + 1} 页获取 ${pageArticles.length} 条`);

      if (pageArticles.length === 0) break;

      for (const item of pageArticles) {
        if (!seen.has(item.link)) {
          seen.add(item.link);
          allResults.push(item);
        }
      }

      if (allResults.length >= limit) break;
    }

    let filtered = allResults.slice(0, limit);

    // Decode search jump URLs to get real article links and clean titles
    filtered = filtered.map((item: { title: string; link: string }) => {
      // Clean up title: trim to first meaningful sentence (max 50 chars)
      let cleanTitle = item.title;
      // Remove trailing descriptions, date stamps, and author info
      // Split on Chinese punctuation that separates title from description
      cleanTitle = cleanTitle.split(/[，。、\n\r。！!?]/)[0];
      if (cleanTitle.length > 50) {
        cleanTitle = cleanTitle.substring(0, 50);
      }
      // Remove common noise patterns
      cleanTitle = cleanTitle.replace(/\s*作者[:\s]*.*$/, '').trim();
      
      if (item.link.includes('search/jump')) {
        try {
          // Double decode: jump URLs are double-encoded
          const decoded = decodeURIComponent(decodeURIComponent(item.link));
          const idMatch = decoded.match(/toutiao\.com\/(article|a|video|w)(\d+)/);
          if (idMatch) {
            const type = idMatch[1] === 'a' ? 'article' : idMatch[1];
            return { title: cleanTitle, link: `https://www.toutiao.com/${type}/${idMatch[2]}/` };
          }
        } catch { /* ignore decode errors */ }
      }
      return { ...item, title: cleanTitle };
    });

    // Handle output logic
    let outputTarget = kwargs.output;
    const shouldOutput = outputTarget === true || (typeof outputTarget === 'string' && outputTarget.length > 0);

    if (shouldOutput) {
      const outputDir = typeof outputTarget === 'string' && outputTarget
        ? outputTarget
        : path.join(homedir(), '.opencli', 'toutiao_output');
      
      fs.mkdirSync(outputDir, { recursive: true });
      const timestamp = Date.now();
      // Generate filename based on category if set
      const catPart = kwargs.category ? `_${String(kwargs.category).replace(/[^\w]/g, '')}` : '';
      const fileName = `toutiao_list${catPart}_${timestamp}.json`;
      const filePath = path.join(outputDir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
      console.log(`Data saved to ${filePath}`);
    }

    return filtered;
  },
});
