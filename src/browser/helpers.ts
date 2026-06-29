import { Page } from 'playwright';

/**
 * 等待指定毫秒数
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 通用重试包装器
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      // NEEDS_MANUAL 类错误代表流程卡死、需要人工介入，重试也无济于事——直接透传，避免浪费时间
      if (
        (err as any)?.name === 'NeedsManualError' ||
        (err as any)?.code === 'NEEDS_MANUAL'
      ) {
        console.log(`[retry] 第 ${attempt}/${maxRetries} 次尝试触发 NEEDS_MANUAL，跳过后续重试: ${lastError.message}`);
        throw lastError;
      }
      console.log(`[retry] 第 ${attempt}/${maxRetries} 次尝试失败: ${lastError.message}`);
      if (attempt < maxRetries) {
        await delay(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * 等待元素出现并点击
 */
export async function waitAndClick(
  page: Page,
  selector: string,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 30000;
  console.log(`[waitAndClick] 等待元素: ${selector}`);
  await page.waitForSelector(selector, { state: 'visible', timeout });
  await page.click(selector);
  console.log(`[waitAndClick] 已点击: ${selector}`);
}

/**
 * 等待输入框并输入文本
 */
export async function waitAndType(
  page: Page,
  selector: string,
  text: string,
  options?: { timeout?: number; clearFirst?: boolean }
): Promise<void> {
  const timeout = options?.timeout ?? 30000;
  const clearFirst = options?.clearFirst ?? true;
  console.log(`[waitAndType] 等待输入框: ${selector}`);
  await page.waitForSelector(selector, { state: 'visible', timeout });
  if (clearFirst) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
  }
  await page.fill(selector, text);
  console.log(`[waitAndType] 已输入文本到: ${selector}`);
}

/**
 * 页面下滑指定距离
 */
export async function scrollDown(page: Page, distance: number = 500): Promise<void> {
  console.log(`[scrollDown] 向下滚动 ${distance}px`);
  await page.mouse.wheel(0, distance);
  await delay(300);
}

/**
 * 滚动到页面底部
 */
export async function scrollToBottom(page: Page): Promise<void> {
  console.log(`[scrollToBottom] 滚动到页面底部`);
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await delay(500);
}

/**
 * 带重试的页面导航
 * - 失败后先导航到 about:blank 重置页面状态，再重试
 * - 使用 waitUntil:'commit' 避免 TikTok 重 SPA 全量加载超时
 * - 最多重试 maxRetries 次
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  options?: { timeout?: number; maxRetries?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }
): Promise<void> {
  const timeout = options?.timeout ?? 90000;
  const maxRetries = options?.maxRetries ?? 3;
  const waitUntil = options?.waitUntil ?? 'commit';

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[navigateWithRetry] 第 ${attempt}/${maxRetries} 次导航到 ${url.substring(0, 80)} (waitUntil=${waitUntil}, timeout=${timeout / 1000}s)`);
      await page.goto(url, { waitUntil, timeout });
      console.log(`[navigateWithRetry] ✅ 导航成功 (URL=${page.url().substring(0, 80)})`);
      return;
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message;
      console.warn(`[navigateWithRetry] 第 ${attempt}/${maxRetries} 次导航失败: ${msg.substring(0, 150)}`);
      // NEEDS_MANUAL 类错误不重试
      if ((err as any)?.name === 'NeedsManualError' || (err as any)?.code === 'NEEDS_MANUAL') {
        throw lastError;
      }
      if (attempt < maxRetries) {
        // 导航到 about:blank 重置页面状态，避免残留的加载状态干扰下次导航
        console.log(`[navigateWithRetry] 导航到 about:blank 重置页面...`);
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await delay(2000); // 2s 间隔后重试
      }
    }
  }
  throw lastError;
}

/**
 * 等待页面导航完成
 */
export async function waitForNavigation(
  page: Page,
  urlPattern?: string | RegExp,
  timeout: number = 60000
): Promise<void> {
  console.log(`[waitForNavigation] 等待导航完成${urlPattern ? `, 目标URL匹配: ${urlPattern}` : ''}`);
  if (urlPattern) {
    await page.waitForURL(urlPattern, { timeout });
  } else {
    await page.waitForLoadState('networkidle', { timeout });
  }
  console.log(`[waitForNavigation] 导航完成, 当前URL: ${page.url()}`);
}

/**
 * 安全点击（捕获异常，失败返回false）
 */
export async function safeClick(page: Page, selector: string): Promise<boolean> {
  try {
    await page.click(selector, { timeout: 5000 });
    console.log(`[safeClick] 成功点击: ${selector}`);
    return true;
  } catch (err) {
    console.log(`[safeClick] 点击失败: ${selector}, 错误: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 上传文件
 */
export async function uploadFile(
  page: Page,
  selector: string,
  filePath: string
): Promise<void> {
  console.log(`[uploadFile] 上传文件到: ${selector}, 文件: ${filePath}`);
  const input = await page.waitForSelector(selector, { timeout: 30000 });
  if (!input) {
    throw new Error(`未找到文件上传元素: ${selector}`);
  }
  await input.setInputFiles(filePath);
  console.log(`[uploadFile] 文件上传完成`);
}

/**
 * 等待页面出现指定文本
 */
export async function waitForText(
  page: Page,
  text: string,
  timeout: number = 30000
): Promise<void> {
  console.log(`[waitForText] 等待文本出现: "${text}"`);
  await page.waitForFunction(
    (searchText: string) => document.body.innerText.includes(searchText),
    text,
    { timeout }
  );
  console.log(`[waitForText] 文本已出现: "${text}"`);
}
