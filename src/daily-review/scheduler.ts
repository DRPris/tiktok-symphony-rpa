/**
 * 每日 23:00 自动生成项目复盘文档
 *
 * 不引入 cron 依赖，使用原生 setTimeout 自调度：
 *   - 计算从「现在」到「下次目标时刻（默认 23:00）」的延迟
 *   - 触发后调用 generator，再递归调度下一次（24h 后的同一时刻）
 *
 * 可通过环境变量覆盖时间：
 *   DAILY_REVIEW_HOUR=23 DAILY_REVIEW_MINUTE=0
 *
 * 设置 DAILY_REVIEW_DISABLED=1 可关闭定时调度。
 */

import { generateDailyReview } from './generator';
import { createLogger } from '../utils/logger';

const log = createLogger('DailyReview');

let scheduledTimer: NodeJS.Timeout | null = null;

function getTargetHourMinute(): { hour: number; minute: number } {
  const hour = clamp(parseInt(process.env.DAILY_REVIEW_HOUR || '23', 10), 0, 23, 23);
  const minute = clamp(parseInt(process.env.DAILY_REVIEW_MINUTE || '0', 10), 0, 59, 0);
  return { hour, minute };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 计算下次触发时刻（毫秒延迟）
 */
function nextDelayMs(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h${m}m`;
}

/**
 * 启动每日复盘调度器
 */
export function startDailyReviewScheduler(): void {
  if (process.env.DAILY_REVIEW_DISABLED === '1') {
    log.info('每日复盘调度器已通过 DAILY_REVIEW_DISABLED=1 关闭');
    return;
  }

  const { hour, minute } = getTargetHourMinute();
  const schedule = () => {
    const delay = nextDelayMs(hour, minute);
    log.info(
      `每日复盘已调度：下次触发在 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}（${formatDuration(delay)}后）`
    );
    scheduledTimer = setTimeout(async () => {
      try {
        const { filePath, targetDate } = await generateDailyReview(new Date());
        log.info(`每日复盘 ${targetDate} 已生成: ${filePath}`);
      } catch (err: any) {
        log.error(`每日复盘生成失败: ${err.message}`);
      } finally {
        // 递归调度下一次
        schedule();
      }
    }, delay);
    // 不阻塞进程退出
    if (scheduledTimer.unref) scheduledTimer.unref();
  };

  schedule();
}

/**
 * 停止调度器（用于 SIGINT/SIGTERM）
 */
export function stopDailyReviewScheduler(): void {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
    log.info('每日复盘调度器已停止');
  }
}
