/**
 * Toutiao utility functions and constants.
 *
 * Shared across hot.ts (public hot-board API) and articles.ts (creator-backend).
 */

import { ArgumentError } from '../../errors.js';

// ── Articles (creator-backend) ──────────────────────────────────────────

const ARTICLES_MIN_PAGE = 1;
const ARTICLES_MAX_PAGE = 4;
const HOT_MIN_LIMIT = 1;
const HOT_MAX_LIMIT = 50;

/** Validate and parse --page argument (1-4). */
export function parseArticlesPage(raw: unknown, fallback = 1): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ArgumentError(`--page must be an integer between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${JSON.stringify(raw)}`);
  }
  if (parsed < ARTICLES_MIN_PAGE || parsed > ARTICLES_MAX_PAGE) {
    throw new ArgumentError(`--page must be between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${parsed}`);
  }
  return parsed;
}

/** Validate and parse --limit argument (1-50). */
export function parseHotLimit(raw: unknown, fallback = 30): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ArgumentError(`--limit must be an integer between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
  }
  if (parsed < HOT_MIN_LIMIT || parsed > HOT_MAX_LIMIT) {
    throw new ArgumentError(`--limit must be between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${parsed}`);
  }
  return parsed;
}

/** Lines to skip when scanning backwards for a title. */
const NON_TITLE_LINES = new Set([
  '展现', '阅读', '点赞', '评论',
  '查看数据', '查看评论', '修改', '更多', '首发',
  '已发布', '定时发布', '定时发布中', '由文章生成', '审核中',
]);

/** Regex for the stats line: 展现 X 阅读 Y 点赞 Z 评论 W */
const STATS_RE = /展现\s*([\d,]+)\s*阅读\s*([\d,]+)\s*点赞\s*([\d,]+)\s*评论\s*([\d,]*)/;

/**
 * Extract creator-backend article rows from the rendered text dump.
 *
 * Each row is anchored on a `MM-DD HH:MM` line. If the stats line is missing
 * (slow render / missing element), the row is still emitted with `null` for
 * stat columns rather than silently dropped.
 */
export function parseToutiaoArticlesText(text: string): Array<{
  title: string;
  date: string;
  status: string | null;
  '展现': string | null;
  '阅读': string | null;
  '点赞': string | null;
  '评论': string | null;
}> {
  type ArticleRow = {
    title: string;
    date: string;
    status: string | null;
    '展现': string | null;
    '阅读': string | null;
    '点赞': string | null;
    '评论': string | null;
  };
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const results: ArticleRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(line)) continue;

    const date = line;
    let title: string | null = null;
    let status: string | null = null;
    let stats: { '展现': string; '阅读': string; '点赞': string; '评论': string } | null = null;

    // Scan backwards up to 3 lines for the title
    for (let back = 3; back >= 1; back--) {
      const prev = lines[i - back] || '';
      if (!prev || prev.length >= 100 || /^\d+$/.test(prev) || NON_TITLE_LINES.has(prev)) continue;
      title = prev;
      break;
    }

    // Scan forwards up to 7 lines for status and stats
    for (let fwd = 1; fwd < 8; fwd++) {
      const fwdLine = lines[i + fwd] || '';
      if (fwdLine === '已发布' || fwdLine === '定时发布中' || fwdLine === '审核中' || fwdLine === '由文章生成') {
        status = fwdLine;
      }
      if (fwdLine.includes('展现') && fwdLine.includes('阅读')) {
        const match = fwdLine.match(STATS_RE);
        if (match) {
          stats = {
            '展现': match[1],
            '阅读': match[2],
            '点赞': match[3],
            '评论': match[4] || '0',
          };
        }
      }
    }

    if (!title) continue;

    if (stats) {
      results.push({ title, date, status, ...stats });
    } else {
      results.push({
        title, date, status,
        '展现': null, '阅读': null, '点赞': null, '评论': null,
      });
    }
  }

  return results;
}

// ── Hot Board (public API) ──────────────────────────────────────────────

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function pickImage(item: HotBoardItem): string | null {
  const imageObj = item?.Image as Record<string, unknown> | undefined;
  if (!imageObj) return null;

  const directUrl = imageObj?.url as string | undefined;
  if (typeof directUrl === 'string' && directUrl) return directUrl;

  const urlList = imageObj?.url_list as unknown[] | undefined;
  if (Array.isArray(urlList)) {
    for (const entry of urlList) {
      const u = typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.url;
      if (typeof u === 'string' && u) return u;
    }
  }
  return null;
}

function parseHot(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface HotBoardItem {
  ClusterIdStr?: string;
  ClusterId?: number | string;
  Title: string;
  QueryWord?: string;
  HotValue?: unknown;
  Label?: string;
  Url?: string;
  Image?: unknown;
}

/** Project a row from the public toutiao hot-board API into stable shape. */
export function mapHotRow(item: HotBoardItem, index: number): {
  rank: number;
  group_id: string | null;
  title: string;
  query: string;
  hot_value: number | null;
  label: string | null;
  url: string | null;
  image_url: string | null;
} | null {
  if (!item || typeof item !== 'object') return null;
  const groupId = trimOrNull(item.ClusterIdStr ?? (item.ClusterId != null ? String(item.ClusterId) : null));
  const title = trimOrNull(item.Title);
  if (!title) return null;
  return {
    rank: index + 1,
    group_id: groupId,
    title,
    query: trimOrNull(item.QueryWord) || title,
    hot_value: parseHot(item.HotValue),
    label: trimOrNull(item.Label),
    url: trimOrNull(item.Url),
    image_url: pickImage(item),
  };
}

/** Public hot-board endpoint serving the homepage trending panel. */
export const HOT_BOARD_URL = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';

// ── Authentication detection ────────────────────────────────────────────

/** Detect whether a text dump looks like a Toutiao login wall. */
export function looksToutiaoAuthWallText(value: string): boolean {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  return /登录|请登录|账号登录|扫码登录|安全验证|验证码|captcha/.test(text) ||
    /\b(login|sign in|captcha|verification required)\b/.test(text) ||
    /mp\.toutiao\.com\/profile_v4\/login/.test(text);
}

export const __test__ = { ARTICLES_MIN_PAGE, ARTICLES_MAX_PAGE, HOT_MIN_LIMIT, HOT_MAX_LIMIT };
