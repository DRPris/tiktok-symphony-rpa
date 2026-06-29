import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import type { BrowserContext } from 'playwright';
import { TaskManager } from '../task/manager';
import { config } from '../config';
import { CreateTaskRequest, TaskMethod, TaskStatus } from '../types';
import {
  scrapeProductPage,
  snapshotToText,
  scrapeProductImages,
} from '../automation/scrape-product';
import { analyzeSellingPoints } from '../llm/selling-point-agent';
import { analyzeAudience } from '../llm/audience-agent';
import { scoreProductImages } from '../llm/image-score-agent';
import { detectCountry, getAllCountryProfiles, getCountryProfile } from '../utils/country-detect';
import {
  downloadImagesToAssets,
  ensureScrapedDir,
} from '../utils/download-image';
import {
  flattenSelectors,
  getDefaultSelectors,
} from '../automation/selectors';
import {
  getOverridesSnapshot,
  updateOverrides,
  getSelectorStats,
} from '../automation/selector-store';
import {
  snapshotAbsoluteDir,
  readSnapshotMeta,
} from '../automation/failure-snapshot';
import {
  resolveProductUrl,
  constructProductUrl,
  extractFromUrl,
  getVentureInfo,
} from '../utils/venture-map';

/**
 * 将用户填的素材路径解析为绝对路径
 * - 以 / 开头：视为绝对路径，原样使用
 * - 其他：拼接到 assets.dir 下
 */
function resolveAssetPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return trimmed;
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(config.assets.dir, trimmed);
}

/**
 * 解析并校验 task.input 中的本地文件路径（referenceVideo / productImages）
 * - 原位修改 input，跳过空值
 * - 任何一个文件不存在都会返回错误
 */
function resolveAndValidateAssets(input: any): { valid: boolean; error?: string } {
  // 参考视频
  if (typeof input.referenceVideo === 'string' && input.referenceVideo.trim()) {
    const abs = resolveAssetPath(input.referenceVideo);
    if (!fs.existsSync(abs)) {
      return {
        valid: false,
        error: `参考视频文件不存在: ${abs}（请检查 assets/ 目录或使用绝对路径）`,
      };
    }
    input.referenceVideo = abs;
  } else {
    delete input.referenceVideo;
  }

  // 商品图片
  if (Array.isArray(input.productImages) && input.productImages.length > 0) {
    const resolved: string[] = [];
    for (const img of input.productImages) {
      if (typeof img !== 'string' || !img.trim()) continue;
      const abs = resolveAssetPath(img);
      if (!fs.existsSync(abs)) {
        return {
          valid: false,
          error: `商品图片文件不存在: ${abs}（请检查 assets/ 目录或使用绝对路径）`,
        };
      }
      resolved.push(abs);
    }
    if (resolved.length > 0) {
      input.productImages = resolved;
    } else {
      delete input.productImages;
    }
  }

  return { valid: true };
}

/**
 * 简单 CORS 中间件 - 允许 localhost 跨域访问
 */
function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin || '*';
  // 允许任意 localhost 来源
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

/**
 * 请求日志中间件
 */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`
    );
  });
  next();
}

/**
 * 校验创建任务请求
 */
function validateCreateTaskRequest(body: any): { valid: boolean; error?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: '请求体必须是 JSON 对象' };
  }

  const { method, input } = body;

  const validMethods: TaskMethod[] = ['template', 'agent-mode'];
  if (!method || !validMethods.includes(method)) {
    return { valid: false, error: `method 必须是 'template' 或 'agent-mode'` };
  }

  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'input 必须是对象' };
  }

  if (!input.productName || typeof input.productName !== 'string') {
    return { valid: false, error: 'input.productName 必填且必须是字符串' };
  }

  // prompt 可以为空：后端 buildCombinedPrompt 会基于商品信息自动拼装
  // 仅当 prompt 和 productUrl 都缺失时才报错
  if (!input.prompt && !input.productUrl) {
    return { valid: false, error: 'input.prompt 必填（或提供 productUrl 由系统自动生成）' };
  }
  if (input.prompt && typeof input.prompt !== 'string') {
    return { valid: false, error: 'input.prompt 必须是字符串' };
  }

  return { valid: true };
}

/**
 * 异步路由处理包装器 - 统一捕获异常
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 创建 Express API 服务器
 * @param taskManager   任务管理器
 * @param getBrowserContext  返回当前可用 BrowserContext的工厂，用于 "AI 分析卖点" 临时开页抓取
 */
export function createApiServer(
  taskManager: TaskManager,
  getBrowserContext?: () => BrowserContext | null
): express.Application {
  const app = express();

  // 中间件
  app.use(express.json({ limit: '10mb' }));
  app.use(corsMiddleware);
  app.use(requestLogger);

  // 审核面板静态文件
  app.use(express.static(path.resolve(__dirname, '../../review-ui')));

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'ok' });
  });

  /**
   * POST /api/tasks - 创建新任务
   */
  app.post(
    '/api/tasks',
    asyncHandler(async (req, res) => {
      const validation = validateCreateTaskRequest(req.body);
      if (!validation.valid) {
        res.status(400).json({ success: false, error: validation.error });
        return;
      }

      // 解析并校验本地素材路径（referenceVideo / productImages）
      const assetCheck = resolveAndValidateAssets(req.body.input);
      if (!assetCheck.valid) {
        res.status(400).json({ success: false, error: assetCheck.error });
        return;
      }

      const request: CreateTaskRequest = req.body;
      const task = await taskManager.createTask(request);
      // 透传幂等标记：同一 productUrl + method 上已存在进行中的任务时，manager 会返回带 duplicate=true 的原任务
      const { duplicate, ...rest } = task as any;
      res.status(201).json({ success: true, task: rest, duplicate: !!duplicate });
    })
  );

  /**
   * GET /api/tasks - 获取任务列表
   */
  app.get(
    '/api/tasks',
    asyncHandler(async (req, res) => {
      const status = req.query.status as TaskStatus | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      let tasks = await taskManager.getAllTasks();

      if (status) {
        tasks = tasks.filter((t) => t.status === status);
      }

      // 按创建时间倒序
      tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const total = tasks.length;
      const paginated = tasks.slice(offset, offset + limit);

      res.json({ success: true, tasks: paginated, total });
    })
  );

  /**
   * GET /api/tasks/:id - 获取任务详情
   */
  app.get(
    '/api/tasks/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const task = await taskManager.getTask(id);
      if (!task) {
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }
      res.json({ success: true, task });
    })
  );

  /**
   * POST /api/tasks/:id/approve - 审核通过
   */
  app.post(
    '/api/tasks/:id/approve',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const existing = await taskManager.getTask(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }
      const task = await taskManager.approveTask(id);
      res.json({ success: true, task });
    })
  );

  /**
   * POST /api/tasks/:id/reject - 审核拒绝
   */
  app.post(
    '/api/tasks/:id/reject',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const existing = await taskManager.getTask(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }

      const reason: string | undefined =
        req.body && typeof req.body.reason === 'string' ? req.body.reason : undefined;

      const task = await taskManager.rejectTask(id);

      if (reason) {
        console.log(`[API] 任务 ${id} 被拒绝，原因: ${reason}`);
      }

      res.json({ success: true, task: reason ? { ...task, error: reason } : task });
    })
  );

  /**
   * POST /api/tasks/:id/retry - 重试失败任务
   */
  app.post(
    '/api/tasks/:id/retry',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const existing = await taskManager.getTask(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }
      // 面板手动点击重试 = 立即重试（不走退避）
      const task = await taskManager.retryTask(id, { immediate: true });
      res.json({ success: true, task });
    })
  );

  /**
   * GET /api/selectors - 选择器全量快照
   * 返回：{ defaults, current, overrides, stats }
   *  defaults  出厂默认（平拍）
   *  current   当前生效值（defaults + overrides后的状态）
   *  overrides 用户在面板上覆盖的那些项
   *  stats     运行期命中/未命中统计
   */
  app.get(
    '/api/selectors',
    asyncHandler(async (_req, res) => {
      res.json({
        success: true,
        defaults: flattenSelectors(getDefaultSelectors()),
        current: flattenSelectors(),
        overrides: getOverridesSnapshot(),
        stats: getSelectorStats(),
      });
    })
  );

  /**
   * PUT /api/selectors - 更新选择器覆盖（热生效）
   * 入参：{ overrides: { 'common.chatInput': '...' } }
   *   空对象 = 清除所有覆盖、还原默认
   */
  app.put(
    '/api/selectors',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) {
        res.status(400).json({ success: false, error: 'overrides 必须是对象' });
        return;
      }
      // 过滤非字符串 / 空值
      const cleaned: Record<string, string> = {};
      for (const k of Object.keys(body.overrides)) {
        const v = body.overrides[k];
        if (typeof v === 'string' && v.trim()) {
          cleaned[k] = v.trim();
        }
      }
      try {
        await updateOverrides(cleaned);
        res.json({
          success: true,
          current: flattenSelectors(),
          overrides: getOverridesSnapshot(),
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message || '保存失败' });
      }
    })
  );

  /**
   * GET /api/snapshots/file?dir=...&name=screenshot.png
   * 静态提供快照文件（screenshot.png / page.html / meta.json）
   * dir 参数必须是 data/snapshots/ 下的相对路径（从 task.failureSnapshots[i].dir 来）
   */
  app.get(
    '/api/snapshots/file',
    asyncHandler(async (req, res) => {
      const dir = String(req.query.dir || '');
      const name = String(req.query.name || '');
      if (!dir || !name) {
        res.status(400).json({ success: false, error: 'dir 和 name 必填' });
        return;
      }
      // 防路径穿越：只允许 snapshots/ 前缀
      const norm = path.normalize(dir);
      if (norm.includes('..') || !norm.startsWith('snapshots')) {
        res.status(400).json({ success: false, error: '非法路径' });
        return;
      }
      if (name.includes('/') || name.includes('..')) {
        res.status(400).json({ success: false, error: '非法文件名' });
        return;
      }
      const filePath = path.join(snapshotAbsoluteDir(norm), name);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ success: false, error: '文件不存在' });
        return;
      }
      res.sendFile(filePath);
    })
  );

  /**
   * GET /api/snapshots/meta?dir=...
   * 返回快照 meta.json 原始内容
   */
  app.get(
    '/api/snapshots/meta',
    asyncHandler(async (req, res) => {
      const dir = String(req.query.dir || '');
      if (!dir) {
        res.status(400).json({ success: false, error: 'dir 必填' });
        return;
      }
      const norm = path.normalize(dir);
      if (norm.includes('..') || !norm.startsWith('snapshots')) {
        res.status(400).json({ success: false, error: '非法路径' });
        return;
      }
      const meta = await readSnapshotMeta(norm);
      if (!meta) {
        res.status(404).json({ success: false, error: 'meta.json 不存在' });
        return;
      }
      res.json({ success: true, meta });
    })
  );

  /**
   * GET /api/health - 增强健康检查
   */
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      const status = await taskManager.getSystemStatus();
      // Top 失败原因：近 24h 内 task.errorInfo.code 聚合
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const all = await taskManager.getAllTasks();
      const counter: Record<string, number> = {};
      for (const t of all) {
        if (
          t.status === 'failed' &&
          t.errorInfo?.code &&
          new Date(t.updatedAt).getTime() >= since
        ) {
          counter[t.errorInfo.code] = (counter[t.errorInfo.code] || 0) + 1;
        }
      }
      const topErrors = Object.entries(counter)
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      res.json({
        success: true,
        status,
        topErrors,
        selectorStats: getSelectorStats(),
      });
    })
  );

  /**
   * GET /api/status - 系统状态
   */
  app.get(
    '/api/status',
    asyncHandler(async (_req, res) => {
      const status = await taskManager.getSystemStatus();
      res.json({ success: true, status });
    })
  );

  /**
   * POST /api/detect-country - 从商品链接域名自动识别目标国家
   * 入参：{ productUrl: string }
   * 出参：{ success, country, countryCode, persona, videoLanguage } 或 { success, detected: false }
   */
  app.post(
    '/api/detect-country',
    asyncHandler(async (req, res) => {
      const productUrl: string = req.body?.productUrl?.toString().trim() || '';
      if (!productUrl) {
        res.status(400).json({ success: false, error: 'productUrl 必填' });
        return;
      }

      const profile = detectCountry(productUrl);
      if (profile) {
        console.log(`[API] detect-country: ${productUrl} -> ${profile.country} (${profile.countryCode})`);
        res.json({ success: true, detected: true, ...profile });
      } else {
        console.log(`[API] detect-country: ${productUrl} -> 未识别`);
        res.json({ success: true, detected: false });
      }
    })
  );

  /**
   * GET /api/country-profiles - 获取所有支持的国家画像列表（用于前端下拉选择）
   */
  app.get('/api/country-profiles', (_req, res) => {
    res.json({ success: true, profiles: getAllCountryProfiles() });
  });

  /**
   * POST /api/analyze-selling-points - 前置 Agent：抻取产品页 + Qwen 提炼卖点
   * 入参：{ productUrl: string, productName?: string }
   * 出参：{ success: true, sellingPoints: string }
   *
   * 注：仅返回卖点文本，不修改任何任务；前端负责「追加不覆盖」的拼接逻辑。
   */
  app.post(
    '/api/analyze-selling-points',
    asyncHandler(async (req, res) => {
      const productUrl: string = req.body?.productUrl?.toString().trim() || '';
      const productName: string | undefined =
        typeof req.body?.productName === 'string'
          ? req.body.productName.trim() || undefined
          : undefined;

      if (!productUrl) {
        res
          .status(400)
          .json({ success: false, error: 'productUrl 必填' });
        return;
      }
      if (!/^https?:\/\//i.test(productUrl)) {
        res.status(400).json({
          success: false,
          error: 'productUrl 必须以 http:// 或 https:// 开头',
        });
        return;
      }

      const ctx = getBrowserContext?.();
      if (!ctx) {
        res.status(503).json({
          success: false,
          error: '浏览器尚未就绪，请稍后重试',
        });
        return;
      }

      console.log(
        `[API] analyze-selling-points: url=${productUrl}, productName=${productName || ''}`
      );

      try {
        // 根据 URL 域名检测目标市场语言
        const countryProfile = detectCountry(productUrl);
        const targetLanguage = countryProfile?.videoLanguage || 'English';

        const snapshot = await scrapeProductPage(ctx, productUrl);
        const text = snapshotToText(snapshot);
        const sellingPoints = await analyzeSellingPoints(text, productName, targetLanguage);

        res.json({
          success: true,
          sellingPoints,
          // 调试辅助信息（前端可选用）
          meta: {
            title: snapshot.title,
            highlightCount: snapshot.highlights.length,
            bulletCount: snapshot.bullets.length,
          },
        });
      } catch (err: any) {
        console.error('[API] analyze-selling-points 失败:', err.message);
        res.status(500).json({
          success: false,
          error: err.message || '卖点分析失败',
        });
      }
    })
  );

  /**
   * POST /api/analyze-audience - 受众分析
   * 入参：{ productUrl: string, productName?: string, sellingPoints?: string }
   * 出参：{ success, audience: string, meta: { title } }
   */
  app.post(
    '/api/analyze-audience',
    asyncHandler(async (req, res) => {
      const productUrl: string = req.body?.productUrl?.toString().trim() || '';
      const productName: string | undefined =
        typeof req.body?.productName === 'string'
          ? req.body.productName.trim() || undefined
          : undefined;
      const sellingPoints: string | undefined =
        typeof req.body?.sellingPoints === 'string'
          ? req.body.sellingPoints.trim() || undefined
          : undefined;

      if (!productUrl) {
        res.status(400).json({ success: false, error: 'productUrl 必填' });
        return;
      }
      if (!/^https?:\/\//i.test(productUrl)) {
        res.status(400).json({
          success: false,
          error: 'productUrl 必须以 http:// 或 https:// 开头',
        });
        return;
      }

      const ctx = getBrowserContext?.();
      if (!ctx) {
        res.status(503).json({
          success: false,
          error: '浏览器尚未就绪，请稍后重试',
        });
        return;
      }

      console.log(
        `[API] analyze-audience: url=${productUrl}, productName=${productName || ''}`
      );

      try {
        // 并行抓取文本内容 + 商品图片 URL
        const [snapshot, imageCandidates] = await Promise.all([
          scrapeProductPage(ctx, productUrl),
          scrapeProductImages(ctx, productUrl).catch((e: any) => {
            console.warn('[API] analyze-audience: 图片抓取失败，跳过图片分析:', e.message);
            return [];
          }),
        ]);
        const text = snapshotToText(snapshot);
        // 取前 5 张图片 URL 供视觉模型分析
        const imageUrls = imageCandidates
          .slice(0, 5)
          .map((c) => c.url)
          .filter(Boolean);

        console.log(`[API] analyze-audience: text=${text.length}字, images=${imageUrls.length}张`);
        const audience = await analyzeAudience(text, productName, sellingPoints, imageUrls);

        res.json({
          success: true,
          audience,
          meta: {
            title: snapshot.title,
            imageCount: imageUrls.length,
          },
        });
      } catch (err: any) {
        console.error('[API] analyze-audience 失败:', err.message);
        res.status(500).json({
          success: false,
          error: err.message || '受众分析失败',
        });
      }
    })
  );

  /**
   * POST /api/scrape-product-images - 抽取产品页主图 + Qwen-VL 质量打分
   * 入参：{ productUrl: string }
   * 出参：{ success, candidates: [{ url, thumbUrl, width, height, score, reason }] }
   *
   * 该接口不下载任何图片，只返回候选。前端面板勾选后调 download-product-images 才会落本地。
   */
  app.post(
    '/api/scrape-product-images',
    asyncHandler(async (req, res) => {
      const productUrl: string =
        req.body?.productUrl?.toString().trim() || '';
      if (!productUrl) {
        res.status(400).json({ success: false, error: 'productUrl 必填' });
        return;
      }
      if (!/^https?:\/\//i.test(productUrl)) {
        res.status(400).json({
          success: false,
          error: 'productUrl 必须以 http:// 或 https:// 开头',
        });
        return;
      }
      const ctx = getBrowserContext?.();
      if (!ctx) {
        res.status(503).json({
          success: false,
          error: '浏览器尚未就绪，请稍后重试',
        });
        return;
      }

      console.log(`[API] scrape-product-images: url=${productUrl}`);

      try {
        // 同一个临时页顺便拍个页面标题，用于前端回填 productName
        let pageTitle = '';
        try {
          const snap = await scrapeProductPage(ctx, productUrl);
          pageTitle = (snap.title || '').trim();
        } catch (e: any) {
          console.warn('[API] scrape title 跳过:', e.message);
        }

        const candidates = await scrapeProductImages(ctx, productUrl);
        if (candidates.length === 0) {
          res.json({ success: true, candidates: [], title: pageTitle });
          return;
        }

        // 调 Qwen-VL 打分
        let scored: Array<{ index: number; score: number; reason: string }> = [];
        try {
          scored = await scoreProductImages(candidates.map((c) => c.url));
        } catch (e: any) {
          console.warn('[API] Qwen-VL 打分失败，退化为 DOM 顺序:', e.message);
        }
        const scoreMap = new Map(scored.map((s) => [s.index, s]));

        // 合并输出 + 按分数倒序
        const merged = candidates
          .map((c, idx) => {
            const s = scoreMap.get(idx);
            return {
              url: c.url,
              thumbUrl: c.thumbUrl,
              width: c.width,
              height: c.height,
              score: s?.score ?? 50,
              reason: s?.reason ?? '',
            };
          })
          .sort((a, b) => b.score - a.score);

        res.json({ success: true, candidates: merged, title: pageTitle });
      } catch (err: any) {
        console.error('[API] scrape-product-images 失败:', err.message);
        res.status(500).json({
          success: false,
          error: err.message || '产品图拽取失败',
        });
      }
    })
  );

  /**
   * POST /api/download-product-images - 下载选中的产品图到 assets/scraped/<hash>/
   * 入参：{ productUrl: string, urls: string[] }
   * 出参：{ success, paths: string[] }   // paths 为本地绝对路径，可直接塑给 productImages
   */
  app.post(
    '/api/download-product-images',
    asyncHandler(async (req, res) => {
      const productUrl: string =
        req.body?.productUrl?.toString().trim() || '';
      const urls: string[] = Array.isArray(req.body?.urls)
        ? req.body.urls.filter(
            (u: any) => typeof u === 'string' && /^https?:\/\//i.test(u)
          )
        : [];

      if (!productUrl) {
        res.status(400).json({ success: false, error: 'productUrl 必填' });
        return;
      }
      if (urls.length === 0) {
        res.status(400).json({
          success: false,
          error: 'urls 为空，请先选中要下载的产品图',
        });
        return;
      }
      if (urls.length > 12) {
        res.status(400).json({
          success: false,
          error: '一次最多下载 12 张产品图',
        });
        return;
      }

      console.log(
        `[API] download-product-images: url=${productUrl}, count=${urls.length}`
      );

      try {
        // 预创建目录以准诮错提示
        ensureScrapedDir(productUrl);
        const results = await downloadImagesToAssets(productUrl, urls);
        if (results.length === 0) {
          res.status(500).json({
            success: false,
            error: '所有图片都下载失败，请检查网络或重试',
          });
          return;
        }
        res.json({
          success: true,
          paths: results.map((r) => r.localPath),
          meta: {
            requested: urls.length,
            downloaded: results.length,
          },
        });
      } catch (err: any) {
        console.error('[API] download-product-images 失败:', err.message);
        res.status(500).json({
          success: false,
          error: err.message || '产品图下载失败',
        });
      }
    })
  );

  /**
   * GET /api/debug/page-inspect - 临时诊断：导航到 Symphony 并返回页面信息
   */
  app.get(
    '/api/debug/page-inspect',
    asyncHandler(async (req, res) => {
      const ctx = getBrowserContext?.();
      if (!ctx) {
        res.status(503).json({ success: false, error: '浏览器未就绪' });
        return;
      }
      const targetUrl = (req.query.url as string) || config.urls.home;
      const clickText = (req.query.click as string) || '';
      const inputText = (req.query.input as string) || '';
      const pressEnter = (req.query.enter as string) === '1' || (req.query.enter as string) === 'true';
      const postWait = Math.min(
        Math.max(parseInt((req.query.postWait as string) || '0', 10) || 0, 0),
        300000
      );
      // 支持自定义等待时间（毫秒），默认 4000，最大 60000
      const waitMs = Math.min(
        Math.max(parseInt((req.query.wait as string) || '4000', 10) || 4000, 0),
        60000
      );
      const page = await ctx.newPage();
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(waitMs);
        // 关闭弹窗
        try {
          const closeBtn = await page.$('[class*="closeButton"], [class*="close"]');
          if (closeBtn) { await closeBtn.click(); await page.waitForTimeout(1000); }
        } catch {}
        // click 支持 '||' 分隔的多步点击：click=TikTok trend||Select a trend||Top Performing Ads
        if (clickText) {
          const steps = clickText.split('||').map(s => s.trim()).filter(Boolean);
          for (const step of steps) {
            try {
              const sel = `[class*="KsButton"]:has-text("${step}"), [class*="chatbox"]:has-text("${step}"), [class*="card"]:has-text("${step}"), button:has-text("${step}"), a:has-text("${step}"), div[role="button"]:has-text("${step}")`;
              await page.click(sel, { timeout: 8000 });
              await page.waitForTimeout(2500);
            } catch (e: any) {
              res.json({ success: false, error: `click step '${step}' failed: ${e.message}`, finalUrl: page.url() });
              return;
            }
          }
        }
        // input 参数：在 ProseMirror 输入文字
        if (inputText) {
          try {
            const editor = await page.waitForSelector('.tiptap.ProseMirror, div[contenteditable="true"]', { timeout: 10000 });
            if (editor) {
              await editor.click({ force: true });
              await page.waitForTimeout(500);
              await page.keyboard.insertText(inputText);
              await page.waitForTimeout(1000);
              if (pressEnter) {
                await page.keyboard.press('Enter');
                await page.waitForTimeout(2000);
              }
            }
          } catch (e: any) {
            res.json({ success: false, error: `input failed: ${e.message}`, finalUrl: page.url() });
            return;
          }
        }
        // postWait：发送后额外等待（令 brief 生成完成）
        if (postWait > 0) {
          console.log(`[page-inspect] postWait 等待 ${postWait}ms…`);
          await page.waitForTimeout(postWait);
        }
        const finalUrl = page.url();
        await page.screenshot({ path: path.resolve(__dirname, '../../debug-symphony.png') });
        const domInfo = await page.evaluate(() => {
          const items: any[] = [];
          const selector =
            'a, button, textarea, input, [contenteditable], [role="button"], [class*="btn"], [class*="Button"], [class*="card"], [class*="upload"], [class*="chat"], [class*="input"], [class*="prompt"], [class*="trend"], [class*="Trend"], [class*="select"], [class*="Select"], [class*="plus"], [class*="add"], [class*="Add"], [data-testid]';
          const all = Array.from(document.querySelectorAll(selector));
          // 过滤掉侧边栏历史会话项（RenameDelete 菜单、select-none p-[4px]）
          const filtered = all.filter(el => {
            const cls = (el.className || '').toString();
            if (cls.includes('select-none p-[4px]')) return false;
            // 过滤 footer-btn / Cancel/Save/Delete 重复项（侧边栏弹出菜单项）
            const text = (el.textContent || '').trim();
            // 保留主体：只过滤明显是侧边栏菜单的
            return true;
          });
          let count = 0;
          for (const el of filtered) {
            if (count >= 400) break;
            const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            const cls = (el.className || '').toString().slice(0, 120);
            if (!text && !cls && !(el as HTMLElement).getAttribute('data-testid')) continue;
            const rect = el.getBoundingClientRect();
            items.push({
              tag: el.tagName,
              class: cls,
              href: (el as HTMLAnchorElement).href || '',
              text,
              type: (el as HTMLInputElement).type || '',
              placeholder: (el as HTMLTextAreaElement).placeholder || '',
              testid: (el as HTMLElement).getAttribute('data-testid') || '',
              role: (el as HTMLElement).getAttribute('role') || '',
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            });
            count++;
          }
          return items;
        });
        res.json({ success: true, finalUrl, domInfo });
      } finally {
        await page.close();
      }
    })
  );

  /**
   * POST /api/resolve-product-url - 通过 venture + productId 复原 Lazada 商品 URL
   *
   * 入参：{ venture: string, productId: string, followRedirect?: boolean }
   * 出参：{ success, constructedUrl, finalUrl, redirected, venture, productId }
   *
   * 使用场景：用户原始数据只有 venture（如 "PH"）和 productId（如 "4738495529"），
   * 本端点将其复原为完整 Lazada 商品 URL，可直接传给商品解析 Agent。
   */
  app.post(
    '/api/resolve-product-url',
    asyncHandler(async (req, res) => {
      const venture: string = req.body?.venture?.toString().trim() || '';
      const productId: string = req.body?.productId?.toString().trim() || '';
      const followRedirect: boolean = req.body?.followRedirect !== false;

      if (!venture) {
        res.status(400).json({ success: false, error: 'venture 必填' });
        return;
      }
      if (!productId) {
        res.status(400).json({ success: false, error: 'productId 必填' });
        return;
      }

      // 先快速校验是否能构造 URL（不等待重定向）
      const quickUrl = constructProductUrl(venture, productId);
      if (!quickUrl) {
        res.status(400).json({
          success: false,
          error:
            '无法识别 venture 或 productId 格式。venture 支持国家码（TH/PH/MY/SG/ID/VN）或域名（lazada.com.ph）；productId 支持纯数字、i123-s456 等格式。',
        });
        return;
      }

      console.log(
        `[API] resolve-product-url: venture=${venture}, productId=${productId} -> ${quickUrl}`,
      );

      try {
        const result = await resolveProductUrl(venture, productId, {
          followRedirect,
          redirectTimeout: 10000,
        });

        if (!result) {
          res.status(400).json({
            success: false,
            error: 'URL 构造失败，请检查 venture 和 productId 格式',
          });
          return;
        }

        res.json({
          success: true,
          constructedUrl: result.constructedUrl,
          finalUrl: result.finalUrl,
          redirected: result.redirected,
          venture: result.venture,
          productId: result.productId,
        });
      } catch (err: any) {
        // 即使重定向失败，也返回构造的 URL
        console.error('[API] resolve-product-url 重定向失败:', err.message);
        res.json({
          success: true,
          constructedUrl: quickUrl,
          finalUrl: quickUrl,
          redirected: false,
          warning: `重定向跟随失败: ${err.message}，返回未解析的 URL`,
        });
      }
    }),
  );

  /**
   * POST /api/resolve-product-urls - 批量通过 venture + productId 复原 URL
   *
   * 入参：{ items: [{ venture, productId }], followRedirect?: boolean }
   * 出参：{ success, results: [{ venture, productId, productUrl, finalUrl?, error? }] }
   */
  app.post(
    '/api/resolve-product-urls',
    asyncHandler(async (req, res) => {
      const items: Array<{ venture: string; productId: string }> =
        req.body?.items;
      const followRedirect: boolean = req.body?.followRedirect !== false;

      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ success: false, error: 'items 必须是非空数组' });
        return;
      }

      if (items.length > 50) {
        res.status(400).json({
          success: false,
          error: '单次最多处理 50 条，请分批提交',
        });
        return;
      }

      const results = await Promise.all(
        items.map(async (item, idx) => {
          const venture = item.venture?.toString().trim() || '';
          const productId = item.productId?.toString().trim() || '';

          if (!venture || !productId) {
            return {
              index: idx,
              venture,
              productId,
              productUrl: '',
              error: 'venture 或 productId 为空',
            };
          }

          try {
            const result = await resolveProductUrl(venture, productId, {
              followRedirect,
              redirectTimeout: 10000,
            });
            if (!result) {
              return {
                index: idx,
                venture,
                productId,
                productUrl: '',
                error: '无法识别 venture 或 productId 格式',
              };
            }
            return {
              index: idx,
              venture: result.venture.ventureCode,
              productId: item.productId,
              productUrl: result.finalUrl,
              constructedUrl: result.constructedUrl,
              redirected: result.redirected,
            };
          } catch (err: any) {
            const fallback = constructProductUrl(venture, productId);
            return {
              index: idx,
              venture,
              productId,
              productUrl: fallback || '',
              error: err.message,
            };
          }
        }),
      );

      const succeeded = results.filter((r) => !r.error).length;
      console.log(
        `[API] resolve-product-urls: 批量解析完成 ${succeeded}/${results.length}`,
      );

      res.json({ success: true, results });
    }),
  );

  /**
   * POST /api/extract-venture-product - 从 Lazada URL 反向提取 venture 和 productId
   *
   * 入参：{ productUrl: string }
   * 出参：{ success, venture, productId, itemId, sellerId }
   */
  app.post(
    '/api/extract-venture-product',
    asyncHandler(async (req, res) => {
      const productUrl: string = req.body?.productUrl?.toString().trim() || '';
      if (!productUrl) {
        res.status(400).json({ success: false, error: 'productUrl 必填' });
        return;
      }

      const extracted = extractFromUrl(productUrl);
      if (!extracted) {
        res.status(400).json({
          success: false,
          error: '无法从 URL 中提取 venture 和 productId，请确认是 Lazada 商品链接',
        });
        return;
      }

      const ventureInfo = getVentureInfo(extracted.venture);
      res.json({
        success: true,
        venture: extracted.venture,
        productId: extracted.productId,
        itemId: extracted.itemId,
        sellerId: extracted.sellerId,
        domain: ventureInfo?.domain || '',
        country: ventureInfo?.country || '',
      });
    }),
  );

  // 404 兑底处理
  app.use((req, res) => {
    res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
  });

  // 统一错误处理
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const message = err?.message || 'Internal Server Error';
    console.error('[API] 错误:', message);

    // 根据错误信息推断状态码
    let statusCode = 500;
    if (/不存在|not found/i.test(message)) {
      statusCode = 404;
    } else if (/非法状态转换|不允许|无法|必须|必填/i.test(message)) {
      statusCode = 400;
    } else if (/最大重试/i.test(message)) {
      statusCode = 409;
    }

    res.status(statusCode).json({ success: false, error: message });
  });

  return app;
}
