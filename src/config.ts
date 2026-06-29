import path from 'path';
import dotenv from 'dotenv';

// 加载 .env (位于项目根目录)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  // 浏览器配置
  browser: {
    userDataDir: path.resolve(__dirname, '../user-data'),
    headless: false,  // RPA需要有头模式便于调试
    channel: 'chrome' as const,  // 使用系统 Chrome
    maxPages: 5,      // 5页：4个给调度器跑任务，1个给轮询器检查生成状态
    defaultTimeout: 30000,  // 默认操作超时30秒
    navigationTimeout: 90000,  // 页面导航超时90秒（TikTok /create 页面加载较重）
  },
  
  // 任务配置
  task: {
    maxRetries: 3,
    generationTimeout: 20 * 60 * 1000,  // 视频生成最长等待20分钟
    pollInterval: 15 * 1000,  // 轮询间隔15秒（加快生成状态检测）
  },
  
  // 服务配置
  server: {
    port: 3000,
    wsPort: 3001,
  },
  
  // 下载配置
  download: {
    dir: path.resolve(__dirname, '../downloads'),
  },

  // 本地素材目录（参考视频 / 商品图片）
  // Excel 中 referenceVideo / productImages 若填写相对路径（不以 / 开头），
  // 后端会自动拼接成 <assets.dir>/<相对路径>
  assets: {
    dir: path.resolve(__dirname, '../assets'),
  },
  
  // TikTok Symphony Creative Studio URLs
  urls: {
    home: 'https://ads.tiktok.com/creative/creativestudio/create',
    imageToVideo: 'https://ads.tiktok.com/creative/creativestudio/image-to-video',
    // Agent/Chat 模式入口：统一使用 /create（稳定不重定向）
    // 发送 Prompt 后页面自动跳转至 /chat/<conversation_id>
    // 注：/chat 在部分时段会重定向至 /home/en（6/2 复盘记录），/create 更可靠
    agentMode: 'https://ads.tiktok.com/creative/creativestudio/create',
  },
  
  // 数据存储
  store: {
    filePath: path.resolve(__dirname, '../data/tasks.json'),
  },

  // LLM (通义千问 / OpenAI 兼容)
  llm: {
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: process.env.LLM_MODEL || 'qwen-plus',
    visionModel: process.env.LLM_VISION_MODEL || 'qwen-vl-plus',
    timeout: Number(process.env.LLM_TIMEOUT) || 60000,
  },
};
