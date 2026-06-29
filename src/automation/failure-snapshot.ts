/**
 * 失败现场快照
 *
 * 每次任务在自动化阶段失败时，落盘三件套：
 *   data/snapshots/<taskId>/<timestamp>/screenshot.png   - 全页截图
 *   data/snapshots/<taskId>/<timestamp>/page.html        - 主体 outerHTML（截前 200KB）
 *   data/snapshots/<taskId>/<timestamp>/meta.json        - URL / 标题 / 错误码 / 控制台错误
 *
 * 同时返回相对快照目录的相对路径，写入 task.failureSnapshots，
 * 审核面板诊断 modal 直接读取这些文件展示。
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { config } from '../config';
import { classifyError, AutomationError } from './errors';
import type { FailureSnapshot } from '../types';

const SNAPSHOT_ROOT = path.resolve(path.dirname(config.store.filePath), 'snapshots');

/** 控制台错误缓存（按 page 弱引用记录最近 30 条） */
const consoleErrorBuffer = new WeakMap<Page, string[]>();

/** 给 page 注册控制台监听（只注册一次） */
export function attachConsoleCapture(page: Page): void {
  if (consoleErrorBuffer.has(page)) return;
  const buf: string[] = [];
  consoleErrorBuffer.set(page, buf);
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      buf.push(`[${msg.type()}] ${msg.text()}`.slice(0, 500));
      if (buf.length > 30) buf.shift();
    }
  });
  page.on('pageerror', (err) => {
    buf.push(`[pageerror] ${err.message}`.slice(0, 500));
    if (buf.length > 30) buf.shift();
  });
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 在失败时调用。永远不抛错——快照本身失败不应再阻塞任务流程。
 */
export async function captureFailure(
  page: Page | null,
  taskId: string,
  err: any,
  extra?: Record<string, any>
): Promise<FailureSnapshot | null> {
  try {
    const stamp = ts();
    const dir = path.join(SNAPSHOT_ROOT, taskId, stamp);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    const auto = classifyError(err);
    let url = '';
    let title = '';
    let html = '';
    let screenshotOk = false;

    if (page) {
      try { url = page.url(); } catch {}
      try { title = await page.title(); } catch {}
      try {
        await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: false });
        screenshotOk = true;
      } catch (e: any) {
        // 页面已关闭等情况，截图不可得，跳过
      }
      try {
        const outer = await page.evaluate(() => document.documentElement?.outerHTML || '');
        // 截前 200KB，避免吃磁盘
        html = outer.slice(0, 200 * 1024);
        await fs.writeFile(path.join(dir, 'page.html'), html, 'utf-8');
      } catch {}
    }

    const consoleErrors = page ? consoleErrorBuffer.get(page) || [] : [];

    const meta = {
      taskId,
      timestamp: new Date().toISOString(),
      errorCode: auto.code,
      errorMessage: auto.message,
      errorDetails: (auto as AutomationError).details,
      url,
      title,
      consoleErrors: consoleErrors.slice(-15),
      extra: extra || {},
    };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

    const relDir = path.relative(path.dirname(config.store.filePath), dir);
    return {
      taskId,
      timestamp: meta.timestamp,
      errorCode: auto.code,
      errorMessage: auto.message.slice(0, 500),
      url,
      dir: relDir,
      hasScreenshot: screenshotOk,
      hasHtml: !!html,
    };
  } catch (e: any) {
    console.warn(`[failure-snapshot] 快照保存失败 (taskId=${taskId}): ${e.message}`);
    return null;
  }
}

/** 给 API 用：根据 task.failureSnapshots 中的 dir，解析为绝对路径并读取 meta.json */
export async function readSnapshotMeta(relDir: string): Promise<any | null> {
  try {
    const abs = path.resolve(path.dirname(config.store.filePath), relDir);
    const txt = await fs.readFile(path.join(abs, 'meta.json'), 'utf-8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** 给 API 用：返回快照目录的绝对路径，便于静态文件服务 */
export function snapshotAbsoluteDir(relDir: string): string {
  return path.resolve(path.dirname(config.store.filePath), relDir);
}

export { SNAPSHOT_ROOT };
