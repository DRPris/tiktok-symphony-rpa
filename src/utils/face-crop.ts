/**
 * 商品图片人脸裁剪预处理工具
 *
 * 在上传至 TikTok Seedance 之前，对检测到人脸的图片进行裁剪，
 * 去掉人脸部分（通常在图片顶部），只保留产品主体。
 *
 * 裁剪策略：
 *   - 从人脸底部以下开始保留（加一定 padding 过渡）
 *   - 保留图片宽度不变
 *   - 裁剪后的图片保存为 *_cropped.jpg/webp/png（不覆盖原图）
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { detectFaces, FaceDetectionResult } from '../llm/face-detect-agent';

/** 人脸底部向下留的过渡 padding（占图片高度比例），包含颈部/耳下安全区域 */
const CROP_PADDING_RATIO = 0.10;

/** 对 Qwen-VL 返回的 faceBottomRatio 做额外安全放大系数（应对检测偏保守） */
const FACE_RATIO_SAFETY_MULTIPLIER = 1.20;

/** 裁剪后图片最小高度比例（保留至少 35% 的图片，避免裁太多） */
const MIN_REMAINING_RATIO = 0.35;

export interface FaceCropResult {
  /** 原始图片路径 */
  originalPath: string;
  /** 处理后的图片路径（如未裁剪则与 originalPath 相同） */
  processedPath: string;
  /** 是否进行了裁剪 */
  wasCropped: boolean;
  /** 裁剪信息（仅裁剪时有值） */
  cropInfo?: {
    faceBottomRatio: number;
    originalHeight: number;
    croppedHeight: number;
  };
}

/**
 * 对一组商品图片进行人脸检测与裁剪预处理。
 *
 * 流程：
 * 1. 调用 Qwen-VL 批量检测人脸
 * 2. 对有人脸的图片，使用 sharp 裁剪去掉顶部人脸区域
 * 3. 裁剪后的图片保存为 <原文件名>_cropped.<ext>
 * 4. 返回处理后的路径数组（无人脸的保持原路径）
 *
 * @param imagePaths 本地商品图片路径数组
 * @returns 处理后的图片路径数组（顺序与输入一致）
 */
export async function preprocessProductImages(
  imagePaths: string[]
): Promise<FaceCropResult[]> {
  if (imagePaths.length === 0) return [];

  console.log(`[face-crop] 开始人脸检测预处理，共 ${imagePaths.length} 张图片...`);

  // Step 1: 批量检测人脸
  const detections = await detectFaces(imagePaths);
  const faceCount = detections.filter((d) => d.hasFace).length;
  console.log(`[face-crop] 检测完成: ${faceCount}/${imagePaths.length} 张图片含人脸`);

  if (faceCount === 0) {
    return imagePaths.map((p) => ({
      originalPath: p,
      processedPath: p,
      wasCropped: false,
    }));
  }

  // Step 2: 对有人脸的图片进行裁剪
  const results: FaceCropResult[] = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const imgPath = imagePaths[i];
    const detection = detections.find((d) => d.index === i);

    if (!detection || !detection.hasFace) {
      results.push({
        originalPath: imgPath,
        processedPath: imgPath,
        wasCropped: false,
      });
      continue;
    }

    // 执行裁剪
    try {
      const cropped = await cropFaceFromImage(imgPath, detection);
      results.push(cropped);
    } catch (err: any) {
      console.warn(`[face-crop] 裁剪失败，使用原图: ${imgPath} - ${err.message}`);
      results.push({
        originalPath: imgPath,
        processedPath: imgPath,
        wasCropped: false,
      });
    }
  }

  const croppedCount = results.filter((r) => r.wasCropped).length;
  console.log(`[face-crop] 预处理完成: ${croppedCount} 张图片已裁剪人脸`);

  return results;
}

/**
 * 对单张图片执行人脸裁剪
 */
async function cropFaceFromImage(
  imagePath: string,
  detection: FaceDetectionResult
): Promise<FaceCropResult> {
  const metadata = await sharp(imagePath).metadata();
  const imgWidth = metadata.width || 0;
  const imgHeight = metadata.height || 0;

  if (imgWidth === 0 || imgHeight === 0) {
    throw new Error('无法读取图片尺寸');
  }

  // 对检测到的人脸底部比例做安全放大（Qwen-VL 倾向给出偏保守的下巴位置，
  // 但 TikTok 的人脸检测范围更大，包括脖子、耳下、头发边缘等）
  const adjustedFaceBottom = Math.min(
    detection.faceBottomRatio * FACE_RATIO_SAFETY_MULTIPLIER,
    0.8 // 不超过 80%
  );

  // 计算裁剪起始 Y 坐标（放大后的人脸底部 + padding）
  const cropStartRatio = Math.min(
    adjustedFaceBottom + CROP_PADDING_RATIO,
    1 - MIN_REMAINING_RATIO // 确保至少保留 MIN_REMAINING_RATIO 的高度
  );

  console.log(
    `[face-crop] ${path.basename(imagePath)}: ` +
    `原始faceBottom=${detection.faceBottomRatio.toFixed(2)}, ` +
    `放大后=${adjustedFaceBottom.toFixed(2)}, ` +
    `裁剪起始=${cropStartRatio.toFixed(2)}`
  );
  const cropStartY = Math.round(cropStartRatio * imgHeight);
  const remainingHeight = imgHeight - cropStartY;

  // 如果剩余高度太小，不裁剪
  if (remainingHeight < imgHeight * MIN_REMAINING_RATIO) {
    console.log(
      `[face-crop] 图片 ${path.basename(imagePath)} 裁剪后剩余太小 (${remainingHeight}px / ${imgHeight}px)，跳过裁剪`
    );
    return {
      originalPath: imagePath,
      processedPath: imagePath,
      wasCropped: false,
    };
  }

  // 生成裁剪后的文件路径
  const ext = path.extname(imagePath);
  const baseName = path.basename(imagePath, ext);
  const dir = path.dirname(imagePath);
  const croppedPath = path.join(dir, `${baseName}_cropped${ext}`);

  // 执行裁剪：保留从 cropStartY 到图片底部的区域
  await sharp(imagePath)
    .extract({
      left: 0,
      top: cropStartY,
      width: imgWidth,
      height: remainingHeight,
    })
    .toFile(croppedPath);

  console.log(
    `[face-crop] ✅ ${path.basename(imagePath)} → ${path.basename(croppedPath)} ` +
    `(裁掉顶部 ${Math.round(cropStartRatio * 100)}%, 剩余 ${remainingHeight}x${imgWidth}px)`
  );

  return {
    originalPath: imagePath,
    processedPath: croppedPath,
    wasCropped: true,
    cropInfo: {
      faceBottomRatio: detection.faceBottomRatio,
      originalHeight: imgHeight,
      croppedHeight: remainingHeight,
    },
  };
}

/**
 * 便捷函数：对图片路径数组进行人脸裁剪预处理，返回处理后的路径数组。
 * 用于在上传前直接替换 imagePaths。
 */
export async function getProcessedImagePaths(
  imagePaths: string[]
): Promise<string[]> {
  const results = await preprocessProductImages(imagePaths);
  return results.map((r) => r.processedPath);
}
