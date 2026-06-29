import { chromium, BrowserContext, Page } from 'playwright';
import { config } from '../config';
import { delay } from './helpers';

const SYMPHONY_URL = config.urls.home;

/**
 * 启动持久化浏览器上下文（复用登录态）
 */
export async function launchBrowser(): Promise<BrowserContext> {
  console.log(`[session] 启动浏览器, userDataDir: ${config.browser.userDataDir}`);
  console.log(`[session] headless: ${config.browser.headless}, channel: chrome`);

  const context = await chromium.launchPersistentContext(config.browser.userDataDir, {
    channel: 'chrome',           // 使用系统 Chrome 而非内置 Chromium
    headless: config.browser.headless,
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // 注入反检测脚本（在每个新页面加载前执行）
  await context.addInitScript(() => {
    // === tsx/esbuild keepNames 兼容垫片 ===
    // tsx 编译时会对命名函数注入 __name(fn, name) 装饰器，
    // 但该辅助函数在 page.evaluate 的浏览器上下文中不存在，必须全局定义。
    if (typeof (globalThis as any).__name === 'undefined') {
      (globalThis as any).__name = (fn: any, _name: string) => fn;
    }

    // 隐藏 webdriver 属性
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    
    // 伪装 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // 伪装 languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'],
    });
    
    // 移除 Playwright 注入的属性
    delete (window as any).__playwright;
    delete (window as any).__pw_manual;
  });

  console.log('[session] 浏览器启动成功');
  return context;
}

/**
 * 检查当前页面是否已登录 Symphony
 * @returns true 表示已登录，false 表示需要登录
 */
export async function checkLoginStatus(page: Page): Promise<boolean> {
  try {
    console.log('[session] 检查登录状态...');
    
    // 导航到 Symphony 页面
    await page.goto(SYMPHONY_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeout,
    });

    // 等待页面稳定
    await delay(3000);

    const currentUrl = page.url();
    console.log(`[session] 当前URL: ${currentUrl}`);

    // 检查是否在登录页面
    if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('passport')) {
      console.log('[session] 检测到登录页面, 需要登录');
      return false;
    }

    // 检查页面是否有登录表单
    const hasLoginForm = await page.evaluate(() => {
      const loginInputs = document.querySelectorAll('input[type="password"], input[name="email"], input[name="username"]');
      return loginInputs.length > 0;
    });

    if (hasLoginForm) {
      console.log('[session] 检测到登录表单, 需要登录');
      return false;
    }

    console.log('[session] 已登录');
    return true;
  } catch (err) {
    console.log(`[session] 检查登录状态异常: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 等待用户手动完成登录
 * 打开登录页面，轮询检测登录是否完成
 */
export async function waitForManualLogin(page: Page): Promise<void> {
  console.log('[session] 正在打开 Symphony 页面...');
  
  try {
    await page.goto(SYMPHONY_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch (err) {
    console.warn(`[session] 自动导航失败（可能 VPN 未开），请你手动在浏览器中访问。错误: ${(err as Error).message.substring(0, 80)}`);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║                                                  ║');
  console.log('║   请在浏览器中手动完成登录                       ║');
  console.log('║   (邮箱 + 验证码)                                ║');
  console.log('║                                                  ║');
  console.log('║   登录成功后系统将自动检测并继续...              ║');
  console.log('║                                                  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 轮询检测登录状态
  const pollInterval = 5000; // 5秒检测一次
  const maxWaitTime = 10 * 60 * 1000; // 最长等待10分钟
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    await delay(pollInterval);

    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch {
      continue;
    }
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    console.log(`[session] 轮询检测中 (${elapsedSec}s)... 当前URL: ${currentUrl}`);

    // 判断是否在目标页面，且不是登录页
    const isOnTarget =
      currentUrl.includes('creativestudio') &&
      !currentUrl.includes('login') &&
      !currentUrl.includes('signin') &&
      !currentUrl.includes('passport');

    if (isOnTarget) {
      // 二次确认：检查页面上是否还有登录表单
      try {
        const hasLoginForm = await page.evaluate(() => {
          const loginInputs = document.querySelectorAll('input[type="password"]');
          return loginInputs.length > 0;
        });

        if (!hasLoginForm) {
          console.log('[session] ✅ 检测到登录成功！');
          return;
        }
      } catch {
        // 页面还未就绪，继续轮询
      }
    }
  }

  throw new Error('登录超时（10分钟），请重试');
}

/**
 * 启动一个轻量的登录态守望者（每隔 intervalMs 检查一次）
 *
 * 关键差异：和 checkLoginStatus 不同，本函数不开新页面、不抢占业务流程——
 * 而是用 BrowserContext 共享 cookies 的 APIRequestContext 直接 HEAD/GET 探测，
 * 完全无视觉打扰，且默认仅在浏览器空闲时执行。
 *
 * @param ctx          浏览器上下文
 * @param onExpired    探测到登录态失效时回调（reason）
 * @param onRecovered  从失效恢复为有效时回调
 * @param opts.intervalMs   检查间隔，默认 30 分钟
 * @param opts.isIdle       可选：返回 false 时跳过本次探测（避免与业务并发）
 * @returns 一个 stop() 函数；调用即可停止 watcher
 */
export function startLoginWatcher(
  ctx: BrowserContext,
  onExpired: (reason: string) => void,
  onRecovered: () => void,
  opts: { intervalMs?: number; isIdle?: () => boolean } | number = {}
): () => void {
  // 兼容老调用：第 4 个参数若是 number，仍当作 intervalMs
  const options = typeof opts === 'number' ? { intervalMs: opts } : opts;
  const intervalMs = options.intervalMs ?? 30 * 60 * 1000;
  const isIdle = options.isIdle;

  let lastHealthy = true;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const probe = async (): Promise<void> => {
    if (stopped) return;
    // 仅在空闲时探测，避免与业务任务竞争
    if (isIdle && !isIdle()) {
      return;
    }

    let healthy = lastHealthy;
    let reason = '';
    try {
      // 用 ctx.request 共享当前 cookies，禁用自动跳转，看是否被踢到登录页
      const resp = await ctx.request.get(SYMPHONY_URL, {
        maxRedirects: 0,
        timeout: 15000,
        failOnStatusCode: false,
      });
      const status = resp.status();
      const location = resp.headers()['location'] || '';

      if (status >= 300 && status < 400 && /login|signin|passport/i.test(location)) {
        healthy = false;
        reason = `重定向到登录页 (${status}): ${location}`;
      } else if (status >= 200 && status < 400) {
        healthy = true;
      } else {
        // 4xx/5xx 视为网络抖动，不改变健康状态
        console.warn(`[loginWatcher] 探测返回异常状态 ${status}（不改变健康状态）`);
      }
    } catch (err: any) {
      // 探测失败不立即判定登录失效——可能只是网络抖动
      console.warn(`[loginWatcher] 探测异常（不改变健康状态）: ${err?.message || err}`);
    }

    if (lastHealthy && !healthy) {
      console.warn(`[loginWatcher] 检测到登录态失效: ${reason}`);
      onExpired(reason);
    } else if (!lastHealthy && healthy) {
      console.log('[loginWatcher] 登录态已恢复');
      onRecovered();
    }
    lastHealthy = healthy;
  };

  // 立即跑一次首检，再周期跑
  probe().catch(() => {});
  timer = setInterval(() => {
    probe().catch(() => {});
  }, intervalMs);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/**
 * 当以 --login 参数直接运行时，执行登录流程
 */
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--login')) {
    return;
  }

  console.log('[session] === 启动登录流程 ===');
  let context: BrowserContext | null = null;

  try {
    // 1. 启动浏览器
    context = await launchBrowser();

    // 2. 获取或创建页面
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // 3. 检查当前登录状态
    const isLoggedIn = await checkLoginStatus(page);

    if (isLoggedIn) {
      console.log('[session] 已有有效登录态，无需重新登录');
    } else {
      // 4. 等待手动登录
      await waitForManualLogin(page);
    }

    console.log('');
    console.log('[session] ✅ 登录流程完成！浏览器保持打开，登录态已保存。');
    console.log('[session] 可以按 Ctrl+C 关闭浏览器。');
    console.log('');

    // 保持进程运行，让用户可以验证
    await new Promise(() => {});
  } catch (err) {
    console.error(`[session] 登录流程失败: ${(err as Error).message}`);
    if (context) {
      await context.close();
    }
    process.exit(1);
  }
}

// 当直接运行此文件时执行 main
main();
