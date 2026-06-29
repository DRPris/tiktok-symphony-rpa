/**
 * 受众分析 Agent —— 双路分析（文本 + 图片视觉）识别目标受众
 *
 * 策略：
 *   1. 文本路：用 Qwen（纯文本模型）从商品页抓取内容分析受众
 *   2. 图片路：用 Qwen-VL（视觉模型）从商品主图识别产品品类、使用者特征、场景
 *   3. 融合路：将文本分析结果 + 图片视觉洞察 合并为最终受众描述
 *
 * 适配场景：部分本地商家文字描述极少，主要靠商品图片传达信息。
 */
import { chatComplete } from './qwen';
import { chatCompleteVision, VisionContentPart } from './qwen';

// ─── 文本路 System Prompt ───────────────────────────
const TEXT_SYSTEM_PROMPT = `你是一名跨境电商短视频营销策略专家，擅长从商品详情页信息中精准识别目标受众画像，并输出可直接嵌入 TikTok 视频生成 Prompt 的受众描述。

任务：分析商品信息，输出一段简洁的英文受众描述（因为 TikTok Symphony 接受英文 Prompt 效果最佳）。

输出格式要求：
1. 输出一段 2-4 句话的英文段落，直接描述目标受众。
2. 内容应包含：目标人群特征（年龄/性别/身份）、使用场景、购买动机、内容偏好/调性。
3. 不要输出标题、编号、解释、寒暄，只输出受众描述段落本身。
4. 语言风格：简洁专业，适合作为 AI 视频生成的 targeting 指令。
5. 如商品页是非英文语种（中文/泰文/越南文等），照样输出英文描述。

示例输出：
Target audience: Young women aged 18-30 who are into skincare routines and beauty trends on TikTok. They value affordable yet effective products, respond well to before-after demonstrations, and prefer fast-paced, visually appealing content with upbeat music.`;

// ─── 图片路 System Prompt ───────────────────────────
const VISION_SYSTEM_PROMPT = `You are an expert e-commerce marketing analyst. Your task is to look at product images and infer the target audience.

Analyze the product images and determine:
1. Product category and type (e.g., women's fashion, kitchen gadget, baby toy)
2. Likely buyer demographics: age range, gender, lifestyle
3. Use scenario: where/when would someone use this product
4. Visual style cues: does the packaging/design suggest premium, budget, trendy, professional, etc.
5. Content tone recommendation: what TikTok video style would appeal to this audience

Output a concise English paragraph (2-3 sentences) describing ONLY the target audience insights you can derive from the images. Do NOT describe the product itself — focus on WHO would buy it and WHY.`;

// ─── 融合路 System Prompt ───────────────────────────
const FUSION_SYSTEM_PROMPT = `You are a marketing strategist. You have two analyses of the same product's target audience:
- "Text Analysis": derived from the product page text/description
- "Visual Analysis": derived from looking at the product images

Merge them into a single, coherent English paragraph (2-4 sentences) that combines the best insights from both. Prioritize specificity: if one analysis is vague but the other is detailed, lean toward the detailed one. Remove redundancy. The output should read as a single unified audience description suitable for a TikTok video generation prompt.

Output ONLY the merged paragraph, no titles, no labels, no explanation.`;

/**
 * 从抓取到的产品页文本中分析目标受众（纯文本路）
 */
async function analyzeAudienceFromText(
  snapshotText: string,
  productName?: string,
  sellingPoints?: string
): Promise<string> {
  const userParts: string[] = [];
  if (productName) {
    userParts.push(`Product name: ${productName}`);
  }
  if (sellingPoints) {
    userParts.push(`Key selling points:\n${sellingPoints}`);
  }
  userParts.push('Below is the raw content scraped from the product detail page. Analyze it and output the target audience description:');
  userParts.push('-----');
  userParts.push(snapshotText);
  userParts.push('-----');
  userParts.push('Output a concise English paragraph (2-4 sentences) describing the target audience for a TikTok marketing video of this product.');

  const text = await chatComplete(
    [
      { role: 'system', content: TEXT_SYSTEM_PROMPT },
      { role: 'user', content: userParts.join('\n') },
    ],
    { temperature: 0.4, maxTokens: 400 }
  );

  return normalizeAudienceOutput(text);
}

/**
 * 从商品图片中分析目标受众（视觉路，Qwen-VL）
 * @param imageUrls 商品图片 URL 数组（最多取 5 张，避免超 token）
 * @param productName 商品名称（可空，给模型上下文）
 */
async function analyzeAudienceFromImages(
  imageUrls: string[],
  productName?: string
): Promise<string> {
  // 最多送 5 张图避免 token 爆炸
  const urls = imageUrls.slice(0, 5);

  const userContent: VisionContentPart[] = [
    {
      type: 'text',
      text: productName
        ? `Product: ${productName}\nBelow are ${urls.length} product image(s). Analyze them and describe the target audience.`
        : `Below are ${urls.length} product image(s). Analyze them and describe the target audience.`,
    },
    ...urls.map<VisionContentPart>((url) => ({
      type: 'image_url',
      image_url: { url },
    })),
  ];

  const text = await chatCompleteVision(
    [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    { temperature: 0.3, maxTokens: 400 }
  );

  return normalizeAudienceOutput(text);
}

/**
 * 融合文本分析和图片分析的结果
 */
async function fuseAudienceInsights(
  textAnalysis: string,
  visualAnalysis: string
): Promise<string> {
  const userMsg = `Text Analysis:\n${textAnalysis}\n\nVisual Analysis:\n${visualAnalysis}\n\nMerge these into a single coherent audience description paragraph.`;

  const text = await chatComplete(
    [
      { role: 'system', content: FUSION_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.3, maxTokens: 400 }
  );

  return normalizeAudienceOutput(text);
}

/**
 * 完整受众分析入口 —— 自动选择分析路径：
 *   - 有文本 + 有图片 → 双路分析 + 融合
 *   - 有文本 + 无图片 → 纯文本分析
 *   - 无文本 + 有图片 → 纯图片分析
 *
 * @param snapshotText  商品页抓取文本（可空）
 * @param productName   商品名称（可空）
 * @param sellingPoints 已提炼的卖点（可空）
 * @param imageUrls     商品图片 URL 数组（可空）
 * @returns 英文受众描述段落
 */
export async function analyzeAudience(
  snapshotText: string,
  productName?: string,
  sellingPoints?: string,
  imageUrls?: string[]
): Promise<string> {
  const hasText = snapshotText && snapshotText.trim().length > 20;
  const hasImages = imageUrls && imageUrls.length > 0;

  // 双路并行分析
  if (hasText && hasImages) {
    console.log(`[audience-agent] 双路分析: 文本(${snapshotText.length}字) + 图片(${imageUrls.length}张)`);
    const [textResult, visualResult] = await Promise.all([
      analyzeAudienceFromText(snapshotText, productName, sellingPoints),
      analyzeAudienceFromImages(imageUrls, productName),
    ]);
    console.log(`[audience-agent] 文本路结果: ${textResult.slice(0, 80)}...`);
    console.log(`[audience-agent] 图片路结果: ${visualResult.slice(0, 80)}...`);

    // 融合两路结果
    const fused = await fuseAudienceInsights(textResult, visualResult);
    console.log(`[audience-agent] 融合结果: ${fused.slice(0, 80)}...`);
    return fused;
  }

  // 仅图片
  if (hasImages) {
    console.log(`[audience-agent] 仅图片分析: ${imageUrls.length}张`);
    return analyzeAudienceFromImages(imageUrls, productName);
  }

  // 仅文本（兜底）
  console.log(`[audience-agent] 仅文本分析: ${snapshotText.length}字`);
  return analyzeAudienceFromText(snapshotText, productName, sellingPoints);
}

/**
 * 清理 LLM 输出：去掉可能的前缀标题和多余空行
 */
function normalizeAudienceOutput(raw: string): string {
  let text = raw.trim();
  // 去掉常见的标题前缀如 "Target audience:" / "Audience:"
  text = text.replace(/^(target\s+audience|audience)\s*[:：]\s*/i, '');
  // 去掉首尾引号
  text = text.replace(/^["'"\u201c]+|["'"\u201d]+$/g, '');
  // 合并多余换行为单行段落
  text = text.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').trim();
  return text;
}
