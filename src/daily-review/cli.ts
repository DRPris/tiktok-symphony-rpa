/**
 * 手动触发每日复盘文档生成（不依赖主进程）
 *
 * 用法：
 *   npm run daily-review               # 生成今日复盘
 *   npm run daily-review -- 2026-06-01 # 生成指定日期复盘（YYYY-MM-DD）
 */

import { generateDailyReview } from './generator';

async function main() {
  const arg = process.argv[2];
  let date = new Date();
  if (arg) {
    const m = arg.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      console.error(`❌ 日期格式错误，应为 YYYY-MM-DD，收到: ${arg}`);
      process.exit(1);
    }
    date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const { filePath, targetDate } = await generateDailyReview(date);
  console.log(`✅ ${targetDate} 复盘文档已生成: ${filePath}`);
}

main().catch((err) => {
  console.error('生成失败:', err);
  process.exit(1);
});
