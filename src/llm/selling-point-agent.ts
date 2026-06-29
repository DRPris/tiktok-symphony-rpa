/**
 * 卖点分析 Agent —— 调用 Qwen 把产品页内容提炼为结构化卖点
 */
import { chatComplete } from './qwen';

function buildSystemPrompt(targetLanguage?: string): string {
  const lang = targetLanguage || 'English';
  return `You are an expert TikTok short-video scriptwriter for cross-border e-commerce. Your task is to extract key selling points from a product detail page that can be directly used in a product video script.

## CRITICAL LANGUAGE RULE (MUST FOLLOW)
**You MUST output ALL text exclusively in ${lang}.** The source page may be in Chinese or another language — you MUST translate and rewrite everything into ${lang}. NEVER output Chinese characters or any language other than ${lang}. If you output any Chinese, your response is considered FAILED.

## Requirements:
1. Output ONLY the final selling point items — no greetings, no explanation, no summary.
2. Output 5-8 selling points, one per line, each prefixed with "- ".
3. Each selling point should be 5-20 words, punchy and suitable for video voice-over.
4. Prioritize: core features / unique advantages / use scenarios / target users / key specs.
5. Do NOT list raw spec sheets — convert them into consumer-friendly benefits.
6. Ignore promotional text (discounts, shipping, return policy, platform navigation).

Remember: ALL output MUST be in ${lang}. Zero tolerance for other languages.`;
}

/**
 * 从抓取到的产品页文本中分析提炼卖点
 * @param snapshotText snapshotToText() 序列化后的文本
 * @param productName  审核面板里已填写的商品名（可空）
 * @param targetLanguage 目标输出语言（如 English / Thai / Vietnamese），默认 English
 * @returns 形如 "- xxx\n- xxx\n..." 的多行卖点
 */
export async function analyzeSellingPoints(
  snapshotText: string,
  productName?: string,
  targetLanguage?: string
): Promise<string> {
  const userParts: string[] = [];
  if (productName) {
    userParts.push(`Product name: ${productName}`);
  }
  userParts.push('Below is the raw content scraped from the product detail page (may be in Chinese or other languages). Extract and TRANSLATE into selling points:');
  userParts.push('-----');
  userParts.push(snapshotText);
  userParts.push('-----');
  userParts.push(`IMPORTANT: Output 5-8 selling points in ${targetLanguage || 'English'} ONLY. Do NOT use Chinese. Each line prefixed with "- ".`);

  const text = await chatComplete(
    [
      { role: 'system', content: buildSystemPrompt(targetLanguage) },
      { role: 'user', content: userParts.join('\n') },
    ],
    { temperature: 0.3, maxTokens: 600 }
  );

  return normalizeBulletList(text);
}

/**
 * 规范化 LLM 输出为统一的 "- xxx" 列表
 * - 去掉空行、序号
 * - 限制条目数量
 */
function normalizeBulletList(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const cleaned: string[] = [];
  for (const line of lines) {
    // 去掉多种前缀：- / • / * / 1. / 1、 / 1)
    const stripped = line.replace(/^[\-\*\•]\s*|^\d+[\.\)、]\s*/, '').trim();
    if (!stripped) continue;
    cleaned.push(`- ${stripped}`);
    if (cleaned.length >= 8) break;
  }

  return cleaned.join('\n') || raw.trim();
}
