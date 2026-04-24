/**
 * Sohu publish — browser UI automation for posting sohu articles.
 *
 * Flow:
 *   1. Navigate to publish page
 *   2. Fill title (5-72 chars)
 *   3. Fill content into editor
 *   4. Upload article images (optional)
 *   5. Upload cover image (optional)
 *   6. Fill summary (optional)
 *   7. Publish / Save as draft
 *
 * Requires: logged into mp.sohu.com in Chrome.
 *
 * Usage:
 *   opencli sohu publish --title "标题" "正文内容..."
 *   opencli sohu publish --title "标题" "正文" --cover /path/cover.jpg
 *   opencli sohu publish --title "标题" "正文内容..." --images /path/img1.jpg,/path/img2.png
 *   opencli sohu publish --title "标题" "正文" --cover /path/cover.jpg --summary "摘要内容" --draft
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const PUBLISH_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1';
const MIN_TITLE_LEN = 5;
const MAX_TITLE_LEN = 72;
const MAX_SUMMARY_LEN = 120;
const UPLOAD_POLL_MS = 1000;
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
 * Wait for upload to complete by polling for upload indicators.
 */
async function waitForUploadComplete(page: IPage, maxWaitMs = UPLOAD_MAX_WAIT_MS): Promise<void> {
  const pollMs = UPLOAD_POLL_MS;
  const maxAttempts = Math.ceil(maxWaitMs / pollMs);
  for (let i = 0; i < maxAttempts; i++) {
    const uploading: boolean = await page.evaluate(`
      () => {
        const inputs = document.querySelectorAll('input[type="file"]');
        // Check if there's an active file dialog or upload in progress
        return !!document.querySelector('[class*="uploading"], [class*="upload"]');
      }
    `);
    if (!uploading) return;
    await page.wait({ time: pollMs / 1000 });
  }
}

/**
 * Click the confirm/ok button in upload dialogs.
 */
async function confirmImageUpload(page: IPage): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(`
    () => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if (!btn || btn.offsetParent === null) continue;
        const text = (btn.innerText || '').trim();
        if (text === '确定' || text === '确认') {
          btn.click();
          return { ok: true };
        }
      }
      return { ok: false, error: '找不到"确定"按钮' };
    }
  `);
}

/**
 * Inject image into the page's file input using DataTransfer.
 */
async function injectImage(page: IPage, image: ImagePayload): Promise<{ ok: boolean; error?: string }> {
  const payload = JSON.stringify(image);
  return page.evaluate(`
    (async () => {
      const img = ${payload};

      // Find the visible file input
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs.find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || inputs[inputs.length - 1];

      if (!input) return { ok: false, error: '找不到文件输入框' };

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
        return { ok: false, error: '文件注入失败: ' + e.message };
      }
    })()
  `);
}

/**
 * Close any blocking elements (modals, AI drawers, etc.)
 */
async function closeBlockingUI(page: IPage): Promise<void> {
  await page.evaluate(`
    () => {
      const mask = document.querySelectorAll('[class*="mask"], [class*="overlay"]');
      mask.forEach(el => { if (el.offsetParent !== null) el.style.display = 'none'; });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  `);
  await page.wait({ time: 0.5 });
}

/**
 * Upload article images via the editor's image dialog.
 * Uses the existing input#new-file in the image upload dialog.
 */
async function uploadArticleImages(page: IPage, images: ImagePayload[]): Promise<void> {
  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    // Step 1: Click the "添加图片" button in editor toolbar
    const btnClicked = await page.evaluate(`
      () => {
        const imgBtn = document.querySelector('.ql-image');
        if (!imgBtn || imgBtn.offsetParent === null) return false;
        imgBtn.click();
        return true;
      }
    `);
    if (!btnClicked) throw new Error(`插入第${i + 1}张图片失败 - 找不到"添加图片"按钮`);
    await page.wait({ time: 1 });

    // Step 2: Inject image into the file input and wait for Vue to detect
    const injectResult = await page.evaluate(`
      (async () => {
        const imgData = ${JSON.stringify(img)};
        const fileInput = document.querySelector('input#new-file');
        if (!fileInput) return { ok: false, error: '找不到文件输入框 input#new-file' };

        // 创建文件对象
        const binary = atob(imgData.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: imgData.mimeType });
        const dt = new DataTransfer();
        dt.items.add(new File([blob], imgData.name, { type: imgData.mimeType }));

        // 注入文件
        try {
          Object.defineProperty(fileInput, 'files', { value: dt.files });
        } catch (e) {
          // 如果 defineProperty 失败，尝试直接修改
          fileInput.files = dt.files;
        }

        // 触发多种事件组合
        const events = [
          new Event('change', { bubbles: true }),
          new Event('input', { bubbles: true }),
          new CustomEvent('file-selected', { bubbles: true })
        ];
        events.forEach(e => fileInput.dispatchEvent(e));

        return { ok: true };
      })()
    `);

    if (!injectResult.ok) throw new Error(`注入第${i + 1}张失败: ${injectResult.error}`);

    // Step 3: Wait for Vue to detect the file (polling for upload-area class change)
    const vueDetected = await page.evaluate(`
      (async () => {
        const maxAttempts = 15;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const uploadArea = document.querySelector('.upload-area');
          if (!uploadArea) {
            // Dialog might not be fully rendered yet
            await new Promise(r => setTimeout(r, 500));
            continue;
          }

          // If no-file class is removed, Vue detected the file
          if (!uploadArea.classList.contains('no-file')) return true;

          await new Promise(r => setTimeout(r, 500));
        }
        return false;
      })()
    `);

    if (!vueDetected) {
      // 如果 Vue 没有检测到，尝试使用更激进的方法
      const retryResult = await page.evaluate(`
        () => {
          const fileInput = document.querySelector('input#new-file');
          if (!fileInput) return false;

          const uploadArea = document.querySelector('.upload-area');
          if (!uploadArea) return false;

          // 手动移除 no-file class
          uploadArea.classList.remove('no-file');

          // 手动启用确定按钮
          const confirmBtn = Array.from(document.querySelectorAll('*'))
            .find(el => (el.innerText || '').trim() === '确定' && el.offsetParent !== null);
          if (confirmBtn) confirmBtn.classList.remove('disable-button');

          return true;
        }
      `);
      if (!retryResult) {
        throw new Error(`第${i + 1}张图片上传超时 - Vue 未检测到文件`);
      }
    }

    await page.wait({ time: 1 });

    // Step 4: Click "确定" button
    const confirmClicked = await page.evaluate(`
      () => {
        const confirmBtn = Array.from(document.querySelectorAll('*'))
          .find(el => {
            const text = (el.innerText || '').trim();
            return text === '确定' && el.offsetParent !== null;
          });
        if (!confirmBtn) return false;
        confirmBtn.click();
        return true;
      }
    `);
    if (!confirmClicked) throw new Error(`第${i + 1}张图片确认失败 - 找不到"确定"按钮`);

    // Step 5: Wait for image to appear in editor
    await page.wait({ time: 5 });

    const imageInEditor = await page.evaluate(`
      () => {
        const editor = document.querySelector('.ql-editor');
        if (!editor) return false;
        const imgElements = editor.querySelectorAll('img');
        if (imgElements.length === 0) return false;

        // Check if last image has a valid src（不是placeholder）
        const lastImg = imgElements[imgElements.length - 1];
        const src = lastImg.getAttribute('src') || '';
        return src.length > 10 && src !== 'about:blank';
      }
    `);

    if (!imageInEditor) {
      throw new Error(`第${i + 1}张图片上传后未在编辑器中显示`);
    }
  }
}

// ============ PUBLISH COMMAND ============

cli({
  site: 'sohu',
  name: 'publish',
  description: '发布搜狐号图文（标题 + 正文 + 封面 + 摘要），支持普通发布/定时发布/存草稿',
  domain: 'mp.sohu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', required: true, help: '文章标题 (5-72字)' },
    { name: 'content', required: false, positional: true, help: '文章正文' },
    { name: 'cover', required: false, help: '封面图片路径 (jpg/png/gif/webp)' },
    { name: 'images', required: false, help: '正文图片路径，逗号分隔（最多9张，jpg/png/gif/webp）' },
    { name: 'summary', required: false, help: '文章摘要 (最多120字，留空则自动生成)' },
    { name: 'draft', type: 'bool', default: false, help: '存草稿，不直接发布' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const title = String(kwargs.title ?? '').trim();
    const content = String(kwargs.content ?? '').trim();
    const coverPath = kwargs.cover ? String(kwargs.cover).trim() : null;
    const summary = kwargs.summary ? String(kwargs.summary).trim() : null;
    const isDraft = Boolean(kwargs.draft);

    // Validate inputs
    if (!title) throw new Error('标题不能为空');
    if (title.length < MIN_TITLE_LEN) throw new Error(`标题至少 ${MIN_TITLE_LEN} 字`);
    if (title.length > MAX_TITLE_LEN) throw new Error(`标题最多 ${MAX_TITLE_LEN} 字，当前 ${title.length} 字`);
    if (!content) throw new Error('请输入正文内容');
    if (summary && summary.length > MAX_SUMMARY_LEN) {
      throw new Error(`摘要最多 ${MAX_SUMMARY_LEN} 字，当前 ${summary.length} 字`);
    }

    // Read cover image if provided
    let coverImageData: ImagePayload | null = null;
    if (coverPath) {
      coverImageData = readImageFile(coverPath);
    }

    // Read article images if provided
    const articleImages: ImagePayload[] = [];
    if (kwargs.images) {
      const imagePaths: string[] = String(kwargs.images)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      for (const imgPath of imagePaths) {
        articleImages.push(readImageFile(imgPath));
      }
    }

    // Step 1: Navigate to publish page
    await page.goto(PUBLISH_URL);
    await page.wait({ time: 3 });

    // Step 2: Fill title
    const titleFilled = await page.evaluate(`
      () => {
        const input = document.querySelector('input[placeholder*="标题"]');
        if (!input || input.offsetParent === null) return false;
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    `);
    if (!titleFilled) throw new Error('无法填写标题 - 找不到标题输入框');

    // Type title character by character to trigger React handlers
    await page.evaluate(`
      (function(t) {
        const input = document.querySelector('input[placeholder*="标题"]');
        if (input) {
          for (let i = 0; i < t.length; i++) {
            document.execCommand('insertText', false, t[i]);
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })(${JSON.stringify(title)})
    `);
    await page.wait({ time: 1 });

    // Step 3: Fill content into editor
    await page.evaluate(`
      () => {
        // Find the editor area - it's a contenteditable-like element
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
          editor.click();
          editor.focus();
        }
      }
    `);
    await page.wait({ time: 0.5 });

    await closeBlockingUI(page);

    const contentFilled = await page.evaluate(`
      () => {
        const editor = document.querySelector('[contenteditable="true"]');
        if (!editor) return false;

        // Clear existing content if any
        if (editor.innerText && editor.innerText.length > 0 && !editor.innerText.includes('请输入正文')) {
          // Select all and delete
          const range = document.createRange();
          range.selectNodeContents(editor);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          document.execCommand('delete');
        }

        // Insert content
        const p = document.createElement('p');
        p.textContent = ${JSON.stringify(content)};
        editor.appendChild(p);

        const events = [
          new Event('input', { bubbles: true }),
          new CompositionEvent('compositionend', { bubbles: true, data: ${JSON.stringify(content)} }),
          new Event('change', { bubbles: true })
        ];
        events.forEach(e => editor.dispatchEvent(e));

        return true;
      }
    `);
    if (!contentFilled) throw new Error('无法填写正文 - 找不到编辑器');
    await page.wait({ time: 1 });

    // Step 4: Upload article images (if provided)
    if (articleImages.length > 0) {
      await uploadArticleImages(page, articleImages);
      await page.wait({ time: 1 });
    }

    // Step 5: Upload cover image (if provided)
    if (coverImageData) {
      // 搜狐号的封面上传是 Vue 组件动态创建 file input，需要等待 input 出现后再注入
      const uploadResult = await page.evaluate(`
        (async () => {
          const img = ${JSON.stringify(coverImageData)};

          // 1. 点击封面上传按钮
          const uploadBtn = document.querySelector('.upload-file.mp-upload');
          if (!uploadBtn) return { ok: false, error: '找不到封面上传按钮' };
          uploadBtn.click();

          // 2. 使用 MutationObserver 等待动态创建的 file input 出现
          const fileInput = await new Promise((resolve) => {
            // 先检查是否已经存在
            const existing = document.querySelector('input[type="file"]');
            if (existing) return resolve(existing);

            const observer = new MutationObserver((mutations, obs) => {
              const input = document.querySelector('input[type="file"]');
              if (input) {
                obs.disconnect();
                resolve(input);
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // 超时 5 秒
            setTimeout(() => { observer.disconnect(); resolve(null); }, 5000);
          });

          if (!fileInput) return { ok: false, error: 'file input 未创建' };

          // 3. 注入图片到 file input
          try {
            const binary = atob(img.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: img.mimeType });
            const dt = new DataTransfer();
            dt.items.add(new File([blob], img.name, { type: img.mimeType }));

            Object.defineProperty(fileInput, 'files', { value: dt.files });
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));

            return { ok: true };
          } catch (e) {
            return { ok: false, error: '文件注入失败: ' + e.message };
          }
        })()
      `);
      if (!uploadResult.ok) {
        throw new Error(`封面上传失败: ${uploadResult.error}`);
      }

      // 等待上传完成
      await page.wait({ time: 3 });
      await waitForUploadComplete(page);

      // 确认上传（如果有确认弹窗）
      const confirmResult = await confirmImageUpload(page);
      if (confirmResult.ok) {
        await page.wait({ time: 2 });
      }
    }

    // Step 6: Fill summary (if provided)
    if (summary) {
      await page.evaluate(`
        () => {
          const input = document.querySelector('input[placeholder*="摘要"]') || document.querySelector('textarea[placeholder*="摘要"]');
          if (input) {
            input.focus();
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      `);
      await page.wait({ time: 0.5 });

      await page.evaluate(`
        (function(s) {
          const input = document.querySelector('input[placeholder*="摘要"]') || document.querySelector('textarea[placeholder*="摘要"]');
          if (input) {
            for (let i = 0; i < s.length; i++) {
              document.execCommand('insertText', false, s[i]);
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })(${JSON.stringify(summary)})
      `);
      await page.wait({ time: 0.5 });
      await closeBlockingUI(page);
    }

    // Step 7: Click Publish or Save as Draft
    const btnText = isDraft ? '存草稿' : '发布';
    const publishClicked = await page.evaluate(`
      (function(btnText) {
        // Look for list items or buttons with the desired text
        const allElements = document.querySelectorAll('li, button, [role="option"], [role="menuitem"]');
        for (const el of allElements) {
          if (!el || el.offsetParent === null) continue;
          const text = (el.innerText || '').trim();
          if (text === btnText) {
            el.click();
            return true;
          }
        }
        return false;
      })(${JSON.stringify(btnText)})
    `);
    if (!publishClicked) throw new Error(`找不到"${btnText}"按钮`);

    // Wait for publish to complete
    await page.wait({ time: 5 });

    // Step 8: Verify
    const currentUrl: string = await page.evaluate('() => location.href');
    const pageText: string = await page.evaluate('() => document.body.innerText');

    const successMsg = pageText.includes('发布成功') ? '发布成功' :
                       pageText.includes('草稿') ? '草稿已保存' : null;
    const urlChanged = currentUrl.includes('/edit') || !currentUrl.includes('addarticle');

    const isSuccess = isDraft ? (successMsg === '草稿已保存' || urlChanged) :
                              (successMsg === '发布成功' || urlChanged);

    const verb = isDraft ? '草稿已保存' : (successMsg || '操作完成，请在浏览器中确认');
    const detail = [
      `"${title.slice(0, 30)}${title.length > 30 ? '...' : ''}"`,
      `${content.length}字`,
      articleImages.length > 0 ? `${articleImages.length}张插图` : null,
      coverImageData ? '有封面' : '无封面',
      summary ? `摘要: ${summary.slice(0, 20)}...` : '无摘要',
    ].filter(Boolean).join(' · ');

    return [
      {
        status: isSuccess ? `✅ ${verb}` : `⚠️ ${verb}`,
        detail,
      },
    ];
  },
});
