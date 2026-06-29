/**
 * 远程图片下载工具
 * 把候选图下载到 <assets.dir>/scraped/<hash>/imgN.{ext}
 * 与 Excel 批量导入逻辑共用 assets 目录，便于 Playwright setInputFiles 直接使用本地路径。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

export interface DownloadedImage {
  url: string;
  localPath: string;
  bytes: number;
}

const SCRAPED_ROOT_NAME = 'scraped';
const REQUEST_TIMEOUT = 20_000;

/** 给一个产品 URL 生成稳定的 hash 目录名（前 12 位） */
export function hashForUrl(productUrl: string): string {
  return crypto
    .createHash('sha1')
    .update(productUrl.trim())
    .digest('hex')
    .slice(0, 12);
}

/** 拿到该产品对应的 scraped 目录绝对路径，必要时创建 */
export function ensureScrapedDir(productUrl: string): string {
  const dir = path.resolve(
    config.assets.dir,
    SCRAPED_ROOT_NAME,
    hashForUrl(productUrl)
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 从 Content-Type / URL 推断扩展名 */
function pickExt(contentType: string | null, url: string): string {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
    if (ct.includes('png')) return '.png';
    if (ct.includes('webp')) return '.webp';
    if (ct.includes('gif')) return '.gif';
  }
  const m = url.match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

/**
 * 下载一组图片到指定产品目录。
 * 返回成功下载的项，失败的项跳过并 console.warn。
 */
export async function downloadImagesToAssets(
  productUrl: string,
  imageUrls: string[]
): Promise<DownloadedImage[]> {
  const dir = ensureScrapedDir(productUrl);
  const results: DownloadedImage[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // 部分电商 CDN 校验 referer / UA
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
        },
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        console.warn(`[download-image] HTTP ${res.status} skip: ${url}`);
        continue;
      }

      const ct = res.headers.get('content-type');
      const ext = pickExt(ct, url);
      const fileName = `img${i + 1}${ext}`;
      const localPath = path.join(dir, fileName);

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5 * 1024) {
        // < 5KB 大概率是图标/占位图，跳过
        console.warn(`[download-image] too small skip: ${url} (${buf.length}B)`);
        continue;
      }
      fs.writeFileSync(localPath, buf);
      results.push({ url, localPath, bytes: buf.length });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.warn(`[download-image] timeout skip: ${url}`);
      } else {
        console.warn(
          `[download-image] failed skip: ${url} -> ${err?.message || err}`
        );
      }
    }
  }

  return results;
}
