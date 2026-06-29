# TikTok Symphony RPA - 视频批量生成系统

## 简介

基于 Playwright 的 TikTok Symphony 视频批量生成自动化系统。支持通过模板模式和 Agent 模式自动完成视频创意生成，集成 AI 前置分析能力（卖点提炼、商品图评分、受众画像识别、国家/人物/语言自动映射），包含 Prompt 模板变量引擎、任务管理、批量导入、自动化流程执行、视频生成状态轮询、人工审核面板等完整功能。

## 功能特点

- **双模式支持**：模板模式（Template）和 Agent 模式（Agent-Mode）
- **Page 池管理**：多标签页并行执行，提高效率
- **任务生命周期**：pending → running → waiting-generation → review → approved → downloading → completed
- **实时通知**：WebSocket 实时推送任务状态变更
- **人工审核**：Web 审核面板，一键审核通过/拒绝
- **自动重试**：失败任务自动重试（可配置重试次数）
- **登录态复用**：持久化浏览器上下文，免重复登录
- **AI 前置分析**：
  - **卖点提炼**：Qwen LLM 从商品页自动提取 5-8 条结构化卖点
  - **商品图评分**：Qwen-VL 视觉模型对候选主图三维度打分排序
  - **受众画像分析**：图文双路融合（文本路 Qwen + 图片路 Qwen-VL），自动识别目标受众并注入 Prompt
  - **国家识别**：基于商品链接域名自动识别目标国家，映射视频人物形象（persona）和输出语言（videoLanguage）
- **Prompt 模板引擎**：支持 `{{productName}}` / `{{audience}}` / `{{sellingPoints}}` / `{{country}}` / `{{persona}}` / `{{videoLanguage}}` 模板变量，自动替换为实际值
- **批量导入**：支持 JSON / Excel 批量上传，AI 自动补全缺失字段（卖点、受众、商品图、商品名、国家/人物/语言）

## 快速开始

### 1. 安装依赖

```bash
npm install
npx playwright install chromium
```

### 2. 首次登录

```bash
npm run login
```

系统会打开浏览器窗口，请在浏览器中手动完成 TikTok 登录（邮箱 + 验证码）。登录成功后系统会自动识别并提示完成。

> 登录态会保存在 `user-data/` 目录中，后续启动无需重复登录。

### 3. 启动系统

```bash
npm run start
```

系统启动后会：
1. 初始化任务管理器
2. 启动 API 和 WebSocket 服务
3. 启动浏览器并验证登录态
4. 初始化 Page 池
5. 开始任务调度

### 4. 访问审核面板

浏览器打开 http://localhost:3000 即可访问审核面板。

## 命令说明

| 命令 | 说明 |
|------|------|
| `npm run start` | 启动 RPA 系统 |
| `npm run login` | 打开浏览器进行手动登录 |
| `npm run dev` | 开发模式（自动重启） |
| `npm run build` | 编译 TypeScript |

## API 使用

### 创建任务

```bash
POST http://localhost:3000/api/tasks
Content-Type: application/json

{
  "method": "template",
  "input": {
    "productName": "智能手表",
    "prompt": "Create a 30s promotional video for this smart watch",
    "sellingPoints": "防水、心率监测、7天续航",
    "audience": "Tech-savvy young adults aged 20-35...",
    "country": "Thailand",
    "persona": "A young Thai person with a friendly, approachable appearance",
    "videoLanguage": "Thai",
    "productImages": ["/path/to/image1.png"],
    "templateId": "optional-template-id"
  }
}
```

**input 字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `productName` | 是 | 商品名称（留空可由 AI 从链接自动提取） |
| `prompt` | 是 | 视频生成提示词 |
| `sellingPoints` | 否 | 商品卖点（可由 AI 自动分析） |
| `audience` | 否 | 目标受众描述（可由 AI 图文双路分析自动生成，英文段落） |
| `country` | 否 | 目标国家（从商品链接域名自动识别，如 "Thailand"） |
| `persona` | 否 | 视频人物形象（根据国家自动映射，可手动覆盖） |
| `videoLanguage` | 否 | 视频输出语言（根据国家自动映射，如 "Thai"） |
| `productUrl` | 否 | 商品链接（用于 AI 前置分析 + 国家识别） |
| `productImages` | 否 | 商品图片本地路径数组 |
| `templateId` | 否 | 模板 ID（模板模式使用） |
```

**method 选项：**
- `template` - 模板模式：从 Symphony 模板库选择模板生成
- `agent-mode` - Agent 模式：通过 AI Agent 对话生成

### 查看任务列表

```bash
GET http://localhost:3000/api/tasks
GET http://localhost:3000/api/tasks?status=review
GET http://localhost:3000/api/tasks?limit=20&offset=0
```

### 查看任务详情

```bash
GET http://localhost:3000/api/tasks/:id
```

### 审核通过

```bash
POST http://localhost:3000/api/tasks/:id/approve
```

### 审核拒绝

```bash
POST http://localhost:3000/api/tasks/:id/reject
Content-Type: application/json

{
  "reason": "视频质量不达标"
}
```

### 重试失败任务

```bash
POST http://localhost:3000/api/tasks/:id/retry
```

### AI 卖点分析

```bash
POST http://localhost:3000/api/analyze-selling-points
Content-Type: application/json

{
  "productUrl": "https://www.lazada.co.th/products/xxx",
  "productName": "可选-商品名称"
}
```

### AI 受众分析

```bash
POST http://localhost:3000/api/analyze-audience
Content-Type: application/json

{
  "productUrl": "https://www.lazada.co.th/products/xxx",
  "productName": "可选-商品名称",
  "sellingPoints": "可选-已有卖点"
}
```

返回示例：
```json
{
  "success": true,
  "audience": "Young women aged 18-30 who are into skincare routines...",
  "meta": { "title": "页面标题", "imageCount": 5 }
}
```

> 受众分析采用**图文双路融合**：同时抓取页面文本（Qwen 文本模型）和商品图片（Qwen-VL 视觉模型），两路结果由 LLM 融合为最终受众描述。特别适合文字描述少、主要靠图片传达信息的本地商家场景。

### 国家识别

```bash
POST http://localhost:3000/api/detect-country
Content-Type: application/json

{
  "productUrl": "https://www.lazada.co.th/products/xxx"
}
```

返回示例：
```json
{
  "success": true,
  "detected": true,
  "country": "Thailand",
  "countryCode": "TH",
  "persona": "A young Thai person with a friendly, approachable appearance",
  "videoLanguage": "Thai"
}
```

> 基于商品链接域名自动识别目标国家，零 LLM 调用、毫秒级响应。支持 Lazada/Shopee/Amazon/Tokopedia/Tiki 等平台，覆盖 13 个国家/地区。识别结果自动映射视频人物形象和输出语言，可在 Prompt 模板中通过 `{{country}}` / `{{persona}}` / `{{videoLanguage}}` 引用。

### 国家画像列表

```bash
GET http://localhost:3000/api/country-profiles
```

返回所有支持的国家及其 persona/videoLanguage 映射（可用于前端下拉选择）。

### 系统状态

```bash
GET http://localhost:3000/api/status
```

返回示例：
```json
{
  "success": true,
  "status": {
    "browserConnected": true,
    "activeTasks": 2,
    "pendingTasks": 5,
    "waitingTasks": 1,
    "availablePages": 3,
    "totalPages": 5
  }
}
```

## 配置说明

配置文件位于 `src/config.ts`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `browser.headless` | `false` | 是否无头模式（建议 false 便于调试） |
| `browser.maxPages` | `5` | 最大并行标签页数 |
| `browser.defaultTimeout` | `30000` | 默认操作超时（ms） |
| `browser.navigationTimeout` | `60000` | 页面导航超时（ms） |
| `task.maxRetries` | `3` | 最大重试次数 |
| `task.generationTimeout` | `1200000` | 视频生成最长等待（20分钟） |
| `task.pollInterval` | `30000` | 生成状态轮询间隔（30秒） |
| `server.port` | `3000` | HTTP 服务端口 |
| `server.wsPort` | `3001` | WebSocket 服务端口 |

## 目录结构

```
├── src/
│   ├── automation/          # 自动化流程
│   │   ├── template-flow.ts # 模板模式流程
│   │   ├── agent-flow.ts    # Agent 模式流程
│   │   ├── shared-steps.ts  # 公共步骤（输入、确认、轮询）
│   │   ├── scrape-product.ts# 商品页抓取（文本 + 图片）
│   │   ├── selectors.ts     # CSS 选择器集合
│   │   └── selector-store.ts# 选择器热更新存储
│   ├── browser/             # 浏览器管理
│   │   ├── session.ts       # 浏览器启动 & 登录管理
│   │   ├── pool.ts          # Page 池
│   │   └── helpers.ts       # 浏览器操作工具函数
│   ├── download/            # 下载管理
│   │   └── manager.ts       # 视频下载管理器
│   ├── llm/                 # AI / LLM 能力层
│   │   ├── qwen.ts          # Qwen LLM 客户端（文本 + 视觉）
│   │   ├── selling-point-agent.ts  # 卖点分析 Agent
│   │   ├── audience-agent.ts       # 受众分析 Agent（图文双路）
│   │   └── image-score-agent.ts    # 商品图质量打分 Agent
│   ├── server/              # 服务层
│   │   ├── api.ts           # Express API 服务
│   │   └── ws.ts            # WebSocket 实时通知
│   ├── task/                # 任务管理
│   │   ├── manager.ts       # 任务管理器（核心）
│   │   ├── queue.ts         # 优先级队列
│   │   └── store.ts         # JSON 持久化存储
│   ├── review/              # 审核面板后端
│   │   └── panel.ts         # 面板逻辑
│   ├── utils/               # 工具类
│   │   ├── logger.ts        # 日志工具
│   │   ├── download-image.ts# 图片下载工具
│   │   └── country-detect.ts# 国家识别 + persona/language 映射
│   ├── config.ts            # 全局配置
│   ├── types.ts             # TypeScript 类型定义
│   └── index.ts             # 主入口
├── review-ui/               # 审核面板前端
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/                    # 任务数据持久化
├── downloads/               # 视频下载目录
├── user-data/               # 浏览器用户数据（登录态）
├── package.json
└── tsconfig.json
```

## 注意事项

- **首次使用必须手动登录**：运行 `npm run login`，在浏览器中完成登录
- **不要同时运行多个实例**：浏览器用户数据目录会冲突
- **视频生成需要 5-15 分钟**：系统会自动轮询检测完成状态
- **如遇风控**：系统会暂停并通知人工介入，需要手动处理验证后重试
- **登录态过期**：如任务执行中出现登录页面，需重新运行 `npm run login`
- **下载目录**：视频文件保存在 `downloads/` 目录下，按日期分类

## WebSocket 事件

连接 `ws://localhost:3001` 可接收实时事件：

| 事件类型 | 说明 |
|----------|------|
| `init` | 连接时推送所有任务和系统状态 |
| `task:created` | 新任务创建 |
| `task:statusChanged` | 任务状态变更 |
| `task:completed` | 任务完成 |
| `task:failed` | 任务失败 |
| `system:status` | 系统状态（每5秒） |
