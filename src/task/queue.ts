import { VideoTask } from '../types';

/**
 * TaskQueue - 基于内存的FIFO任务队列
 */
export class TaskQueue {
  private tasks: VideoTask[] = [];

  /**
   * 任务入队（加到队尾）
   */
  enqueue(task: VideoTask): void {
    this.tasks.push(task);
    console.log(`[TaskQueue] 任务入队: ${task.id}, 当前队列长度: ${this.tasks.length}`);
  }

  /**
   * 取出队首任务
   */
  dequeue(): VideoTask | undefined {
    const task = this.tasks.shift();
    if (task) {
      console.log(`[TaskQueue] 任务出队: ${task.id}, 剩余队列长度: ${this.tasks.length}`);
    }
    return task;
  }

  /**
   * 查看队首任务但不取出
   */
  peek(): VideoTask | undefined {
    return this.tasks[0];
  }

  /**
   * 获取队列长度
   */
  size(): number {
    return this.tasks.length;
  }

  /**
   * 队列是否为空
   */
  isEmpty(): boolean {
    return this.tasks.length === 0;
  }

  /**
   * 获取队列中所有任务（用于展示）
   */
  getAll(): VideoTask[] {
    return [...this.tasks];
  }

  /**
   * 移除指定任务
   */
  remove(taskId: string): boolean {
    const index = this.tasks.findIndex(t => t.id === taskId);
    if (index === -1) {
      return false;
    }
    this.tasks.splice(index, 1);
    console.log(`[TaskQueue] 移除任务: ${taskId}, 剩余队列长度: ${this.tasks.length}`);
    return true;
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.tasks = [];
    console.log('[TaskQueue] 队列已清空');
  }
}
