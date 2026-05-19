/**
 * Toutiao homepage hot-board — public trending news topics on Toutiao.
 *
 * Backed by the public hot-event/hot-board endpoint which serves the same JSON
 * the toutiao.com homepage hot panel renders. No authentication required.
 */
import { cli, Strategy } from '../../registry.js';
import { CommandExecutionError, EmptyResultError } from '../../errors.js';
import { HOT_BOARD_URL, mapHotRow, parseHotLimit, type HotBoardItem } from './utils.js';

cli({
  site: 'toutiao',
  name: 'hot',
  description: '今日头条首页热榜（公开 API，无需登录）',
  domain: 'www.toutiao.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'limit', type: 'int', default: 30, help: '返回条数 (1-50)' },
  ],
  columns: ['rank', 'group_id', 'title', 'query', 'hot_value', 'label', 'url', 'image_url'],
  func: async (_page, kwargs) => {
    const limit = parseHotLimit(kwargs?.limit, 30);
    let resp: Response;
    try {
      resp = await fetch(HOT_BOARD_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://www.toutiao.com/',
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao hot-board request failed: ${msg}`);
    }
    if (!resp.ok) {
      throw new CommandExecutionError(`toutiao hot-board failed: HTTP ${resp.status}`);
    }
    let payload: Record<string, unknown>;
    try {
      payload = await resp.json() as Record<string, unknown>;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`toutiao hot-board returned malformed JSON: ${msg}`);
    }
    if (payload?.status && payload.status !== 'success') {
      throw new CommandExecutionError(`toutiao hot-board returned status=${payload.status}`);
    }
    if (payload?.error || payload?.message) {
      throw new CommandExecutionError(`toutiao hot-board returned error: ${payload.error || payload.message}`);
    }
    const list = Array.isArray(payload?.data) ? payload.data as unknown as HotBoardItem[] : [];
    const rows = list.map(mapHotRow).filter(Boolean).slice(0, limit);
    if (rows.length === 0) {
      throw new EmptyResultError('toutiao hot', '上游 hot-board 返回空列表。');
    }
    // Re-rank (1..N) after filter so ranks are dense even if upstream had nulls.
    return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
  },
});
