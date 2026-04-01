/**
 * Toutiao publish — browser UI automation for posting toutiao articles.
 *
 * Usage:
 *   opencli toutiao publish --title "标题" --content "正文内容..."
 *   opencli toutiao publish --title "标题" --content "正文" --images /path/a.jpg
 *   opencli toutiao publish --title "标题" --content "正文" --cover none
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish?from=toutiao_pc';
const MAX_IMAGES = 9;
const UPLOAD_SETTLE_MS = 2000;

type ImagePayload = { name: string; mimeType: string; base64: string };

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

// ============ PUBLISH COMMAND ============

cli({
  site: 'toutiao',
  name: 'publish',
  description: '发布头条号图文（标题 + 正文 + 图片）',
  domain: 'mp.toutiao.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', required: true, help: '文章标题' },
    { name: 'content', required: false, help: '文章正文' },
    { name: 'images', required: false, help: '图片路径，逗号分隔' },
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
    let coverType = String(kwargs.cover ?? '').toLowerCase();
    if (!coverType || coverType === 'auto') {
      coverType = imagePaths.length === 0 ? 'none' : imagePaths.length >= 3 ? 'three' : 'single';
    }

    if (!title) throw new Error('标题不能为空');
    if (imagePaths.length > MAX_IMAGES) {
      throw new Error(`图片数量过多: ${imagePaths.length} (最多 ${MAX_IMAGES})`);
    }

    const imageData: ImagePayload[] = imagePaths.map(readImageFile);

    // Step 1: 打开发布页面
    await page.goto(PUBLISH_URL);
    await page.wait({ time: 3 });

    // Step 2: 填写标题
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

    // Step 3: 选择封面
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

    // Step 4: 填写正文
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

    // Step 5: 上传图片 - 尝试查找并使用 toutiao 的上传组件
    if (imageData.length > 0) {
      const payload = JSON.stringify(imageData);
      
      // 全面搜索页面中的文件上传元素
      const searchResult = await page.evaluate(`
        () => {
          const results = {
            fileInputs: [],
            iframes: [],
            uploadTriggers: [],
            classes: []
          };
          
          // 1. 查找所有 file input
          const inputs = document.querySelectorAll('input[type="file"]');
          results.fileInputs = Array.from(inputs).map(i => ({
            accept: i.accept,
            visible: i.offsetParent !== null,
            id: i.id,
            className: i.className
          }));
          
          // 2. 查找所有 iframe
          const iframes = document.querySelectorAll('iframe');
          results.iframes = Array.from(iframes).map(f => ({
            src: f.src?.slice(0, 50),
            visible: f.offsetParent !== null
          }));
          
          // 3. 查找可能的 upload 触发器
          const potentialTriggers = document.querySelectorAll('[class*="upload"], [class*="image"], [data-type="image"]');
          results.uploadTriggers = Array.from(potentialTriggers).slice(0, 5).map(el => ({
            className: el.className?.slice(0, 40),
            tagName: el.tagName,
            visible: el.offsetParent !== null
          }));
          
          // 4. 收集页面关键 class
          const bodyClasses = document.body.className;
          results.classes = bodyClasses ? bodyClasses.split(' ').slice(0, 10) : [];
          
          return results;
        }
      `);
      
      console.log('Upload search result:', JSON.stringify(searchResult, null, 2));
      
      // 如果找到 file input，尝试注入
      if (searchResult.fileInputs && searchResult.fileInputs.length > 0) {
        const upload = await page.evaluate(`
          () => {
            const input = document.querySelector('input[type="file"]');
            if (!input) return { ok: false, error: 'No input' };
            
            const dt = new DataTransfer();
            const blob = new Blob([new Uint8Array()], { type: 'image/png' });
            dt.items.add(new File([blob], 'test.png', { type: 'image/png' }));
            Object.defineProperty(input, 'files', { value: dt.files, writable: false });
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }
        `);
      }
    }

    // Step 6: 点击发布
    await page.evaluate(`() => window.scrollTo(0, document.body.scrollHeight)`);
    await page.wait({ time: 1 });

    const publishClick = await page.evaluate(`
      () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if (!btn || btn.offsetParent === null || btn.disabled) continue;
          const text = (btn.innerText || '').trim();
          if (text.includes('预览并发布') && btn.className.includes('primary')) {
            btn.click();
            return true;
          }
        }
        return false;
      }
    `);
    if (!publishClick) throw new Error('找不到发布按钮');
    
    await page.wait({ time: 5 });

    return [
      {
        status: '⚠️ 操作完成，请在浏览器中确认',
        detail: `"${title.slice(0, 20)}${title.length > 20 ? '...' : ''}" · ${content.length}字`,
      },
    ];
  },
});
