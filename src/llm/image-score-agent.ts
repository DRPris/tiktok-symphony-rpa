/**
 * 产品图片质量打分 Agent
 * 调用 Qwen-VL 让模型对一组候选商品图按
 *  - 清晰度（分辨率/对焦/噪点）
 *  - 主体是否突出（产品占比、是否被遮挡）
 *  - 背景是否简洁（白底/纯色优先于复杂背景）
 * 三个维度综合给出 0-100 分。
 */

import { chatCompleteVision, VisionContentPart } from './qwen';

export interface ScoredImage {
  /** 在原候选数组中的下标 */
  index: number;
  /** 0-100，越高越好 */
  score: number;
  /** 简短理由（中文，可选） */
  reason: string;
}

const SYSTEM_PROMPT = `你是一位专业的电商主图筛选评审，正在为短视频脚本挑选合适的「产品主图」。
评审标准（按权重排序）：
1) 清晰度：分辨率高、对焦准确、不模糊；
2) 主体突出：产品本身在画面中占比高、不被人物/手势/水印过度遮挡；
3) 背景简洁：白底或纯色背景优先，复杂使用场景（人像、街景、家居环境复杂等）扣分。

输出要求：
- 严格输出 JSON，不要任何额外解释、不要 Markdown 代码块。
- 结构：{"scores":[{"index":0,"score":92,"reason":"白底清晰，主体居中"}, ...]}
- index 必须与输入图片顺序一一对应（从 0 开始）。
- score 取 0-100 的整数；reason 不超过 20 个汉字。`;

/**
 * 让 Qwen-VL 对一批图片打分。
 * 一次最多送 10 张图，超过会自动分批。
 */
export async function scoreProductImages(
  imageUrls: string[]
): Promise<ScoredImage[]> {
  if (imageUrls.length === 0) return [];

  const BATCH = 10;
  const allScored: ScoredImage[] = [];

  for (let start = 0; start < imageUrls.length; start += BATCH) {
    const batch = imageUrls.slice(start, start + BATCH);
    const userContent: VisionContentPart[] = [
      {
        type: 'text',
        text: `下面是 ${batch.length} 张候选商品图，请按上述标准打分。图片在数组中的顺序对应 index 0~${batch.length - 1}。`,
      },
      ...batch.map<VisionContentPart>((url) => ({
        type: 'image_url',
        image_url: { url },
      })),
    ];

    const raw = await chatCompleteVision(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.2, maxTokens: 1200 }
    );

    const parsed = parseScoreJson(raw, batch.length);
    // 把 batch 内的 index 映射回全局 index
    for (const s of parsed) {
      allScored.push({
        index: start + s.index,
        score: s.score,
        reason: s.reason,
      });
    }
  }

  return allScored;
}

/**
 * 兼容性 JSON 解析：
 *  - 直接 JSON.parse
 *  - 失败时尝试从文本中抠出第一个 {...} 段
 *  - 仍失败则按 batchSize 退化为 50 分（不至于全军覆没）
 */
function parseScoreJson(raw: string, batchSize: number): ScoredImage[] {
  const tryParse = (txt: string): any => {
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  };

  let obj = tryParse(raw);
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }

  if (!obj || !Array.isArray(obj.scores)) {
    console.warn('[image-score] Qwen-VL 返回非 JSON, 退化为均分:', raw.slice(0, 200));
    return Array.from({ length: batchSize }, (_, i) => ({
      index: i,
      score: 50,
      reason: '解析失败',
    }));
  }

  const result: ScoredImage[] = [];
  for (const item of obj.scores) {
    const idx = Number(item?.index);
    const sc = Math.round(Number(item?.score));
    if (!Number.isInteger(idx) || idx < 0 || idx >= batchSize) continue;
    if (!Number.isFinite(sc)) continue;
    result.push({
      index: idx,
      score: Math.max(0, Math.min(100, sc)),
      reason: typeof item?.reason === 'string' ? item.reason.trim() : '',
    });
  }

  // 模型偶尔漏 index，补齐
  const seen = new Set(result.map((r) => r.index));
  for (let i = 0; i < batchSize; i++) {
    if (!seen.has(i)) {
      result.push({ index: i, score: 50, reason: '未评分' });
    }
  }

  return result.sort((a, b) => a.index - b.index);
}
