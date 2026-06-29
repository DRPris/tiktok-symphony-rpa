import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 截图监控工具
 * 在关键步骤自动保存截图到 logs/screenshots/ 目录
 * 方便远程调试页面状态
 */

const SCREENSHOT_DIR = path.resolve('logs/screenshots');

// 确保截图目录存在
function ensureDir(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

/**
 * 生成时间戳文件名
 */
function timestampName(label: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${ts}_${label}.png`;
}

/**
 * 在关键步骤截图保存
 * @param page Playwright Page 实例
 * @param label 步骤标签（如 "step1-enter-agent", "step3-click-plus"）
 * @param taskId 可选任务ID，用于文件名前缀
 */
export async function takeStepScreenshot(
  page: Page,
  label: string,
  taskId?: string,
): Promise<string | null> {
  try {
    ensureDir();
    const prefix = taskId ? `${taskId.slice(0, 8)}_` : '';
    const filename = `${prefix}${timestampName(label)}`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    
    await page.screenshot({
      path: filepath,
      fullPage: false,
      timeout: 10000,
    });
    
    console.log(`[screenshot] 📸 已保存: ${filepath}`);
    return filepath;
  } catch (err: any) {
    console.warn(`[screenshot] ⚠️ 截图失败 (${label}): ${err.message?.substring(0, 100)}`);
    return null;
  }
}

/**
 * 在关键步骤截图（带 DOM 快照信息）
 * 除了截图还输出关键 DOM 状态供日志分析
 */
export async function takeDebugScreenshot(
  page: Page,
  label: string,
  taskId?: string,
): Promise<{ screenshotPath: string | null; domInfo: any }> {
  const screenshotPath = await takeStepScreenshot(page, label, taskId);
  
  let domInfo: any = {};
  try {
    domInfo = await page.evaluate(() => {
      const url = window.location.href;
      const title = document.title;
      
      // 输入框状态
      const inputEl = document.querySelector(
        '.tiptap.ProseMirror, div.ProseMirror, div[contenteditable="true"]'
      ) as HTMLElement | null;
      const inputRect = inputEl?.getBoundingClientRect();
      
      // 查找 "+" 相关元素
      const allElements = document.querySelectorAll('*');
      const plusElements: any[] = [];
      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        const text = (htmlEl.textContent || '').trim();
        const hasSvg = !!htmlEl.querySelector('svg');
        if ((text === '+' || (hasSvg && text.length <= 1)) && htmlEl.children.length <= 3) {
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width > 0 && rect.width <= 80 && rect.height > 0 && rect.height <= 80) {
            plusElements.push({
              tag: htmlEl.tagName,
              cls: (htmlEl.className || '').toString().substring(0, 100),
              text,
              hasSvg,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              parentTag: htmlEl.parentElement?.tagName,
              parentCls: (htmlEl.parentElement?.className || '').toString().substring(0, 80),
            });
          }
        }
      }
      
      return {
        url,
        title,
        inputExists: !!inputEl,
        inputRect: inputRect ? {
          x: Math.round(inputRect.left),
          y: Math.round(inputRect.top),
          w: Math.round(inputRect.width),
          h: Math.round(inputRect.height),
        } : null,
        plusElements: plusElements.slice(0, 10),
        viewportSize: { w: window.innerWidth, h: window.innerHeight },
      };
    });
    
    console.log(`[screenshot] 🔍 DOM 状态 (${label}):`);
    console.log(`  URL: ${domInfo.url}`);
    console.log(`  输入框: ${domInfo.inputExists ? `存在 (${domInfo.inputRect?.x},${domInfo.inputRect?.y} ${domInfo.inputRect?.w}x${domInfo.inputRect?.h})` : '未找到'}`);
    if (domInfo.plusElements.length > 0) {
      console.log(`  "+" 元素 (${domInfo.plusElements.length} 个):`);
      domInfo.plusElements.forEach((el: any, i: number) => {
        console.log(`    [${i}] <${el.tag}> cls="${el.cls}" pos=(${el.x},${el.y}) size=${el.w}x${el.h} svg=${el.hasSvg} parent=<${el.parentTag}>`);
      });
    } else {
      console.log(`  "+" 元素: 未找到`);
    }
  } catch (err: any) {
    console.warn(`[screenshot] DOM 信息获取失败: ${err.message?.substring(0, 100)}`);
  }
  
  return { screenshotPath, domInfo };
}

/**
 * 清理超过指定天数的旧截图
 */
export function cleanOldScreenshots(maxAgeDays: number = 3): void {
  try {
    ensureDir();
    const files = fs.readdirSync(SCREENSHOT_DIR);
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    
    for (const file of files) {
      const filepath = path.join(SCREENSHOT_DIR, file);
      const stat = fs.statSync(filepath);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(filepath);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[screenshot] 🧹 清理了 ${cleaned} 个过期截图`);
    }
  } catch {}
}
