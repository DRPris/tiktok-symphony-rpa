export type TaskMethod = 'template' | 'agent-mode';

export type TaskStatus = 
  | 'pending' 
  | 'running' 
  | 'waiting-generation' 
  | 'review' 
  | 'approved' 
  | 'rejected' 
  | 'downloading' 
  | 'completed' 
  | 'failed';

export interface TaskInput {
  productUrl?: string;
  productImages?: string[];       // 商品图片本地路径数组（通过 "+" -> "Upload images" 上传）
  referenceVideo?: string;        // 参考视频本地路径（通过 "+ TikTok trend" -> "Upload reference video" 上传）
  productName: string;
  sellingPoints: string;
  /** 受众分析结果（英文段落，由 audience-agent 生成，融入 prompt 提交） */
  audience?: string;
  /** 商品目标国家（从 URL 域名自动识别，如 "Thailand"） */
  country?: string;
  /** 视频人物形象描述（根据国家自动映射，如 "A young Thai person..."） */
  persona?: string;
  /** 视频输出语言（根据国家自动映射，如 "Thai"） */
  videoLanguage?: string;
  prompt: string;
  templateId?: string;
  trendType?: 'trending-template' | 'top-ads';
  trendCategory?: string;         // 趋势分类名称
  trendIndex?: number;            // 选择第几个视频，从1开始
  filterOptions?: Record<string, string>;
  /** AI 前置 Agent 补全标记（哪些字段由 AI 自动填充） */
  aiMeta?: {
    enriched: boolean;
  };
}

export interface TaskResult {
  videoUrl?: string;
  localPath?: string;
  thumbnailUrl?: string;
}

/**
 * 任务失败现场快照元数据（实际截图/HTML/meta.json 落在 data/snapshots/<taskId>/<timestamp>/）
 * 在面板诊断 modal 中按 dir 路径定位文件展示。
 */
export interface FailureSnapshot {
  taskId: string;
  timestamp: string;          // ISO 时间
  errorCode: string;          // AutomationErrorCode（保持 string 以避免循环依赖）
  errorMessage: string;       // 摘要，最长 500 字
  url: string;                // 失败时的页面 URL
  dir: string;                // 相对于 data/ 的快照目录路径
  hasScreenshot: boolean;
  hasHtml: boolean;
}

/** 任务级错误归因 */
export interface TaskErrorInfo {
  code: string;               // AutomationErrorCode
  message: string;
  occurredAt: string;
}

/**
 * 任务全链路时间戳记录
 * 记录从商品上传 → 点击生成 → 视频生成完毕的各关键节点耗时
 */
export interface TaskTimestamps {
  /** 商品图片上传开始时间 */
  uploadStart?: string;
  /** 商品图片上传完成时间 */
  uploadEnd?: string;
  /** Prompt 发送时间 */
  promptSent?: string;
  /** AI 生成 Brief 完成时间 */
  briefReady?: string;
  /** Brief 确认（点击按钮）时间 */
  briefConfirmed?: string;
  /** AI 生成分镜完成时间 */
  storyboardReady?: string;
  /** 分镜确认 / 点击生成视频按钮时间 */
  storyboardConfirmed?: string;
  /** 进入视频生成等待状态时间 */
  generationStarted?: string;
  /** 视频生成完毕时间 */
  generationComplete?: string;
  /** 视频生成完毕截图路径 */
  generationCompleteScreenshot?: string;
  /** 总耗时（秒），generationComplete - uploadStart */
  totalDurationSec?: number;
}

export interface VideoTask {
  id: string;
  method: TaskMethod;
  status: TaskStatus;
  input: TaskInput;
  result?: TaskResult;
  pageUrl?: string;  // 等待生成时保存的页面URL
  /**
   * Agent 模式下，Prompt 发送后 TikTok 分配的对话 URL（含 /chat/{id}）。
   * 用于重试时复用已有对话，避免重复创建 chat 会话。
   */
  chatUrl?: string;
  error?: string;
  /** 结构化错误归因；与 error 共存以兼容旧任务 */
  errorInfo?: TaskErrorInfo;
  /** 失败现场快照（每次失败 push 一条，最多保留 5 条） */
  failureSnapshots?: FailureSnapshot[];
  /** 由调度器使用：最早可重试时间（ISO），实现指数退避 */
  nextRetryAt?: string;
  /** 登录态过期挂起标记；为 true 时调度器跳过该任务，等待登录恢复 */
  needsLogin?: boolean;
  /**
   * 需要人工在浏览器中介入完成的标记（如：模板/Agent 流程在中段卡住、按钮文案改版选择器全失效等）。
   * 为 true 时：
   *  - 不再自动重试（避免反复失败浪费 retryCount）
   *  - 前端展示橙色「需要人工介入」badge + 「我已处理→继续」按钮（点击后转为普通 retry）
   */
  needsManualIntervention?: boolean;
  /**
   * 内容策略拒绝标记（如：图片含人脸、违规内容等）。
   * 为 true 时：
   *  - 不再自动重试（重试也会被同样拒绝）
   *  - 前端展示红色「内容拒绝」badge
   */
  contentRejected?: boolean;
  /** 全链路时间戳记录 */
  timestamps?: TaskTimestamps;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  method: TaskMethod;
  input: TaskInput;
}

export interface TaskStatusUpdate {
  taskId: string;
  status: TaskStatus;
  result?: TaskResult;
  error?: string;
}

export interface SystemStatus {
  browserConnected: boolean;
  activeTasks: number;
  pendingTasks: number;
  waitingTasks: number;
  availablePages: number;
  totalPages: number;
}
