/**
 * Toutiao publish — browser UI automation for posting toutiao articles.
 *
 * Flow:
 *   1. Navigate to publish page
 *   2. Fill title
 *   3. Select cover mode (single / three / none)
 *   4. Fill content
 *   5. Upload images to editor (if any)
 *   6. Upload cover image (if specified and not auto-filled from editor images)
 *   7. Publish
 *
 * Requires: logged into mp.toutiao.com in Chrome.
 *
 * Usage:
 *   opencli toutiao publish --title "标题" --content "正文内容..."
 *   opencli toutiao publish --title "标题" --content "正文" --images /path/a.jpg,/path/b.jpg
 *   opencli toutiao publish --title "标题" --content "正文" --images /path/a.jpg --cover single
 *   opencli toutiao publish --title "标题" --content "正文" --cover-image /path/cover.jpg
 *   opencli toutiao publish --title "标题" --content "正文" --cover-image /path/cover.jpg --cover three
 *   opencli toutiao publish --title "标题" --content "正文" --cover none
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish?from=toutiao_pc';
const MAX_IMAGES = 9;
const UPLOAD_POLL_MS = 1500;
const UPLOAD_MAX_WAIT_MS = 30_000;

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
 * Wait for upload to complete by polling for upload indicators to disappear.
 */
async function waitForUploadComplete(page: IPage, maxWaitMs = UPLOAD_MAX_WAIT_MS): Promise<void> {
  const pollMs = UPLOAD_POLL_MS;
  const maxAttempts = Math.ceil(maxWaitMs / pollMs);
  for (let i = 0; i < maxAttempts; i++) {
    const uploading: boolean = await page.evaluate(`
      () => {
        const panel = document.querySelector('.upload-image-panel, .mp-ic-img-drawer');
        if (!panel || panel.offsetParent === null) return false;
        const text = (panel.innerText || '');
        // If panel shows "已上传 N 张图片" without uploading indicators, it's done
        return text.includes('上传中') || text.includes('uploading');
      }
    `);
    if (!uploading) return;
    await page.wait({ time: pollMs / 1000 });
  }
}

/**
 * Click the "确定" button to confirm image insertion into editor or cover.
 */
async function confirmImageUpload(page: IPage): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(`
    () => {
      // Search within upload panel first
      const panel = document.querySelector('.upload-image-panel, .mp-ic-img-drawer');
      if (panel) {
        const buttons = panel.querySelectorAll('button');
        for (const btn of buttons) {
          if ((btn.innerText || '').trim() === '确定' && btn.offsetParent !== null) {
            btn.click();
            return { ok: true };
          }
        }
      }
      // Fallback: search all buttons
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if ((btn.innerText || '').trim() === '确定' && btn.offsetParent !== null) {
          btn.click();
          return { ok: true };
        }
      }
      return { ok: false, error: '找不到"确定"按钮' };
    }
  `);
}

/**
 * Close any blocking elements (AI assistant drawer, modals) that prevent toolbar interaction.
 */
async function closeBlockingUI(page: IPage): Promise<void> {
  await page.evaluate(`
    () => {
      // Hide AI assistant drawer and mask via CSS (safer than clicking SVG elements)
      const blockers = document.querySelectorAll(
        '.ai-assistant-drawer-wrapper, .ai-assistant.is-expand, .byte-drawer-wrapper.ai-assistant-drawer, .byte-drawer-mask'
      );
      blockers.forEach(el => { el.style.display = 'none'; });

      // Escape key as fallback
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  `);
  await page.wait({ time: 0.5 });
}

/**
 * Inject images into the ProseMirror editor via the image upload panel.
 * Steps: close blockers → click toolbar image button → wait for panel → inject files → confirm.
 */
async function injectImagesToEditor(
  page: IPage,
  images: ImagePayload[],
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (images.length === 0) return { ok: true, count: 0 };

  const payload = JSON.stringify(images);

  // Step 0: Close any blocking UI elements
  await closeBlockingUI(page);

    // Step 1: Click the image button using coordinate-based dispatch (btn.click() doesn't trigger React events)
    let btnClicked = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await closeBlockingUI(page);
        await page.wait({ time: 1 });
      }

      btnClicked = await page.evaluate(`
        () => {
          const btn = document.querySelector('.syl-toolbar-tool.image');
          if (!btn || btn.offsetParent === null) return false;

          const rect = btn.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          if (!target) return false;

          target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          return true;
        }
      `);
      if (btnClicked) break;
    }
    if (!btnClicked) return { ok: false, count: 0, error: '找不到图片工具栏按钮' };

  // Step 2: Wait for upload panel and file input to appear (with polling)
  let inputFound = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.wait({ time: 1 });
    inputFound = await page.evaluate(`
      () => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        return inputs.some(i => i.offsetWidth > 0 && i.offsetHeight > 0);
      }
    `);
    if (inputFound) break;
  }

  if (!inputFound) {
    // Take debug screenshot
    try {
      await page.screenshot({ path: '/tmp/toutiao_editor_input_debug.png' });
    } catch { /* ignore */ }
    return { ok: false, count: 0, error: '找不到文件输入框（上传面板未出现）' };
  }

  // Step 3: Inject images into file input
  const uploadResult = await page.evaluate(`
    (async () => {
      const images = ${payload};

      // Find the visible file input (not the drag one which has 0x0 size)
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs.find(i => i.offsetWidth > 0 && i.offsetHeight > 0);

      if (!input) return { ok: false, error: '找不到文件输入框' };

      try {
        const dt = new DataTransfer();
        for (const img of images) {
          const binary = atob(img.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: img.mimeType });
          dt.items.add(new File([blob], img.name, { type: img.mimeType }));
        }

        Object.defineProperty(input, 'files', { value: dt.files, writable: false });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));

        return { ok: true, count: dt.files.length };
      } catch (e) {
        return { ok: false, error: '文件注入失败: ' + e.message };
      }
    })()
  `);

  if (!uploadResult.ok) return { ok: false, count: 0, error: uploadResult.error };

  // Step 3: Wait for upload to complete
  await page.wait({ time: 3 });
  await waitForUploadComplete(page);

  // Step 4: Click "确定" to insert images into editor
  const confirm = await confirmImageUpload(page);
  if (!confirm.ok) return { ok: false, count: 0, error: confirm.error };

  // Wait for images to appear in editor
  await page.wait({ time: 3 });

  return { ok: true, count: uploadResult.count };
}

/**
 * Upload a cover image by clicking the cover area, injecting into the drawer's file input, and confirming.
 */
async function injectCoverImage(
  page: IPage,
  image: ImagePayload,
): Promise<{ ok: boolean; error?: string }> {
  // Step 0: Close any blocking UI elements and scroll to cover area
  await closeBlockingUI(page);

  // Scroll cover area into view
  await page.evaluate(`
    () => {
      const coverWrap = document.querySelector('.article-cover-images-wrap');
      if (coverWrap) coverWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  `);
  await page.wait({ time: 1 });

  const payload = JSON.stringify(image);

  // Step 0: Close any blocking UI elements
  await closeBlockingUI(page);

  // Step 1: Click the cover image area to open upload drawer
  let coverClicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await closeBlockingUI(page);
      await page.wait({ time: 0.5 });
    }

    coverClicked = await page.evaluate(`
      () => {
        // Try clicking the article-cover-add area (the "+" icon) first
        const addEl = document.querySelector('.article-cover-add');
        if (addEl && addEl.offsetParent !== null) {
          const rect = addEl.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          if (target) {
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            return true;
          }
        }

        // Fallback: click the cover image if it exists
        const coverImg = document.querySelector('.article-cover-images img');
        if (coverImg && coverImg.offsetParent !== null) {
          const rect = coverImg.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          if (target) {
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            return true;
          }
        }

        // Last fallback: click the cover wrap
        const coverWrap = document.querySelector('.article-cover-images-wrap');
        if (coverWrap && coverWrap.offsetParent !== null) {
          const rect = coverWrap.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          if (target) {
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            return true;
          }
        }
        return false;
      }
    `);
    if (coverClicked) break;
  }
  if (!coverClicked) return { ok: false, error: '无法点击封面区域' };

  // Step 2: Wait for upload drawer to appear (with polling)
  let drawerFound = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.wait({ time: 1 });
    drawerFound = await page.evaluate(`
      () => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        return inputs.some(i => i.offsetWidth > 0 && i.offsetHeight > 0);
      }
    `);
    if (drawerFound) break;
  }

  if (!drawerFound) {
    try {
      await page.screenshot({ path: '/tmp/toutiao_cover_upload_debug.png' });
    } catch { /* ignore */ }
    return { ok: false, error: '找不到封面文件输入框（上传面板未出现）' };
  }

  // Step 3: Inject image into the drawer's file input
  const uploadResult = await page.evaluate(`
    (async () => {
      const img = ${payload};

      // Wait for drawer to render
      await new Promise(r => setTimeout(r, 500));

      // Find the visible file input in the upload drawer
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs.find(i => i.offsetWidth > 0 && i.offsetHeight > 0);

      if (!input) return { ok: false, error: '找不到封面文件输入框' };

      try {
        const binary = atob(img.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: img.mimeType });
        const dt = new DataTransfer();
        dt.items.add(new File([blob], img.name, { type: img.mimeType }));

        Object.defineProperty(input, 'files', { value: dt.files, writable: false });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));

        return { ok: true };
      } catch (e) {
        return { ok: false, error: '封面文件注入失败: ' + e.message };
      }
    })()
  `);

  if (!uploadResult.ok) return { ok: false, error: uploadResult.error };

  // Step 3: Wait for upload
  await page.wait({ time: 3 });
  await waitForUploadComplete(page);

  // Step 4: Click "确定" to confirm cover
  const confirm = await confirmImageUpload(page);
  if (!confirm.ok) return { ok: false, error: confirm.error };

  // Wait for cover to update
  await page.wait({ time: 2 });

  return { ok: true };
}

// ============ PUBLISH COMMAND ============

cli({
  site: 'toutiao',
  name: 'publish',
  description: '发布头条号图文（标题 + 正文 + 图片 + 封面）',
  domain: 'mp.toutiao.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', required: true, help: '文章标题' },
    { name: 'content', required: false, help: '文章正文' },
    { name: 'images', required: false, help: '图片路径，逗号分隔（最多9张）' },
    { name: 'cover-image', required: false, help: '封面图片路径（与正文图片独立）' },
    { name: 'cover', required: false, help: '封面类型', choices: ['single', 'three', 'none', 'auto'], default: 'auto' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const title = String(kwargs.title ?? '').trim();
    const content = String(kwargs.content ?? '').trim();
    const imagePaths: string[] = kwargs.images
      ? String(kwargs.images).split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
    const coverImagePath = kwargs['cover-image'] ? String(kwargs['cover-image']).trim() : null;
    let coverType = String(kwargs.cover ?? '').toLowerCase();

    // Auto-detect cover type
    if (!coverType || coverType === 'auto') {
      if (coverImagePath) {
        // User provided a cover image, default to single
        coverType = 'single';
      } else if (imagePaths.length === 0) {
        coverType = 'none';
      } else if (imagePaths.length >= 3) {
        coverType = 'three';
      } else {
        coverType = 'single';
      }
    }

    if (!title) throw new Error('标题不能为空');
    if (imagePaths.length > MAX_IMAGES) {
      throw new Error(`图片数量过多: ${imagePaths.length} (最多 ${MAX_IMAGES})`);
    }

    // Read images early (fast-fail on bad paths)
    const imageData: ImagePayload[] = imagePaths.map(readImageFile);
    let coverImageData: ImagePayload | null = null;
    if (coverImagePath) {
      coverImageData = readImageFile(coverImagePath);
    }

    // Step 1: Navigate to publish page
    await page.goto(PUBLISH_URL);
    await page.wait({ time: 3 });

    // Step 2: Fill title
    const titleFilled = await page.evaluate(`
      () => {
        const title = ${JSON.stringify(title)};
        const selectors = ['textarea[placeholder*="标题"]', 'input[placeholder*="标题"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            el.focus();
            el.value = title;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value.length > 0;
          }
        }
        return false;
      }
    `);
    if (!titleFilled) throw new Error('无法填写标题');
    await page.wait({ time: 0.5 });

    // Step 3: Select cover mode (radio button)
    const targetCover = coverType === 'single' ? '单图' : coverType === 'three' ? '三图' : '无封面';

    await page.evaluate(`
      () => {
        const targetText = ${JSON.stringify(targetCover)};
        const labels = document.querySelectorAll('label.byte-radio');
        for (const label of labels) {
          if (!label || label.offsetParent === null) continue;
          const text = (label.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text === targetText) {
            label.click();
            label.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
      }
    `);
    await page.wait({ time: 0.5 });

    // Step 4: Fill content
    await page.evaluate(`() => {
      const editor = document.querySelector('.ProseMirror');
      if (editor) editor.click();
    }`);
    await page.wait({ time: 0.5 });
    await page.evaluate(`() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }`);
    await page.wait({ time: 0.5 });

    const contentFilled = await page.evaluate(`
      () => {
        const content = ${JSON.stringify(content)};
        let editor = document.querySelector('.ProseMirror');
        if (!editor) {
          const els = document.querySelectorAll('[contenteditable="true"]');
          for (const el of els) {
            if (el && el.offsetParent !== null) {
              const ph = el.getAttribute('placeholder') || '';
              if (!ph.includes('AI')) {
                editor = el;
                break;
              }
            }
          }
        }
        if (!editor) return false;

        editor.focus();
        editor.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = content;
        editor.appendChild(p);

        const events = [
          new Event('input', { bubbles: true }),
          new Event('selectionchange', { bubbles: true }),
          new CompositionEvent('compositionend', { bubbles: true, data: content }),
          new Event('change', { bubbles: true })
        ];
        events.forEach(e => editor.dispatchEvent(e));

        setTimeout(() => {
          editor.dispatchEvent(new Event('blur', { bubbles: true }));
          editor.dispatchEvent(new Event('focus', { bubbles: true }));
        }, 100);

        return true;
      }
    `);
    if (!contentFilled) throw new Error('无法填写正文');
    await page.wait({ time: 1 });

    // Step 5: Upload images to editor (if any)
    let editorImagesUploaded = false;
    if (imageData.length > 0) {
      const uploadResult = await injectImagesToEditor(page, imageData);
      if (!uploadResult.ok) {
        throw new Error(`正文图片上传失败: ${uploadResult.error}`);
      }
      editorImagesUploaded = true;
    }

    // Step 5.5: Upload cover image (if user specified a separate cover file)
    if (coverImageData && coverType !== 'none') {
      const coverResult = await injectCoverImage(page, coverImageData);
      if (!coverResult.ok) {
        throw new Error(`封面图片上传失败: ${coverResult.error}`);
      }
    }

    // Step 6: Click "预览并发布" to enter preview mode
    await page.evaluate(`() => window.scrollTo(0, document.body.scrollHeight)`);
    await page.wait({ time: 1 });

    // Click "预览并发布" using coordinate-based dispatch (React event handling)
    const previewClick = await page.evaluate(`
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const pubBtn = buttons.find(b => {
          if (!b || b.offsetParent === null) return false;
          const text = (b.innerText || '').trim();
          return text.includes('预览并发布') && b.className.includes('primary');
        });
        if (!pubBtn) return false;

        const rect = pubBtn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y);
        if (!target) return false;

        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return true;
      }
    `);
    if (!previewClick) throw new Error('找不到"预览并发布"按钮');

    // Wait for preview mode to appear (buttons change to "返回编辑" and "确认发布")
    await page.wait({ time: 5 });

    // Step 7: Click "确认发布" to actually publish
    const confirmPublish = await page.evaluate(`
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if (!btn || btn.offsetParent === null) continue;
          const text = (btn.innerText || '').trim();
          if (text === '确认发布') {
            btn.click();
            return true;
          }
        }
        return false;
      }
    `);
    if (!confirmPublish) throw new Error('找不到"确认发布"按钮（预览模式未出现）');

    // Wait for publish to complete
    await page.wait({ time: 5 });

    // Build status detail
    const coverDetail = coverType === 'single' ? '单图封面' : coverType === 'three' ? '三图封面' : '无封面';
    const imageDetail = imageData.length > 0 ? `${imageData.length}张正文图片` : '无正文图片';
    const coverFileDetail = coverImageData ? `自定义封面` : '';

    return [
      {
        status: '⚠️ 操作完成，请在浏览器中确认',
        detail: `"${title.slice(0, 20)}${title.length > 20 ? '...' : ''}" · ${content.length}字 · ${coverDetail}${coverFileDetail ? ' · ' + coverFileDetail : ''} · ${imageDetail}`,
      },
    ];
  },
});
