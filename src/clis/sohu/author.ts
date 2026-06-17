/**
 * Sohu article author — fetch author info from a sohu article page via
 * HTTP fetch + parsing the inline `var cfgs` script block.
 *
 * Usage: opencli sohu author --url "https://m.sohu.com/a/1033155452_122846686"
 */
import { cli, Strategy } from '../../registry.js';
import { CommandExecutionError, EmptyResultError } from '../../errors.js';

function extractArticleId(url: string): string | null {
  const str = String(url).trim();
  const match = str.match(/\/a\/(\d+)/);
  if (match) return match[1];
  return null;
}

cli({
  site: 'sohu',
  name: 'author',
  description: '查看搜狐号文章作者信息（公开页面解析，无需登录）',
  domain: 'm.sohu.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'url', required: true, help: '文章链接' },
  ],
  columns: ['author_name', 'author_id', 'author_avatar', 'personal_page'],
  func: async (_page, kwargs) => {
    const articleUrl = String(kwargs.url || '').trim();
    if (!articleUrl) throw new CommandExecutionError('文章链接不能为空');

    const articleId = extractArticleId(articleUrl);
    if (!articleId) throw new CommandExecutionError(`无法从链接中解析文章ID: ${articleUrl}`);

    // Try mobile URL first (m.sohu.com has the cfgs script block with full author data)
    const pageUrl = articleUrl.includes('m.sohu.com')
      ? articleUrl
      : `https://m.sohu.com/a/${articleId}`;

    let resp: Response;
    try {
      resp = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          Referer: 'https://m.sohu.com/',
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`sohu author request failed: ${msg}`);
    }

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new EmptyResultError('sohu author', '文章不存在或已被删除');
      }
      throw new CommandExecutionError(`sohu author failed: HTTP ${resp.status}`);
    }

    let html: string;
    try {
      html = await resp.text();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`sohu author failed to read response: ${msg}`);
    }

    // Parse author data from the `var cfgs = { ... }` script block
    const cfgs = parseCfgs(html);
    if (!cfgs || !cfgs.authorName) {
      throw new EmptyResultError('sohu author', '未找到作者信息');
    }

    return [{
      author_name: cfgs.authorName,
      author_id: cfgs.authorId || '',
      author_avatar: cfgs.authorAvatar || '',
      personal_page: cfgs.personalPage || '',
    }];
  },
});

// ============ HTML extraction helpers ============

interface CfgsData {
  authorName?: string;
  authorId?: string;
  authorAvatar?: string;
  personalPage?: string;
  mediaId?: string;
  title?: string;
  newsId?: string;
}

/**
 * Parse the `var cfgs = { ... }` block from sohu mobile article HTML.
 * This block contains structured author data including name, ID, avatar, etc.
 */
function parseCfgs(html: string): CfgsData | null {
  const match = html.match(/var\s+cfgs\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!match) return null;

  const block = match[1];
  const result: CfgsData = {};

  for (const key of ['authorName', 'authorId', 'authorAvatar', 'personalPage', 'mediaId', 'title', 'newsId'] as const) {
    const re = new RegExp(`${key}\\s*:\\s*['"]([^'"]*)['"]`);
    const m = block.match(re);
    if (m && m[1]) {
      (result as Record<string, string>)[key] = m[1];
    }
  }

  return result;
}
