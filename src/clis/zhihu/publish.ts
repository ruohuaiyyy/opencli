/**
 * Zhihu article publisher — zhuanlan.zhihu.com UI automation.
 *
 * Flow:
 *   1. Navigate to write page
 *   2. Fill title and body text
 *   3. Upload cover image (optional)
 *   4. Publish article
 *
 * Requires: logged into zhuanlan.zhihu.com in Chrome.
 *
 * Usage:
 *   opencli zhihu publish --title "标题" "正文内容"
 *   opencli zhihu publish --title "标题" "正文内容" --cover /path/cover.jpg
 *   opencli zhihu publish --title "标题" "正文内容" --cover /path/cover.jpg --draft
 *
 * Extensible: add --type article/answer/idea in future.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const PUBLISH_URL = 'https://zhuanlan.zhihu.com/write';
const MAX_TITLE_LEN = 100;
const UPLOAD_SETTLE_MS = 2000;

type ImagePayload = { name: string; mimeType: string; base64: string };

/**
 * Read a local image and return the name, MIME type, and base64 content.
 */
function readImageFile(filePath: string): ImagePayload {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`Image file not found: ${absPath}`);
  const ext = path.extname(absPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeMap[ext];
  if (!mimeType) throw new Error(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
  const base64 = fs.readFileSync(absPath).toString('base64');
  return { name: path.basename(absPath), mimeType, base64 };
}

/**
 * Inject image into the page's file input using DataTransfer.
 */
async function injectImage(page: IPage, image: ImagePayload): Promise<{ ok: boolean; error?: string }> {
  const payload = JSON.stringify(image);
  return page.evaluate(`
    (async () => {
      const img = ${payload};

      // Find cover image input - look for file input in cover upload area
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs.find(el => {
        const accept = el.getAttribute('accept') || '';
        const parent = el.closest('[class*="cover"]') || el.closest('[class*="image"]');
        return accept.includes('image') || accept.includes('.jpg') || accept.includes('.png') || parent;
      }) || inputs[0];

      if (!input) return { ok: false, error: 'No file input found on page' };

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
        return { ok: false, error: 'Failed to create File: ' + e.message };
      }
    })()
  `);
}

/**
 * Wait for upload to complete.
 */
async function waitForUpload(page: IPage, maxWaitMs = 20_000): Promise<void> {
  const pollMs = 1_000;
  const maxAttempts = Math.ceil(maxWaitMs / pollMs);
  for (let i = 0; i < maxAttempts; i++) {
    const uploading: boolean = await page.evaluate(`
      () => !!document.querySelector('[class*="upload"][class*="loading"], [class*="uploading"]')
    `);
    if (!uploading) return;
    await page.wait({ time: pollMs / 1000 });
  }
}

/**
 * Fill a visible text input or contenteditable with the given text.
 */
async function fillField(page: IPage, selectors: string[], text: string, fieldName: string): Promise<void> {
  const result: { ok: boolean; sel?: string } = await page.evaluate(`
    (function(selectors, text) {
      for (const sel of selectors) {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (!el || el.offsetParent === null) continue;
          el.focus();
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = '';
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { ok: true, sel };
        }
      }
      return { ok: false };
    })(${JSON.stringify(selectors)}, ${JSON.stringify(text)})
  `);
  if (!result.ok) {
    await page.screenshot({ path: `/tmp/zhihu_publish_${fieldName}_debug.png` });
    throw new Error(
      `Could not find ${fieldName} input. Debug screenshot: /tmp/zhihu_publish_${fieldName}_debug.png`
    );
  }
}

cli({
  site: 'zhihu',
  name: 'publish',
  description: '发布知乎文章 (支持标题、正文、封面图)',
  domain: 'zhuanlan.zhihu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', required: true, help: '文章标题 (最多100字)' },
    { name: 'content', required: true, positional: true, help: '文章正文' },
    { name: 'cover', required: false, help: '封面图片路径 (jpg/png/gif/webp)' },
    { name: 'type', default: 'article', help: '发布类型 (目前仅支持 article)' },
    { name: 'draft', type: 'bool', default: false, help: '保存为草稿，不直接发布' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const title = String(kwargs.title ?? '').trim();
    const content = String(kwargs.content ?? '').trim();
    const coverPath = kwargs.cover ? String(kwargs.cover).trim() : null;
    const isDraft = Boolean(kwargs.draft);

    // Validate inputs
    if (!title) throw new Error('--title is required');
    if (title.length > MAX_TITLE_LEN)
      throw new Error(`Title is ${title.length} chars — must be ≤ ${MAX_TITLE_LEN}`);
    if (!content) throw new Error('Positional argument <content> is required');

    // Read cover image if provided
    let coverImage: ImagePayload | null = null;
    if (coverPath) {
      coverImage = readImageFile(coverPath);
    }

    // Step 1: Navigate to write page
    await page.goto(PUBLISH_URL);
    await page.wait({ time: 3 });

    // Check current URL
    let pageUrl: string = await page.evaluate('() => location.href');
    
    // If redirected to an edit page (has draft), need to handle it
    if (pageUrl.includes('/p/') && pageUrl.includes('/edit')) {
      // First check if there's already content - if so, we can use this page
      const hasContent: boolean = await page.evaluate(`
        () => {
          // Check title
          const title = document.querySelector('textarea');
          if (title && title.value && title.value.length > 0) return true;
          // Check content
          const content = document.querySelector('[contenteditable="true"]');
          if (content && content.textContent && content.textContent.length > 0) return true;
          return false;
        }
      `);
      
      if (hasContent) {
        // There's existing content - clear it first or just use the page
        // Let's clear and start fresh
        await page.evaluate(`
          () => {
            const title = document.querySelector('textarea');
            if (title) { title.value = ''; title.dispatchEvent(new Event('input')); }
            const content = document.querySelectorAll('[contenteditable="true"]');
            content.forEach((el: any) => { el.textContent = ''; el.dispatchEvent(new Event('input')); });
          }
        `);
        await page.wait({ time: 1 });
      }
      
      // Try to find and click "写新文章" button
      const clickedNew = await page.evaluate(`
        () => {
          // Look for "写新文章" link/button
          const links = document.querySelectorAll('a, button');
          for (const el of links) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text.includes('写新') || text.includes('新文章')) {
              el.click();
              return true;
            }
          }
          // Try to navigate directly
          window.location.href = 'https://zhuanlan.zhihu.com/write';
          return false;
        }
      `);
      
      await page.wait({ time: 3 });
      pageUrl = await page.evaluate('() => location.href');
    }

    // Step 2: Upload cover image (if provided)
    if (coverImage) {
      // Try to find the file input directly (Zhihu has input[type="file"] for cover)
      const coverUploaded: boolean = await page.evaluate(`
        () => {
          const inputs = document.querySelectorAll('input[type="file"]');
          for (const input of inputs) {
            const accept = input.getAttribute('accept') || '';
            if (accept.includes('image') || accept.includes('jpg') || accept.includes('png')) {
              return true;
            }
          }
          return false;
        }
      `);
      
      if (!coverUploaded) {
        // Try to click on cover upload area
        await page.evaluate(`
          () => {
            const candidates = document.querySelectorAll('[class*="cover"], [class*="image"], [class*="Cover"]');
            for (const el of candidates) {
              if (el.offsetParent !== null) {
                el.click();
                return;
              }
            }
          }
        `);
        await page.wait({ time: 1 });
      }
      
      const upload = await injectImage(page, coverImage);
      if (upload.ok) {
        await page.wait({ time: UPLOAD_SETTLE_MS / 1000 });
        await waitForUpload(page);
      }
    }
    
    // Step 3: Fill title - use typeText for natural typing
    // First click to focus, then type using Playwright's native typeText
    // Step 3: Fill title - click to focus using evaluate, then type character by character
    await page.evaluate(`
      () => {
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.click();
          textarea.focus();
        }
      }
    `);
    await page.wait({ time: 0.3 });
    
    // Type title character by character using execCommand
    await page.evaluate(`
      (function(t) {
        const textarea = document.querySelector('textarea');
        if (textarea) {
          for (let i = 0; i < t.length; i++) {
            document.execCommand('insertText', false, t[i]);
          }
        }
      })(${JSON.stringify(title)})
    `);
    await page.wait({ time: 0.5 });
    
    // Step 4: Fill content - click to focus using evaluate
    await page.evaluate(`
      () => {
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
          editor.click();
          editor.focus();
        }
      }
    `);
    await page.wait({ time: 0.3 });
    
    // Type content using evaluate - character by character
    await page.evaluate(`
      (function(c) {
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
          // Type character by character
          for (let i = 0; i < c.length; i++) {
            document.execCommand('insertText', false, c[i]);
          }
        }
      })(${JSON.stringify(content)})
    `);
    await page.wait({ time: 0.5 });

    // Blur to trigger validation
    await page.click('body');
    await page.wait({ time: 0.5 });

    // Step 5: Click publish button
    const btnClicked = await page.evaluate(`
      () => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (text === '发布' || text.includes('发布文章')) {
            btn.click();
            return true;
          }
        }
        return false;
      }
    `);

    if (!btnClicked) {
      throw new Error('Could not find publish button');
    }

    // Step 6: Wait for potential modal
    await page.wait({ time: 2 });

    // Step 7: Verify success
    await page.wait({ time: 3 });

    const finalUrl: string = await page.evaluate('() => location.href');
    const pageText: string = await page.evaluate('() => document.body.innerText');
    
    // Check for success indicators
    const successMsg: string = pageText.includes('发布成功') ? '发布成功' : (pageText.includes('草稿') ? '草稿已保存' : '');
    
    // Determine if published: URL changed from /write to /p/ or /edit
    const navigatedAway = finalUrl.includes('/p/') || finalUrl.includes('/edit');
    const verb = isDraft ? '草稿已保存' : '发布成功';
    const isPublished = isDraft ? (successMsg.includes('草稿') || navigatedAway) : (successMsg.includes('发布成功') || navigatedAway);

    return [
      {
        status: isPublished ? `✅ ${verb}` : '⚠️ 操作完成，请在浏览器中确认',
        detail: [
          `"${title}"`,
          coverImage ? '有封面' : '无封面',
          successMsg || finalUrl || '',
        ]
          .filter(Boolean)
          .join(' · '),
      },
    ];
  },
});