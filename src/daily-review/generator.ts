/**
 * 每日复盘文档生成器
 *
 * 输入：
 *  - logs/*.log              （扫描指定日期的错误/警告/超时/失败行）
 *  - data/tasks.json         （统计指定日期的任务情况，并对比近 7 天趋势）
 *
 * 输出：
 *  - docs/复盘-YYYY-MM-DD.md
 *    若文件已存在，则保留用户手写区块，仅刷新自动汇总区块
 *    （以 <!-- AUTO:BEGIN --> ... <!-- AUTO:END --> 包裹）
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { VideoTask } from '../types';
import { createLogger } from '../utils/logger';
import { chatComplete } from '../llm/qwen';

const log = createLogger('DailyReview');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');

const AUTO_BEGIN = '<!-- AUTO:BEGIN -->';
const AUTO_END = '<!-- AUTO:END -->';

interface LogIssue {
  file: string;
  line: number;
  level: 'ERROR' | 'WARN' | 'INFO';
  timestamp: string;
  module: string;
  message: string;
}

interface DailyTaskStat {
  date: string;
  total: number;
  byStatus: Record<string, number>;
  topErrors: { reason: string; count: number }[];
}

/**
 * 取本地时区的 YYYY-MM-DD
 */
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 扫描 logs/ 下所有 *.log，提取指定日期的错误/警告/超时/失败行
 */
function scanLogIssues(targetDate: string): LogIssue[] {
  if (!fs.existsSync(LOGS_DIR)) return [];

  const issues: LogIssue[] = [];
  const datePrefix = `[${targetDate} `;
  const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'));

  // 正则：[YYYY-MM-DD HH:MM:SS] [LEVEL] [Module] message
  const lineRe = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(DEBUG|INFO|WARN|ERROR)\] \[([^\]]+)\] (.*)$/;
  // 兜底关键字（无标准前缀的行也能命中）
  const fallbackRe = /(timeout|超时|失败|error|exception|reject)/i;

  for (const f of files) {
    const fullPath = path.join(LOGS_DIR, f);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const m = line.match(lineRe);
      if (m) {
        const [, ts, lvl, module, msg] = m;
        if (!ts.startsWith(targetDate)) continue;
        // 标准格式行：仅记录 WARN/ERROR，或带超时/失败关键字的 INFO
        if (lvl === 'ERROR' || lvl === 'WARN') {
          issues.push({
            file: f,
            line: i + 1,
            level: lvl as 'ERROR' | 'WARN',
            timestamp: ts,
            module,
            message: msg,
          });
        } else if (fallbackRe.test(msg)) {
          issues.push({
            file: f,
            line: i + 1,
            level: 'INFO',
            timestamp: ts,
            module,
            message: msg,
          });
        }
      } else {
        // 非标准前缀行：仅在文件 mtime 是今天 + 命中关键字时记录
        if (!fallbackRe.test(line)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (toLocalDate(stat.mtime) !== targetDate) continue;
        } catch {
          continue;
        }
        issues.push({
          file: f,
          line: i + 1,
          level: 'INFO',
          timestamp: '-',
          module: '-',
          message: line.trim(),
        });
      }
    }
  }

  return issues;
}

/**
 * 加载所有任务（容错）
 */
function loadAllTasks(): VideoTask[] {
  try {
    const raw = fs.readFileSync(config.store.filePath, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 统计指定日期的任务情况（基于 createdAt 本地日期）
 */
function statTasksByDate(tasks: VideoTask[], targetDate: string): DailyTaskStat {
  const ofDay = tasks.filter((t) => {
    if (!t.createdAt) return false;
    return toLocalDate(new Date(t.createdAt)) === targetDate;
  });

  const byStatus: Record<string, number> = {};
  const errorCounter = new Map<string, number>();
  for (const t of ofDay) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if (t.status === 'failed' && t.error) {
      const key = t.error.length > 60 ? t.error.slice(0, 60) + '…' : t.error;
      errorCounter.set(key, (errorCounter.get(key) || 0) + 1);
    }
  }
  const topErrors = Array.from(errorCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  return { date: targetDate, total: ofDay.length, byStatus, topErrors };
}

/**
 * 近 N 天趋势
 */
function statRecentDays(tasks: VideoTask[], endDate: Date, days: number): DailyTaskStat[] {
  const out: DailyTaskStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i);
    out.push(statTasksByDate(tasks, toLocalDate(d)));
  }
  return out;
}

/**
 * 调用 LLM 对当日问题作智能归纳（无 LLM_API_KEY 或调用失败时返回空字符串，不报错）
 */
async function summarizeWithLLM(
  targetDate: string,
  issues: LogIssue[],
  todayStat: DailyTaskStat,
  tasks: VideoTask[]
): Promise<string> {
  if (!config.llm.apiKey) {
    log.info('未配置 LLM_API_KEY，跳过 AI 归纳');
    return '';
  }
  if (issues.length === 0 && todayStat.total === 0) {
    log.info('今日无问题也无任务，跳过 AI 归纳');
    return '';
  }

  // 提取当日任务的精简信息
  const todayTasks = tasks
    .filter((t) => t.createdAt && toLocalDate(new Date(t.createdAt)) === targetDate)
    .map((t) => ({
      id: t.id.slice(0, 8),
      method: t.method,
      status: t.status,
      error: t.error || '',
      product: (t.input?.productName || '').slice(0, 60),
      retryCount: t.retryCount,
    }));

  // 提取问题日志样本（最多 40 条，避免 prompt 过长）
  const sampledIssues = issues.slice(0, 40).map((x) => ({
    level: x.level,
    time: x.timestamp.split(' ')[1] || '-',
    module: x.module,
    msg: x.message.slice(0, 200),
  }));

  const userContent =
    `请你作为 RPA 项目复盘助手，基于以下 ${targetDate} 的事实数据，输出“今日问题候选清单”。\n\n` +
    `## 当日任务统计\n${JSON.stringify(todayStat, null, 2)}\n\n` +
    `## 当日任务明细\n${JSON.stringify(todayTasks, null, 2)}\n\n` +
    `## 今日日志中的 ERROR/WARN/超时样本（最多 40 条）\n${JSON.stringify(sampledIssues, null, 2)}\n\n` +
    `## 输出要求\n` +
    `用 markdown 表格列出 **最多 5 个** 识别出的问题。列：问题标题 | 所属模块 | 严重度(高/中/低) | 一句证据 | 改进建议。\n` +
    `表格后附 1–2 句「全日总结」。不要备注、不要其他文本。如果事实不足以得出问题，则输出「今日无明显问题」。严禁虚构、严禁代你合理化猜测。`;

  try {
    const text = await chatComplete(
      [
        {
          role: 'system',
          content: '你是严谨的 RPA 项目复盘助手，只凭事实说话，不猜测、不虚构。输出中文。',
        },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.2, maxTokens: 1200 }
    );
    return text;
  } catch (err: any) {
    log.warn(`AI 归纳调用失败: ${err.message}`);
    return '';
  }
}

function renderAutoSection(targetDate: string, issues: LogIssue[], todayStat: DailyTaskStat, trend: DailyTaskStat[], aiSummary: string): string {
  const errorCount = issues.filter((x) => x.level === 'ERROR').length;
  const warnCount = issues.filter((x) => x.level === 'WARN').length;
  const otherCount = issues.length - errorCount - warnCount;

  // 任务状态格式化
  const statusOrder = ['pending', 'running', 'waiting-generation', 'review', 'approved', 'rejected', 'downloading', 'completed', 'failed'];
  const statusKeys = statusOrder.filter((s) => todayStat.byStatus[s]);
  const statusLine = statusKeys.length === 0 ? '_今日无新建任务_' : statusKeys.map((s) => `\`${s}\`: **${todayStat.byStatus[s]}**`).join(' ｜ ');

  // 失败原因 Top3
  const failedCount = todayStat.byStatus['failed'] || 0;
  let topErrLines: string;
  if (todayStat.topErrors.length > 0) {
    topErrLines = todayStat.topErrors.map((e, i) => `${i + 1}. \`${e.count}\` × ${e.reason}`).join('\n');
  } else if (failedCount > 0) {
    topErrLines = `_今日有 ${failedCount} 条失败任务，但未在 \`error\` 字段记录原因，请查阅 B 区日志清单_`;
  } else {
    topErrLines = '_今日无失败任务_';
  }

  // 日志问题清单（最多展示 30 条，超出折叠）
  const showIssues = issues.slice(0, 30);
  const issueRows = showIssues.length === 0
    ? '_今日无可识别的错误/警告/超时条目_'
    : showIssues
        .map((x) => `| ${x.level} | ${x.timestamp.split(' ')[1] || '-'} | ${x.module} | ${escapePipe(x.message)} | \`${x.file}:${x.line}\` |`)
        .join('\n');
  const issueOverflow = issues.length > 30 ? `\n\n> 共 ${issues.length} 条，已截断展示前 30 条。完整请查看 \`logs/\`。` : '';

  // 近 7 天趋势表
  const trendHeader = '| 日期 | 新建 | completed | failed | review | 其他 |\n|------|------|-----------|--------|--------|------|';
  const trendRows = trend.map((d) => {
    const completed = d.byStatus['completed'] || 0;
    const failed = d.byStatus['failed'] || 0;
    const review = d.byStatus['review'] || 0;
    const others = d.total - completed - failed - review;
    const isToday = d.date === targetDate ? ' **(今日)**' : '';
    return `| ${d.date}${isToday} | ${d.total} | ${completed} | ${failed} | ${review} | ${others} |`;
  }).join('\n');

  // D. AI 智能归纳（可选）
  const aiBlock = aiSummary
    ? `\n### D. AI 候选问题清单（仅供参考，请校正）\n\n${aiSummary}\n`
    : '\n### D. AI 候选问题清单\n\n_未启用 AI 归纳（未配置 LLM_API_KEY 或今日无数据）_\n';

  return `${AUTO_BEGIN}
> 🤖 由 \`daily-review\` 于 ${nowStr()} 自动生成。修改下方内容会在下次 23:00 重新生成时被覆盖；请把人工补充内容写在 AUTO 区块**之外**。

### A. 今日健康度概览

- 日志错误：**${errorCount}** 条 ｜ 警告：**${warnCount}** 条 ｜ 其他可疑：**${otherCount}** 条
- 今日任务：${statusLine}
- 失败原因 Top3：

${topErrLines}

### B. 今日日志问题清单

| 级别 | 时间 | 模块 | 摘要 | 位置 |
|------|------|------|------|------|
${issueRows}${issueOverflow}

### C. 近 7 天任务趋势

${trendHeader}
${trendRows}
${aiBlock}
${AUTO_END}`;
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
}

function nowStr(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${toLocalDate(d)} ${hh}:${mm}`;
}

/**
 * 生成或刷新当日复盘文档
 *
 * - 如果文件不存在：生成完整模板（含 AUTO 区块）
 * - 如果文件存在且包含 AUTO 区块：仅替换该区块，保留其余手工内容
 * - 如果文件存在但无 AUTO 区块：在文件末尾追加 AUTO 区块
 */
export async function generateDailyReview(date: Date = new Date()): Promise<{ filePath: string; targetDate: string }> {
  const targetDate = toLocalDate(date);
  const fileName = `复盘-${targetDate}-模拟流程问题记录.md`;
  const filePath = path.join(DOCS_DIR, fileName);

  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }

  log.info(`开始生成 ${targetDate} 复盘文档...`);

  const issues = scanLogIssues(targetDate);
  const tasks = loadAllTasks();
  const todayStat = statTasksByDate(tasks, targetDate);
  const trend = statRecentDays(tasks, date, 7);
  const aiSummary = await summarizeWithLLM(targetDate, issues, todayStat, tasks);
  const autoSection = renderAutoSection(targetDate, issues, todayStat, trend, aiSummary);

  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(AUTO_BEGIN) && content.includes(AUTO_END)) {
      const re = new RegExp(`${escapeReg(AUTO_BEGIN)}[\\s\\S]*?${escapeReg(AUTO_END)}`);
      content = content.replace(re, autoSection);
    } else {
      content = content.trimEnd() + '\n\n---\n\n## 自动汇总（每日 23:00 刷新）\n\n' + autoSection + '\n';
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    log.info(`✅ 已刷新自动汇总区块: ${path.relative(PROJECT_ROOT, filePath)}`);
  } else {
    const fullDoc = buildFullTemplate(targetDate, autoSection);
    fs.writeFileSync(filePath, fullDoc, 'utf-8');
    log.info(`✅ 已生成新复盘文档: ${path.relative(PROJECT_ROOT, filePath)}`);
  }

  log.info(
    `汇总: 日志问题 ${issues.length} 条 ｜ 今日任务 ${todayStat.total} 条 ｜ 失败 ${todayStat.byStatus['failed'] || 0} 条`
  );

  return { filePath, targetDate };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFullTemplate(targetDate: string, autoSection: string): string {
  return `# 模拟流程操作问题复盘

- **日期**：${targetDate}
- **场景**：RPA 系统 TikTok Symphony 视频生成端到端模拟流程
- **作者**：sloane

> 用途：记录今日模拟流程操作中遇到的问题、临时解决手段、是否需要继续改善，作为后续优化与复盘的依据。
> 字段说明：问题描述 / 复现路径 / 临时解决 / 根因初判 / 是否需要持续改善（✅需要 ⚠️观察 ❌已闭环） / 改进建议 Owner

---

## 一、问题清单总览

| # | 问题简述 | 模块 | 严重度 | 当前状态 | 是否需要改善 |
|---|---------|------|--------|---------|--------------|
| 1 | _待填写_ | _待填写_ | _高/中/低_ | _未解决/临时绕过/已修复_ | _✅/⚠️/❌_ |
| 2 | | | | | |

---

## 二、问题详细记录

### 问题 #1：（标题）

- **发生时间**：${targetDate} HH:MM
- **所在环节**：登录 / 批量导入 / AI 补全预览 / 商品图抓取 / 模板流程 / Agent 流程 / 视频生成等待 / 审核面板 / 下载 / 其他
- **问题描述**：
- **复现路径**：
- **临时解决**：
- **根因初判**：
- **是否需要持续改善**：⚠️ 待定
- **改进建议**：
  - [ ]
- **关联代码 / 日志**：

---

## 三、改进项跟踪（Action Items）

| ID | 行动项 | 优先级 | Owner | 截止 | 状态 |
|----|--------|--------|-------|------|------|
| A1 | _待填写_ | P0/P1/P2 | sloane | YYYY-MM-DD | TODO |

---

## 四、复盘结论

- **整体评价**：
- **最痛的 1 个问题**：
- **下一次模拟前必须先解决**：

---

## 五、自动汇总（每日 23:00 刷新）

${autoSection}
`;
}
