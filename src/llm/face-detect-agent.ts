/**
 * 人脸检测 Agent
 *
 * 调用 Qwen-VL 多模态模型判断商品图片是否包含人脸，
 * 并返回人脸在图片中的位置（用于后续裁剪）。
 *
 * 典型场景：TikTok Seedance 对含人脸图片会返回
 * "This image may include a human face, which isn't supported"
 * 拒绝生成视频。为避免被风控拦截，在上传前先检测并裁剪。
 */

import fs from 'fs';
import path from 'path';
import { chatCompleteVision, VisionContentPart } from './qwen';

export interface FaceDetectionResult {
  /** 图片在输入数组中的下标 */
  index: number;
  /** 是否检测到人脸 */
  hasFace: boolean;
  /** 人脸区域底部位置占图片高度的比例 (0-1)，用于裁剪。仅 hasFace=true 时有意义 */
  faceBottomRatio: number;
}

const SYSTEM_PROMPT = `你是一个图片内容审核助手，专门检测商品图片中是否包含人类面部（人脸）。

任务：
- 判断每张图片是否包含人类面部/人脸（包括正脸、侧脸、被部分遮挡的脸）
- 如果包含人脸，估算“人脸及周围安全区域”的底部在图片中从上往下的比例位置
- 仅人类面部算，卡通/动漫面部不算

重要：“人脸及周围安全区域”的底部不是仅指下巴，而是包含以下所有区域的最低点：
- 整个头部（包括头发、头顶）
- 面部（眼睛、鼻子、嘴巴、下巴）
- 脖子/颈部区域
- 耳朵下方
例如：如果人物的下巴在图片 20% 的位置，但脖子延伸到了 28%，则 faceBottomRatio 应该填 0.28。

输出要求：
- 严格输出 JSON，不要任何额外解释、不要 Markdown 代码块
- 结构：{"results":[{"index":0,"hasFace":true,"faceBottomRatio":0.30}, ...]}
- index 与输入图片顺序对应（从 0 开始）
- faceBottomRatio：人脸及颈部安全区域底部在整张图片高度中的比例位置（0=图片顶部，1=图片底部）
  - 一定要包含脖子区域，不是仅到下巴！
  - 对于穿衣模特图（电商服装展示），通常人脸+脖子占图片上方 25%-40% 的区域
  - 如果 hasFace=false，填 0
- 宁可高估（多裁一点）也不要低估（裁不干净）`;

/**
 * 将本地图片文件转为 base64 data URI（Qwen-VL 接受的格式）
 */
function imageToDataUri(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  const mime = mimeMap[ext] || 'image/jpeg';
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 批量检测一组商品图片中的人脸。
 * 每次最多 5 张（控制 token 消耗和响应时间）。
 *
 * @param imagePaths 本地图片路径数组
 * @returns 每张图片的人脸检测结果
 */
export async function detectFaces(
  imagePaths: string[]
): Promise<FaceDetectionResult[]> {
  if (imagePaths.length === 0) return [];

  const BATCH = 5;
  const allResults: FaceDetectionResult[] = [];

  for (let start = 0; start < imagePaths.length; start += BATCH) {
    const batch = imagePaths.slice(start, start + BATCH);

    const userContent: VisionContentPart[] = [
      {
        type: 'text',
        text: `下面有 ${batch.length} 张商品图片，请逐张判断是否包含人脸，并给出人脸底部位置比例。`,
      },
    ];

    for (const imgPath of batch) {
      if (!fs.existsSync(imgPath)) {
        console.warn(`[face-detect] 图片不存在，跳过: ${imgPath}`);
        continue;
      }
      try {
        const dataUri = imageToDataUri(imgPath);
        userContent.push({
          type: 'image_url',
          image_url: { url: dataUri },
        });
      } catch (err: any) {
        console.warn(`[face-detect] 读取图片失败: ${imgPath} - ${err.message}`);
      }
    }

    try {
      const raw = await chatCompleteVision(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        { temperature: 0.1, maxTokens: 600 }
      );

      const parsed = parseFaceDetectionJson(raw, batch.length);
      for (const r of parsed) {
        allResults.push({
          index: start + r.index,
          hasFace: r.hasFace,
          faceBottomRatio: r.faceBottomRatio,
        });
      }
    } catch (err: any) {
      console.error(`[face-detect] Qwen-VL 调用失败: ${err.message}`);
      // 调用失败时保守处理：标记为无人脸（不裁剪），让 TikTok 自行判断
      for (let i = 0; i < batch.length; i++) {
        allResults.push({
          index: start + i,
          hasFace: false,
          faceBottomRatio: 0,
        });
      }
    }
  }

  return allResults;
}

/**
 * 解析 Qwen-VL 返回的 JSON 结果
 */
function parseFaceDetectionJson(raw: string, batchSize: number): FaceDetectionResult[] {
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

  if (!obj || !Array.isArray(obj.results)) {
    console.warn('[face-detect] Qwen-VL 返回非 JSON，保守处理:', raw.slice(0, 200));
    return Array.from({ length: batchSize }, (_, i) => ({
      index: i,
      hasFace: false,
      faceBottomRatio: 0,
    }));
  }

  const result: FaceDetectionResult[] = [];
  for (const item of obj.results) {
    const idx = Number(item?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= batchSize) continue;

    const hasFace = !!item?.hasFace;
    let faceBottomRatio = Number(item?.faceBottomRatio) || 0;
    // 约束范围在 0.05 ~ 0.8（不会把整张图裁没了）
    if (hasFace) {
      faceBottomRatio = Math.max(0.05, Math.min(0.8, faceBottomRatio));
    }

    result.push({ index: idx, hasFace, faceBottomRatio });
  }

  // 补齐缺失的 index
  const seen = new Set(result.map((r) => r.index));
  for (let i = 0; i < batchSize; i++) {
    if (!seen.has(i)) {
      result.push({ index: i, hasFace: false, faceBottomRatio: 0 });
    }
  }

  return result.sort((a, b) => a.index - b.index);
}
