#!/usr/bin/env node
/**
 * 一次性批量创建脚本
 * 流程: scrape-images -> download-images -> analyze-selling-points -> create task
 * 并发: 3   失败: 跳过该条但不中断
 *
 * 用法: node scripts/batch-create.mjs data/batch-5-products.json
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://localhost:3000';
const CONCURRENCY = 3;
const TOP_N_IMAGES = 1; // 每条产品取打分最高的前 N 张图

const inputFile = process.argv[2] || 'data/batch-5-products.json';
const items = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf-8'));

const DEFAULT_PROMPT =
  'Use TikTok trending video style to generate a video ad for {{productName}}, featuring {{persona}} speaking in {{videoLanguage}}. Target audience: {{audience}}. Highlight these key features: {{sellingPoints}}. Designed to maximize GMV performance. 1 Pesos for Lazada new user';

const ts = () => new Date().toISOString().slice(11, 19);
const log = (i, msg) => console.log(`[${ts()}] [#${i + 1}] ${msg}`);
const warn = (i, msg) => console.warn(`[${ts()}] [#${i + 1}] ⚠ ${msg}`);

async function postJson(url, body, timeoutMs = 120_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function processOne(item, i) {
  const { productUrl, prompt = DEFAULT_PROMPT, method = 'agent-mode' } = item;
  log(i, `start: ${productUrl.slice(0, 80)}...`);

  // Step 0: 国家识别（域名解析，不调 LLM）
  let country = '';
  let persona = '';
  let videoLanguage = '';
  try {
    const r = await postJson(`${API}/api/detect-country`, { productUrl }, 10_000);
    if (r.detected) {
      country = r.country || '';
      persona = r.persona || '';
      videoLanguage = r.videoLanguage || '';
      log(i, `⓪ 国家: ${country} (${r.countryCode}), 语言: ${videoLanguage}`);
    }
  } catch (e) {
    warn(i, `⓪ 国家识别失败: ${e.message}`);
  }

  // Step 1: 抓图 + 拿 title
  let title = '';
  let imageCandidates = [];
  try {
    const r = await postJson(`${API}/api/scrape-product-images`, { productUrl }, 120_000);
    title = (r.title || '').trim();
    imageCandidates = r.candidates || [];
    log(i, `① 抓图: title="${title.slice(0, 50)}", candidates=${imageCandidates.length}`);
  } catch (e) {
    warn(i, `① 抓图失败: ${e.message}`);
  }

  const productName = title || `Product ${i + 1}`;

  // Step 2: 下载 top N 图
  let productImages = [];
  if (imageCandidates.length > 0) {
    const topUrls = imageCandidates.slice(0, TOP_N_IMAGES).map((c) => c.url);
    try {
      const r = await postJson(
        `${API}/api/download-product-images`,
        { productUrl, urls: topUrls },
        90_000
      );
      productImages = r.paths || [];
      log(i, `② 下图: ${productImages.length} 张 -> ${productImages[0]?.split('/').slice(-2).join('/')}`);
    } catch (e) {
      warn(i, `② 下图失败: ${e.message}`);
    }
  }

  // Step 3: 卖点分析
  let sellingPoints = '';
  try {
    const r = await postJson(
      `${API}/api/analyze-selling-points`,
      { productUrl, productName },
      120_000
    );
    sellingPoints = (r.sellingPoints || '').trim();
    log(i, `③ 卖点: ${sellingPoints.split('\n').filter(Boolean).length} 条`);
  } catch (e) {
    warn(i, `③ 卖点失败: ${e.message}`);
  }

  // Step 3.5: 受众分析
  let audience = '';
  try {
    const r = await postJson(
      `${API}/api/analyze-audience`,
      { productUrl, productName, sellingPoints },
      120_000
    );
    audience = (r.audience || '').trim();
    log(i, `③⁵ 受众: ${audience.slice(0, 60)}...`);
  } catch (e) {
    warn(i, `③⁵ 受众分析失败: ${e.message}`);
  }

  // Step 4: 创建任务
  const taskBody = {
    method,
    input: {
      productName,
      prompt,
      productUrl,
      ...(sellingPoints ? { sellingPoints } : {}),
      ...(audience ? { audience } : {}),
      ...(country ? { country } : {}),
      ...(persona ? { persona } : {}),
      ...(videoLanguage ? { videoLanguage } : {}),
      ...(productImages.length > 0 ? { productImages } : {}),
    },
  };
  if (productImages.length === 0) {
    warn(i, `④ 跳过创建：缺少 productImages（agent-mode 需要图）`);
    return { ok: false, reason: 'no-image' };
  }
  try {
    const r = await postJson(`${API}/api/tasks`, taskBody, 30_000);
    log(i, `④ 创建任务 ✓ id=${r.task.id}`);
    return { ok: true, taskId: r.task.id, productName };
  } catch (e) {
    warn(i, `④ 创建失败: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// 并发池
async function runPool(arr, n, fn) {
  const results = new Array(arr.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= arr.length) return;
      try {
        results[i] = await fn(arr[i], i);
      } catch (e) {
        results[i] = { ok: false, reason: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

console.log(`\n=== 批量创建 ${items.length} 条任务 (并发 ${CONCURRENCY}) ===\n`);
const t0 = Date.now();
const results = await runPool(items, CONCURRENCY, processOne);
const cost = ((Date.now() - t0) / 1000).toFixed(1);

const ok = results.filter((r) => r?.ok).length;
const fail = results.length - ok;
console.log(`\n=== 完成: 成功 ${ok}/${results.length}, 失败 ${fail}, 耗时 ${cost}s ===`);
results.forEach((r, i) => {
  const tag = r?.ok ? '✓' : '✗';
  const detail = r?.ok ? `${r.taskId}  ${r.productName?.slice(0, 50)}` : r?.reason;
  console.log(`  [${tag}] #${i + 1}  ${detail}`);
});
