/**
 * Toutiao user article list — fetch articles from a public author profile page.
 *
 * Uses browser automation to visit the author's profile page, scroll to
 * trigger lazy-loading of article cards, then extract titles, dates, and
 * metrics from the DOM. No authentication required.
 *
 * Usage:
 *   opencli toutiao userArticles --url "https://www.toutiao.com/c/user/token/MS4wLjABAAAAxxxx/"
 *   opencli toutiao userArticles --url "https://www.toutiao.com/c/user/token/MS4wLjABAAAAxxxx/" --scrolls 10
 *   opencli toutiao userArticles --url "https://www.toutiao.com/c/user/token/MS4wLjABAAAAxxxx/" --days 30 --limit 20
 */
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { CommandExecutionError, EmptyResultError } from '../../errors.js';

function extractProfileUrl(rawUrl: string): string | null {
  const url = String(rawUrl).trim();
  const match = url.match(/c\/user\/token\/([\w-]+)/);
  return match ? match[1] : null;
}

async function scrollPage(page: IPage, maxScrolls: number): Promise<void> {
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(
      '(() => { window.scrollTo(0, document.body.scrollHeight); })()'
    );
    await page.wait({ time: 2 });
  }
  await page.evaluate(
    '(() => { window.scrollTo({ top: 0, behavior: "smooth" }); })()'
  );
  await page.wait({ time: 1 });
}

async function extractArticles(page: IPage): Promise<Array<{
  title: string;
  date: string;
  url: string;
  readCount: string;
}>> {
  return page.evaluate(`
    (() => {
      const results = [];
      const seen = new Set();

      // Iterate over feed-card-wrappers (each represents one article/video)
      const wrappers = document.querySelectorAll('.feed-card-wrapper');

      for (const wrapper of Array.from(wrappers)) {
        // Pick the title link specifically — skip cover image links with empty text
        const titleLink = wrapper.querySelector('.feed-card-article-l a.title, .feed-card-video a');
        if (!titleLink) continue;

        const href = titleLink.getAttribute('href') || '';
        if (!href || href.startsWith('javascript')) continue;

        let fullUrl = href;
        if (!fullUrl.startsWith('http')) fullUrl = 'https://www.toutiao.com' + fullUrl;
        const normalizedHref = fullUrl.split('?')[0].split('#')[0];

        // Dedup only after we have a valid title link
        if (seen.has(normalizedHref)) continue;

        let title = (titleLink.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!title || title.length < 3) continue;

        // Filter UI noise using alternation (|) — not character class ([…])
        if (/^(阅读|点赞|评论|分享|关注|展现|举报|广告|首页|搜索|登录|注册|收藏|\\d+阅读)$/.test(title)) continue;

        seen.add(normalizedHref);

        // Extract date from the precise footer element inside the wrapper
        let date = '';
        const timeEl = wrapper.querySelector('.feed-card-footer-time-cmp');
        if (timeEl) {
          date = timeEl.textContent.trim();
        } else {
          const wrapperText = wrapper.textContent || '';
          const dateMatch = wrapperText.match(/(\\d{4}-\\d{2}-\\d{2})/);
          if (dateMatch) date = dateMatch[1];
          else {
            const relMatch = wrapperText.match(/(\\d+\\s*(小时|分钟|天)前)/);
            if (relMatch) date = relMatch[1];
          }
        }

        // Extract read count from the tools-text element
        let readCount = '';
        const readEl = wrapper.querySelector('.profile-feed-card-tools-text');
        if (readEl) readCount = readEl.textContent.trim();

        results.push({ title, date, url: normalizedHref, readCount });
      }

      return results;
    })()
  `);
}

cli({
  site: 'toutiao',
  name: 'userArticles',
  description: '获取今日头条指定作者的文章列表（可配置时间范围）',
  domain: 'www.toutiao.com',
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: 'url', required: true, help: '作者主页链接，如 https://www.toutiao.com/c/user/token/MS4wLjABAAAAxxxx/' },
    { name: 'days', type: 'int', default: 30, help: '时间范围（天数，默认30天）' },
    { name: 'limit', type: 'int', default: 50, help: '返回条数上限（默认50）' },
    { name: 'scrolls', type: 'int', default: 5, help: '滚动次数（默认5次，每次间隔2秒）' },
  ],
  columns: ['rank', 'title', 'date', 'readCount', 'url'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const rawUrl = String(kwargs.url || '').trim();
    if (!rawUrl) throw new CommandExecutionError('作者主页链接不能为空');

    const profileId = extractProfileUrl(rawUrl);
    if (!profileId) throw new CommandExecutionError(
      `无法从链接中解析用户token: ${rawUrl}`
    );

    const days = Number(kwargs.days ?? 30);
    const limit = Number(kwargs.limit ?? 50);
    const scrolls = Number(kwargs.scrolls ?? 5);

    if (!Number.isFinite(days) || days < 1) {
      throw new CommandExecutionError(`--days 必须大于 0，当前值: ${days}`);
    }
    if (!Number.isFinite(limit) || limit < 1) {
      throw new CommandExecutionError(`--limit 必须大于 0，当前值: ${limit}`);
    }
    if (!Number.isFinite(scrolls) || scrolls < 1) {
      throw new CommandExecutionError(`--scrolls 必须大于 0，当前值: ${scrolls}`);
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const profileUrl = `https://www.toutiao.com/c/user/token/${profileId}/`;
    console.log(`  访问作者主页: ${profileUrl}`);

    try {
      await page.goto(profileUrl);
      await page.wait({ time: 3 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao userArticles page load failed: ${msg}`);
    }

    console.log(`  滚动页面加载文章... (滚动 ${scrolls} 次)`);
    await scrollPage(page, scrolls);

    let rawList = await extractArticles(page);
    console.log(`  共找到 ${rawList.length} 篇文章`);

    const rows: Array<{ rank: number; title: string; date: string; readCount: string; url: string }> = [];
    for (const article of rawList) {
      if (rows.length >= limit) break;

      const articleDate = parseArticleDate(article.date);
      if (articleDate && articleDate < cutoffDate) continue;

      rows.push({
        rank: rows.length + 1,
        title: article.title,
        date: article.date || '',
        readCount: article.readCount || '',
        url: article.url,
      });
    }

    if (rows.length === 0) {
      throw new EmptyResultError(
        'toutiao userArticles',
        `作者近 ${days} 天内无文章，或页面未正确渲染。`,
      );
    }

    return rows;
  },
});

function parseArticleDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  const hourMatch = dateStr.match(/(\d+)\s*小时前/);
  if (hourMatch) {
    const d = new Date();
    d.setHours(d.getHours() - Number(hourMatch[1]));
    return d;
  }

  const minMatch = dateStr.match(/(\d+)\s*分钟前/);
  if (minMatch) {
    const d = new Date();
    d.setMinutes(d.getMinutes() - Number(minMatch[1]));
    return d;
  }

  const dayMatch = dateStr.match(/(\d+)\s*天前/);
  if (dayMatch) {
    const d = new Date();
    d.setDate(d.getDate() - Number(dayMatch[1]));
    return d;
  }

  const absMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (absMatch) {
    return new Date(Number(absMatch[1]), Number(absMatch[2]) - 1, Number(absMatch[3]));
  }

  const shortMatch = dateStr.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (shortMatch) {
    const now = new Date();
    const month = Number(shortMatch[1]) - 1;
    const day = Number(shortMatch[2]);
    const year = month > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
    return new Date(year, month, day, Number(shortMatch[3]), Number(shortMatch[4]));
  }

  return null;
}
