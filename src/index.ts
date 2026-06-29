import { BrowserContext, Page } from 'playwright';
import { config } from './config';
import { TaskManager } from './task/manager';
import { PagePool } from './browser/pool';
import { launchBrowser, checkLoginStatus, waitForManualLogin, startLoginWatcher } from './browser/session';
import { createApiServer } from './server/api';
import { WebSocketServer } from './server/ws';
import { executeTemplateFlow } from './automation/template-flow';
import { executeAgentFlow } from './automation/agent-flow';
import { checkVideoGenerationStatus, retryGeneration } from './automation/shared-steps';
import { takeStepScreenshot } from './automation/screenshot-monitor';
import { createLogger } from './utils/logger';
import { navigateWithRetry } from './browser/helpers';
import { startDailyReviewScheduler, stopDailyReviewScheduler } from './daily-review/scheduler';
import { initSelectorStore } from './automation/selector-store';
import { attachConsoleCapture, captureFailure } from './automation/failure-snapshot';

const log = createLogger('Main');

// 全局状态
let browserContext: BrowserContext | null = null;
let pagePool: PagePool | null = null;
let stopLoginWatcher: (() => void) | null = null;

/**
 * 主入口
 */
async function main() {
  log.info('=== TikTok Symphony RPA System ===');
  log.info('正在初始化系统...');

  // 0. 加载选择器覆盖配置（热更新）——必须在任何使用 SELECTORS 的代码路径之前
  try {
    await initSelectorStore();
  } catch (err: any) {
    log.warn(`选择器覆盖配置加载失败，将使用默认值: ${err.message}`);
  }

  // 1. 初始化任务管理器
  const taskManager = new TaskManager();
  await taskManager.initialize();

  // 2. 启动 HTTP API 服务（传入工厂函数动态获取 BrowserContext）
  const app = createApiServer(taskManager, () => browserContext);
  const httpServer = app.listen(config.server.port, () => {
    log.info(`API Server 已启动: http://localhost:${config.server.port}`);
  });

  // 3. 启动 WebSocket 服务
  const wsServer = new WebSocketServer(taskManager, config.server.wsPort);
  wsServer.start();
  log.info(`WebSocket Server 已启动: ws://localhost:${config.server.wsPort}`);

  // 4. 启动浏览器
  log.info('正在启动浏览器...');
  try {
    browserContext = await launchBrowser();
  } catch (err: any) {
    log.error(`浏览器启动失败: ${err.message}`);
    log.error('请确认已安装 Chromium: npx playwright install chromium');
    process.exit(1);
  }

  // 5. 检查登录状态
  log.info('检查登录状态...');
  const pages = browserContext.pages();
  log.info(`检测到 ${pages.length} 个遗留标签页（user-data 恢复）`);
  // 关闭除首个以外的所有遗留页面，避免多个 chat 标签混淆
  if (pages.length > 1) {
    for (let i = 1; i < pages.length; i++) {
      try {
        const u = pages[i].url();
        await pages[i].close();
        log.info(`  关闭遗留标签页: ${u.substring(0, 80)}`);
      } catch (e) {
        // 忽略
      }
    }
  }
  const checkPage = pages.length > 0 ? pages[0] : await browserContext.newPage();
  const isLoggedIn = await checkLoginStatus(checkPage);

  if (!isLoggedIn) {
    log.warn('═══════════════════════════════════════════════════');
    log.warn('  未检测到有效登录态！');
    log.warn('  请在打开的浏览器窗口中手动完成登录');
    log.warn('  登录成功后系统将自动继续...');
    log.warn('═══════════════════════════════════════════════════');
    try {
      await waitForManualLogin(checkPage);
      log.info('✅ 登录成功，继续启动...');
    } catch (err: any) {
      log.error(`登录等待失败: ${err.message}`);
      await browserContext.close();
      process.exit(1);
    }
  } else {
    log.info('登录状态有效，继续启动...');
  }

  // 关闭检测用的页面（PagePool会创建自己的页面）
  await checkPage.close();

  // 6. 初始化 PagePool
  log.info('初始化 Page 池...');
  pagePool = new PagePool(browserContext);
  await pagePool.initialize();
  const poolStatus = pagePool.getStatus();
  log.info(`Page 池就绪: ${poolStatus.available} 个可用页面`);

  // 注入浏览器状态提供器，让 WS 能推送真实状态
  taskManager.setBrowserStatusProvider(() => ({
    connected: browserContext !== null,
    availablePages: pagePool ? pagePool.getStatus().available : 0,
  }));

  // 7. 注册任务调度逻辑
  registerTaskDispatcher(taskManager, pagePool);

  // 8. 启动轮询：等待生成的任务
  startGenerationPoller(taskManager, pagePool);

  // 9. 启动调度器
  taskManager.startScheduler();
  log.info('调度器已启动');

  // 9.05 启动登录态 watcher（默认 30 分钟轻量探测一次，仅在空闲时跑）
  if (browserContext) {
    stopLoginWatcher = startLoginWatcher(
      browserContext,
      (reason) => taskManager.markLoginExpired(reason),
      () => {
        taskManager.markLoginRecovered().catch((e: any) =>
          log.warn(`登录恢复后释放任务异常: ${e.message}`)
        );
      },
      {
        // 仅在浏览器空闲（无任何 page 在跑业务）时才探测，
        // 避免跟业务请求争 cookies/network
        isIdle: () => !!pagePool && pagePool.getStatus().busy === 0,
      }
    );
    log.info('登录态守望者已启动（间隔 30 分钟，空闲时轻量探测）');
  }

  // 9.1 启动每日复盘调度（默认每天 23:00 自动生成 docs/复盘-YYYY-MM-DD.md）
  startDailyReviewScheduler();

  log.info('═══════════════════════════════════════════════════');
  log.info('  系统启动完成！');
  log.info(`  审核面板: http://localhost:${config.server.port}`);
  log.info(`  WebSocket: ws://localhost:${config.server.wsPort}`);
  log.info('═══════════════════════════════════════════════════');

  // 10. 注册优雅退出
  const shutdown = async (signal: string) => {
    log.info(`收到 ${signal}，正在关闭系统...`);
    try {
      taskManager.stopScheduler();
      stopDailyReviewScheduler();
      if (stopLoginWatcher) {
        try { stopLoginWatcher(); } catch {}
        stopLoginWatcher = null;
      }
      wsServer.stop();
      httpServer.close(() => {
        log.info('HTTP 服务已关闭');
      });
      if (pagePool) {
        await pagePool.cleanup();
      }
      if (browserContext) {
        await browserContext.close();
        log.info('浏览器已关闭');
      }
    } catch (err: any) {
      log.error(`关闭过程出错: ${err.message}`);
    }
    setTimeout(() => process.exit(0), 1000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 注册任务调度 —— 监听 task:ready-for-execution 事件
 *
 * 设计目标：同时跑 N 个任务（N = pagePool 可用数）。
 * 不再用全局 isExecuting 锁串行所有任务。
 */
function registerTaskDispatcher(taskManager: TaskManager, pool: PagePool): void {
  taskManager.on('task:ready-for-execution', async () => {
    // 循环从 pending 队列捡任务上 page，直到队空或 page 耗尽。
    // 每个任务的 executeTask 异步跑，不 await，实现并发。
    while (true) {
      const status = pool.getStatus();
      // ★ 预留 1 个 page 给 Poller：Dispatcher 仅使用 dispatcherAvailable 部分
      if (status.dispatcherAvailable <= 0) {
        log.debug(`[Dispatcher] 无可用 page (available=${status.available}, reservedForPoller=${status.available - status.dispatcherAvailable}, busy=${status.busy})，等待释放后再调度`);
        break;
      }

      const task = await taskManager.getNextPendingTask();
      if (!task) break;

      const page = await pool.acquirePage(task.id);
      if (!page) {
        log.warn(`竞态：任务 ${task.id} 拿不到 page，回退到 failed 后重试`);
        await taskManager.recordFailure(task.id, new Error('无可用页面'), null, { autoRetry: true }).catch(() => {});
        continue;
      }
      // 备份：给 page 装上控制台错误捕获（WeakMap 内部去重，重复调用无副作用）
      try { attachConsoleCapture(page); } catch {}

      // 异步启动，不阻塞循环——下一轮循环可以继续并发拉起下一个任务
      executeTask(taskManager, pool, page, task).catch(err => {
        log.error(`[Dispatcher] 任务 ${task.id} 未捕获异常: ${err.message}`);
      });
    }
  });
}

/**
 * 单个任务的完整执行流程。出错、成功、走 waiting-generation 都一律释放 page，
 * 让 page 池立即可供下一个任务使用。
 * waiting-generation 后续生成轮询由 pollSingleTask 重新 acquire+goto。
 */
async function executeTask(
  taskManager: TaskManager,
  pool: PagePool,
  page: Page,
  task: { id: string; method: string }
): Promise<void> {
  log.info(`调度任务: ${task.id} (method=${task.method})`);
  try {
    const result =
      task.method === 'template'
        ? await executeTemplateFlow(page, task as any)
        : await executeAgentFlow(page, task as any, {
            // chatUrl 捕获后立即持久化到磁盘，防止后续步骤失败/崩溃导致重试时丢失 chatUrl 而重复创建对话
            onChatUrlCaptured: (chatUrl) => {
              taskManager.patchTask(task.id, { chatUrl }).catch((e) =>
                log.warn(`[executeTask] chatUrl 即时落盘失败: ${e.message}`)
              );
            },
          });

    if (result.success) {
      // 保存 chatUrl（如果 agent-flow 过程中捕获到了）
      const chatUrl = (task as any).chatUrl as string | undefined;
      // 保存时间戳
      const timestamps = (task as any).timestamps as any;
      await taskManager.updateTaskStatus(task.id, 'waiting-generation', {
        pageUrl: result.pageUrl,
        ...(chatUrl ? { chatUrl } : {}),
        ...(timestamps ? { timestamps } : {}),
      });
      log.info(`任务 ${task.id} 进入视频生成等待阶段——释放 page 供他人使用`);
    } else {
      // 即使失败，也要保存 chatUrl（避免重试时重复创建 chat）
      const chatUrl = (task as any).chatUrl as string | undefined;
      if (chatUrl) {
        await taskManager.patchTask(task.id, { chatUrl }).catch(() => {});
      }
      // 走统一失败通道：落快照 + 错误分类 + 退避重试
      const snapshot = await captureFailure(page, task.id, new Error('自动化流程返回 success=false'));
      await taskManager.recordFailure(
        task.id,
        new Error('自动化流程返回 success=false'),
        snapshot,
        { autoRetry: true }
      );
      log.error(`任务 ${task.id} 执行失败`);
    }
  } catch (err: any) {
    log.error(`任务 ${task.id} 执行异常: ${err.message}`);
    try {
      // 即使异常，也要保存 chatUrl（避免重试时重复创建 chat）
      const chatUrl = (task as any).chatUrl as string | undefined;
      if (chatUrl) {
        await taskManager.patchTask(task.id, { chatUrl }).catch(() => {});
      }
      const snapshot = await captureFailure(page, task.id, err);
      await taskManager.recordFailure(task.id, err, snapshot, { autoRetry: true });
    } catch {}
  } finally {
    await pool.releasePage(task.id);
  }
}

/**
 * 启动视频生成轮询器
 * 定时检查 waiting-generation 状态的任务，监测视频是否生成完成
 *
 * ★ 设计变更：轮询器采用单次检查模式，每次 acquire→navigate→check→release，
 * 不长期持有 page，避免页面池被耗尽。
 */
function startGenerationPoller(taskManager: TaskManager, pool: PagePool): void {
  const pollInterval = config.task.pollInterval; // 30秒

  setInterval(async () => {
    try {
      const allTasks = await taskManager.getAllTasks();
      const waitingTasks = allTasks.filter(t => t.status === 'waiting-generation');

      if (waitingTasks.length === 0) return;

      log.info(`轮询检查 ${waitingTasks.length} 个等待生成的任务...`);

      for (const task of waitingTasks) {
        try {
          await pollSingleTask(taskManager, pool, task);
        } catch (err: any) {
          log.error(`轮询任务 ${task.id} 异常: ${err.message}`);
        }
      }
    } catch (err: any) {
      log.error(`生成轮询器异常: ${err.message}`);
    }
  }, pollInterval);
}

/**
 * 轮询单个 waiting-generation 任务
 *
 * 设计原则：每次轮询都 acquire→use→release，不长期持有 page，
 * 避免 page 池被 "等生成中的任务" 长期掏空。
 */
async function pollSingleTask(
  taskManager: TaskManager,
  pool: PagePool,
  task: { id: string; pageUrl?: string; createdAt: string; updatedAt: string }
): Promise<void> {
  // 超时检测：从进入 waiting-generation 的 updatedAt 起计时
  const elapsed = Date.now() - new Date(task.updatedAt).getTime();
  if (elapsed > config.task.generationTimeout) {
    log.warn(`任务 ${task.id} 生成超时 (${Math.round(elapsed / 60000)}分钟)`);
    await taskManager.recordFailure(
      task.id,
      new Error(`视频生成超时 (${Math.round(elapsed / 60000)}分钟)`),
      null,
      { autoRetry: true }
    ).catch(() => {});
    return;
  }

  // ★ 单次检查模式：acquire → navigate → check → release，不长期持有 page
  const page = await pool.acquirePage(task.id, true);
  if (!page) {
    log.debug(`轮询 ${task.id}：暂无可用 page，跳过本次`);
    return;
  }
  try { attachConsoleCapture(page); } catch {}

  try {
    // ★ 智能导航策略：
    // 1. 如果页面不在 chatUrl 上 → 导航到 chatUrl
    // 2. 如果页面在 chatUrl 上但内容为空（React 崩溃）→ 强制重载
    // 3. 如果页面在 chatUrl 上且内容正常 → 短暂等待
    const currentUrl = page.url();
    const onCorrectUrl = task.pageUrl && currentUrl.includes(task.pageUrl);
    log.info(`轮询 ${task.id}：页面 URL=${currentUrl.substring(0, 80)}, target=${task.pageUrl?.substring(0, 80)}, onCorrectUrl=${onCorrectUrl}`);
    
    if (!onCorrectUrl) {
      // 导航到 chatUrl
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        await navigateWithRetry(page, task.pageUrl!, {
          waitUntil: 'domcontentloaded',
          timeout: config.browser.navigationTimeout,
          maxRetries: 2,
        });
        log.info(`轮询 ${task.id}：导航后 URL=${page.url().substring(0, 80)}`);
        try {
          await page.waitForSelector('#root > *', { timeout: 20000 });
          log.debug(`轮询 ${task.id}：React 已挂载`);
        } catch {
          log.warn(`轮询 ${task.id}：React 未挂载 (20s 超时)，继续检查`);
        }
      } catch (err: any) {
        log.warn(`导航到任务 ${task.id} 的页面失败: ${err.message}`);
        return;
      }
    } else {
      // 页面在正确 URL 上，检查内容是否还在
      const contentLen = await page.evaluate(() => (document.body.innerText || '').length).catch(() => 0);
      if (contentLen < 100) {
        // ★ 内容丢失（React 崩溃或页面被重置），强制重载
        log.info(`轮询 ${task.id}：页面内容丢失 (bodyLen=${contentLen})，强制重载...`);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          try {
            await page.waitForSelector('#root > *', { timeout: 20000 });
            log.debug(`轮询 ${task.id}：重载后 React 已挂载`);
          } catch {
            log.warn(`轮询 ${task.id}：重载后 React 未挂载，继续检查`);
          }
        } catch (err: any) {
          log.warn(`轮询 ${task.id}：重载失败: ${err.message}`);
        }
      } else {
        // 内容正常，短暂等待 React 更新
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // ★ 单次检查，不阻塞，返回 ready/generating/error/loading
    const result = await checkVideoGenerationStatus(page);

    if (result.status === 'ready') {
      // 视频生成完毕，记录时间戳并截图
      const now = new Date().toISOString();
      log.info(`任务 ${task.id} 视频生成完成，截图并记录时间戳...`);

      // 截图：视频生成完毕的页面
      const screenshotPath = await takeStepScreenshot(page, 'video-generation-complete', task.id);

      // 获取已有时间戳并更新
      const existingTask = await taskManager.getTask(task.id);
      const ts = existingTask?.timestamps || {};
      ts.generationComplete = now;
      if (screenshotPath) {
        ts.generationCompleteScreenshot = screenshotPath;
      }
      // 计算总耗时
      if (ts.uploadStart) {
        ts.totalDurationSec = Math.round((new Date(now).getTime() - new Date(ts.uploadStart).getTime()) / 1000);
      } else if (ts.promptSent) {
        ts.totalDurationSec = Math.round((new Date(now).getTime() - new Date(ts.promptSent).getTime()) / 1000);
      }

      // 打印完整时间戳汇总
      log.info(`任务 ${task.id} ⏱ 全链路时间戳汇总:`);
      if (ts.uploadStart) log.info(`  图片上传开始: ${ts.uploadStart}`);
      if (ts.uploadEnd) log.info(`  图片上传完成: ${ts.uploadEnd}`);
      if (ts.promptSent) log.info(`  Prompt发送: ${ts.promptSent}`);
      if (ts.briefReady) log.info(`  Brief就绪: ${ts.briefReady}`);
      if (ts.briefConfirmed) log.info(`  Brief确认: ${ts.briefConfirmed}`);
      if (ts.storyboardReady) log.info(`  分镜就绪: ${ts.storyboardReady}`);
      if (ts.storyboardConfirmed) log.info(`  点击生成视频: ${ts.storyboardConfirmed}`);
      if (ts.generationStarted) log.info(`  进入生成: ${ts.generationStarted}`);
      log.info(`  视频生成完毕: ${ts.generationComplete}`);
      if (ts.totalDurationSec) log.info(`  总耗时: ${ts.totalDurationSec}s (${(ts.totalDurationSec / 60).toFixed(1)}分钟)`);
      if (screenshotPath) log.info(`  完成截图: ${screenshotPath}`);

      // 更新任务状态并保存时间戳
      await taskManager.updateTaskStatus(task.id, 'review', { timestamps: ts });
      log.info(`任务 ${task.id} 进入审核状态`);
    } else if (result.status === 'error') {
      log.warn(`任务 ${task.id} 生成失败: ${result.detail}，尝试重试...`);
      try {
        await retryGeneration(page);
        log.info(`任务 ${task.id} 已触发重试`);
      } catch (retryErr: any) {
        log.error(`任务 ${task.id} 重试失败: ${retryErr.message}`);
        const snapshot = await captureFailure(page, task.id, retryErr);
        await taskManager.recordFailure(task.id, retryErr, snapshot, { autoRetry: true });
      }
    } else {
      // 'generating' 或 'loading' — 下次轮询再检查
      log.debug(`任务 ${task.id} 状态: ${result.status} (${result.detail})`);
    }
  } finally {
    // ★ 单次检查模式：立即释放 page，不长期持有
    await pool.releasePage(task.id);
  }
}

// 启动
main().catch((err) => {
  log.error(`启动失败: ${err.message}`);
  process.exit(1);
});
