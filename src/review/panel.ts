/**
 * 审核面板后端辅助模块
 *
 * 当前 API 已覆盖全部审核操作（approve / reject / retry），
 * 此模块作为扩展点保留，可在此添加：
 *  - 审核通知（邮件、Webhook）
 *  - 审核日志持久化
 *  - 自动审核规则
 */

export interface ReviewNotification {
  taskId: string;
  action: 'approve' | 'reject' | 'retry';
  timestamp: string;
}

/**
 * 记录审核操作日志（当前仅打印到控制台）
 */
export function logReviewAction(notification: ReviewNotification): void {
  console.log(
    `[Review] ${notification.action.toUpperCase()} 任务 ${notification.taskId} @ ${notification.timestamp}`
  );
}
