/**
 * Weibo publish — browser UI automation for posting weibo.
 *
 * Flow:
 *   1. Navigate to weibo.com home page
 *   2. Click the publish/trigger button to open the compose box
 *   3. Fill text content
 *   4. Upload images via DataTransfer injection
 *   5. Publish
 *
 * Requires: logged into weibo.com in Chrome.
 *
 * Usage:
 *   opencli weibo publish "微博内容" \
 *     --images /path/a.jpg,/path/b.jpg
 *   opencli weibo publish "纯文字微博"
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const MAX_IMAGES = 9;
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
  if (!mimeType) throw new Error(`Unsupported image format "${ext}". Supported: jpg, jpeg, png, gif, webp`);
  const base64 = fs.readFileSync(absPath).toString('base64');
  return { name: path.basename(absPath), mimeType, base64 };
}

/**
 * Click the publish/trigger button to open the compose box on Weibo home page.
 */
async function openComposeBox(page: IPage): Promise<boolean> {
  const result = await page.evaluate(`
    () => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      
      // Try multiple selectors for the publish trigger button
      const buttonSelectors = [
        // Primary: Write new weibo button
        '[node-type="publish"]',
        '.W_btn_a[node-type="publish"]',
        '.btn_bed[node-type="publish"]',
        // Alternative selectors
        '[action-type="publish"]',
        '[node-type="btn_publish"]',
        // Fallback: any prominent write button
        'a[href*="/publish"]',
        '.W_icon_bed',
        // Check for visible "发布" or "发微博" buttons
        'button:contains("发布")',
        'a:contains("发布")',
        'span:contains("发布微博")',
        'div[action-type="publish"]'
      ];

      // Also try by text content
      const allElements = document.querySelectorAll('*');
      const candidates = [];
      
      for (const el of allElements) {
        if (!el || el.offsetParent === null) continue;
        const text = normalize(el.innerText || el.textContent || '');
        // Look for publish-related text
        if (text === '发布' || text === '发微博' || text.includes('发布微博') || text === '写微博') {
          candidates.push(el);
        }
      }

      // Try button selectors first
      for (const sel of buttonSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            el.click();
            return { ok: true, method: 'selector', selector: sel };
          }
        } catch (e) {}
      }

      // Try text-based candidates
      for (const el of candidates) {
        if (el && el.offsetParent !== null) {
          el.click();
          return { ok: true, method: 'text', text: el.innerText };
        }
      }

      // Check if compose box is already open (publish area visible)
      const composeArea = document.querySelector('.area_textarea, .W_input, [node-type="text"] textarea, [node-type="publish"]');
      if (composeArea && composeArea.offsetParent !== null) {
        return { ok: true, method: 'already_open' };
      }

      return { ok: false, candidates: candidates.slice(0, 5).map(e => e?.innerText?.slice(0, 20)) };
    }
  `);

  if (result?.ok) {
    console.log('[DEBUG] Opened compose box:', result.method, result.selector || result.text || '');
    await page.wait({ time: 1 });
    return true;
  }

  console.log('[DEBUG] Could not find publish button, candidates:', result?.candidates);
  return false;
}

/**
 * Inject images into the page's file input using DataTransfer.
 */
async function injectImages(page: IPage, images: ImagePayload[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const payload = JSON.stringify(images);
  return page.evaluate(`
    (async () => {
      const images = ${payload};

      // Find image file inputs
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      let input = null;

      // Try to find the correct upload input (weibo has multiple file inputs)
      for (const el of inputs) {
        const accept = el.getAttribute('accept') || '';
        if (
          accept.includes('image') ||
          accept.includes('.jpg') ||
          accept.includes('.jpeg') ||
          accept.includes('.png') ||
          accept.includes('.gif')
        ) {
          input = el;
          break;
        }
      }

      // Fallback: look for any visible file input
      if (!input) {
        input = inputs.find(el => el.offsetParent !== null);
      }

      if (!input) return { ok: false, count: 0, error: 'No image file input found on page' };

      const dt = new DataTransfer();
      for (const img of images) {
        try {
          const binary = atob(img.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: img.mimeType });
          dt.items.add(new File([blob], img.name, { type: img.mimeType }));
        } catch (e) {
          return { ok: false, count: 0, error: 'Failed to create File: ' + e.message };
        }
      }

      Object.defineProperty(input, 'files', { value: dt.files, writable: false });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));

      return { ok: true, count: dt.files.length };
    })()
  `);
}

/**
 * Wait for image upload to complete.
 */
async function waitForUploads(page: IPage, maxWaitMs = 30_000): Promise<void> {
  const pollMs = 1_500;
  const maxAttempts = Math.ceil(maxWaitMs / pollMs);
  for (let i = 0; i < maxAttempts; i++) {
    const uploading: boolean = await page.evaluate(`
      () => {
        // Check for upload progress indicators
        return !!document.querySelector(
          '[class*="loading"][class*="img"], [class*="upload"][class*="ing"], .img_load, .uploading'
        );
      }
    `);
    if (!uploading) return;
    await page.wait({ time: pollMs / 1_000 });
  }
}

/**
 * Fill the text content in the compose box.
 */
async function fillContent(page: IPage, content: string): Promise<boolean> {
  const contentEscaped = JSON.stringify(content);
  const result = await page.evaluate(`
    () => {
      const content = ${contentEscaped};
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      
      // Weibo text input selectors
      const selectors = [
        // Primary: textarea in compose area
        '.area_textarea',
        '.W_input',
        '[node-type="text"] textarea',
        '[node-type="publish"] textarea',
        'textarea[name="content"]',
        'textarea[placeholder*="有什么"]',
        'textarea[placeholder*="分享"]',
        // Fallback to any visible textarea
        'textarea:visible'
      ];

      let textarea = null;
      
      // Try selectors first
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          textarea = el;
          break;
        }
      }

      // If no textarea found, try contenteditable
      if (!textarea) {
        const editables = document.querySelectorAll('[contenteditable="true"]');
        for (const el of editables) {
          if (el && el.offsetParent !== null && el.innerText) {
            const placeholder = el.getAttribute('placeholder') || '';
            if (placeholder.includes('有什么') || placeholder.includes('分享')) {
              textarea = el;
              break;
            }
          }
        }
      }

      if (!textarea) return { ok: false, error: 'No text input found' };

      // Focus and fill
      textarea.focus();
      
      // Try native setter for React/Vue
      if (textarea.tagName === 'TEXTAREA' || textarea.tagName === 'INPUT') {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          textarea.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 
          'value'
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(textarea, content);
        } else {
          textarea.value = content;
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable
        textarea.innerText = content;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }

      return { ok: true };
    }
  `);

  return result?.ok || false;
}

/**
 * Click the publish button.
 */
async function clickPublish(page: IPage): Promise<{ ok: boolean; error?: string }> {
  const result = await page.evaluate(`
    () => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      
      // Publish button selectors
      const buttonSelectors = [
        // Primary
        'a[node-type="publish"]',
        '.W_btn_a[node-type="publish"]',
        'button[node-type="publish"]',
        // Alternative
        '[action-type="publish"]',
        '[node-type="submit"]',
        // By text
        'a:contains("发布")',
        'button:contains("发布")',
        'span:contains("发布")'
      ];

      // Try by selectors
      for (const sel of buttonSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null && !el.disabled) {
            el.click();
            return { ok: true };
          }
        } catch (e) {}
      }

      // Try by text content
      const allElements = document.querySelectorAll('button, a, span');
      for (const el of allElements) {
        if (!el || el.offsetParent === null || el.disabled) continue;
        const text = normalize(el.innerText || el.textContent || '');
        if (text === '发布' || text === '发送' || text.includes('发布')) {
          el.click();
          return { ok: true };
        }
      }

      return { ok: false, error: 'Publish button not found' };
    }
  `);

  return { ok: result?.ok || false, error: result?.error };
}

/**
 * Inspect current page state for debugging.
 */
async function inspectPageState(page: IPage): Promise<any> {
  return page.evaluate(`
    () => {
      const results = {
        url: location.href,
        hasComposeBox: false,
        textInputFound: false,
        fileInputs: 0,
        buttons: [],
        visibleTexts: []
      };

      // Check for compose box
      const composeSelectors = ['.area_textarea', '.W_input', '[node-type="text"]', '[node-type="publish"]'];
      for (const sel of composeSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          results.hasComposeBox = true;
          if (sel.includes('textarea') || sel.includes('input')) {
            results.textInputFound = true;
          }
          break;
        }
      }

      // Count file inputs
      results.fileInputs = document.querySelectorAll('input[type="file"]').length;

      // Get visible buttons
      document.querySelectorAll('button, a, [role="button"]').forEach(btn => {
        if (btn.offsetParent !== null && !btn.disabled) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (text && text.length > 0 && text.length < 20) {
            results.buttons.push(text);
          }
        }
      });

      // Get some visible texts for debugging
      const bodyText = document.body.innerText || '';
      if (bodyText.includes('有什么新鲜事')) results.visibleTexts.push('has placeholder');
      if (bodyText.includes('发布')) results.visibleTexts.push('has publish text');
      if (bodyText.includes('图片')) results.visibleTexts.push('has image text');

      return results;
    }
  `);
}

cli({
  site: 'weibo',
  name: 'publish',
  description: '发布微博 (纯文字或带图片)',
  domain: 'weibo.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'content', required: true, positional: true, help: '微博内容' },
    { name: 'images', required: false, help: '图片路径，逗号分隔，最多9张 (jpg/png/gif/webp)' },
    { name: 'visible', type: 'bool', default: false, help: '是否可见（仅自己可见）' },
  ],
  columns: ['status', 'detail'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new Error('Browser page required');

    const content = String(kwargs.content ?? '').trim();
    const imagePaths: string[] = kwargs.images
      ? String(kwargs.images).split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
    const isVisible = Boolean(kwargs.visible);

    // Validate inputs
    if (!content) throw new Error('微博内容不能为空');
    if (imagePaths.length > MAX_IMAGES) {
      throw new Error(`图片数量过多: ${imagePaths.length} (最多 ${MAX_IMAGES})`);
    }

    // Read images in Node.js context before navigating (fast-fail on bad paths)
    const imageData: ImagePayload[] = imagePaths.map(readImageFile);

    console.log('[DEBUG] Starting weibo publish:', { contentLength: content.length, imageCount: imageData.length });

    // Step 1: Navigate to weibo.com home page
    await page.goto('https://weibo.com');
    await page.wait({ time: 3 });

    // Check page state
    const initialState = await inspectPageState(page);
    console.log('[DEBUG] Initial page state:', JSON.stringify(initialState, null, 2));

    // Step 2: Open compose box
    const composeOpened = await openComposeBox(page);
    if (!composeOpened) {
      // Take screenshot for debugging
      await page.screenshot({ path: '/tmp/weibo_publish_compose_debug.png' });
      throw new Error(
        '无法打开微博发布框。请确认已登录微博。' +
        ' Debug screenshot: /tmp/weibo_publish_compose_debug.png'
      );
    }

    // Wait for compose box to fully load
    await page.wait({ time: 1 });

    // Step 3: Fill content
    const contentFilled = await fillContent(page, content);
    if (!contentFilled) {
      await page.screenshot({ path: '/tmp/weibo_publish_content_debug.png' });
      throw new Error('无法填写微博内容。请确认发布框已打开。 Debug screenshot: /tmp/weibo_publish_content_debug.png');
    }
    await page.wait({ time: 0.5 });

    // Step 4: Upload images if provided
    if (imageData.length > 0) {
      const upload = await injectImages(page, imageData);
      if (!upload.ok) {
        await page.screenshot({ path: '/tmp/weibo_publish_upload_debug.png' });
        throw new Error(
          `图片上传失败: ${upload.error ?? 'unknown'}. ` +
          'Debug screenshot: /tmp/weibo_publish_upload_debug.png'
        );
      }
      console.log('[DEBUG] Images uploaded:', upload.count);
      // Wait for uploads to complete
      await page.wait({ time: UPLOAD_SETTLE_MS / 1_000 });
      await waitForUploads(page);
    }

    // Step 5: Handle visibility option if needed (only if checkbox exists)
    if (isVisible) {
      await page.evaluate(`
        () => {
          // Look for visibility/privacy options
          const checkboxes = document.querySelectorAll('input[type="checkbox"]');
          for (const cb of checkboxes) {
            const label = cb.closest('label') || cb.parentElement;
            const text = (label?.innerText || '').toLowerCase();
            if (text.includes('仅自己') || text.includes('私密')) {
              cb.click();
            }
          }
        }
      `);
    }

    // Step 6: Click publish button
    const publishResult = await clickPublish(page);
    if (!publishResult.ok) {
      await page.screenshot({ path: '/tmp/weibo_publish_submit_debug.png' });
      throw new Error(
        `无法点击发布按钮: ${publishResult.error ?? 'unknown'}. ` +
        'Debug screenshot: /tmp/weibo_publish_submit_debug.png'
      );
    }

    // Wait for publish to complete
    await page.wait({ time: 3 });

    // Step 7: Verify success
    const finalState = await inspectPageState(page);
    console.log('[DEBUG] Final page state:', JSON.stringify(finalState, null, 2));

    // Check for success indicators
    const successCheck = await page.evaluate(`
      () => {
        const bodyText = document.body.innerText || '';
        const keywords = ['发布成功', '发布失败', '已发布', '发送成功'];
        
        for (const kw of keywords) {
          if (bodyText.includes(kw)) {
            return kw;
          }
        }
        
        // Check if compose box is still there (if not, likely published)
        const composeBox = document.querySelector('.area_textarea, .W_input');
        if (!composeBox || composeBox.offsetParent === null) {
          return 'possibly_published';
        }
        
        return null;
      }
    `);

    const isSuccess = successCheck && (successCheck.includes('成功') || successCheck === 'possibly_published');

    return [
      {
        status: isSuccess ? '✅ 发布成功' : '⚠️ 操作完成，请在浏览器中确认',
        detail: [
          `"${content.slice(0, 30)}${content.length > 30 ? '...' : ''}"`,
          imageData.length ? `${imageData.length}张图片` : '',
        ].filter(Boolean).join(' · '),
      },
    ];
  },
});
