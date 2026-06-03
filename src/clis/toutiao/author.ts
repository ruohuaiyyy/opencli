/**
 * Toutiao article author — fetch author info (screen_name, follower_count, auth_info)
 * from the public mobile API. No authentication required.
 *
 * Usage: opencli toutiao author --url "https://www.toutiao.com/article/7493364682510680586"
 */
import { cli, Strategy } from '../../registry.js';
import { CommandExecutionError, EmptyResultError } from '../../errors.js';

function extractItemId(url: string): string | null {
  const str = String(url).trim();
  // Patterns:
  //   https://www.toutiao.com/article/7493364682510680586
  //   https://toutiao.com/group/7493364682510680586/
  //   http://m.toutiao.com/group/7644409370134741546/
  const match = str.match(/(?:group|article)\/(\d+)/);
  if (match) return match[1];
  // Also try just a numeric path segment
  const numMatch = str.match(/\/(\d{15,})/);
  if (numMatch) return numMatch[1];
  return null;
}

cli({
  site: 'toutiao',
  name: 'author',
  description: '查看今日头条文章作者信息（公开 API，无需登录）',
  domain: 'www.toutiao.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'url', required: true, help: '文章链接' },
  ],
  columns: ['screen_name', 'follower_count', 'auth_info', 'media_id'],
  defaultFormat: 'json',
  func: async (_page, kwargs) => {
    const articleUrl = String(kwargs.url || '').trim();
    if (!articleUrl) throw new CommandExecutionError('文章链接不能为空');

    const itemId = extractItemId(articleUrl);
    if (!itemId) throw new CommandExecutionError(`无法从链接中解析文章ID: ${articleUrl}`);

    const apiUrl = `https://m.toutiao.com/i${itemId}/info/`;

    let resp: Response;
    try {
      resp = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://www.toutiao.com/',
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao author request failed: ${msg}`);
    }

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new EmptyResultError('toutiao author', '文章不存在或已被删除');
      }
      throw new CommandExecutionError(`toutiao author failed: HTTP ${resp.status}`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await resp.json() as Record<string, unknown>;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao author returned malformed JSON: ${msg}`);
    }

    if (!payload?.data) {
      throw new EmptyResultError('toutiao author', 'API 未返回文章数据');
    }

    const data = payload.data as Record<string, unknown>;
    const mediaUser = (data.media_user || {}) as Record<string, unknown>;
    const userAuthInfo = (mediaUser.user_auth_info || {}) as Record<string, unknown>;

    if (!mediaUser.screen_name && !data.source) {
      throw new EmptyResultError('toutiao author', '未找到作者信息');
    }

    return [{
      screen_name: mediaUser.screen_name || data.source || '',
      follower_count: String(mediaUser.follower_count ?? ''),
      auth_info: userAuthInfo.auth_info || '',
      media_id: String(mediaUser.id ?? data.media_id ?? ''),
    }];
  },
});