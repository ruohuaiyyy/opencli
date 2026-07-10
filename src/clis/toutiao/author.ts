/**
 * Toutiao article author — fetch author info (screen_name, follower_count, auth_info)
 * from the public mobile API. No authentication required.
 *
 * Supports:
 *   - Standard article:  https://www.toutiao.com/article/{id}
 *                        https://toutiao.com/group/{id}/
 *   - Short link `a`:    https://www.toutiao.com/a{id}
 *                        https://m.toutiao.com/a{id}/
 *   - News (zixun):      https://www.toutiao.com/zixun/{id}/   (HTML fallback)
 *   - Microblog (w):     https://www.toutiao.com/w/{id}/        (thread data path)
 *
 * Usage: opencli toutiao author --url "https://www.toutiao.com/article/7493364682510680586"
 */
import { cli, Strategy } from '../../registry.js';
import { CommandExecutionError, EmptyResultError } from '../../errors.js';

export function extractItemId(url: string): string | null {
  const str = String(url).trim();
  // Patterns:
  //   https://www.toutiao.com/article/7493364682510680586
  //   https://toutiao.com/group/7493364682510680586/
  //   http://m.toutiao.com/group/7644409370134741546/
  //   https://www.toutiao.com/a7654576612733633058?channel=  (short link, no separator)
  //   https://m.toutiao.com/a1829516766819331/
  //   https://www.toutiao.com/zixun/7537563358837803060/    (news)
  //   https://www.toutiao.com/w/1860901006413911/          (weitoutiao)
  const match = str.match(/(?:group|article)\/(\d+)/);
  if (match) return match[1];
  // Short link a{id} — `a` immediately followed by digits (no slash separator).
  // Use a left boundary of `^`, `/`, `?`, or `=` so `article/...` is not matched
  // (after the leading `a` comes `rticle`, not digits).
  const shortMatch = str.match(/(?:^|[/?=])a(\d{12,})(?:[/?#]|$)/);
  if (shortMatch) return shortMatch[1];
  // Also try just a numeric path segment (covers zixun, w, etc.)
  const numMatch = str.match(/\/(\d{15,})/);
  if (numMatch) return numMatch[1];
  return null;
}

interface AuthorRow {
  screen_name: string;
  follower_count: string;
  auth_info: string;
  media_id: string;
}

/**
 * Pull the author row out of a mobile-API payload. Returns null when the API
 * payload doesn't carry author info (e.g. zixun news returns `data: null`).
 */
export function extractAuthorFromApi(payload: unknown): AuthorRow | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // 1. Standard article: data.media_user.{screen_name, follower_count, user_auth_info, id}
  const mediaUser = obj.media_user as Record<string, unknown> | undefined;
  if (mediaUser && typeof mediaUser.screen_name === 'string' && mediaUser.screen_name) {
    const userAuthInfo = (mediaUser.user_auth_info as Record<string, unknown> | undefined) || {};
    return {
      screen_name: mediaUser.screen_name,
      follower_count: String(mediaUser.follower_count ?? ''),
      auth_info: String((userAuthInfo as Record<string, unknown>).auth_info || ''),
      media_id: String(mediaUser.id ?? obj.media_id ?? ''),
    };
  }

  // 2. Microblog (微头条): data.thread.thread_base.user.info.{name, user_id, user_auth_info}
  const threadBase = (obj.thread as Record<string, unknown> | undefined)?.thread_base as
    | Record<string, unknown>
    | undefined;
  const userInfo = (threadBase?.user as Record<string, unknown> | undefined)?.info as
    | Record<string, unknown>
    | undefined;
  if (userInfo && typeof userInfo.name === 'string' && userInfo.name) {
    let authInfo = '';
    const rawAuth = userInfo.user_auth_info;
    if (typeof rawAuth === 'string' && rawAuth) {
      try {
        const parsed = JSON.parse(rawAuth) as Record<string, unknown>;
        authInfo = String(parsed.auth_info || '');
      } catch {
        authInfo = '';
      }
    }
    return {
      screen_name: userInfo.name,
      follower_count: '',
      auth_info: authInfo,
      media_id: String(userInfo.user_id ?? ''),
    };
  }

  return null;
}

/**
 * Fallback for news (zixun) pages: the mobile API returns `data: null`, so
 * the only place author info lives is in the URL-encoded JSON embedded in
 * the rendered HTML page (`data.mediaInfo.{name, unsafeUserId, userAuthInfo}`).
 *
 * Returns null when the HTML doesn't contain a recognisable mediaInfo blob.
 */
export async function extractAuthorFromZixunHtml(articleUrl: string): Promise<AuthorRow | null> {
  let resp: Response;
  try {
    resp = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.toutiao.com/',
      },
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let html: string;
  try {
    html = await resp.text();
  } catch {
    return null;
  }

  // Find script tags whose inner content is URL-encoded JSON starting with %7B.
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const inner = match[1].trim();
    if (!inner.startsWith('%7B') && !inner.startsWith('%7b')) continue;

    let decoded: string;
    try {
      decoded = decodeURIComponent(inner);
    } catch {
      continue;
    }
    if (!decoded.includes('"mediaInfo"')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      continue;
    }

    const mediaInfo = (parsed as Record<string, unknown>)?.data
      ? ((parsed as Record<string, unknown>).data as Record<string, unknown>).mediaInfo
      : undefined;
    if (!mediaInfo || typeof mediaInfo !== 'object') continue;

    const info = mediaInfo as Record<string, unknown>;
    const name = info.name;
    if (typeof name !== 'string' || !name) continue;

    const userAuthInfo = (info.userAuthInfo as Record<string, unknown> | undefined) || {};
    return {
      screen_name: name,
      follower_count: '',
      auth_info: String(userAuthInfo.auth_info || ''),
      media_id: String(info.unsafeUserId ?? ''),
    };
  }

  return null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  func: async (_page, kwargs) => {
    const articleUrl = String(kwargs.url || '').trim();
    if (!articleUrl) throw new CommandExecutionError('文章链接不能为空');

    const itemId = extractItemId(articleUrl);
    if (!itemId) throw new CommandExecutionError(`无法从链接中解析文章ID: ${articleUrl}`);

    const apiUrl = `https://m.toutiao.com/i${itemId}/info/`;

    let apiResp: Response;
    try {
      apiResp = await fetch(apiUrl, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          Referer: articleUrl,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao author request failed: ${msg}`);
    }

    if (!apiResp.ok) {
      if (apiResp.status === 404) {
        throw new EmptyResultError('toutiao author', '文章不存在或已被删除');
      }
      throw new CommandExecutionError(`toutiao author failed: HTTP ${apiResp.status}`);
    }

    let payload: unknown;
    try {
      payload = await apiResp.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao author returned malformed JSON: ${msg}`);
    }

    let row = extractAuthorFromApi(payload);

    // News (zixun) pages return `data: null` from the mobile API. Author info
    // is only available in the rendered HTML, so fall back to parsing it.
    if (!row) {
      row = await extractAuthorFromZixunHtml(articleUrl);
    }

    if (!row) {
      throw new EmptyResultError('toutiao author', '未找到作者信息');
    }

    return [row];
  },
});

export const __test__ = { extractItemId, extractAuthorFromApi, extractAuthorFromZixunHtml };