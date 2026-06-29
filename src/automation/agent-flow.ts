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
  pushPendingUserInputs,
  removeOverlays,
  startNewChat,
  checkVideoGenerationStatus,
} from './shared-steps';
import { delay, retry, navigateWithRetry } from '../browser/helpers';
import { NeedsManualError } from './errors';
import { takeStepScreenshot, takeDebugScreenshot, cleanOldScreenshots } from './screenshot-monitor';
import { getProcessedImagePaths } from '../utils/face-crop';
import { detectCountry } from '../utils/country-detect';

/**
 * 随机延迟（1-3 秒），模拟人类操作节奏
 */
function randomDelay(min = 1000, max = 3000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return delay(ms);
}

/**
 * Prompt 模板变量替换
 * 支持 {{productName}} / {{audience}} / {{sellingPoints}} / {{country}} / {{persona}} / {{videoLanguage}} 占位符
 * 若 prompt 中包含 {{...}}，执行变量替换并返回；否则回退到拼接模式
 */
function resolvePromptTemplate(
  prompt: string,
  vars: Record<string, string | undefined>,
): { resolved: string; isTemplate: boolean } {
  const HAS_VAR = /\{\{\w+\}\}/;
  if (!HAS_VAR.test(prompt)) return { resolved: prompt, isTemplate: false };

  const resolved = prompt.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const val = vars[key];
    // 有值则替换，无值则移除占位符（避免 prompt 出现原始 {{xxx}}）
    return val?.trim() || '';
  });
  // 清理连续空行
  return { resolved: resolved.replace(/\n{3,}/g, '\n\n').trim(), isTemplate: true };
}

/**
 * 构建完整的 Prompt
 * - 模板模式：prompt 含 {{productName}} / {{audience}} / {{sellingPoints}} / {{country}} / {{persona}} / {{videoLanguage}} 时执行变量替换
 * - 拼接模式（向后兼容）：prompt 不含模板变量时，按结构化字段追加
 * - 安全兆底：若 videoLanguage/country/persona 为空但 productUrl 可用，自动从 URL 检测国家并填充
 */
function buildCombinedPrompt(task: VideoTask): string {
  let { prompt, productName, audience, sellingPoints, country, persona, videoLanguage } = task.input;

  // 兆底：若前端未传入 country/persona/videoLanguage，从 productUrl 自动检测
  if ((!videoLanguage || !persona) && task.input.productUrl) {
    const profile = detectCountry(task.input.productUrl);
    if (profile) {
      if (!country) country = profile.country;
      if (!persona) persona = profile.persona;
      if (!videoLanguage) videoLanguage = profile.videoLanguage;
      console.log(`[buildCombinedPrompt] 自动检测国家: ${profile.country}, 语言: ${profile.videoLanguage}`);
    }
  }
  // 最终兆底：若仍无法识别，默认 English
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
  if (prompt) {
    parts.push(prompt);
  }
  if (productName) {
    parts.push(`Product: ${productName}`);
  }
  if (audience) {
    parts.push(`Target Audience: ${audience}`);
  }
  if (sellingPoints) {
    parts.push(`Key Selling Points: ${sellingPoints}`);
  }
  if (persona) {
    parts.push(`Video Persona: ${persona}`);
  }
  if (videoLanguage) {
    parts.push(`Video Language: ${videoLanguage}`);
  }
  if (country) {
    parts.push(`Target Market: ${country}`);
  }
  return parts.join('\n');
}

/**
 * 确保聊天模式切换到 "TikTok Symphony"(formerly "TikTok trend")。
 * /create 页面顶部的两个 toggle 按钮（chatbox-setting-btn）：
 *   - TikTok Symphony (formerly "TikTok trend")
 *   - Dreamina Seedance 2.0
 * 默认通常是 TikTok Symphony，但仍点击一次以确保状态正确。
 * 失败不抛错（仅警告）。
 */
async function ensureTikTokTrendMode(page: Page): Promise<void> {
  try {
    await removeOverlays(page);

    // 策略 1: 直接查找并点击 TikTok Symphony / TikTok trend 按钮
    const sel = SELECTORS.agent.tiktokTrendButton;
    const btn = await page.waitForSelector(sel, { timeout: 8000, state: 'visible' });
    if (btn) {
      await btn.click({ force: true }).catch(() => {});
      console.log('[agent-flow] ensureTikTokTrendMode: 已点击 TikTok Symphony/trend 模式按钮');
      await randomDelay(800, 1500);
      return;
    }
  } catch {
    // 策略 2: 检测 Dreamina 下拉器并点击切换（2026-06 新版：显示为下拉选择器）
    try {
      const dreaminaBtn = await page.$(SELECTORS.agent.dreaminaButton);
      if (dreaminaBtn) {
        const isVisible = await dreaminaBtn.isVisible().catch(() => false);
        if (isVisible) {
          console.log('[agent-flow] ensureTikTokTrendMode: 检测到 Dreamina 下拉器，点击展开...');
          await dreaminaBtn.click({ force: true });
          await randomDelay(800, 1200);
          // 下拉展开后，在列表中查找 TikTok Symphony 选项
          try {
            const symphonyOption = await page.waitForSelector(
              '[role="option"]:has-text("TikTok Symphony"), [role="option"]:has-text("Symphony"), ' +
              '[class*="dropdown-item"]:has-text("TikTok Symphony"), [class*="menu-item"]:has-text("TikTok Symphony"), ' +
              '[class*="option"]:has-text("TikTok Symphony"), li:has-text("TikTok Symphony")',
              { timeout: 5000, state: 'visible' }
            );
            if (symphonyOption) {
              await symphonyOption.click({ force: true });
              console.log('[agent-flow] ensureTikTokTrendMode: ✅ 已从下拉列表切换到 TikTok Symphony');
              await randomDelay(800, 1500);
              return;
            }
          } catch {
            console.warn('[agent-flow] ensureTikTokTrendMode: 下拉展开后未找到 TikTok Symphony 选项');
            // 尝试 DOM 搜索方式
            const switched = await page.evaluate(() => {
              const items = document.querySelectorAll('[role="option"], [class*="dropdown"] *, [class*="menu"] li, [class*="popover"] *');
              for (const item of items) {
                const text = (item.textContent || '').trim();
                if (text.includes('TikTok Symphony') || text.includes('Symphony') ||
                    (text.includes('TikTok') && !text.includes('Dreamina'))) {
                  (item as HTMLElement).click();
                  return { clicked: true, text };
                }
              }
              return { clicked: false };
            });
            if (switched.clicked) {
              console.log(`[agent-flow] ensureTikTokTrendMode: ✅ DOM 搜索切换到 "${(switched as any).text}"`);
              await randomDelay(800, 1500);
              return;
            }
          }
        }
      }
    } catch {}
    console.warn(
      `[agent-flow] ensureTikTokTrendMode: 未找到模式切换按钮（可能已默认选中或页面结构变更），继续执行`,
    );
  }
}

/**
 * 2026-06 改版适配：尝试进入 Agent 模式
 * 策略优先级：
 *   1) 点击内容区 Agent Tab（最可靠，/create 页面已默认展示 Agent/Video/Image tabs）
 *   2) DOM 搜索点击 "Agent" 文本元素（兆底）
 *   3) 侧边栏 Agent 导航项（最后兆底，因侧边栏偶尔不显示 Agent 入口）
 * 返回 true 表示成功进入（chatInput 已出现）
 */
async function enterAgentMode(page: Page): Promise<boolean> {
  console.log('[agent-flow] enterAgentMode: 尝试进入 Agent 模式...');
  await removeOverlays(page);

  // 策略 1（优先）：点击内容区 Agent 标签页 tab
  // Home 页面（/create）已默认展示 Agent | Video | Image tabs
  try {
    const agentTab = await page.$(SELECTORS.agent.agentTab);
    if (agentTab) {
      const isVisible = await agentTab.isVisible().catch(() => false);
      if (isVisible) {
        console.log('[agent-flow] enterAgentMode: 找到 Agent 标签页，点击...');
        await agentTab.click({ force: true });
        await randomDelay(1500, 2500);
        try {
          await page.waitForSelector(SELECTORS.common.chatInput, {
            timeout: 10000,
            state: 'visible',
          });
          console.log('[agent-flow] enterAgentMode: ✅ 通过 Agent Tab 成功进入 Agent 模式');
          return true;
        } catch {
          console.warn('[agent-flow] enterAgentMode: Agent Tab 点击后 chatInput 仍未出现');
        }
      }
    }
  } catch (e: any) {
    console.warn(`[agent-flow] enterAgentMode: Tab策略异常: ${e.message?.substring(0, 100)}`);
  }

  // 策略 2：通过 page.evaluate 在 DOM 中搜索并点击 "Agent" 文本元素（tab 或导航）
  try {
    const clicked = await page.evaluate(() => {
      // 在页面中查找 "Agent" 文本（优先匹配 tab/导航类元素）
      // ⚠️ 排除 nav * 避免误匹配顶部全局工具栏（global_toolbar）导致跳转到 business.tiktok.com/select
      const candidates = document.querySelectorAll('a, button, [role="tab"], [role="menuitem"], [class*="tab"]');
      for (const el of candidates) {
        const text = (el.textContent || '').trim();
        if (text === 'Agent' || text === 'agent') {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          // 确保是可见的小元素（tab/导航项，而非大容器）
          // 过滤掉顶部全局工具栏区域（top < 60px）避免误触账户切换器
          if (rect.width > 0 && rect.height > 0 && rect.width < 200 && rect.top > 60) {
            htmlEl.click();
            return { clicked: true, tag: htmlEl.tagName, text, top: Math.round(rect.top) };
          }
        }
      }
      return { clicked: false };
    });
    if (clicked.clicked) {
      console.log(`[agent-flow] enterAgentMode: 通过 DOM 搜索点击了 <${(clicked as any).tag}> Agent`);
      await randomDelay(2000, 3000);
      try {
        await page.waitForSelector(SELECTORS.common.chatInput, {
          timeout: 10000,
          state: 'visible',
        });
        console.log('[agent-flow] enterAgentMode: ✅ 通过 DOM 搜索成功进入 Agent 模式');
        return true;
      } catch {}
    }
  } catch (e: any) {
    console.warn(`[agent-flow] enterAgentMode: DOM搜索策略异常: ${e.message?.substring(0, 100)}`);
  }

  // 策略 3（最后兆底）：点击侧边栏 "Agent" 导航项（侧边栏偶尔不显示 Agent 入口）
  try {
    const sidebarAgent = await page.$(SELECTORS.agent.sidebarAgentNav);
    if (sidebarAgent) {
      const isVisible = await sidebarAgent.isVisible().catch(() => false);
      if (isVisible) {
        // ⚠️ 位置过滤：排除顶部全局工具栏区域（rect.top <= 100）避免误触 global_toolbar
        const box = await sidebarAgent.boundingBox();
        if (!box || box.y <= 100) {
          console.warn(`[agent-flow] enterAgentMode: 侧边栏 Agent 元素位于顶部工具栏区域 (y=${box?.y})，跳过以避免误触 global_toolbar`);
        } else {
          console.log('[agent-flow] enterAgentMode: 找到侧边栏 Agent 导航项，点击...');
          await sidebarAgent.click({ force: true });
          await randomDelay(2000, 3000);
          try {
            await page.waitForLoadState('networkidle', { timeout: 10000 });
          } catch {}
          try {
            await page.waitForSelector(SELECTORS.common.chatInput, {
              timeout: 15000,
              state: 'visible',
            });
            console.log('[agent-flow] enterAgentMode: ✅ 通过侧边栏成功进入 Agent 模式');
            return true;
          } catch {
            console.warn('[agent-flow] enterAgentMode: 侧边栏点击后 chatInput 仍未出现');
          }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[agent-flow] enterAgentMode: 侧边栏策略异常: ${e.message?.substring(0, 100)}`);
  }

  console.warn('[agent-flow] enterAgentMode: 所有策略均未能成功进入 Agent 模式');
  return false;
}

/**
 * Agent 模式视频生成流程（/chat chatbot 范式）
 *
 * 完整流程：
 *   1) 进入 /chat 页面
 *   2) 确保模式 = TikTok trend
 *   3) 上传商品图片（如果有）
 *   4) 输入 Prompt 并发送
 *   5) 等待 AI 生成 Brief
 *   6) 确认 Brief
 *   7) 等待分镜（Storyboard）生成
 *   8) 确认分镜并进入视频生成
 */
export async function executeAgentFlow(
  page: Page,
  task: VideoTask,
  opts?: { onChatUrlCaptured?: (chatUrl: string) => void },
): Promise<{ success: boolean; pageUrl?: string }> {
  console.log(
    `[agent-flow] ============ 开始执行 Agent 模式流程 (taskId=${task.id}) ============`,
  );

  // 清理超过 3 天的旧截图
  cleanOldScreenshots(3);

  // ============ 重试复用逻辑 ============
  // 如果任务已经有 chatUrl（上次执行已成功发送了 Prompt），
  // 导航到该对话页面，检查当前状态：
  // - 视频已生成完成 → 直接进入 waiting-generation（轮询器会检测到 ready）
  // - 视频正在生成 → 进入 waiting-generation
  // - 页面处于中间状态（Pending user inputs）→ 尝试推进流程后进入 waiting-generation
  // - 页面报错 → 返回失败，让任务重试
  if (task.chatUrl && /\/chat\/\d+/.test(task.chatUrl)) {
    console.log(
      `[agent-flow] 检测到已有 chatUrl=${task.chatUrl}，导航到该页面检查状态`,
    );
    try {
      await navigateWithRetry(page, task.chatUrl, {
        timeout: config.browser.navigationTimeout,
        waitUntil: 'domcontentloaded',
      });
      try {
        await page.waitForSelector('#root > *', { timeout: 20000 });
      } catch {
        console.warn('[agent-flow] 复用 chatUrl: React 未挂载 (20s 超时)，继续检查');
      }
      await new Promise(r => setTimeout(r, 5000)); // 等 SPA 渲染

      const status = await checkVideoGenerationStatus(page);
      console.log(`[agent-flow] 复用 chatUrl 状态: ${status.status} (${status.detail || ''})`);

      if (status.status === 'ready' || status.status === 'generating') {
        // 视频已就绪或正在生成 → 直接进入 waiting-generation
        return { success: true, pageUrl: task.chatUrl };
      }

      if (status.status === 'error') {
        // 页面报错 → 返回失败
        console.warn(`[agent-flow] 复用 chatUrl 检测到错误: ${status.detail}`);
        return { success: false };
      }

      // status === 'loading' → 页面可能在中间状态，尝试推进流程
      console.log('[agent-flow] 复用 chatUrl: 页面处于中间状态，尝试推进流程...');
      try {
        await pushPendingUserInputs(page, 3);
      } catch (e: any) {
        console.warn(`[agent-flow] 推进流程异常: ${e.message}`);
      }
      // 推进后再次检查
      const status2 = await checkVideoGenerationStatus(page);
      console.log(`[agent-flow] 推进后状态: ${status2.status} (${status2.detail || ''})`);

      if (status2.status === 'error') {
        return { success: false };
      }
      // 无论 ready/generating/loading 都进入 waiting-generation，让轮询器继续监控
      return { success: true, pageUrl: task.chatUrl };
    } catch (err: any) {
      console.error(`[agent-flow] 复用 chatUrl 导航失败: ${err.message}`);
      // 导航失败 → 清除 chatUrl，走完整流程创建新对话
      console.log('[agent-flow] 清除旧 chatUrl，走完整流程创建新对话');
      task.chatUrl = undefined;
    }
  }

  try {
    // ---------------- Step 1: 进入 Agent 模式页面 ----------------
    console.log(`[agent-flow] Step 1: 导航到 ${config.urls.agentMode}`);
    await navigateWithRetry(page, config.urls.agentMode, {
      timeout: config.browser.navigationTimeout,
      waitUntil: 'commit',
    });
    // 等待页面核心元素出现（比 networkidle 更可靠）
    try {
      await page.waitForSelector('#root > *', { timeout: 20000 });
    } catch {
      console.warn('[agent-flow] Step 1: #root 元素等待超时，继续执行');
    }

    // 2026-06 改版适配：/create 默认停留在 Inspire 页面（也有 chatInput），
    // 必须 **始终** 点击 Agent Tab 切换到 Agent 模式，不能仅靠 chatInput 判断。
    // 先短暂等待页面就绪
    await randomDelay(1500, 2500);

    // 检查当前是否已在 Agent 模式（URL 含 /agent 或 /chat）
    const currentUrl = page.url();
    const isAlreadyAgent = currentUrl.includes('/agent') || currentUrl.includes('/chat');
    let chatInputReady = false;

    if (!isAlreadyAgent) {
      console.log('[agent-flow] Step 1: 当前在 Inspire/Home 页面，需要切换到 Agent 模式...');
      chatInputReady = await enterAgentMode(page);
    } else {
      console.log('[agent-flow] Step 1: URL 表明已在 Agent 模式');
      chatInputReady = true;
    }

    // 如果 enterAgentMode 成功但 chatInput 还没出现，再等一下
    if (chatInputReady) {
      try {
        await page.waitForSelector(SELECTORS.common.chatInput, {
          timeout: 10000,
          state: 'visible',
        });
      } catch {
        console.warn('[agent-flow] Step 1: 进入 Agent 模式后 chatInput 仍未出现，可能需要额外等待');
      }
    }

    if (!chatInputReady) {
      // 最终兜底：再尝试一次 enterAgentMode + 等待
      console.warn('[agent-flow] Step 1: 首次 enterAgentMode 失败，最终兜底尝试...');
      chatInputReady = await enterAgentMode(page);
      if (!chatInputReady) {
        try {
          await page.waitForSelector(SELECTORS.common.chatInput, {
            timeout: 15000,
            state: 'visible',
          });
          chatInputReady = true;
        } catch {
          console.error('[agent-flow] Step 1: ❗ 无法进入 Agent 模式，chatInput 始终未出现');
          try {
            const fs = await import('fs');
            const path = await import('path');
            const screenshotPath = path.join('logs', `agent-mode-failed-${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: false });
            console.error(`[agent-flow] Step 1: 调试截图已保存: ${screenshotPath}`);
          } catch {}
          throw new NeedsManualError('Agent 模式进入失败：chatInput 未出现，可能页面结构变更', {
            stage: 'enterAgentMode',
            url: page.url(),
          });
        }
      }
    }

    console.log(`[agent-flow] Step 1: 页面加载完成, URL=${page.url()}`);
    await takeStepScreenshot(page, 'step1-agent-ready', task.id);
    await randomDelay(1500, 2500);
    await removeOverlays(page);

    // ---------------- Step 1.5: 创建新对话（避免复用其他任务的聊天窗口） ----------------
    console.log('[agent-flow] Step 1.5: 点击 "+ Start new chat" 创建新会话...');
    await startNewChat(page);
    await randomDelay(1000, 2000);

    // 验证：确保不在旧对话中（检查页面是否有已有的 AI 回复内容）
    const hasExistingChat = await page.evaluate(() => {
      const body = document.body.innerText || '';
      // 如果页面已有 Product Brief 或 AI 回复的内容，说明在旧对话中
      return body.includes('Product Brief') || body.includes('Product brief') ||
             body.includes("I've created") || body.includes('Your video is ready');
    });
    if (hasExistingChat) {
      console.warn('[agent-flow] Step 1.5: 检测到已有对话内容，强制刷新页面创建新会话...');
      // 导航到 /create 并重新进入 Agent 模式
      await navigateWithRetry(page, config.urls.agentMode, { waitUntil: 'commit', timeout: config.browser.navigationTimeout });
      await randomDelay(2000, 3000);
      await enterAgentMode(page);
      await randomDelay(1500, 2500);
      // 再试一次 startNewChat
      await startNewChat(page);
      await randomDelay(1000, 1500);
    }

    // ---------------- Step 2: 确保 TikTok trend 模式 ----------------
    console.log('[agent-flow] Step 2: 确保对话模式为 TikTok trend');
    await ensureTikTokTrendMode(page);

    // ---- 初始化时间戳对象 ----
    const ts: TaskTimestamps = task.timestamps || {};

    // ---------------- Step 3: 上传商品图片（含人脸预处理） ----------------
    if (task.input.productImages && task.input.productImages.length > 0) {
      console.log(
        `[agent-flow] Step 3: 上传商品图片 (${task.input.productImages.length} 张)`,
      );

      // Step 3a: 人脸检测与裁剪预处理
      let imagesToUpload = task.input.productImages!;
      try {
        console.log('[agent-flow] Step 3a: 人脸检测预处理...');
        imagesToUpload = await getProcessedImagePaths(task.input.productImages!);
        console.log(`[agent-flow] Step 3a: 预处理完成，${imagesToUpload.length} 张图片就绪`);
      } catch (err: any) {
        console.warn(`[agent-flow] Step 3a: 人脸预处理失败，使用原图继续: ${err.message}`);
      }

      // Step 3b: 执行上传
      ts.uploadStart = new Date().toISOString();
      console.log(`[agent-flow] ⏱ 时间戳 uploadStart: ${ts.uploadStart}`);
      // 截图：点击 "+" 按钮前的页面状态（调试用）
      await takeDebugScreenshot(page, 'step3-before-upload', task.id);
      await retry(
        async () => {
          await uploadProductImages(page, imagesToUpload);
        },
        2,
        2000,
      );
      ts.uploadEnd = new Date().toISOString();
      console.log(`[agent-flow] ⏱ 时间戳 uploadEnd: ${ts.uploadEnd}`);
      await takeStepScreenshot(page, 'step3-after-upload', task.id);
      await randomDelay(1500, 2500);
    } else {
      console.log('[agent-flow] Step 3: 无商品图片，跳过上传');
    }

    // ---------------- Step 4: 输入 Prompt 并发送 ----------------
    const combinedPrompt = buildCombinedPrompt(task);
    console.log(
      `[agent-flow] Step 4: 输入并发送 Prompt (${combinedPrompt.length} 字符)`,
    );
    await inputPromptAndSend(page, combinedPrompt);
    ts.promptSent = new Date().toISOString();
    console.log(`[agent-flow] ⏱ 时间戳 promptSent: ${ts.promptSent}`);
    await randomDelay(2000, 3000);

    // Step 4+: 记录 chatUrl，以便重试时复用已有对话（避免重复创建 chat）
    // ⚠️ 捕获后立即通过回调持久化到磁盘，防止后续步骤失败/崩溃导致 chatUrl 丢失
    const currentChatUrl = page.url();
    if (/\/chat\/\d+/.test(currentChatUrl)) {
      task.chatUrl = currentChatUrl;
      console.log(`[agent-flow] Step 4+: 记录 chatUrl=${currentChatUrl}，后续重试可复用`);
      opts?.onChatUrlCaptured?.(currentChatUrl);
    } else {
      // 兆底：等待短暂时间后再检查一次 URL（可能网络延迟导致跳转较慢）
      console.log('[agent-flow] Step 4+: URL 未变更为 /chat/{id}，等待 5s 后重试检测...');
      await page.waitForTimeout(5000);
      const retryUrl = page.url();
      if (/\/chat\/\d+/.test(retryUrl)) {
        task.chatUrl = retryUrl;
        console.log(`[agent-flow] Step 4+: 延迟检测成功，记录 chatUrl=${retryUrl}`);
        opts?.onChatUrlCaptured?.(retryUrl);
      } else {
        console.warn('[agent-flow] Step 4+: 未能捕获 chatUrl，后续将在 Step 5 后补充检测');
      }
    }

    // ---------------- Step 5: 等待 AI 生成 Brief ----------------
    console.log('[agent-flow] Step 5: 等待 AI 生成 Brief (超时 180s)');
    await waitForAIResponse(page, 180000);
    ts.briefReady = new Date().toISOString();
    console.log(`[agent-flow] ⏱ 时间戳 briefReady: ${ts.briefReady}`);
    await randomDelay();

    // Step 5+: 如果 Step 4+ 未捕获 chatUrl，此时补充检测（AI 已响应，URL 肯定已跳转）
    if (!task.chatUrl) {
      const postAiUrl = page.url();
      if (/\/chat\/\d+/.test(postAiUrl)) {
        task.chatUrl = postAiUrl;
        console.log(`[agent-flow] Step 5+: 补充捕获 chatUrl=${postAiUrl}`);
        opts?.onChatUrlCaptured?.(postAiUrl);
      }
    }

    // ---------------- Step 6: 确认 Brief ----------------
    console.log('[agent-flow] Step 6: 确认 Brief');
    await retry(
      async () => {
        await confirmBrief(page);
      },
      2,
      2000,
    );
    ts.briefConfirmed = new Date().toISOString();
    console.log(`[agent-flow] ⏱ 时间戳 briefConfirmed: ${ts.briefConfirmed}`);
    await randomDelay();

    // ---------------- Step 7: 等待分镜生成 ----------------
    console.log('[agent-flow] Step 7: 等待分镜 (Storyboard) 生成 (超时 240s)');
    await waitForAIResponse(page, 240000);
    ts.storyboardReady = new Date().toISOString();
    console.log(`[agent-flow] ⏱ 时间戳 storyboardReady: ${ts.storyboardReady}`);
    await randomDelay();

    // ---------------- Step 8: 确认分镜并进入生成 ----------------
    console.log('[agent-flow] Step 8: 确认分镜，触发视频生成');
    await retry(
      async () => {
        await confirmStoryboard(page);
      },
      2,
      2000,
    );
    ts.storyboardConfirmed = new Date().toISOString();
    console.log(`[agent-flow] ⏱ 时间戳 storyboardConfirmed: ${ts.storyboardConfirmed}`);
    await randomDelay();

    // ---------------- Step 9: 推进 storyboard 阶段的 "Pending user inputs" ----------------
    // 实际观察：confirmStoryboard 后AI 会说「I'm working on producing the final video」，
    // 但 Task progress 卡片仍在 `2/3 Generate a storyboard - Pending user inputs`。
    // 必须在输入框发一句推进话术才会跳到 3/3 阶段。
    console.log('[agent-flow] Step 9: 检测并跳出 storyboard Pending user inputs (如有)');
    try {
      await pushPendingUserInputs(page, 8);
    } catch (err: any) {
      // NeedsManualError 必须上抛，让任务进入 needs-manual 挂起态等用户处理；其它异常按原逻辑忽略
      if (err instanceof NeedsManualError || err?.code === 'NEEDS_MANUAL') {
        console.warn(`[agent-flow] Step 9: pushPendingUserInputs 触发 NEEDS_MANUAL，向上抛出: ${err.message}`);
        throw err;
      }
      console.warn(`[agent-flow] Step 9: pushPendingUserInputs 异常，忽略: ${err.message}`);
    }
    await randomDelay();

    // 记录进入生成等待阶段的时间戳
    ts.generationStarted = new Date().toISOString();
    console.log(`[agent-flow] ⏱ 时间戳 generationStarted: ${ts.generationStarted}`);

    // 保存时间戳到任务对象
    task.timestamps = ts;

    // 打印阶段性耗时汇总
    console.log('[agent-flow] ⏱ 时间戳汇总:');
    if (ts.uploadStart && ts.uploadEnd) {
      const uploadSec = (new Date(ts.uploadEnd).getTime() - new Date(ts.uploadStart).getTime()) / 1000;
      console.log(`  图片上传: ${uploadSec.toFixed(1)}s`);
    }
    if (ts.promptSent && ts.briefReady) {
      const briefSec = (new Date(ts.briefReady).getTime() - new Date(ts.promptSent).getTime()) / 1000;
      console.log(`  AI生成Brief: ${briefSec.toFixed(1)}s`);
    }
    if (ts.briefConfirmed && ts.storyboardReady) {
      const sbSec = (new Date(ts.storyboardReady).getTime() - new Date(ts.briefConfirmed).getTime()) / 1000;
      console.log(`  AI生成分镜: ${sbSec.toFixed(1)}s`);
    }
    if (ts.uploadStart) {
      const elapsedSec = (Date.now() - new Date(ts.uploadStart).getTime()) / 1000;
      console.log(`  从上传到进入生成: ${elapsedSec.toFixed(1)}s`);
    }

    const pageUrl = page.url();
    console.log(
      `[agent-flow] ============ Agent 模式流程执行成功 (taskId=${task.id}) pageUrl=${pageUrl} ============`,
    );
    return { success: true, pageUrl };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(
      `[agent-flow] ============ Agent 模式流程执行失败 (taskId=${task.id}): ${errorMsg} ============`,
    );
    console.error((err as Error).stack);
    // NEEDS_MANUAL / CONTENT_REJECTED 必须保留原 error 实例上抛，让 manager.recordFailure 识别错误码
    if (
      err instanceof NeedsManualError || (err as any)?.code === 'NEEDS_MANUAL' ||
      (err as any)?.code === 'CONTENT_REJECTED' || (err as any)?.name === 'ContentRejectedError'
    ) {
      throw err;
    }
    return { success: false };
  }
}
