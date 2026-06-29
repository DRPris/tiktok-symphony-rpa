# Changelog

本文件记录 TikTok Symphony RPA 系统的重要版本变更。

---

## [0.8.0] - 2026-06-16

### Fixed — 批量执行稳定性全面加固

- **并发任务隔离**：新增 `startNewChat(page)` 函数，每个任务执行前强制创建新对话
  - 解决同一 BrowserContext 下并行任务共享 `/chat` 路由导致的商品信息串台问题
  - 通过 `text=/Start new chat/i` 触发 + 旧对话内容检测 fallback
- **图片批量上传重构**：`uploadProductImages` 改为 `fileChooser.setFiles(imagePaths)` 一次性上传
  - 消除逐张循环重复点击 "+" 按钮导致的 DOM 异常（"Element is not attached to DOM"）
  - 兜底策略：优先检测 `input[type=file]` 直接注入，否则走标准 fileChooser 流程
- **CONTENT_REJECTED 不可重试错误体系**：
  - 新增 `ContentRejectedError` 类 + `CONTENT_REJECTED` 错误码（`src/automation/errors.ts`）
  - `waitForAIResponse` 实时检测人脸拒绝文案（"Please upload an image without faces"）
  - `recordFailure` 对该错误码永久标记 `contentRejected=true`，跳过退避重试
  - `executeAgentFlow` catch 块增加 CONTENT_REJECTED 上抛条件，避免被吞为通用错误
- **inputPromptAndSend DOM 防脱落**：
  - 新增 URL 含 `/chat/{chatId}` 检测 → 消息已发送则提前 return
  - 兜底操作前重新获取 DOM 引用（`page.$('.tiptap.ProseMirror, ...')`）
  - 彻底解决页面导航后旧 inputEl 引用触发 "Element is not attached" 的问题
- **视频生成检测修正**：
  - 移除 `body.includes('in progress')` 误匹配（页面永久存在 "Task progress" 文本）
  - 改为精确匹配：`'Generating your video'` / `'Video generation in progress'` / `'Working on producing'`
  - 新增完成信号：`a[download][href*="video"]` DOM 检测 + `video[src*="output"]` 新视频元素检测

### Changed — Agent 模式入口与选择器重构

- **Agent 入口三阶策略**：Agent Tab 优先 → DOM 文本搜索 → 侧边栏兜底
  - 新增 Inspire 页面防误入：URL 白名单校验 + Agent Tab DOM 存在性双因子验证
  - 失败时主动跳转标准入口，避免 Inspire 循环陷阱
- **选择器全面适配 TikTok 新版 UI**：
  - `tiktokTrendButton`：兼容 "TikTok Symphony" / "Symphony" 重命名 + `:not(:has-text("Dreamina"))` 防误匹配
  - 新增 `dreaminaButton`：检测 Dreamina Seedance 2.0 模式切换按钮
  - `generatingIndicator`：排除静态文本误匹配，精确匹配动态进度元素
  - `downloadButton`：增加 `a[download][href*="video"]` DOM 匹配
  - `modalCloseButton`：增加 `[aria-label="close"]` / `[aria-label="Close"]`
- **Agent 模式入口 URL 迁移**：`config.urls.agentMode` 从 `/chat` 改为 `/create`（更稳定，无重定向）
- **确认按钮文案扩展**：
  - confirmBrief 新增 `'Create storyboard'` 变体
  - confirmStoryboard 新增 `"Looks perfect, let's generate the video!"` / `'Looks perfect'`
- **'+' 按钮定位增强**：多策略扫描（宽泛容器匹配 + SVG 识别 + 尺寸筛选 + 邻近元素探测）
- **登录态健康监测无干扰化**：空闲时段探测，避免打断正在执行的任务

### 涉及文件

| 文件 | 变更类型 |
|------|----------|
| `src/automation/agent-flow.ts` | startNewChat 集成 + CONTENT_REJECTED 上抛 + 入口策略重构 |
| `src/automation/shared-steps.ts` | 批量上传 + startNewChat + DOM 防脱落 + 视频检测修正 |
| `src/automation/selectors.ts` | 全面适配新版 UI 选择器 |
| `src/automation/errors.ts` | 新增 CONTENT_REJECTED 错误码 |
| `src/config.ts` | agentMode URL 迁移至 /create |
| `src/task/manager.ts` | CONTENT_REJECTED 永久失败分支 |
| `src/types.ts` | VideoTask 新增 `contentRejected` 字段 |

---

## [0.7.0] - 2026-06-16

### Added — 国家识别 + Prompt 模板引擎增强

- **新增 `src/utils/country-detect.ts`**：基于商品 URL 域名自动识别目标国家，支持 13 个国家/地区
  - 覆盖平台：Lazada、Shopee、Amazon、Tokopedia、Tiki、Coupang 等
  - 零 LLM 调用、毫秒级响应
  - 自动映射：country → persona（视频人物形象） + videoLanguage（视频语言）
- **新增 API `POST /api/detect-country`**：接收 productUrl，返回 country/countryCode/persona/videoLanguage
- **新增 API `GET /api/country-profiles`**：获取所有支持的国家画像列表
- **`TaskInput` 新增字段**：`country?: string` / `persona?: string` / `videoLanguage?: string`
- **Prompt 模板引擎**：支持 6 个模板变量 `{{productName}}` / `{{audience}}` / `{{sellingPoints}}` / `{{country}}` / `{{persona}}` / `{{videoLanguage}}`
  - 含模板变量时自动替换；不含时向后兼容拼接模式
- **审核面板**：新建任务表单新增「🌏 国家 / 人物 / 语言」输入区域，粘贴商品链接后自动填充
- **批量 AI 补全**：自动识别每行的目标国家并填充 country/persona/videoLanguage
- **批量创建脚本**：`scripts/batch-create.mjs` 新增 Step 0 国家识别

### Changed

- **DEFAULT_PROMPT 更新**：`Use TikTok trending video style to generate a video ad for {{productName}}, featuring {{persona}} speaking in {{videoLanguage}}...`
- **拼接模式输出结构**：新增 `Video Persona:` 和 `Video Language:` 段
- **Prompt 输入框 placeholder** 更新为包含所有 6 个模板变量的示例
- `confirmBatchCreate` / `enrichOneItem` 透传 country/persona/videoLanguage 字段

---

## [0.6.0] - 2026-06-16

### Added — AI 受众分析 Agent（图文双路融合）

- **新增 `src/llm/audience-agent.ts`**：受众分析 Agent，支持三种自适应路径：
  - 文本路（Qwen 文本模型）：从商品页抓取文本分析受众
  - 图片路（Qwen-VL 视觉模型）：从商品图片识别产品品类、目标人群、使用场景、定位档次
  - 融合路：双路并行分析后由 LLM 合并输出最终受众描述
- **新增 API `POST /api/analyze-audience`**：接收 `productUrl`，自动抓取页面文本和商品图片，返回英文受众描述段落
- **`TaskInput` 新增 `audience?: string` 字段**：存储受众分析结果
- **Prompt 自动注入受众**：`buildCombinedPrompt`（agent-flow）和 `buildPrompt`（template-flow）自动拼接 `Target Audience:` 段
- **审核面板**：新建任务表单增加「🎯 AI 受众分析」按钮 + `audience` 输入框
- **批量 AI 补全集成受众**：批量导入自动检测缺 `audience` 的行，并发补全时自动调用受众分析
- **批量创建脚本**：`scripts/batch-create.mjs` 新增 Step 3.5 受众分析步骤

### Changed

- `buildCombinedPrompt` / `buildPrompt` 输出结构变更为：`{prompt}\nProduct: {name}\nTarget Audience: {audience}\nKey Selling Points: {sellingPoints}`
- 批量 AI 补全提示信息增加受众分析说明
- `collectPreviewData` / `confirmBatchCreate` 透传 `audience` 字段

---

## [0.5.0] - 2026-06-04

### Added — 稳定性与自愈能力

- **选择器中心化 + 热更新**：`data/selectors-overrides.json` + 面板选择器管理 Tab
- **失败现场快照**：截图 + DOM + URL + 控制台错误 → `data/snapshots/`，面板「🔍 诊断」一键查看
- **错误分类 + 指数退避**：7 类 `AutomationErrorCode` + 60s×2^n 退避（上限 10min）
- **登录态主动续期**：每 30min 探测，失效自动挂起 + 面板告警 + 恢复后续跑
- **TaskStore 原子写 + 断点续跑**：tmp+rename 写锁 + 启动时僵尸任务回滚
- **每日自动复盘**：每日 23:00 自动生成复盘文档

---

## [0.4.0] - 2026-06-02

### Added — 页面适配与鲁棒性

- **TikTok 页面改版适配**：3 轮 URL/DOM 大改版适配（/symphony → /chat → /create）
- **浏览器状态同步修复**：TaskManager 状态提供器注入
- **Reactour 蒙版自动绕过**
- **登录等待机制增强**：容忍 goto 失败、延长轮询、放宽检测条件
- **AI 响应多信号检测**：消息计数 + 媒体元素 + URL 变化 + 诊断快照

---

## [0.3.0] - 2026-05-31

### Added — 批量能力与智能补全

- **批量导入**：支持 JSON 数组和 Excel 文件批量上传
- **AI 前置 Agent — 卖点分析**：`src/llm/selling-point-agent.ts`，Qwen LLM 提炼 5-8 条结构化卖点
- **AI 前置 Agent — 商品图提取**：`src/llm/image-score-agent.ts`，Qwen-VL 三维度质量打分
- **AI 补全预览面板**：批量导入后可编辑预览 Modal，支持修改、删图、全选、导出 Excel
- **新建任务功能**：审核面板新增「+ 新建任务」按钮 + 表单

---

## [0.2.0] - 2026-05-28

### Added — 基础自动化能力

- **模板流程引擎**：`src/automation/template-flow.ts`
- **Agent 流程引擎**：`src/automation/agent-flow.ts`
- **浏览器池管理**：5 并发 Page 池 + 登录态复用（user-data）
- **WebSocket 实时推送**：任务状态变更实时通知前端
- **审核面板**：Web UI 展示任务列表、状态、操作

---

## [0.1.0] - 2026-05-25

### Added — 项目初始化

- 项目脚手架搭建（Node.js + TypeScript + Playwright）
- 基础配置管理（`src/config.ts`）
- 任务数据模型定义（`src/types.ts`）
- Express API 服务 + WebSocket 服务
- 任务持久化存储（`src/task/store.ts`）
