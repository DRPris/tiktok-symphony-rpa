/**
 * 选择器配置存储 - 支持热更新
 *
 * 数据流：
 *   启动: loadOverridesFromDisk() -> applyOverrides(SELECTORS, overrides)
 *   面板编辑: PUT /api/selectors -> saveOverridesToDisk() -> applyOverrides()
 *
 * 文件格式（data/selectors.json）：
 * {
 *   "common.chatInput": "新选择器字符串",
 *   "agent.addButton": "新选择器字符串"
 * }
 * （未列出的 path 仍使用 selectors.ts 中的默认值）
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { config } from '../config';
import { SELECTORS, getDefaultSelectors, applySelectorOverrides } from './selectors';

const OVERRIDE_FILE = path.resolve(path.dirname(config.store.filePath), 'selectors.json');

/** 命中统计：{ "common.chatInput": { hits: 3, misses: 0, lastHitAt: '...' } } */
const stats: Record<
  string,
  { hits: number; misses: number; lastHitAt?: string; lastMissAt?: string }
> = {};

let currentOverrides: Record<string, string> = {};

/** 从文件加载覆盖配置；不存在则返回空对象 */
export async function loadOverridesFromDisk(): Promise<Record<string, string>> {
  try {
    const txt = await fs.readFile(OVERRIDE_FILE, 'utf-8');
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      currentOverrides = parsed;
      return parsed;
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.warn(`[selector-store] 读取 ${OVERRIDE_FILE} 失败: ${err.message}`);
    }
  }
  currentOverrides = {};
  return {};
}

/** 保存覆盖配置到磁盘（原子写） */
export async function saveOverridesToDisk(overrides: Record<string, string>): Promise<void> {
  const dir = path.dirname(OVERRIDE_FILE);
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const tmp = `${OVERRIDE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(overrides, null, 2), 'utf-8');
  await fs.rename(tmp, OVERRIDE_FILE);
  currentOverrides = overrides;
}

/** 启动时调用：加载文件 + 应用到 SELECTORS */
export async function initSelectorStore(): Promise<void> {
  const overrides = await loadOverridesFromDisk();
  applySelectorOverrides(SELECTORS, overrides);
  const cnt = Object.keys(overrides).length;
  if (cnt > 0) {
    console.log(`[selector-store] 已应用 ${cnt} 个用户自定义选择器覆盖`);
  }
}

/** 面板调用：原子地更新 + 持久化 + 热生效 */
export async function updateOverrides(overrides: Record<string, string>): Promise<void> {
  await saveOverridesToDisk(overrides);
  // 先把 SELECTORS 重置为默认，再叠加新的 overrides，避免移除某条 override 后旧值残留
  applySelectorOverrides(SELECTORS, getDefaultSelectors() as any, /*reset*/ true);
  applySelectorOverrides(SELECTORS, overrides);
}

export function getOverridesSnapshot(): Record<string, string> {
  return { ...currentOverrides };
}

/** 命中上报：自动化代码命中 / 未命中选择器时调用 */
export function reportSelectorHit(path: string): void {
  if (!stats[path]) stats[path] = { hits: 0, misses: 0 };
  stats[path].hits += 1;
  stats[path].lastHitAt = new Date().toISOString();
}

export function reportSelectorMiss(path: string): void {
  if (!stats[path]) stats[path] = { hits: 0, misses: 0 };
  stats[path].misses += 1;
  stats[path].lastMissAt = new Date().toISOString();
}

export function getSelectorStats() {
  return { ...stats };
}
