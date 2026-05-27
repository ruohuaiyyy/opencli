import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

async function simulateHumanScroll(page: IPage): Promise<void> {
  function renderProgress(pct: number, width = 20): string {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}] ${pct}%`;
  }

  const pageHeight: number = await page.evaluate(`Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)`);
  const viewportHeight: number = await page.evaluate(`window.innerHeight`);
  const maxScroll = Math.max(0, pageHeight - viewportHeight);

  // 随机分段数：6-9 段（确保整体时间 15s 以上）
  const segments = 6 + Math.floor(Math.random() * 4);

  console.log('\n  开始模拟人类翻页...');

  let currentScroll = 0;

  for (let i = 0; i < segments; i++) {
    // 不均匀步进 — 前面多后面少（模拟注意力衰减）
    const remaining = maxScroll - currentScroll;
    if (remaining <= 50) break;

    const fraction = 0.12 + Math.random() * 0.28;
    const step = remaining * fraction * (1 + (segments - i) / segments * 0.3);
    currentScroll = Math.min(currentScroll + step, maxScroll);

    // 滚动到目标位置
    await page.evaluate(`(() => { window.scrollTo({ top: ${Math.round(currentScroll)}, behavior: 'smooth' }); })()`);
    const pct = maxScroll > 0 ? Math.round((currentScroll / maxScroll) * 100) : 100;
    process.stdout.write(`\r  ${renderProgress(pct)}`);

    // 随机停顿：2-5s，偶尔 6-8s（模拟认真阅读）
    const waitTime = 2000 + Math.random() * 6000;

    // 25% 概率轻微回滚（模拟看漏了回看）
    if (Math.random() < 0.25 && currentScroll > viewportHeight * 0.5) {
      const backBy = viewportHeight * (0.15 + Math.random() * 0.3);
      await page.wait({ time: Math.round(0.5 + Math.random()) });
      await page.evaluate(`(() => { window.scrollTo({ top: ${Math.round(currentScroll - backBy)}, behavior: 'smooth' }); })()`);
      await page.wait({ time: Math.round(0.5 + Math.random() * 1) });
      await page.evaluate(`(() => { window.scrollTo({ top: ${Math.round(currentScroll)}, behavior: 'smooth' }); })()`);
    }

    await page.wait({ time: Math.round(waitTime / 1000) });
  }

  console.log('');
  console.log('  ↕ 已到底部，正在回顾...');

  // 随机回顾位置：30%-70%
  const returnPct = 0.3 + Math.random() * 0.4;
  await page.evaluate(`(() => { window.scrollTo({ top: ${Math.round(maxScroll * returnPct)}, behavior: 'smooth' }); })()`);
  await page.wait({ time: 2 });

  // 回到顶部
  await page.evaluate(`(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); })()`);
  await page.wait({ time: 1.5 });

  console.log('  ✓ 文章浏览完成\n');
}

async function interactWithCheck(
  page: IPage,
  opts: {
    selector: string;
    name: string;
    checkStatus: () => Promise<{ exists: boolean; isDone: boolean }>;
    click: () => Promise<void>;
  }
): Promise<{ status: string; detail: string }> {
  const { exists, isDone } = await opts.checkStatus();

  if (!exists) {
    return { status: '跳过', detail: `未找到${opts.name}按钮` };
  }

  if (isDone) {
    return { status: '跳过', detail: `已${opts.name}` };
  }

  await opts.click();
  await page.wait({ time: 1 });

  return { status: '成功', detail: `${opts.name}成功` };
}

cli({
  site: 'toutiao',
  name: 'read',
  description: '阅读今日头条文章（支持自动滚动 + 点赞/收藏/关注）',
  domain: 'www.toutiao.com',
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: 'url', required: true, help: '文章链接' },
    { name: 'scroll', type: 'boolean', default: 'false', help: '是否模拟人类上下翻看内容' },
    { name: 'like', type: 'boolean', default: 'false', help: '是否点赞' },
    { name: 'collect', type: 'boolean', default: 'false', help: '是否收藏' },
    { name: 'follow', type: 'boolean', default: 'false', help: '是否关注' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const articleUrl = String(kwargs.url || '').trim();
    const doScroll = kwargs.scroll === true || kwargs.scroll === 'true';
    const doLike = kwargs.like === true || kwargs.like === 'true';
    const doCollect = kwargs.collect === true || kwargs.collect === 'true';
    const doFollow = kwargs.follow === true || kwargs.follow === 'true';

    if (!articleUrl) throw new Error('文章链接不能为空');

    await page.goto(articleUrl);
    await page.wait({ time: 3 });

    if (doScroll) {
      await simulateHumanScroll(page);
    }

    const results: Array<{ status: string; detail: string }> = [];

    if (doLike) {
      results.push(await interactWithCheck(page, {
        selector: '.detail-like',
        name: '点赞',
        checkStatus: async () => await page.evaluate(`
          () => {
            const btn = document.querySelector('.detail-like');
            if (!btn) return { exists: false };
            return {
              exists: true,
              isDone: btn.getAttribute('aria-pressed') === 'true' ||
                      (btn.getAttribute('aria-label') || '').includes('已点赞')
            };
          }
        `),
        click: async () => await page.evaluate(`
          () => {
            const btn = document.querySelector('.detail-like');
            if (btn && btn.offsetParent !== null) btn.click();
          }
        `),
      }));
    }

    if (doCollect) {
      results.push(await interactWithCheck(page, {
        selector: '.detail-interaction-collect',
        name: '收藏',
        checkStatus: async () => await page.evaluate(`
          () => {
            const btn = document.querySelector('.detail-interaction-collect');
            if (!btn) return { exists: false };
            return {
              exists: true,
              isDone: btn.getAttribute('aria-pressed') === 'true' ||
                      (btn.getAttribute('aria-label') || '').includes('已收藏')
            };
          }
        `),
        click: async () => await page.evaluate(`
          () => {
            const btn = document.querySelector('.detail-interaction-collect');
            if (btn && btn.offsetParent !== null) btn.click();
          }
        `),
      }));
    }

    if (doFollow) {
      results.push(await interactWithCheck(page, {
        selector: 'button:has-text("关注")',
        name: '关注',
        checkStatus: async () => await page.evaluate(`
          () => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => {
              const text = (b.textContent || '').trim();
              return text === '关注' || text === '+ 关注';
            });
            if (!btn) return { exists: false };
            return { exists: true, isDone: false };
          }
        `),
        click: async () => await page.evaluate(`
          () => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => {
              const text = (b.textContent || '').trim();
              return text === '关注' || text === '+ 关注';
            });
            if (btn && btn.offsetParent !== null) btn.click();
          }
        `),
      }));
    }

    return results.length > 0 ? results : [{ status: '完成', detail: '文章浏览完成' }];
  },
});
