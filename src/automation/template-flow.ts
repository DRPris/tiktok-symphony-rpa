import { Page } from 'playwright';
import { VideoTask, TaskTimestamps } from '../types';
import { config } from '../config';
import { SELECTORS } from './selectors';
import {
  inputPromptAndSend,
  uploadProductImages,
  waitForAIResponse,
  confirmBrief,
  confirmStoryboard,
} from './shared-steps';
import {
  waitAndClick,
  scrollDown,
  delay,
  retry,
  waitForNavigation,
} from '../browser/helpers';
import { detectCountry } from '../utils/country-detect';

/**
 * 在 [min, max] 区间随机延迟，模拟人类操作节奏
 */
function humanDelay(min = 1000, max = 3000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return delay(ms);
}

/**
 * Prompt 模板变量替换
 * 支持 {{productName}} / {{audience}} / {{sellingPoints}} / {{country}} / {{persona}} / {{videoLanguage}} 占位符
 */
function resolvePromptTemplate(
  prompt: string,
  vars: Record<string, string | undefined>,
): { resolved: string; isTemplate: boolean } {
  const HAS_VAR = /\{\{\w+\}\}/;
  if (!HAS_VAR.test(prompt)) return { resolved: prompt, isTemplate: false };

  const resolved = prompt.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const val = vars[key];
    return val?.trim() || '';
  });
  return { resolved: resolved.replace(/\n{3,}/g, '\n\n').trim(), isTemplate: true };
}

/**
 * 构建发送给 AI 的完整 prompt
 * - 模板模式：prompt 含 {{productName}} / {{audience}} / {{sellingPoints}} / {{country}} / {{persona}} / {{videoLanguage}} 时执行变量替换
 * - 拼接模式（向后兼容）：prompt 不含模板变量时，按结构化字段追加
 * - 安全兆底：若 videoLanguage/country/persona 为空但 productUrl 可用，自动检测国家
 */
function buildPrompt(task: VideoTask): string {
  let { prompt, productName, sellingPoints, audience, country, persona, videoLanguage } = task.input;

  // 兆底：若前端未传入 country/persona/videoLanguage，从 productUrl 自动检测
  if ((!videoLanguage || !persona) && task.input.productUrl) {
    const profile = detectCountry(task.input.productUrl);
    if (profile) {
      if (!country) country = profile.country;
      if (!persona) persona = profile.persona;
      if (!videoLanguage) videoLanguage = profile.videoLanguage;
      console.log(`[buildPrompt/template] 自动检测国家: ${profile.country}, 语言: ${profile.videoLanguage}`);
    }
  }
  if (!videoLanguage) videoLanguage = 'English';

  // 尝试模板替换
  const { resolved, isTemplate } = resolvePromptTemplate(prompt || '', {
    productName,
    audience,
    sellingPoints,
    country,
    persona,
    videoLanguage,
  });
  if (isTemplate) return resolved;

  // 拼接模式（向后兼容）
  const parts: string[] = [];
  if (prompt && prompt.trim().length > 0) {
    parts.push(prompt.trim());
  }
  if (productName && productName.trim().length > 0) {
    parts.push(`Product: ${productName.trim()}`);
  }
  if (audience && audience.trim().length > 0) {
    parts.push(`Target Audience: ${audience.trim()}`);
  }
  if (sellingPoints && sellingPoints.trim().length > 0) {
    parts.push(`Key Selling Points: ${sellingPoints.trim()}`);
  }
  if (persona && persona.trim().length > 0) {
    parts.push(`Video Persona: ${persona.trim()}`);
  }
  if (videoLanguage && videoLanguage.trim().length > 0) {
    parts.push(`Video Language: ${videoLanguage.trim()}`);
  }
  if (country && country.trim().length > 0) {
    parts.push(`Target Market: ${country.trim()}`);
  }
  return parts.join('\n');
}

/**
 * Step 1: 导航到视频生成页面
 * 有商品图片时直接去 imageToVideo，否则去主页(create)
 */
/**
 * 关闭 reactour 新手引导蒙版
 * 该蒙版会拦截点击事件，必须先处理
 * 策略：
 * 1. 尝试点击 "Skip" / "Close" / "Got it" / "Don't show again" 按钮
 * 2. 如果找不到，使用 CSS 隐藏 + pointer-events:none
 *    ⚠️ 不能用 element.remove() 删 DOM 节点，否则 React 内部引用会造成
 *    "Failed to execute 'removeChild' on 'Node'" 错误，导致页面崩溃
 */
async function dismissReactourTour(page: Page): Promise<void> {
  const removed = await page.evaluate(() => {
    const tour = document.querySelector('#___reactour') as HTMLElement | null;
    if (!tour) return { had: false };
    // 尝试点击关闭按钮
    const btns = Array.from(tour.querySelectorAll('button')) as HTMLButtonElement[];
    const closeKeywords = ['skip', 'close', 'got it', "don't show", 'finish', 'dismiss', '跳过', '关闭'];
    for (const btn of btns) {
      const text = (btn.textContent || '').toLowerCase().trim();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (closeKeywords.some(kw => text.includes(kw) || aria.includes(kw))) {
        btn.click();
        return { had: true, action: 'clicked', text };
      }
    }
    // 点不到就用 CSS 隐藏（不能 remove DOM 节点，React 依赖它！）
    tour.style.display = 'none';
    tour.style.pointerEvents = 'none';
    tour.style.visibility = 'hidden';
    // 同样用 CSS 隐藏其他蒙版类元素
    document.querySelectorAll('[class*="reactour"], [class*="tour-mask"]').forEach(el => {
      const e = el as HTMLElement;
      e.style.display = 'none';
      e.style.pointerEvents = 'none';
    });
    return { had: true, action: 'css-hidden' };
  });
  if (removed.had) {
    console.log(`[template-flow] dismissReactourTour: 新手引导已处理 (${removed.action})`);
    await delay(500);
  }
}

async function navigateToCreator(page: Page, hasImages: boolean): Promise<void> {
  // 统一使用 Agent/Chat 模式入口，每次打开新对话
  const targetUrl = config.urls.agentMode || config.urls.home;
  console.log(`[template-flow] Step 1: 导航到 Agent/Chat 页面 (hasImages=${hasImages})...`);
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.browser.navigationTimeout,
  });

  // 等待页面加载
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    console.warn('[template-flow] Step 1: 等待 networkidle 超时，继续执行');
  }

  // 给页面 JS 渲染预留时间（新版 React SPA 需要渲染对话 UI）
  await delay(3000);

  // 尝试关闭弹窗（如果存在）
  try {
    const closeBtn = await page.$(SELECTORS.home.modalCloseButton);
    if (closeBtn) {
      console.log('[template-flow] Step 1: 检测到弹窗，关闭...');
      await closeBtn.click();
      await delay(1000);
    }
  } catch {
    // 忽略
  }

  // 关闭新手引导蒙版 (reactour) —— 它会拦截鼠标事件
  await dismissReactourTour(page);

  // 等待 AI 聊天输入框出现（全页面限定为 30s，隔 2s 轮询一次，遵循 SPA 渲染特点）
  let inputFound = false;
  for (let i = 0; i < 15; i++) {
    const inputEl = await page.$(SELECTORS.common.chatInput);
    if (inputEl) {
      const visible = await inputEl.isVisible().catch(() => false);
      if (visible) {
        inputFound = true;
        break;
      }
    }
    await delay(2000);
  }

  if (inputFound) {
    console.log(`[template-flow] Step 1: 对话界面就绪, URL=${page.url()}`);
  } else {
    console.warn(`[template-flow] Step 1: 未检测到对话输入框, URL=${page.url()}`);
    // 保存调试截图
    try {
      const fs = await import('fs');
      const path = await import('path');
      const screenshotDir = path.resolve('logs');
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const screenshotPath = path.join(screenshotDir, `nav-failed-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.warn(`[template-flow] Step 1: 调试截图已保存: ${screenshotPath}`);
      // 输出页面 HTML 结构概要
      const summary = await page.evaluate(() => ({
        title: document.title,
        bodyText: (document.body.innerText || '').substring(0, 500),
        buttonCount: document.querySelectorAll('button').length,
        inputCount: document.querySelectorAll('input').length,
        textareaCount: document.querySelectorAll('textarea').length,
        contenteditableCount: document.querySelectorAll('[contenteditable="true"]').length,
        proseMirrorCount: document.querySelectorAll('.ProseMirror').length,
      }));
      console.warn(`[template-flow] Step 1: 页面概要 = ${JSON.stringify(summary)}`);
    } catch (e) {
      console.warn('[template-flow] Step 1: 截图失败:', (e as Error).message);
    }
  }
}

/**
 * Step 2: 选择视频生成类型
 * 有商品图片时选 "Image to video"，否则选 "Text to video"
 */
async function selectGenerationType(page: Page, hasImages: boolean): Promise<void> {
  const targetType = hasImages ? 'Image to video' : 'Text to video';
  const targetSelector = hasImages ? SELECTORS.home.imageToVideo : SELECTORS.home.textToVideo;
  console.log(`[template-flow] Step 2: 选择生成类型: ${targetType}...`);

  // 先尝试点击 "Try now" 按钮进入工具
  try {
    const tryNow = await page.$(SELECTORS.home.tryNowButton);
    if (tryNow) {
      console.log('[template-flow] Step 2: 点击 "Try now" 按钮...');
      await humanDelay(500, 1200);
      await tryNow.click();
      await delay(3000);
      // 检查是否已进入对话界面
      const chatInput = await page.$(SELECTORS.common.chatInput);
      if (chatInput) {
        console.log('[template-flow] Step 2: 已通过 "Try now" 进入对话界面');
        return;
      }
    }
  } catch {
    console.log('[template-flow] Step 2: "Try now" 未找到或点击失败，尝试选择具体类型');
  }

  // 尝试点击具体的生成类型按钮
  try {
    await page.click(targetSelector, { timeout: 10000 });
    console.log(`[template-flow] Step 2: 已点击 "${targetType}"`);
    await delay(3000);
  } catch {
    console.log(`[template-flow] Step 2: 未找到 "${targetType}" 按钮，尝试滚动查找`);
    // 向下滚动再试
    await scrollDown(page, 600);
    await delay(1000);
    await page.click(targetSelector, { timeout: 10000 });
    await delay(3000);
  }

  // 等待进入对话/编辑界面
  try {
    await page.waitForSelector(SELECTORS.common.chatInput, {
      state: 'visible',
      timeout: config.browser.defaultTimeout,
    });
    console.log(`[template-flow] Step 2: 已进入对话界面, URL=${page.url()}`);
  } catch {
    console.log(`[template-flow] Step 2: 未检测到对话输入框，继续执行并观察页面状态 URL=${page.url()}`);
  }
}

/**
 * 主流程：执行基于模板的视频生成
 */
export async function executeTemplateFlow(
  page: Page,
  task: VideoTask
): Promise<{ success: boolean; pageUrl?: string }> {
  console.log(`[template-flow] ====== 开始执行模板流程 (taskId=${task.id}) ======`);

  try {
    // Step 1: 导航到视频生成页面
    const hasImages = !!(task.input.productImages && task.input.productImages.length > 0);
    await retry(() => navigateToCreator(page, hasImages), 2, 2000);
    await humanDelay();

    // ---- 初始化时间戳对象 ----
    const ts: TaskTimestamps = task.timestamps || {};

    // Step 4: 上传商品图片（如果有）
    if (task.input.productImages && task.input.productImages.length > 0) {
      console.log(`[template-flow] Step 4: 上传 ${task.input.productImages.length} 张商品图片...`);
      ts.uploadStart = new Date().toISOString();
      console.log(`[template-flow] ⏱ 时间戳 uploadStart: ${ts.uploadStart}`);
      await retry(
        () => uploadProductImages(page, task.input.productImages as string[]),
        2,
        2000
      );
      ts.uploadEnd = new Date().toISOString();
      console.log(`[template-flow] ⏱ 时间戳 uploadEnd: ${ts.uploadEnd}`);
      await humanDelay();
      console.log('[template-flow] Step 4: 商品图片上传完成');
    } else {
      console.log('[template-flow] Step 4: 无商品图片，跳过上传');
    }

    // Step 5: 构建并输入 Prompt
    const combinedPrompt = buildPrompt(task);
    console.log(`[template-flow] Step 5: 输入 Prompt (${combinedPrompt.length} 字符)...`);
    await retry(() => inputPromptAndSend(page, combinedPrompt), 2, 2000);
    ts.promptSent = new Date().toISOString();
    console.log(`[template-flow] ⏱ 时间戳 promptSent: ${ts.promptSent}`);
    await humanDelay();
    console.log('[template-flow] Step 5: Prompt 已发送');

    // Step 6: 等待 AI 响应
    console.log('[template-flow] Step 6: 等待 AI 响应（最长 3 分钟）...');
    const aiResponse = await waitForAIResponse(page, 180_000);
    ts.briefReady = new Date().toISOString();
    console.log(`[template-flow] ⏱ 时间戳 briefReady: ${ts.briefReady}`);
    console.log(`[template-flow] Step 6: AI 已响应 (前 100 字): ${aiResponse.slice(0, 100)}`);
    await humanDelay();

    // Step 7: 检查并确认 Brief
    let needBriefConfirm = false;
    try {
      await confirmBrief(page);
      needBriefConfirm = true;
      ts.briefConfirmed = new Date().toISOString();
      console.log(`[template-flow] ⏱ 时间戳 briefConfirmed: ${ts.briefConfirmed}`);
    } catch (e) {
      console.log(`[template-flow] Step 7: confirmBrief 未生效 (${(e as Error).message.substring(0, 80)})，按直接生成模式继续`);
    }

    if (needBriefConfirm) {
      console.log('[template-flow] Step 7: Brief 已确认，等待分镜生成');
      await humanDelay();

      // Step 8: 等待分镜生成并确认
      console.log('[template-flow] Step 8: 等待分镜生成并确认（最长 150s）...');
      await retry(() => confirmStoryboard(page), 2, 2000);
      ts.storyboardConfirmed = new Date().toISOString();
      console.log(`[template-flow] ⏱ 时间戳 storyboardConfirmed: ${ts.storyboardConfirmed}`);
      await humanDelay();
      console.log('[template-flow] Step 8: 分镜已确认');
    } else {
      console.log('[template-flow] Step 7: 未检测到 Brief 流程（image-to-video 模式），跳过确认步骤');
    }

    // Step 9: 记录页面 URL
    ts.generationStarted = new Date().toISOString();
    console.log(`[template-flow] ⏱ 时间戳 generationStarted: ${ts.generationStarted}`);
    task.timestamps = ts;

    const currentUrl = page.url();
    console.log(`[template-flow] Step 9: 进入视频生成等待阶段, URL=${currentUrl}`);
    console.log(`[template-flow] ====== 模板流程执行成功 (taskId=${task.id}) ======`);

    return { success: true, pageUrl: currentUrl };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[template-flow] ====== 模板流程执行失败 (taskId=${task.id}): ${message} ======`);
    // NEEDS_MANUAL 必须保留原 error 实例上抛，避免被退化为普通失败、走错重试分支
    if ((err as any)?.code === 'NEEDS_MANUAL' || (err as any)?.name === 'NeedsManualError') {
      throw err;
    }
    return { success: false };
  }
}
