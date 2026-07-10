/**
 * Fetch toutiao account info (screen_name, follower_count, auth_info) for URLs in Excel,
 * write results back to Excel with checkpoint support (resume on interrupt).
 *
 * Usage: node fetch-toutiao-accounts.mjs
 */

import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const INPUT_FILE = 'D:/Users/wenjiewj.han/Downloads/今日头条来源URL汇总_豆包AI生成.xlsx';
const OUTPUT_FILE = 'D:/Users/wenjiewj.han/Downloads/今日头条来源URL汇总_豆包AI生成_结果.xlsx';
const PROGRESS_FILE = 'D:/Users/wenjiewj.han/Downloads/toutiao-fetch-progress.json';

const CONCURRENCY = 8;       // parallel requests
const RETRY_MAX = 3;         // max retries per URL
const RETRY_DELAY_MS = 2000; // delay between retries
const BATCH_DELAY_MS = 500;  // delay between batches to avoid rate limiting
const TIMEOUT_MS = 10000;    // request timeout

// ── Helper: fetch with retry ──────────────────────────────────────────
async function fetchJson(url, retries = RETRY_MAX) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        if (res.status === 404) return null; // article removed
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }
      const json = await res.json();
      if (!json || !json.success) {
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return null;
      }
      return json;
    } catch (e) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Extract item_id from URL ──────────────────────────────────────────
function extractItemId(url) {
  if (!url) return null;
  const str = String(url).trim();
  // Patterns:
  //   http://m.toutiao.com/group/7644409370134741546/
  //   https://www.toutiao.com/article/7493364682510680586
  //   https://toutiao.com/group/7493364682510680586/
  const match = str.match(/(?:group|article)\/(\d+)/);
  if (match) return match[1];
  // Also try just a numeric path segment
  const numMatch = str.match(/\/(\d{15,})/);
  if (numMatch) return numMatch[1];
  return null;
}

// ── Fetch account info for one item_id ────────────────────────────────
async function fetchAccountInfo(itemId) {
  const apiUrl = `https://m.toutiao.com/i${itemId}/info/`;
  const json = await fetchJson(apiUrl);
  if (!json || !json.data) return null;

  const data = json.data;
  const mediaUser = data.media_user || {};

  return {
    screen_name: mediaUser.screen_name || data.source || '',
    follower_count: mediaUser.follower_count || String(mediaUser.follower_count || ''),
    auth_info: mediaUser.user_auth_info?.auth_info || '',
    media_id: mediaUser.id || data.media_id || '',
  };
}

// ── Load/save progress checkpoint ─────────────────────────────────────
function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('Reading Excel file...');
  const wb = XLSX.readFile(INPUT_FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const header = rows[0];
  const totalUrls = rows.length - 1;
  console.log(`Total URLs: ${totalUrls}`);

  // Load checkpoint
  const progress = loadProgress();
  const completedCount = Object.keys(progress).length;
  console.log(`Already completed (from checkpoint): ${completedCount}`);

  // Extract item_ids
  const tasks = [];
  for (let i = 1; i < rows.length; i++) {
    const url = rows[i][0];
    const itemId = extractItemId(url);
    if (!itemId) {
      progress[String(i)] = { screen_name: 'URL无法解析', follower_count: '', auth_info: '', media_id: '' };
      continue;
    }
    if (progress[String(i)]) continue; // already done
    tasks.push({ rowIdx: i, itemId });
  }

  console.log(`Remaining to fetch: ${tasks.length}`);

  // Process in batches
  let fetched = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let batchStart = 0; batchStart < tasks.length; batchStart += CONCURRENCY) {
    const batch = tasks.slice(batchStart, batchStart + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (task) => {
        const info = await fetchAccountInfo(task.itemId);
        return { rowIdx: task.rowIdx, info };
      })
    );

    for (const { rowIdx, info } of results) {
      if (info) {
        progress[String(rowIdx)] = info;
        fetched++;
      } else {
        progress[String(rowIdx)] = { screen_name: '获取失败', follower_count: '', auth_info: '', media_id: '' };
        failed++;
      }
    }

    // Save checkpoint every batch
    if (batchStart % (CONCURRENCY * 10) === 0 || batchStart + CONCURRENCY >= tasks.length) {
      saveProgress(progress);
    }

    // Progress display
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = fetched / elapsed;
    const remaining = tasks.length - fetched - failed;
    const eta = remaining / rate;
    console.log(
      `Progress: ${fetched + failed}/${tasks.length} ` +
      `(ok:${fetched} fail:${failed}) ` +
      `rate:${rate.toFixed(1)}/s ETA:${eta > 0 ? (eta / 60).toFixed(1) + 'min' : '-'}`
    );

    // Small delay between batches
    if (batchStart + CONCURRENCY < tasks.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Final checkpoint save
  saveProgress(progress);
  console.log(`\nAll done! Fetched: ${fetched}, Failed: ${failed}`);

  // ── Write results to Excel ────────────────────────────────────────
  console.log('Writing results to Excel...');

  const outRows = [];
  // New header: original + account columns
  outRows.push([header[0] || '今日头条来源URL', '账号名', '粉丝数', '认证信息', 'media_id']);

  for (let i = 1; i < rows.length; i++) {
    const url = rows[i][0] || '';
    const pInfo = progress[String(i)] || { screen_name: '', follower_count: '', auth_info: '', media_id: '' };
    outRows.push([
      url,
      pInfo.screen_name,
      pInfo.follower_count,
      pInfo.auth_info,
      pInfo.media_id,
    ]);
  }

  const outWs = XLSX.utils.aoa_to_sheet(outRows);
  // Set column widths
  outWs['!cols'] = [
    { wch: 60 },  // URL
    { wch: 20 },  // 账号名
    { wch: 15 },  // 粉丝数
    { wch: 40 },  // 认证信息
    { wch: 15 },  // media_id
  ];

  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, outWs, '今日头条来源URL');
  XLSX.writeFile(outWb, OUTPUT_FILE);

  console.log(`Output saved to: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});