/**
 * Baijia publish — browser UI automation for posting articles on Baijiahao.
 *
 * Flow:
 *   1. Navigate to publish page
 *   2. Fill title (textContent + input/change events)
 *   3. Select cover mode (single / three)
 *   4. Fill content via UEditor iframe
 *   5. Insert images into UEditor (base64 <img> tags)
 *   6. Publish
 *
 * Requires: logged into baijiahao.baidu.com in Chrome.
 *
 * Usage:
 *   opencli baijia publish --title "标题" --content "正文内容..."
 *   opencli baijia publish --title "标题" --content "正文" --images /path/a.jpg,/path/b.jpg
 *   opencli baijia publish --title "标题" --content "正文" --cover three
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const PUBLISH_URL = 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1';
const MAX_IMAGES = 9;

type ImagePayload = { name: string; mimeType: string; base64: string };

// ============ HELPER FUNCTIONS ============

function readImageFile(filePath: string): ImagePayload {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`Image file not found: ${absPath}`);
  const ext = path.extname(absPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp',
  };
  const mimeType = mimeMap[ext];
  if (!mimeType) throw new Error(`Unsupported image format: ${ext}`);
  const base64 = fs.readFileSync(absPath).toString('base64');
  return { name: path.basename(absPath), mimeType, base64 };
}

/**
 * Insert images into UEditor iframe as base64 <img> tags.
 */
async function insertImagesToEditor(
  page: IPage,
  images: ImagePayload[],
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (images.length === 0) return { ok: true, count: 0 };

  const payload = JSON.stringify(images);

  const result = await page.evaluate(`
    () => {
      const iframe = document.querySelector('#ueditor_0');
      if (!iframe) return { ok: false, error: '找不到编辑器' };

      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc || !iframeDoc.body) return { ok: false, error: '无法访问编辑器内容' };

        const images = ${payload};
        let inserted = 0;

        for (const img of images) {
          const imgEl = iframeDoc.createElement('img');
          imgEl.src = 'data:' + img.mimeType + ';base64,' + img.base64;
          imgEl.style.maxWidth = '100%';
          imgEl.alt = img.name;
          iframeDoc.body.appendChild(imgEl);
          inserted++;
        }

        // Trigger content change event
        iframeDoc.body.dispatchEvent(new Event('input', { bubbles: true }));

        return { ok: true, count: inserted };
      } catch (e) {
        return { ok: false, error: '图片插入失败: ' + e.message };
      }
    }
  `);

  return result;
}

// ============ PUBLISH COMMAND ============

cli({
  site: 'baijia',
  name: 'publish',
  description: '发布百家号图文（标题 + 正文 + 图片）',
  domain: 'baijiahao.baidu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', required: true, help: '文章标题（2-64字）' },
    { name: 'content', required: false, help: '文章正文' },
    { name: 'images', required: false, help: '正文图片路径，逗号分隔（最多9张）' },
    { name: 'cover', required: false, help: '封面类型', choices: ['single', 'three', 'auto'], default: 'auto' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const title = String(kwargs.title ?? '').trim();
    const content = String(kwargs.content ?? '').trim();
    const imagePaths: string[] = kwargs.images
      ? String(kwargs.images).split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
    let coverType = String(kwargs.cover ?? '').toLowerCase();
    if (!coverType || coverType === 'auto') {
      coverType = imagePaths.length >= 3 ? 'three' : 'single';
    }

    if (!title) throw new Error('标题不能为空');
    if (title.length < 2 || title.length > 64) throw new Error('标题长度必须在 2-64 字之间');
    if (imagePaths.length > MAX_IMAGES) {
      throw new Error(`图片数量过多: ${imagePaths.length} (最多 ${MAX_IMAGES})`);
    }

    // Read images early (fast-fail on bad paths)
    const imageData: ImagePayload[] = imagePaths.map(readImageFile);

    // Step 1: Navigate to publish page
    await page.goto(PUBLISH_URL);
    await page.wait({ time: 5 });

    // Close any "我知道了" dialogs
    await page.evaluate(`() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        (b.innerText || '').trim() === '我知道了'
      );
      if (btn) btn.click();
    }`);
    await page.wait({ time: 2 });

    // Step 2: Fill title (use React-compatible approach)
    const titleFilled = await page.evaluate(`
      () => {
        const editor = document.querySelector('[class*="editor"][contenteditable="true"]');
        if (!editor || editor.offsetParent === null) return false;

        const title = ${JSON.stringify(title)};

        // Use native input event that React listens to
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLDivElement.prototype, 'textContent'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(editor, title);
        } else {
          editor.textContent = title;
        }

        // Dispatch events React listens to
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));

        // Also try keydown/keyup for good measure
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

        return true;
      }
    `);
    if (!titleFilled) throw new Error('找不到标题输入框');
    await page.wait({ time: 2 });

    // Step 3: Select cover mode
    const targetCover = coverType === 'three' ? '三图' : '单图';
    await page.evaluate(`
      () => {
        const targetText = ${JSON.stringify(targetCover)};
        const labels = document.querySelectorAll('label.cheetah-radio-wrapper');
        for (const label of labels) {
          const text = (label.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text === targetText) {
            label.click();
            return;
          }
        }
      }
    `);
    await page.wait({ time: 0.5 });

    // Step 4: Fill content via UEditor iframe
    if (content) {
      const contentFilled = await page.evaluate(`
        () => {
          const iframe = document.querySelector('#ueditor_0');
          if (!iframe) return false;
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!iframeDoc || !iframeDoc.body) return false;
            const html = ${JSON.stringify(`<p>${content.replace(/\n/g, '</p><p>')}</p>`)};
            iframeDoc.body.innerHTML = html;
            iframeDoc.body.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          } catch { return false; }
        }
      `);
      if (!contentFilled) throw new Error('无法填写正文（UEditor 不可访问）');
      await page.wait({ time: 1 });
    }

    // Step 5: Insert images into UEditor (if any)
    if (imageData.length > 0) {
      const insertResult = await insertImagesToEditor(page, imageData);
      if (!insertResult.ok) {
        throw new Error(`图片插入失败: ${insertResult.error}`);
      }
      await page.wait({ time: 2 });
    }

    // Step 6: Publish
    await page.wait({ time: 2 });

    const publishClick = await page.evaluate(`
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if ((btn.innerText || '').trim() === '发布' && !btn.disabled) {
            btn.click();
            return true;
          }
        }
        return false;
      }
    `);
    if (!publishClick) throw new Error('找不到发布按钮');

    await page.wait({ time: 5 });

    // Build status detail
    const coverDetail = coverType === 'single' ? '单图封面' : '三图封面';
    const imageDetail = imageData.length > 0 ? `${imageData.length}张正文图片` : '无正文图片';

    return [
      {
        status: '⚠️ 操作完成，请在浏览器中确认',
        detail: `"${title.slice(0, 20)}${title.length > 20 ? '...' : ''}" · ${content.length}字 · ${coverDetail} · ${imageDetail}`,
      },
    ];
  },
});
