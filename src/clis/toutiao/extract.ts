import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

function extractArticleId(url: string): string {
  const match = url.match(/article\/(\d+)/);
  return match ? match[1] : Date.now().toString();
}

async function extractContent(page: IPage, retries = 3): Promise<{ title: string; content: string; publishTime: string }> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const result = await page.evaluate(`(function() {
          var title = '';
          var titleSelectors = ['article h1', 'h1.article-title', 'h1', 'meta[property="og:title"]'];
          for (var i = 0; i < titleSelectors.length; i++) {
            var el = document.querySelector(titleSelectors[i]);
            if (el) {
              title = el.getAttribute('content') || el.textContent || '';
              title = title.trim();
              if (title) break;
            }
          }
          if (!title) title = document.title || '';

          var publishTime = '';
          var timeSelectors = [
            'meta[property="article:published_time"]',
            'meta[itemprop="datePublished"]',
            'meta[name="publishdate"]',
            'meta[name="date"]',
            'time[datetime]',
            '.article-meta span',
            '.article-meta',
            '.article-sub .date',
            '.article-sub time',
            '.author-info .time',
            '.author-info time',
          ];
          for (var i = 0; i < timeSelectors.length; i++) {
            var el = document.querySelector(timeSelectors[i]);
            if (el) {
              publishTime = el.getAttribute('content') || el.getAttribute('datetime') || el.textContent || '';
              publishTime = publishTime.trim();
              if (publishTime) break;
            }
          }
          // Fallback: search page for date pattern like "2026-04-29 04:57"
          if (!publishTime) {
            var bodyText = document.body ? document.body.innerText || '' : '';
            var dateMatch = bodyText.match(/(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2})/);
            if (dateMatch) publishTime = dateMatch[1];
          }

          var contentSelectors = ['.article-content', 'div.article-content', '.pgc-article-content', '#article-root', 'article'];
          var contentContainer = null;
          for (var j = 0; j < contentSelectors.length; j++) {
            var el2 = document.querySelector(contentSelectors[j]);
            if (el2) { contentContainer = el2; break; }
          }

          if (contentContainer) {
            var clone = contentContainer.cloneNode(true);
            var allEls = clone.querySelectorAll('*');
            var mediaText = '';

            // 1. Media Extraction
            for (var i = 0; i < allEls.length; i++) {
              var elem = allEls[i];
              var tagName = elem.tagName.toLowerCase();
              var src = elem.getAttribute('data-lazy-src') || elem.getAttribute('data-src') || elem.getAttribute('data-original') || elem.getAttribute('src') || elem.getAttribute('original-src') || '';
              
              if (!src && tagName === 'noscript' && elem.textContent) {
                 var temp = document.createElement('div');
                 temp.innerHTML = elem.textContent;
                 var nImg = temp.querySelector('img');
                 var nVid = temp.querySelector('video');
                 if (nImg) src = nImg.getAttribute('src') || nImg.getAttribute('original-src') || '';
                 if (nVid) src = nVid.getAttribute('src') || nVid.getAttribute('data-src') || '';
              }

              if (src) src = src.trim();

              var isValid = src && (src.indexOf('http') === 0 || src.indexOf('//') === 0 || src.indexOf('data:') === 0);
              var isTracking = src.indexOf('stat') !== -1 || src.indexOf('log') !== -1 || src.indexOf('bytelog') !== -1;

              if (isValid && !isTracking) {
                 mediaText += (['video', 'source'].indexOf(tagName) !== -1 ? '[视频] ' : '[图片] ') + (src.indexOf('//') === 0 ? 'https:' + src : src) + '\\n\\n';
              }
              
              var bgUrl = '';
              try { bgUrl = elem.style.getPropertyValue('background-image') || ''; } catch(e) {}
              if (bgUrl && bgUrl.indexOf('url(') !== -1) {
                 bgUrl = bgUrl.replace(/url\(["']?([^"')]+)["']?\)/, '$1').trim();
                 if (bgUrl && bgUrl.startsWith('http')) {
                    mediaText += '[图片] ' + bgUrl + '\\n\\n';
                 }
              }
            }

            // 2. Remove unwanted elements
            var unwanted = clone.querySelectorAll('script, style, .ad, .ad-wrapper, .recommend, .recommend-wrapper, .related-articles, h1, .article-title, .video-player-controls, .pgc-player-overlay, .xgplayer-controls, .xgplayer-ctrl, .video-controller, .player-control, .xgplayer, .xgplayer-mask, .pgc-player, .player-wrap, .video-cover-layer, noscript');
            for (var n = 0; n < unwanted.length; n++) {
              if (unwanted[n].parentNode) unwanted[n].parentNode.removeChild(unwanted[n]);
            }

            // 3. Clean up leftover media controls text
            var leftover = clone.querySelectorAll('*');
            for (var q = leftover.length - 1; q >= 0; q--) {
              var el = leftover[q];
              if (el.children.length === 0) {
                var t = (el.innerText || '').trim();
                if (/重播|暂停|直播|进入全屏|点击按住可拖动视频|打开画中画/.test(t)) {
                  if (el.parentNode) el.parentNode.removeChild(el);
                }
              }
            }

            var text = clone.innerText || clone.textContent || '';
            var lines = text.split('\\n');
            var cleaned = [];
            for (var p = 0; p < lines.length; p++) {
              var l = lines[p].trim();
              if (l.length > 0) cleaned.push(l);
            }
            return { title: title, publishTime: publishTime, content: mediaText + cleaned.join('\\n\\n') };
          }

          return { title: title, publishTime: publishTime, content: '' };
        })()`);

      if (!result.title && !result.content) {
        throw new Error('未找到标题或正文内容');
      }

      return {
        title: result.title || '未知标题',
        publishTime: result.publishTime || '',
        content: result.content || '正文提取失败',
      };
    } catch (e) {
      lastError = e as Error;
      if (i < retries - 1) {
        await page.wait({ time: 2 });
      }
    }
  }

  throw lastError || new Error('内容提取失败');
}

cli({
  site: 'toutiao',
  name: 'extract',
  description: '提取今日头条文章内容并保存为JSON文件',
  domain: 'www.toutiao.com',
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: 'url', required: true, help: '文章链接' },
    { name: 'out-dir', required: false, help: '自定义输出目录' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const articleUrl = String(kwargs.url || '').trim();
    if (!articleUrl) throw new Error('文章链接不能为空');

    await page.goto(articleUrl);
    await page.wait({ time: 3 });

    const extracted = await extractContent(page);

    const outDir = kwargs['out-dir'] || path.join(os.homedir(), '.opencli', 'toutiao_output');
    await fs.mkdir(outDir, { recursive: true });

    const articleId = extractArticleId(articleUrl);
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
    const fileName = `toutiao_${articleId}_${timestamp}.json`;
    const filePath = path.join(outDir, fileName);

    const output = {
      title: extracted.title,
      publishTime: extracted.publishTime,
      content: extracted.content,
    };

    await fs.writeFile(filePath, JSON.stringify(output, null, 2), 'utf-8');

    return [{ status: '成功', detail: `已保存至 ${filePath}` }];
  },
});
