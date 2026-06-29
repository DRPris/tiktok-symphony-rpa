/**
 * 自动化流程错误分类
 *
 * 设计目标：
 * - 把"出错的原因"从一句话字符串升级为可枚举的错误码，便于：
 *   1) 失败仪表板按 code 聚合 Top N；
 *   2) 重试策略针对不同错误差异化（登录失效不计入 retryCount）；
 *   3) 选择器失效自动上报到 selector-store 命中率统计。
 *
 * 注意：不强求所有抛错点都用这些类，未识别的错误一律归为 'UNKNOWN'。
 */

export type AutomationErrorCode =
  | 'SELECTOR_TIMEOUT'   // 选择器在超时内未找到
  | 'LOGIN_EXPIRED'      // 登录态失效（不计入 retryCount）
  | 'RATE_LIMIT'         // 触发风控/限流
  | 'NETWORK'            // 网络错误（页面 goto 失败、断网）
  | 'GENERATION_TIMEOUT' // 视频生成超时
  | 'GENERATION_FAILED'  // 检测到 retry 按钮，生成失败
  | 'INPUT_INVALID'      // 输入参数非法（图片不存在等）
  | 'CONTENT_REJECTED'   // 内容策略拒绝（如图片含人脸），不可重试
  | 'NEEDS_MANUAL'       // 流程在中段卡住，需要人工在浏览器内点一下才能继续（不自动重试）
  | 'UNKNOWN';

export class AutomationError extends Error {
  code: AutomationErrorCode;
  /** 失败时附加上下文：选择器路径、当前 URL 等 */
  details?: Record<string, any>;

  constructor(code: AutomationErrorCode, message: string, details?: Record<string, any>) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.details = details;
  }
}

export class SelectorTimeoutError extends AutomationError {
  constructor(selectorPath: string, timeoutMs: number, extra?: Record<string, any>) {
    super(
      'SELECTOR_TIMEOUT',
      `选择器超时未命中: ${selectorPath} (timeout=${timeoutMs}ms)`,
      { selectorPath, timeoutMs, ...extra }
    );
    this.name = 'SelectorTimeoutError';
  }
}

export class LoginExpiredError extends AutomationError {
  constructor(detected: string) {
    super('LOGIN_EXPIRED', `检测到登录态失效: ${detected}`, { detected });
    this.name = 'LoginExpiredError';
  }
}

export class GenerationTimeoutError extends AutomationError {
  constructor(elapsedMin: number) {
    super('GENERATION_TIMEOUT', `视频生成超时 (${elapsedMin}分钟)`, { elapsedMin });
    this.name = 'GenerationTimeoutError';
  }
}

/**
 * 内容策略拒绝错误（如图片含人脸、违规内容等）。
 * 此类错误不可自动重试，任务直接标记为永久失败。
 */
export class ContentRejectedError extends AutomationError {
  constructor(reason: string, details?: Record<string, any>) {
    super('CONTENT_REJECTED', `内容被拒绝: ${reason}`, details);
    this.name = 'ContentRejectedError';
  }
}

/**
 * 流程在中段卡住、需要人工在浏览器中介入完成的错误。
 * 触发该错误的任务不会被自动重试，而是被打上 needsManualIntervention=true 标记，
 * 等待用户在审核面板里点 "我已处理→继续" 后再走 retry 流程。
 */
export class NeedsManualError extends AutomationError {
  constructor(reason: string, details?: Record<string, any>) {
    super('NEEDS_MANUAL', `需要人工介入: ${reason}`, details);
    this.name = 'NeedsManualError';
  }
}

/**
 * 把任意抛出的错误归一化为 AutomationError，方便统一上报。
 * 特别地：根据 message 关键词识别 Playwright 内置超时错误。
 */
export function classifyError(err: any): AutomationError {
  if (err instanceof AutomationError) return err;
  const msg = String(err?.message || err || '');
  if (/Timeout \d+ms exceeded.*waitForSelector/i.test(msg) || /waitForSelector.*Timeout/i.test(msg)) {
    return new AutomationError('SELECTOR_TIMEOUT', msg);
  }
  if (/login|signin|passport|未登录|登录失效/i.test(msg)) {
    return new AutomationError('LOGIN_EXPIRED', msg);
  }
  if (/net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|Navigation timeout/i.test(msg)) {
    return new AutomationError('NETWORK', msg);
  }
  if (/risk|captcha|verify|too many|频繁|Please try again/i.test(msg)) {
    return new AutomationError('RATE_LIMIT', msg);
  }
  // 人脸/内容策略拒绝 → 不可重试
  if (/without faces|face.*detected|contain.*face|人脸|content policy|violat/i.test(msg)) {
    return new AutomationError('CONTENT_REJECTED', msg);
  }
  return new AutomationError('UNKNOWN', msg);
}
