"""
批量编排引擎核心 - 多Tab并发控制 + 任务调度 + 错误恢复 + 进度展示
"""

import os
import sys
import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

# 确保可以导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import (
    Progress,
    SpinnerColumn,
    TextColumn,
    BarColumn,
    TaskProgressColumn,
    TimeElapsedColumn,
)
from rich.live import Live

import config
from task_queue import TaskQueue
from session_manager import SessionManager
from utils import get_output_path, random_delay
from generators import get_generator, GenerationError

logger = logging.getLogger("symphony_batch")
console = Console()


# CAPTCHA 检测关键词（从页面 URL/文字中识别）
CAPTCHA_INDICATORS = [
    "captcha",
    "verify",
    "verification",
    "robot",
    "challenge",
    "secsdk",
]


class BatchEngine:
    """批量视频生成引擎 - 多Tab并发控制"""

    # 重试退避基数（秒）：第 n 次重试等待 BACKOFF_BASE ** n 秒
    BACKOFF_BASE = 3

    def __init__(
        self,
        session_manager: SessionManager,
        task_queue: TaskQueue,
        max_concurrent: int = 3,
    ):
        self.session_manager = session_manager
        self.task_queue = task_queue
        self.max_concurrent = max_concurrent
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self._running = True
        self._paused = False
        self._active_pages: List[Any] = []
        self._active_tasks: List[asyncio.Task] = []
        # CAPTCHA 互斥锁，避免重复弹出提示
        self._captcha_lock = asyncio.Lock()
        self._start_time: Optional[float] = None

    # ===== 主入口 =====

    async def start(self) -> Dict[str, int]:
        """
        启动批量处理

        Returns:
            最终统计字典
        """
        self._start_time = time.time()
        self._running = True

        # 1. 获取浏览器上下文
        console.print("[bold cyan]▶ 正在获取浏览器上下文...[/bold cyan]")
        context = await self.session_manager.get_context()
        console.print("[green]  ✓ 浏览器就绪[/green]")

        # 2. 取出全部 pending 任务
        tasks = await self.task_queue.get_pending_tasks()
        if not tasks:
            console.print("[yellow]当前批次没有待处理任务[/yellow]")
            return await self.task_queue.get_stats()

        total = len(tasks)
        console.print(
            Panel(
                f"[bold]并发 Tab 数：[/bold] {self.max_concurrent}\n"
                f"[bold]待处理任务：[/bold] {total}\n"
                f"[bold]批次 ID：[/bold] {self.task_queue.get_batch_id()}",
                title="🚀 Symphony 批量生成",
                border_style="cyan",
            )
        )

        # 3. 进度条 + 并发执行
        with Progress(
            SpinnerColumn(),
            TextColumn("[bold blue]{task.description}"),
            BarColumn(bar_width=40),
            TaskProgressColumn(),
            TextColumn("• 完成 [green]{task.completed}[/green]/[bold]{task.total}[/bold]"),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            progress_task = progress.add_task("批量生成中", total=total)

            coroutines = [
                self._process_task_wrapper(context, task, progress, progress_task)
                for task in tasks
            ]
            self._active_tasks = [asyncio.create_task(c) for c in coroutines]

            try:
                await asyncio.gather(*self._active_tasks, return_exceptions=True)
            except asyncio.CancelledError:
                logger.warning("批量任务被取消")

        # 4. 汇总报告
        stats = await self.task_queue.get_stats()
        await self._render_report(stats)
        return stats

    async def _process_task_wrapper(
        self, context, task: Dict[str, Any], progress: Progress, progress_task_id
    ):
        """处理任务的外层包装：负责更新进度条"""
        try:
            await self.process_task(context, task)
        finally:
            progress.update(progress_task_id, advance=1)

    # ===== 单任务处理 =====

    async def process_task(self, context, task: Dict[str, Any]):
        """
        处理单个任务（含重试逻辑）

        Args:
            context: 浏览器上下文
            task: 任务字典
        """
        async with self.semaphore:
            # 等待可能的暂停（CAPTCHA）
            await self._wait_if_paused()

            if not self._running:
                return

            task_id = task["id"]
            product_name = task["product_name"]
            mode = task["mode"]
            task_data = task["task_data"]

            page = None
            try:
                page = await context.new_page()
                self._active_pages.append(page)

                await self.task_queue.update_status(
                    task_id, TaskQueue.STATUS_RUNNING
                )
                console.log(f"[blue]▶[/blue] [bold]{product_name}[/bold] "
                            f"({mode}) 开始处理")

                # 调用具体生成器
                output_path = get_output_path(product_name)
                GeneratorClass = get_generator(mode)
                generator = GeneratorClass(page)

                # 标记进入等待阶段
                await self.task_queue.update_status(
                    task_id, TaskQueue.STATUS_WAITING
                )

                saved_path = await generator.run(task_data, output_path)

                await self.task_queue.update_status(
                    task_id,
                    TaskQueue.STATUS_DONE,
                    output_path=saved_path,
                )
                console.log(
                    f"[green]✓[/green] [bold]{product_name}[/bold] "
                    f"({mode}) 完成 → {saved_path}"
                )

            except Exception as e:
                # 检测 CAPTCHA
                if page is not None and await self._looks_like_captcha(page, e):
                    await self.handle_captcha(page)
                    # CAPTCHA 解除后，将本任务重置为 pending，由后续运行处理
                    await self.task_queue.update_status(
                        task_id,
                        TaskQueue.STATUS_PENDING,
                        error_msg="CAPTCHA 已暂停",
                    )
                    return

                # 普通错误：尝试重试
                await self._handle_error(context, task, e)

            finally:
                if page is not None:
                    if page in self._active_pages:
                        self._active_pages.remove(page)
                    try:
                        await page.close()
                    except Exception:
                        pass

    # ===== 错误处理与重试 =====

    async def _handle_error(self, context, task: Dict[str, Any], error: Exception):
        """处理任务错误：根据当前重试次数决定是否重试"""
        task_id = task["id"]
        product_name = task["product_name"]
        retries = await self.task_queue.increment_retry(task_id)

        if retries < config.MAX_RETRIES:
            # 计算退避时长（指数退避）
            backoff = self.BACKOFF_BASE ** (retries - 1) if retries > 0 else 1
            console.log(
                f"[yellow]⟳[/yellow] [bold]{product_name}[/bold] 第 {retries} 次重试 "
                f"({backoff}s 后)：{error}"
            )
            await self.task_queue.update_status(
                task_id,
                TaskQueue.STATUS_PENDING,
                error_msg=f"重试 {retries}/{config.MAX_RETRIES}: {error}",
            )
            await asyncio.sleep(backoff)

            # 直接在当前协程中再次执行任务
            await self.process_task(context, task)
        else:
            await self.task_queue.update_status(
                task_id,
                TaskQueue.STATUS_FAILED,
                error_msg=str(error),
            )
            console.log(
                f"[red]✗[/red] [bold]{product_name}[/bold] 失败 "
                f"(重试 {retries} 次后放弃)：{error}"
            )

    # ===== CAPTCHA 处理 =====

    async def _looks_like_captcha(self, page, error: Exception) -> bool:
        """根据当前页面信息判断是否触发了 CAPTCHA"""
        try:
            url = (page.url or "").lower()
            if any(ind in url for ind in CAPTCHA_INDICATORS):
                return True
            # 查找页面中典型的验证码元素
            for selector in [
                'iframe[src*="captcha"]',
                'div[class*="captcha"]',
                'div[id*="captcha"]',
                '[class*="verify"]',
            ]:
                try:
                    el = await page.query_selector(selector)
                    if el and await el.is_visible():
                        return True
                except Exception:
                    continue
        except Exception:
            pass

        # 错误信息中含相关关键词
        msg = str(error).lower()
        return any(ind in msg for ind in CAPTCHA_INDICATORS)

    async def handle_captcha(self, page=None):
        """检测到 CAPTCHA 时暂停批量，通知用户手动处理"""
        # 防止多个任务同时弹提示
        async with self._captcha_lock:
            if self._paused:
                # 已经在暂停状态，等待恢复
                return
            self._paused = True
            self._running = False

            console.print()
            console.print(
                Panel(
                    "[bold yellow]⚠ 检测到验证码（CAPTCHA）！[/bold yellow]\n\n"
                    "批量处理已 [bold red]暂停[/bold red]。\n\n"
                    "请在浏览器中完成验证后回到此终端。\n\n"
                    "[dim]按 [bold]Enter[/bold] 继续，输入 [bold]q[/bold] 后回车终止批量[/dim]",
                    title="🛡️ CAPTCHA",
                    border_style="yellow",
                )
            )

            # 阻塞等待用户输入（在 executor 中执行避免阻塞 event loop）
            loop = asyncio.get_event_loop()
            answer = await loop.run_in_executor(None, input, ">>> ")

            if answer.strip().lower() in ("q", "quit", "exit"):
                console.print("[red]用户终止批量处理[/red]")
                self._paused = False
                await self.stop()
                return

            console.print("[green]✓ 已恢复批量处理[/green]")
            self._paused = False
            self._running = True

    async def _wait_if_paused(self):
        """如果当前处于暂停状态则等待恢复"""
        while self._paused and self._running:
            await asyncio.sleep(0.5)

    # ===== 优雅停止 =====

    async def stop(self):
        """优雅停止：等待当前活跃任务结束并关闭所有页面"""
        self._running = False
        self._paused = False
        console.print("[yellow]正在等待当前任务结束...[/yellow]")

        # 取消所有未开始的任务
        for t in self._active_tasks:
            if not t.done():
                t.cancel()

        # 等待已开始的页面关闭
        for page in list(self._active_pages):
            try:
                await page.close()
            except Exception:
                pass
        self._active_pages.clear()

    # ===== 汇总报告 =====

    async def _render_report(self, stats: Dict[str, int]):
        """生成并打印批量处理汇总报告"""
        elapsed = time.time() - (self._start_time or time.time())
        total = stats.get("total", 0)
        done = stats.get(TaskQueue.STATUS_DONE, 0)
        failed = stats.get(TaskQueue.STATUS_FAILED, 0)
        pending = stats.get(TaskQueue.STATUS_PENDING, 0)

        # 百分比
        success_pct = (done / total * 100) if total else 0
        fail_pct = (failed / total * 100) if total else 0
        # 总耗时
        elapsed_str = self._format_duration(elapsed)
        avg_str = (
            self._format_duration(elapsed / done)
            if done
            else "—"
        )

        # 主表格
        table = Table(
            title="📊 Symphony 批量生成报告",
            border_style="cyan",
            show_header=True,
            header_style="bold cyan",
            title_style="bold cyan",
        )
        table.add_column("指标", style="bold", width=18)
        table.add_column("值", justify="right")

        table.add_row("总任务数", str(total))
        table.add_row(
            "成功", f"[green]{done}[/green] ({success_pct:.1f}%)"
        )
        table.add_row(
            "失败", f"[red]{failed}[/red] ({fail_pct:.1f}%)"
        )
        if pending:
            table.add_row("未处理", f"[yellow]{pending}[/yellow]")
        table.add_row("总耗时", elapsed_str)
        table.add_row("平均耗时", f"{avg_str}/个")

        console.print()
        console.print(table)

        # 失败任务清单
        failed_tasks = await self.task_queue.get_failed_tasks()
        if failed_tasks:
            fail_table = Table(
                title="❌ 失败任务清单",
                border_style="red",
                show_header=True,
                header_style="bold red",
            )
            fail_table.add_column("产品名", style="bold")
            fail_table.add_column("模式")
            fail_table.add_column("重试", justify="right")
            fail_table.add_column("错误信息", style="dim")
            for t in failed_tasks:
                fail_table.add_row(
                    t.get("product_name") or "-",
                    t.get("mode") or "-",
                    str(t.get("retries") or 0),
                    (t.get("error_msg") or "")[:80],
                )
            console.print()
            console.print(fail_table)

    @staticmethod
    def _format_duration(seconds: float) -> str:
        """将秒数格式化为 'Xh Ym Zs' 或 'Xm Ys'"""
        seconds = max(0, int(seconds))
        hours, rem = divmod(seconds, 3600)
        mins, secs = divmod(rem, 60)
        if hours:
            return f"{hours}小时{mins}分{secs}秒"
        if mins:
            return f"{mins}分{secs}秒"
        return f"{secs}秒"

    # 兼容旧文档中的方法名
    def generate_report(self, stats: Dict[str, int]):
        """同步包装 _render_report，便于在外层手工调用"""
        asyncio.get_event_loop().run_until_complete(self._render_report(stats))
