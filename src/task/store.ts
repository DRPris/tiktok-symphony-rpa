import fs from 'fs/promises';
import path from 'path';
import { VideoTask, TaskStatus } from '../types';
import { config } from '../config';

/**
 * TaskStore - JSON文件持久化存储
 */
export class TaskStore {
  private filePath: string;
  // 串行化所有 "读改写" 操作，避免并发竞态 + .tmp rename 冲突
  private opQueue: Promise<unknown> = Promise.resolve();
  private writeCounter = 0;
  // ★ 内存缓存：避免每次操作都从磁盘读取
  private cache: VideoTask[] | null = null;
  private cacheLoaded = false;

  constructor() {
    this.filePath = config.store.filePath;
  }

  /**
   * 把所有写/读改写操作串到一条 promise 链上执行，保证同一时刻只有一个 fs 改写在跑。
   * 任何 fn 抛错都只影响调用者本身，不会阻断后续排队任务。
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.catch(() => undefined).then(() => fn());
    this.opQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * 确保存储目录存在
   */
  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      // 目录已存在则忽略
    }
  }

  /**
   * 从文件加载所有任务（带内存缓存）
   * 首次加载后缓存到内存，后续写操作同步更新缓存
   */
  async load(): Promise<VideoTask[]> {
    // ★ 优先从内存缓存返回
    if (this.cacheLoaded && this.cache !== null) {
      return this.cache;
    }
    try {
      await this.ensureDir();
      const data = await fs.readFile(this.filePath, 'utf-8');
      const tasks: VideoTask[] = JSON.parse(data);
      this.cache = tasks;
      this.cacheLoaded = true;
      console.log(`[TaskStore] 从文件加载了 ${tasks.length} 个任务`);
      return tasks;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.cache = [];
        this.cacheLoaded = true;
        return [];
      }
      console.error('[TaskStore] 加载任务文件失败:', err.message);
      return [];
    }
  }

  /**
   * 直接保存（无锁内部实现）。tmpPath 带 PID+自增 counter，杜绝并发 rename 撞同名。
   */
  private async _saveDirect(tasks: VideoTask[]): Promise<void> {
    await this.ensureDir();
    const tmpPath = `${this.filePath}.${process.pid}.${++this.writeCounter}.tmp`;
    const data = JSON.stringify(tasks, null, 2);
    await fs.writeFile(tmpPath, data, 'utf-8');
    await fs.rename(tmpPath, this.filePath);
    // ★ 同步更新内存缓存
    this.cache = tasks;
    this.cacheLoaded = true;
  }

  /**
   * 保存所有任务到文件（带锁，避免并发 rename 冲突）
   */
  async save(tasks: VideoTask[]): Promise<void> {
    return this.withLock(async () => {
      try {
        await this._saveDirect(tasks);
      } catch (err: any) {
        console.error('[TaskStore] 保存任务文件失败:', err.message);
        throw err;
      }
    });
  }

  /**
   * 添加单个任务（带锁，read-modify-write 原子化）
   */
  async addTask(task: VideoTask): Promise<void> {
    return this.withLock(async () => {
      try {
        const tasks = await this.load();
        tasks.push(task);
        await this._saveDirect(tasks);
        console.log(`[TaskStore] 添加任务: ${task.id}`);
      } catch (err: any) {
        console.error('[TaskStore] 添加任务失败:', err.message);
        throw err;
      }
    });
  }

  /**
   * 更新任务（带锁，read-modify-write 原子化）
   */
  async updateTask(taskId: string, updates: Partial<VideoTask>): Promise<void> {
    return this.withLock(async () => {
      try {
        const tasks = await this.load();
        const index = tasks.findIndex(t => t.id === taskId);
        if (index === -1) {
          throw new Error(`任务不存在: ${taskId}`);
        }
        tasks[index] = { ...tasks[index], ...updates };
        await this._saveDirect(tasks);
        console.log(`[TaskStore] 更新任务: ${taskId}`);
      } catch (err: any) {
        console.error('[TaskStore] 更新任务失败:', err.message);
        throw err;
      }
    });
  }

  /**
   * 获取单个任务
   */
  async getTask(taskId: string): Promise<VideoTask | undefined> {
    try {
      const tasks = await this.load();
      return tasks.find(t => t.id === taskId);
    } catch (err: any) {
      console.error('[TaskStore] 获取任务失败:', err.message);
      return undefined;
    }
  }

  /**
   * 获取所有任务
   */
  async getAllTasks(): Promise<VideoTask[]> {
    return this.load();
  }

  /**
   * 按状态筛选任务
   */
  async getTasksByStatus(status: TaskStatus): Promise<VideoTask[]> {
    try {
      const tasks = await this.load();
      return tasks.filter(t => t.status === status);
    } catch (err: any) {
      console.error('[TaskStore] 按状态筛选任务失败:', err.message);
      return [];
    }
  }
}
