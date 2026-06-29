import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  VideoTask,
  TaskStatus,
  CreateTaskRequest,
  SystemStatus,
  FailureSnapshot,
  TaskErrorInfo,
} from '../types';
import { config } from '../config';
import { TaskQueue } from './queue';
import { TaskStore } from './store';
import { classifyError } from '../automation/errors';

/** 退避算法：delay = min(60s * 2^retryCount, 5min) */
function computeBackoffMs(retryCount: number): number {
  const base = 60 * 1000; // 60s
  const cap = 5 * 60 * 1000; // 5min（原 10min，加快重试节奏）
  const v = base * Math.pow(2, Math.max(0, retryCount));
  return Math.min(v, cap);
}

/** 最多保留的失败快照条数 */
const MAX_FAILURE_SNAPSHOTS = 5;

/**
 * 合法的状态转换映射
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  'pending': ['running', 'failed'],
  'running': ['waiting-generation', 'review', 'failed'],
  'waiting-generation': ['review', 'failed'],
  'review': ['approved', 'rejected', 'failed'],
  'approved': ['downloading', 'failed'],
  'rejected': ['pending', 'failed'],
  'downloading': ['completed', 'failed'],
  'completed': [],
  'failed': ['pending'],  // 允许重试
};

/**
 * TaskManager - 核心任务生命周期管理器
 * 
 * 事件：
 * - 'task:created' (task: VideoTask)
 * - 'task:statusChanged' (task: VideoTask, oldStatus: TaskStatus)
 * - 'task:ready-for-execution' (task: VideoTask)
 * - 'task:waiting-generation' (task: VideoTask)
 * - 'task:ready-for-review' (task: VideoTask)
 * - 'task:completed' (task: VideoTask)
 * - 'task:failed' (task: VideoTask)
 */
export class TaskManager extends EventEmitter {
  private queue: TaskQueue;
  private store: TaskStore;
  private schedulerInterval: NodeJS.Timeout | null = null;
  private browserStatusProvider: (() => { connected: boolean; availablePages: number }) | null = null;
  /** 延迟重试计时器，跳出调度器后重新入队；key=taskId */
  private retryTimers: Map<string, NodeJS.Timeout> = new Map();
  /** 登录态是否有效；被外部（session watcher）从 index.ts 设置 */
  private loginHealthy = true;

  constructor() {
    super();
    this.queue = new TaskQueue();
    this.store = new TaskStore();
  }

  /**
   * 设置浏览器状态提供器（由主模块注入 PagePool 状态）
   */
  setBrowserStatusProvider(provider: () => { connected: boolean; availablePages: number }): void {
    this.browserStatusProvider = provider;
  }

  /**
   * 初始化：从持久化存储恢复 pending 任务到队列
   * 并且对上次崩溃遗留的「僵尸任务」进行回滚：
   *  - status=running        → 回 pending（重新排队）
   *  - status=downloading    → 回 approved（重新恢复下载流程交给 manager 重跑）
   *  - status=waiting-generation 保留（轮询器会接手）
   */
  async initialize(): Promise<void> {
    try {
      const tasks = await this.store.load();

      // 1) 僵尸任务回滚
      const zombiesRunning = tasks.filter(t => t.status === 'running');
      const zombiesDownloading = tasks.filter(t => t.status === 'downloading');
      for (const t of zombiesRunning) {
        await this.store
          .updateTask(t.id, {
            status: 'pending',
            updatedAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
      for (const t of zombiesDownloading) {
        await this.store
          .updateTask(t.id, {
            status: 'approved',
            updatedAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
      if (zombiesRunning.length || zombiesDownloading.length) {
        console.warn(
          `[TaskManager] 检测到上次未正常退出的僵尸任务: running=${zombiesRunning.length}, downloading=${zombiesDownloading.length}，已自动回滚`
        );
      }

      // 2) 恢复 pending 任务到队列（含刚刚被回滚的 zombiesRunning）
      const refreshed = await this.store.load();
      const pendingTasks = refreshed.filter(t => t.status === 'pending' && !t.needsLogin);
      // 按创建时间顺序入队，避免后创建但先入队
      pendingTasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const task of pendingTasks) {
        // nextRetryAt 未到 → 安排定时器入队；已到 → 直接入队
        if (task.nextRetryAt && new Date(task.nextRetryAt).getTime() > Date.now()) {
          this.scheduleDelayedEnqueue(task);
        } else {
          this.queue.enqueue(task);
        }
      }
      console.log(
        `[TaskManager] 初始化完成，恢复了 ${pendingTasks.length} 个待执行任务` +
          (zombiesRunning.length ? `（含 ${zombiesRunning.length} 个从 running 回滚）` : '')
      );
    } catch (err: any) {
      console.error('[TaskManager] 初始化失败:', err.message);
    }
  }

  /** 安排在 nextRetryAt 到达后重新入队 */
  private scheduleDelayedEnqueue(task: VideoTask): void {
    const old = this.retryTimers.get(task.id);
    if (old) clearTimeout(old);
    const delay = Math.max(
      0,
      new Date(task.nextRetryAt!).getTime() - Date.now()
    );
    console.log(
      `[TaskManager] 任务 ${task.id} 将在 ${Math.round(delay / 1000)}s 后重新入队（退避）`
    );
    const tm = setTimeout(async () => {
      this.retryTimers.delete(task.id);
      try {
        const fresh = await this.store.getTask(task.id);
        if (!fresh || fresh.status !== 'pending' || fresh.needsLogin) return;
        this.queue.enqueue(fresh);
        this.emit('task:ready-for-execution', fresh);
      } catch (err: any) {
        console.error(`[TaskManager] 延迟入队失败 ${task.id}: ${err.message}`);
      }
    }, delay);
    this.retryTimers.set(task.id, tm);
  }

  /**
   * 创建新任务
   *
   * 幂等保护：若当前存在相同 productUrl + method 且状态在「未终结」集合中的任务，
   * 则直接返回该已有任务并在 task 上打上 duplicate=true 标记，避免前端双击 / WS 重连 / 批量重走
   * 造成同一商品被重复创建。
   */
  async createTask(
    request: CreateTaskRequest,
  ): Promise<VideoTask & { duplicate?: boolean }> {
    try {
      // 幂等检查：有 productUrl 才去重（无 url 的任务无法判重，保持原行为）
      const productUrl = (request.input?.productUrl || '').trim();
      if (productUrl) {
        const ACTIVE: TaskStatus[] = [
          'pending',
          'running',
          'waiting-generation',
          'review',
          'approved',
          'downloading',
        ];
        const all = await this.store.getAllTasks();
        const dup = all.find(
          (t) =>
            t.method === request.method &&
            (t.input?.productUrl || '').trim() === productUrl &&
            ACTIVE.includes(t.status),
        );
        if (dup) {
          console.warn(
            `[TaskManager] 检测到重复创建：productUrl=${productUrl} method=${request.method} 已存在任务 ${dup.id} (status=${dup.status})，跳过新建。`,
          );
          return { ...dup, duplicate: true };
        }
      }

      const now = new Date().toISOString();
      const task: VideoTask = {
        id: uuidv4(),
        method: request.method,
        status: 'pending',
        input: request.input,
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      // 持久化保存
      await this.store.addTask(task);
      // 加入队列
      this.queue.enqueue(task);

      console.log(`[TaskManager] 创建任务: ${task.id}, 方法: ${task.method}`);
      
      // 触发事件
      this.emit('task:created', task);
      this.emit('task:ready-for-execution', task);

      return task;
    } catch (err: any) {
      console.error('[TaskManager] 创建任务失败:', err.message);
      throw err;
    }
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId: string, status: TaskStatus, extra?: Partial<VideoTask>): Promise<VideoTask> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }

      const oldStatus = task.status;

      // 校验状态转换合法性
      if (!VALID_TRANSITIONS[oldStatus]?.includes(status)) {
        throw new Error(`非法状态转换: ${oldStatus} -> ${status}`);
      }

      const updates: Partial<VideoTask> = {
        ...extra,
        status,
        updatedAt: new Date().toISOString(),
      };

      await this.store.updateTask(taskId, updates);
      const updatedTask: VideoTask = { ...task, ...updates };

      console.log(`[TaskManager] 任务状态更新: ${taskId} ${oldStatus} -> ${status}`);

      // 触发通用状态变更事件
      this.emit('task:statusChanged', updatedTask, oldStatus);

      // 触发特定状态事件
      switch (status) {
        case 'waiting-generation':
          this.emit('task:waiting-generation', updatedTask);
          break;
        case 'review':
          this.emit('task:ready-for-review', updatedTask);
          break;
        case 'completed':
          this.emit('task:completed', updatedTask);
          break;
        case 'failed':
          this.emit('task:failed', updatedTask);
          break;
      }

      return updatedTask;
    } catch (err: any) {
      console.error('[TaskManager] 更新任务状态失败:', err.message);
      throw err;
    }
  }

  /**
   * 获取下一个待执行任务
   */
  async getNextPendingTask(): Promise<VideoTask | undefined> {
    try {
      // 登录态不健康时不调度新任务，避免批量走到登录页被一锅端失败
      if (!this.loginHealthy) {
        return undefined;
      }
      const task = this.queue.dequeue();
      if (!task) {
        return undefined;
      }
      // 防御性：万一某个任务在队列中被打上了 needsLogin，跳过
      if (task.needsLogin) {
        console.warn(`[TaskManager] 跳过需要登录的任务: ${task.id}`);
        return undefined;
      }

      // 更新状态为 running
      const updatedTask = await this.updateTaskStatus(task.id, 'running');
      return updatedTask;
    } catch (err: any) {
      console.error('[TaskManager] 获取下一个任务失败:', err.message);
      return undefined;
    }
  }

  /**
   * 审核通过任务
   */
  async approveTask(taskId: string): Promise<VideoTask> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }
      if (task.status !== 'review') {
        throw new Error(`任务状态不是review，无法审批: 当前状态=${task.status}`);
      }

      const updatedTask = await this.updateTaskStatus(taskId, 'approved');
      console.log(`[TaskManager] 任务审核通过: ${taskId}`);
      return updatedTask;
    } catch (err: any) {
      console.error('[TaskManager] 审核任务失败:', err.message);
      throw err;
    }
  }

  /**
   * 拒绝任务
   */
  async rejectTask(taskId: string): Promise<VideoTask> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }
      if (task.status !== 'review') {
        throw new Error(`任务状态不是review，无法拒绝: 当前状态=${task.status}`);
      }

      const updatedTask = await this.updateTaskStatus(taskId, 'rejected');
      console.log(`[TaskManager] 任务被拒绝: ${taskId}`);
      return updatedTask;
    } catch (err: any) {
      console.error('[TaskManager] 拒绝任务失败:', err.message);
      throw err;
    }
  }

  /**
   * 重试任务
   * @param opts.immediate true 跳过指数退避（用户在面板上手动点击重试）
   *                       false 按 retryCount 退避（系统自动重试）
   */
  async retryTask(
    taskId: string,
    opts?: { immediate?: boolean }
  ): Promise<VideoTask> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }
      if (task.status !== 'failed' && task.status !== 'rejected') {
        throw new Error(`任务状态不允许重试: 当前状态=${task.status}`);
      }

      if (task.retryCount >= config.task.maxRetries) {
        throw new Error(`任务已达最大重试次数: ${task.retryCount}/${config.task.maxRetries}`);
      }

      const immediate = !!opts?.immediate;
      const backoffMs = immediate ? 0 : computeBackoffMs(task.retryCount);
      const nextRetryAt = backoffMs > 0
        ? new Date(Date.now() + backoffMs).toISOString()
        : undefined;

      const updates: Partial<VideoTask> = {
        status: 'pending' as TaskStatus,
        retryCount: task.retryCount + 1,
        error: undefined,
        errorInfo: undefined,
        nextRetryAt,
        needsLogin: false,
        needsManualIntervention: false,
        updatedAt: new Date().toISOString(),
      };

      // 手动重试时清除 chatUrl，让任务从头执行全新对话；
      // 自动重试保留 chatUrl，复用已有对话避免 TikTok 侧边栏产生重复记录。
      if (immediate) {
        updates.chatUrl = undefined;
      }

      await this.store.updateTask(taskId, updates);
      const updatedTask: VideoTask = { ...task, ...updates };

      if (backoffMs > 0) {
        // 调度到延迟入队计时器，避免马上被 dispatcher 拉走重复跜路
        this.scheduleDelayedEnqueue(updatedTask);
        console.log(
          `[TaskManager] 任务重试已排队: ${taskId}, 退避 ${Math.round(backoffMs / 1000)}s, 重试次数: ${updatedTask.retryCount}/${config.task.maxRetries}`
        );
      } else {
        this.queue.enqueue(updatedTask);
        console.log(
          `[TaskManager] 任务重试（立即）: ${taskId}, 重试次数: ${updatedTask.retryCount}/${config.task.maxRetries}`
        );
      }

      this.emit('task:statusChanged', updatedTask, task.status);
      if (backoffMs === 0) {
        this.emit('task:ready-for-execution', updatedTask);
      }

      return updatedTask;
    } catch (err: any) {
      console.error('[TaskManager] 重试任务失败:', err.message);
      throw err;
    }
  }

  /**
   * 记录任务失败：统一入口。
   * - 写入 errorInfo + failureSnapshots
   * - 根据错误类型决定是否自动重试：
   *   * LOGIN_EXPIRED → 不计 retryCount，挂起 needsLogin=true，状态 failed
   *   * 其他                 → 若 retryCount<maxRetries 且允许自动重试，走退避 retry
   *   * 否则             → 仅状态转 failed，不重试
   */
  async recordFailure(
    taskId: string,
    err: any,
    snapshot?: FailureSnapshot | null,
    opts?: { autoRetry?: boolean }
  ): Promise<VideoTask | null> {
    try {
      const task = await this.store.getTask(taskId);
      if (!task) return null;

      const auto = classifyError(err);
      const errorInfo: TaskErrorInfo = {
        code: auto.code,
        message: auto.message.slice(0, 1000),
        occurredAt: new Date().toISOString(),
      };

      const snapshots = (task.failureSnapshots || []).slice();
      if (snapshot) {
        snapshots.push(snapshot);
        while (snapshots.length > MAX_FAILURE_SNAPSHOTS) snapshots.shift();
      }

      // 状态转换：只有合法源状态才能转 failed；downloading->failed 、running->failed 、waiting-generation->failed 都 OK
      const allowedFromPrev: TaskStatus[] = [
        'pending',
        'running',
        'waiting-generation',
        'review',
        'approved',
        'downloading',
      ];
      const updates: Partial<VideoTask> = {
        errorInfo,
        error: errorInfo.message,
        failureSnapshots: snapshots,
        updatedAt: new Date().toISOString(),
      };

      // 只有当前不是 failed/completed 才转状态
      if (allowedFromPrev.includes(task.status)) {
        updates.status = 'failed';
      }

      // 登录过期 → 挂起，不计 retryCount
      if (auto.code === 'LOGIN_EXPIRED') {
        updates.needsLogin = true;
        await this.store.updateTask(taskId, updates);
        const t: VideoTask = { ...task, ...updates };
        this.emit('task:statusChanged', t, task.status);
        this.emit('task:failed', t);
        console.warn(`[TaskManager] 任务 ${taskId} 登录态过期挂起，等待人工重新登录`);
        return t;
      }

      // 需人工介入 → 打标记、不自动重试，等用户在面板上点「我已处理→继续」后才 retry
      if (auto.code === 'NEEDS_MANUAL') {
        updates.needsManualIntervention = true;
        await this.store.updateTask(taskId, updates);
        const t: VideoTask = { ...task, ...updates };
        this.emit('task:statusChanged', t, task.status);
        this.emit('task:failed', t);
        console.warn(
          `[TaskManager] 任务 ${taskId} 需人工介入、不自动重试：${errorInfo.message}`,
        );
        return t;
      }

      // 内容策略拒绝（如图片含人脸）→ 永久失败，不自动重试
      if (auto.code === 'CONTENT_REJECTED') {
        updates.contentRejected = true;
        await this.store.updateTask(taskId, updates);
        const t: VideoTask = { ...task, ...updates };
        this.emit('task:statusChanged', t, task.status);
        this.emit('task:failed', t);
        console.warn(
          `[TaskManager] 任务 ${taskId} 内容被拒绝（不可重试）：${errorInfo.message}`,
        );
        return t;
      }

      await this.store.updateTask(taskId, updates);
      const t: VideoTask = { ...task, ...updates };
      this.emit('task:statusChanged', t, task.status);
      this.emit('task:failed', t);

      // 自动重试（如果没超上限且调用者允许）
      const allowAutoRetry = opts?.autoRetry !== false; // 默认 true
      if (allowAutoRetry && t.retryCount < config.task.maxRetries) {
        try {
          await this.retryTask(taskId, { immediate: false });
        } catch (e: any) {
          console.warn(`[TaskManager] 自动重试排队失败 ${taskId}: ${e.message}`);
        }
      }
      return t;
    } catch (e: any) {
      console.error(`[TaskManager] recordFailure 异常: ${e.message}`);
      return null;
    }
  }

  /** session watcher 调用：登录态失效 */
  markLoginExpired(reason: string): void {
    this.loginHealthy = false;
    console.warn(`[TaskManager] 登录态失效: ${reason}`);
    this.emit('login:expired', reason);
  }

  /** session watcher 调用：登录态恢复，释放所有 needsLogin 任务重新入队 */
  async markLoginRecovered(): Promise<number> {
    this.loginHealthy = true;
    let count = 0;
    try {
      const all = await this.store.getAllTasks();
      const stuck = all.filter(t => t.needsLogin && t.status === 'failed');
      for (const t of stuck) {
        try {
          await this.retryTask(t.id, { immediate: true });
          count++;
        } catch {}
      }
    } catch (e: any) {
      console.warn(`[TaskManager] markLoginRecovered 异常: ${e.message}`);
    }
    console.log(`[TaskManager] 登录态恢复，释放 ${count} 个挂起任务`);
    this.emit('login:recovered', count);
    return count;
  }

  isLoginHealthy(): boolean {
    return this.loginHealthy;
  }

  /**
   * 获取系统状态
   */
  async getSystemStatus(): Promise<SystemStatus & { loginHealthy: boolean; failedRecent: number; needsLoginCount: number }> {
    try {
      const allTasks = await this.store.getAllTasks();
      const activeTasks = allTasks.filter(t => t.status === 'running').length;
      const pendingTasks = allTasks.filter(t => t.status === 'pending').length;
      const waitingTasks = allTasks.filter(t => t.status === 'waiting-generation').length;
      const needsLoginCount = allTasks.filter(t => t.needsLogin).length;

      // 近 24h 失败任务数
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const failedRecent = allTasks.filter(
        t => t.status === 'failed' && new Date(t.updatedAt).getTime() >= since
      ).length;

      const browserStatus = this.browserStatusProvider
        ? this.browserStatusProvider()
        : { connected: false, availablePages: 0 };

      return {
        browserConnected: browserStatus.connected,
        activeTasks,
        pendingTasks,
        waitingTasks,
        availablePages: browserStatus.availablePages,
        totalPages: config.browser.maxPages,
        loginHealthy: this.loginHealthy,
        failedRecent,
        needsLoginCount,
      };
    } catch (err: any) {
      console.error('[TaskManager] 获取系统状态失败:', err.message);
      return {
        browserConnected: false,
        activeTasks: 0,
        pendingTasks: 0,
        waitingTasks: 0,
        availablePages: 0,
        totalPages: config.browser.maxPages,
        loginHealthy: this.loginHealthy,
        failedRecent: 0,
        needsLoginCount: 0,
      };
    }
  }

  /**
   * 部分更新任务字段（不涉及状态转换）。
   * 适合在执行流程中保存中间数据（如 chatUrl）。
   */
  async patchTask(taskId: string, data: Partial<VideoTask>): Promise<void> {
    try {
      await this.store.updateTask(taskId, { ...data, updatedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error(`[TaskManager] patchTask 失败 (${taskId}): ${err.message}`);
    }
  }

  /**
   * 获取单个任务
   */
  async getTask(taskId: string): Promise<VideoTask | undefined> {
    try {
      return await this.store.getTask(taskId);
    } catch (err: any) {
      console.error('[TaskManager] 获取任务失败:', err.message);
      return undefined;
    }
  }

  /**
   * 获取所有任务
   */
  async getAllTasks(): Promise<VideoTask[]> {
    try {
      return await this.store.getAllTasks();
    } catch (err: any) {
      console.error('[TaskManager] 获取所有任务失败:', err.message);
      return [];
    }
  }

  /**
   * 启动调度器 - 定期检查是否有任务可执行
   */
  startScheduler(): void {
    if (this.schedulerInterval) {
      console.log('[TaskManager] 调度器已在运行');
      return;
    }

    console.log('[TaskManager] 启动调度器');
    this.schedulerInterval = setInterval(async () => {
      try {
        // 检查是否有待执行任务
        if (!this.queue.isEmpty()) {
          const nextTask = this.queue.peek();
          if (nextTask) {
            this.emit('task:ready-for-execution', nextTask);
          }
        }
      } catch (err: any) {
        console.error('[TaskManager] 调度器执行出错:', err.message);
      }
    }, 1000);
  }

  /**
   * 停止调度器
   */
  stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      console.log('[TaskManager] 调度器已停止');
    }
    // 清理所有退避定时器，避免退出后被 fire
    for (const [, tm] of this.retryTimers) clearTimeout(tm);
    this.retryTimers.clear();
  }
}
