/**
 * Xiaohongshu keep-alive — maintains login session by keeping a page open.
 *
 * Use this to refresh cookies and prevent session expiry across multiple accounts.
 *
 * Usage:
 *   opencli xiaohongshu keep-alive                     # 30s keep-alive, close after 5s
 *   opencli xiaohongshu keep-alive --duration 60        # keep alive for 60 seconds
 *   opencli xiaohongshu keep-alive --close-after -1     # keep alive, don't close tab
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const DEFAULT_URL = 'https://creator.xiaohongshu.com';

cli({
  site: 'xiaohongshu',
  name: 'keep-alive',
  description: '保持小红书登录态活跃，刷新 Cookie 有效期',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'duration', type: 'number', default: 30, help: '保活时长（秒），默认30' },
    { name: 'close-after', type: 'number', default: 5, help: '保活后关闭标签页的秒数（-1=不关闭，默认5）' },
    { name: 'url', required: false, help: '保活目标 URL，默认创作者中心首页' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const duration = Number(kwargs.duration ?? 30);
    const closeAfter = Number(kwargs['close-after'] ?? 5);
    const targetUrl = String(kwargs.url ?? DEFAULT_URL);

    // ── Step 1: Navigate to target URL ──────────────────────────────────────
    // Retry navigation: on fresh Chrome profiles the extension may not be
    // fully connected yet, causing "Inspected target navigated or closed".
    let navOk = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(targetUrl);
        await page.wait({ time: 3 });
        navOk = true;
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('navigated or closed') && attempt < 3) {
          await page.wait({ time: 2 });
          continue;
        }
        throw err;
      }
    }
    if (!navOk) {
      throw new Error('Failed to navigate after 3 attempts');
    }

    // ── Step 2: Verify login state ──────────────────────────────────────────
    const currentUrl: string = await page.evaluate('() => location.href');
    if (!currentUrl.includes('xiaohongshu.com')) {
      throw new Error(
        'Redirected away from xiaohongshu.com — session may have expired. ' +
        'Please log in to creator.xiaohongshu.com in Chrome first.'
      );
    }

    // ── Step 3: Keep page alive for duration ────────────────────────────────
    await page.wait({ time: duration });

    // ── Step 4: Optional refresh to trigger additional API calls ────────────
    if (duration > 10) {
      try {
        await page.evaluate('() => location.reload()');
        await page.wait({ time: 3 });
      } catch {
        // Refresh may cause brief CDP disconnect — non-fatal
      }
    }

    // ── Step 5: Close tab after delay ───────────────────────────────────────
    if (closeAfter >= 0) {
      await page.wait({ time: closeAfter });
      try {
        await page.closeTab();
      } catch {
        // Tab may already be closed due to navigation — non-fatal
      }
    }

    // ── Step 6: Return result ───────────────────────────────────────────────
    return [
      {
        status: '✅ 保活完成',
        detail: [
          `保活 ${duration}s`,
          closeAfter >= 0 ? `${closeAfter}s 后关闭标签页` : '标签页保持打开',
          currentUrl,
        ].join(' · '),
      },
    ];
  },
});
