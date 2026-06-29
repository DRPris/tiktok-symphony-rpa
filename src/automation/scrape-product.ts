/**
 * 产品页面卖点抓取器（适配 Lazada 等 JS 渲染电商）
 *
 * 流程：
 *   1. 在已存在的 BrowserContext 上临时新建一个 Page
 *   2. 导航到产品 URL，等待 DOM 加载与首屏渲染
 *   3. 执行 page.evaluate 提取标题 / meta / 高亮卖点 / 列表 / 表格 / 正文
 *   4. 关闭临时 Page，返回结构化的 ProductSnapshot 文本
 *
 * 该模块不依赖项目的 PagePool，避免占用主流程的 5 个生成槽位。
 */
import type { BrowserContext } from 'playwright';

export interface ProductSnapshot {
  url: string;
  title: string;
  metaDescription: string;
  highlights: string[];
  bullets: string[];
  specs: string[];
  bodyExcerpt: string;
}

const MAX_BULLETS = 40;
const MAX_SPEC_ROWS = 30;
const MAX_BODY = 4000;
const PAGE_LOAD_TIMEOUT = 30000;
const SETTLE_DELAY = 2500;

/**
 * 在临时页面上抓取产品信息
 */
export async function scrapeProductPage(
  context: BrowserContext,
  url: string
): Promise<ProductSnapshot> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('产品链接必须以 http:// 或 https:// 开头');
  }

  console.log(`[scrape-product] 打开临时页面抓取: ${url}`);
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_LOAD_TIMEOUT,
    });

    // 给 SPA 一点渲染时间（Lazada / Shopee 等首屏数据靠 JS 注入）
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      // 部分电商埋点持续在跑，networkidle 拿不到也可以接受
    }
    await page.waitForTimeout(SETTLE_DELAY);

    const snapshot = await page.evaluate(
      ({ maxBullets, maxSpecs, maxBody }) => {
        const trim = (s: string | null | undefined) =>
          (s || '').replace(/\s+/g, ' ').trim();

        const title =
          trim(document.querySelector('h1')?.textContent) ||
          trim(document.title);

        const metaDescription =
          trim(
            document
              .querySelector('meta[name="description"]')
              ?.getAttribute('content') || ''
          ) ||
          trim(
            document
              .querySelector('meta[property="og:description"]')
              ?.getAttribute('content') || ''
          );

        // Lazada 常见高亮卖点容器
        const highlightSelectors = [
          '.pdp-product-highlights li',
          '[class*="highlight"] li',
          '[class*="key-features"] li',
          '[class*="product-feature"] li',
          '.pdp-mod-product-info-section li',
        ];
        const highlights: string[] = [];
        for (const sel of highlightSelectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = trim(el.textContent);
            if (t && t.length > 2 && t.length < 200) highlights.push(t);
          });
          if (highlights.length > 0) break;
        }

        // 通用 li 列表（兜底，去重）
        const bullets: string[] = [];
        const seen = new Set<string>();
        document.querySelectorAll('li').forEach((el) => {
          if (bullets.length >= maxBullets) return;
          const t = trim(el.textContent);
          if (!t || t.length < 4 || t.length > 200) return;
          // 过滤导航 / 面包屑这种短链接
          if (el.querySelector('a') && t.length < 20) return;
          if (seen.has(t)) return;
          seen.add(t);
          bullets.push(t);
        });

        // 规格 / 详情表格
        const specs: string[] = [];
        document
          .querySelectorAll(
            '.specification tr, .pdp-mod-specification tr, table tr'
          )
          .forEach((row) => {
            if (specs.length >= maxSpecs) return;
            const cells = Array.from(row.querySelectorAll('th, td'))
              .map((c) => trim(c.textContent))
              .filter(Boolean);
            if (cells.length >= 2) {
              const line = cells.slice(0, 2).join(': ');
              if (line.length < 200) specs.push(line);
            }
          });

        // 正文兜底
        const detailEl =
          document.querySelector('.pdp-product-detail') ||
          document.querySelector('#module_product_detail') ||
          document.querySelector('[class*="product-description"]') ||
          document.body;
        const bodyExcerpt = trim(
          (detailEl as HTMLElement)?.innerText || ''
        ).slice(0, maxBody);

        return {
          title,
          metaDescription,
          highlights: highlights.slice(0, maxBullets),
          bullets,
          specs,
          bodyExcerpt,
        };
      },
      { maxBullets: MAX_BULLETS, maxSpecs: MAX_SPEC_ROWS, maxBody: MAX_BODY }
    );

    console.log(
      `[scrape-product] 抓取完成: title="${snapshot.title.slice(0, 40)}...", ` +
        `highlights=${snapshot.highlights.length}, bullets=${snapshot.bullets.length}, ` +
        `specs=${snapshot.specs.length}, body=${snapshot.bodyExcerpt.length}字`
    );

    return { url, ...snapshot };
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.warn(
        `[scrape-product] 关闭临时页面失败: ${(err as Error).message}`
      );
    }
  }
}

/**
 * 把 ProductSnapshot 序列化成给 LLM 的纯文本（裁剪长度，去重）
 * 注意：所有标签使用英文，避免给 LLM 中文语境暗示导致输出中文
 */
export function snapshotToText(s: ProductSnapshot): string {
  const lines: string[] = [];
  lines.push(`URL: ${s.url}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.metaDescription) lines.push(`Description: ${s.metaDescription}`);

  if (s.highlights.length > 0) {
    lines.push('', '[Official Highlights]');
    s.highlights.forEach((h) => lines.push(`- ${h}`));
  }

  if (s.bullets.length > 0) {
    lines.push('', '[Page Bullet Points]');
    s.bullets.slice(0, 25).forEach((b) => lines.push(`- ${b}`));
  }

  if (s.specs.length > 0) {
    lines.push('', '[Specifications]');
    s.specs.forEach((sp) => lines.push(`- ${sp}`));
  }

  if (s.bodyExcerpt) {
    lines.push('', '[Product Detail Excerpt]', s.bodyExcerpt);
  }

  // 截断总长度，避免吃太多 token
  const text = lines.join('\n');
  return text.length > 6000 ? text.slice(0, 6000) + '\n...(truncated)' : text;
}

// =====================================================================
// 以下为产品主图拽取实现 (gallery DOM 顺序 + 分辨率过滤)
// =====================================================================

export interface ProductImageCandidate {
  /** 原图 URL（已从 thumb 升级） */
  url: string;
  /** 缩略图 URL（用于前端面板预览） */
  thumbUrl: string;
  /** 原图在页面上的 naturalWidth */
  width: number;
  /** 原图在页面上的 naturalHeight */
  height: number;
}

const MIN_IMAGE_DIMENSION = 500;   // 不足 500px 的跳过
const MAX_IMAGE_CANDIDATES = 12;   // gallery 拿前 12 张候选

/**
 * 在同一个临时页面上拽取 gallery 主图 URL。
 * 适配 Lazada / Shopee / TikTok Shop 等常见产品页；以 gallery 顺序为准。
 */
export async function scrapeProductImages(
  context: BrowserContext,
  url: string
): Promise<ProductImageCandidate[]> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('产品链接必须以 http:// 或 https:// 开头');
  }

  console.log(`[scrape-product] 打开临时页面拽取主图: ${url}`);
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_LOAD_TIMEOUT,
    });
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      /* 部分电商里埋点持续在跑，networkidle 拿不到也可以接受 */
    }
    await page.waitForTimeout(SETTLE_DELAY);

    // 有的电商主图是懒加载，只有鼠标移到 gallery 上才会加载高清原图。
    // 为提高成功率，先滚动页面让 IntersectionObserver 走完。
    try {
      await page.evaluate(async () => {
        for (let y = 0; y < 1500; y += 300) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 200));
        }
        window.scrollTo(0, 0);
      });
    } catch {
      /* 滚动失败不中断 */
    }

    const candidates = await page.evaluate(
      ({ maxCount, minDim }) => {
        // gallery 常见选择器 (Lazada / Shopee / TikTok Shop / 独立站 swiper)
        const gallerySelectors = [
          '.gallery-preview-panel img',
          '.pdp-mod-common-image img',
          '[class*="gallery"] img',
          '[class*="swiper-slide"] img',
          '[class*="thumbnail-list"] img',
          '[class*="product-image"] img',
          '[data-spm*="gallery"] img',
        ];

        const seen = new Set<string>();
        const result: Array<{
          url: string;
          thumbUrl: string;
          width: number;
          height: number;
        }> = [];

        // Lazada 主图 URL 路径中常包含 _\d+x\d+ 这种缩图后缀，去掉后靠近原图
        const upgradeUrl = (raw: string): string => {
          if (!raw) return raw;
          let s = raw;
          if (s.startsWith('//')) s = 'https:' + s;
          // 去掉 _xxxxxxx.jpg 这种不同尺寸后缀
          s = s.replace(/_\d+x\d+(\.[a-zA-Z]+)/, '$1');
          // Shopee/Alibaba 类似 .jpg_q60 / .jpg_180x180 后缀
          s = s.replace(/(\.[a-zA-Z]{3,4})_[\dxq_]+$/, '$1');
          return s;
        };

        for (const sel of gallerySelectors) {
          const imgs = Array.from(document.querySelectorAll(sel)) as HTMLImageElement[];
          for (const img of imgs) {
            if (result.length >= maxCount) break;
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            const rawSrc =
              img.currentSrc ||
              img.src ||
              img.getAttribute('data-src') ||
              img.getAttribute('data-original') ||
              '';
            if (!rawSrc) continue;
            // 跳过 base64 占位、sprite
            if (rawSrc.startsWith('data:')) continue;

            const upgraded = upgradeUrl(rawSrc);
            if (seen.has(upgraded)) continue;
            seen.add(upgraded);

            // 不足最小分辨率：如果是 gallery 的 main image 渲染后是全尺寸，natural 还会是原图尺寸
            // 若 natural 为 0（未加载完）则不过滤，后续达下载后再判断
            if (w > 0 && h > 0 && (w < minDim || h < minDim)) continue;

            result.push({
              url: upgraded,
              thumbUrl: rawSrc.startsWith('//') ? 'https:' + rawSrc : rawSrc,
              width: w,
              height: h,
            });
          }
          if (result.length > 0) break; // 取到一个选择器有货就用它
        }

        // 最后兑底：og:image
        if (result.length === 0) {
          const og = document
            .querySelector('meta[property="og:image"]')
            ?.getAttribute('content');
          if (og) {
            const u = og.startsWith('//') ? 'https:' + og : og;
            result.push({ url: u, thumbUrl: u, width: 0, height: 0 });
          }
        }

        return result;
      },
      { maxCount: MAX_IMAGE_CANDIDATES, minDim: MIN_IMAGE_DIMENSION }
    );

    console.log(`[scrape-product] 拽取主图完成：${candidates.length} 张候选`);
    return candidates;
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.warn(
        `[scrape-product] 关闭临时页面失败: ${(err as Error).message}`
      );
    }
  }
}
