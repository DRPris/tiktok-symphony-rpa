import { BrowserContext, Page } from 'playwright';
import { config } from '../config';

export class PagePool {
  private context: BrowserContext;
  private maxPages: number;
  private availablePages: Page[] = [];
  private busyPages: Map<string, Page> = new Map();
  /** 冷却中的页面（释放后等待 COOLDOWN_MS 再加入可用池） */
  private cooldownPages: Set<Page> = new Set();
  /** 冷却期毫秒数：页面释放后等待此时间再放回可用池，避免快速轮转导致 TikTok 网络拥塞 */
  private readonly COOLDOWN_MS = 3_000;
  /** ★ 不再为轮询器预留页面——非阻塞轮询器每次只占用页面几秒钟，
   *    与 Dispatcher 公平竞争即可。如果轮询器拿不到页面，跳过本次检查，
   *    下一个 30s 周期再试，不会影响业务正确性。
   *    这避免了 2 页面系统中 Dispatcher 永远拿不到页面的死锁问题。
   *    ★ 3 页面配置下：Dispatcher 最多用 2 页，Poller 始终能拿到 1 页。
   */
  private pollerTaskIds: Set<string> = new Set();

  /** 预留数：maxPages >= 3 时预留 1 页给 Poller，否则不预留 */
  private get effectiveReserve(): number {
    return this.maxPages >= 3 ? 1 : 0;
  }

  constructor(context: BrowserContext) {
    this.context = context;
    this.maxPages = config.browser.maxPages;
    console.log(`[PagePool] 初始化, 最大页面数: ${this.maxPages}, 冷却期: ${this.COOLDOWN_MS / 1000}s, Poller预留: ${this.effectiveReserve}个`);
  }

  /**
   * 预创建标签页放入空闲池
   */
  async initialize(): Promise<void> {
    console.log(`[PagePool] 开始预创建 ${this.maxPages} 个标签页...`);
    for (let i = 0; i < this.maxPages; i++) {
      try {
        const page = await this.context.newPage();
        await page.goto('about:blank');
        this.availablePages.push(page);
        console.log(`[PagePool] 创建标签页 ${i + 1}/${this.maxPages}`);
      } catch (err) {
        console.error(`[PagePool] 创建标签页 ${i + 1} 失败: ${(err as Error).message}`);
      }
    }
    console.log(`[PagePool] 初始化完成, 可用页面: ${this.availablePages.length}`);
  }

  /**
   * 从空闲池获取一个Page
   * @param taskId  任务 ID
   * @param forPoller  是否为生成轮询器请求（true=可使用预留页面, false=Dispatcher 不可占用预留）
   * @returns Page 或 null（无空闲Page时）
   */
  async acquirePage(taskId: string, forPoller = false): Promise<Page | null> {
    // ★ 智能预留：maxPages >= 3 时为 Poller 预留 1 页
    // Poller 请求时可以使用预留页；Dispatcher 请求时不可占用预留页
    const pollerBusy = this.pollerTaskIds.size;
    const remainingReserve = Math.max(0, this.effectiveReserve - pollerBusy);
    const minAvailable = forPoller ? 0 : remainingReserve;
    console.log(`[PagePool] 请求页面, taskId: ${taskId}, forPoller: ${forPoller}, 当前可用: ${this.availablePages.length}, 预留: ${remainingReserve} (轮询器已用: ${pollerBusy})`);

    if (this.availablePages.length <= minAvailable) {
      console.log(`[PagePool] 无可用页面, taskId: ${taskId}, 需保留 ${minAvailable} 个给Poller`);
      return null;
    }

    const page = this.availablePages.pop()!;
    this.busyPages.set(taskId, page);
    if (forPoller) {
      this.pollerTaskIds.add(taskId);
    }
    console.log(`[PagePool] 分配页面给 taskId: ${taskId} (forPoller=${forPoller}), 剩余可用: ${this.availablePages.length}`);
    return page;
  }

  /**
   * 释放Page回到空闲池（含冷却期）
   *
   * ★ 不再导航到 about:blank — 保留页面当前状态，
   * 让轮询器可以直接检查视频生成状态而不需要重新加载。
   * 冷却期（默认 30s）仍然生效，防止页面被快速轮转分配。
   */
  async releasePage(taskId: string): Promise<void> {
    console.log(`[PagePool] 释放页面, taskId: ${taskId}`);

    const page = this.busyPages.get(taskId);
    if (!page) {
      console.log(`[PagePool] 未找到 taskId: ${taskId} 对应的页面`);
      return;
    }

    this.busyPages.delete(taskId);
    this.pollerTaskIds.delete(taskId);

    // ★ 不导航到 about:blank，保留页面当前 URL 和内容
    // 冷却期会防止页面被立即重新分配
    this.startCooldown(page, taskId);
  }

  /**
   * 启动冷却计时器：COOLDOWN_MS 后将页面加入可用池
   */
  private startCooldown(page: Page, taskId: string): void {
    this.cooldownPages.add(page);
    console.log(`[PagePool] 页面进入 ${this.COOLDOWN_MS / 1000}s 冷却期, taskId: ${taskId}`);

    setTimeout(() => {
      this.cooldownPages.delete(page);
      try {
        if (page.isClosed()) {
          console.log(`[PagePool] 冷却期结束但页面已关闭, 创建新页面替代`);
          this.context.newPage().then(newPage => {
            this.availablePages.push(newPage);
            console.log(`[PagePool] 冷却完成(新页面), 当前可用: ${this.availablePages.length}`);
          }).catch(err => {
            console.error(`[PagePool] 冷却后创建新页面失败: ${(err as Error).message}`);
          });
          return;
        }
        this.availablePages.push(page);
        console.log(`[PagePool] 冷却期结束, 页面已回收, 当前可用: ${this.availablePages.length}`);
      } catch (err) {
        console.warn(`[PagePool] 冷却期后回收异常: ${(err as Error).message}`);
      }
    }, this.COOLDOWN_MS);
  }

  /**
   * 关闭异常Page，创建新Page替换
   */
  async replacePage(taskId: string): Promise<Page> {
    console.log(`[PagePool] 替换异常页面, taskId: ${taskId}`);

    const oldPage = this.busyPages.get(taskId);
    if (oldPage) {
      this.busyPages.delete(taskId);
      try {
        await oldPage.close();
        console.log(`[PagePool] 旧页面已关闭`);
      } catch (err) {
        console.log(`[PagePool] 关闭旧页面异常: ${(err as Error).message}`);
      }
    }

    const newPage = await this.context.newPage();
    this.busyPages.set(taskId, newPage);
    console.log(`[PagePool] 新页面已创建并分配给 taskId: ${taskId}`);
    return newPage;
  }

  /**
   * 获取页面池状态
   */
  getStatus(): { available: number; busy: number; total: number; cooldown: number; dispatcherAvailable: number } {
    return {
      available: this.availablePages.length,
      busy: this.busyPages.size,
      cooldown: this.cooldownPages.size,
      total: this.availablePages.length + this.busyPages.size + this.cooldownPages.size,
      /** Dispatcher 可用页面数 = 总可用 - 动态预留（轮询器已占用的不重复预留） */
      dispatcherAvailable: Math.max(0, this.availablePages.length - Math.max(0, this.effectiveReserve - this.pollerTaskIds.size)),
    };
  }

  /**
   * 关闭所有Page，清理资源
   */
  async cleanup(): Promise<void> {
    console.log('[PagePool] 开始清理所有页面...');

    // 关闭空闲页面
    for (const page of this.availablePages) {
      try {
        await page.close();
      } catch (_) {}
    }
    this.availablePages = [];

    // 关闭冷却中的页面
    for (const page of this.cooldownPages) {
      try {
        await page.close();
      } catch (_) {}
    }
    this.cooldownPages.clear();

    // 关闭使用中的页面
    for (const [taskId, page] of this.busyPages) {
      try {
        await page.close();
        console.log(`[PagePool] 关闭 taskId: ${taskId} 的页面`);
      } catch (_) {}
    }
    this.busyPages.clear();

    console.log('[PagePool] 所有页面已清理');
  }
}
