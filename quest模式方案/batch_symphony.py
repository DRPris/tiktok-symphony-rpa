"""
Symphony 批量生成 - CLI 主入口

用法示例：
    # 标准批量
    python batch_symphony.py --input products.csv

    # 指定并发数
    python batch_symphony.py --input products.csv --concurrent 5

    # 断点续传
    python batch_symphony.py --resume

    # 生成示例 CSV
    python batch_symphony.py --gen-sample sample_products.csv

    # 仅校验 CSV，不实际执行
    python batch_symphony.py --input products.csv --dry-run
"""

import os
import sys
import signal
import asyncio
import logging
import argparse
from typing import Optional

# 确保可以导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rich.console import Console
from rich.panel import Panel

import config
from utils import setup_logging
from csv_parser import CSVParser

console = Console()


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description="Symphony 批量视频生成工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--input",
        "-i",
        default=None,
        help="产品 CSV 文件路径",
    )
    parser.add_argument(
        "--concurrent",
        "-c",
        type=int,
        default=None,
        help=f"最大并发 Tab 数（默认 {config.MAX_CONCURRENT_TABS}）",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="断点续传：将未完成任务重置为 pending 继续运行",
    )
    parser.add_argument(
        "--batch-id",
        default=None,
        help="指定批次 ID（默认自动生成或使用最近批次）",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="无头浏览器模式",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅校验 CSV 与解析任务，不真正运行",
    )
    parser.add_argument(
        "--gen-sample",
        default=None,
        help="生成示例 CSV 到指定路径并退出",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="日志级别（默认 INFO）",
    )

    return parser.parse_args()


# ===== 子命令 =====

def cmd_gen_sample(path: str) -> int:
    """生成示例 CSV"""
    CSVParser.generate_sample_csv(path)
    console.print(
        Panel(
            f"[green]✓ 示例 CSV 已生成：[/green]\n[bold]{os.path.abspath(path)}[/bold]",
            title="📄 Sample CSV",
            border_style="green",
        )
    )
    return 0


async def cmd_dry_run(input_csv: str) -> int:
    """仅校验 CSV，不实际执行"""
    if not input_csv or not os.path.exists(input_csv):
        console.print(f"[bold red]✗ 找不到输入文件：{input_csv}[/bold red]")
        return 1

    tasks = CSVParser.parse(input_csv)
    valid, errors = CSVParser.validate(tasks)

    console.print(
        Panel(
            f"[bold]文件：[/bold] {input_csv}\n"
            f"[bold]总行数：[/bold] {len(tasks)}\n"
            f"[bold green]有效任务：[/bold green] {len(valid)}\n"
            f"[bold red]无效任务：[/bold red] {len(errors)}",
            title="🔍 CSV 校验结果",
            border_style="cyan",
        )
    )

    if errors:
        console.print("[bold red]错误明细：[/bold red]")
        for err in errors:
            console.print(f"  • [red]{err}[/red]")

    if valid:
        console.print("\n[bold green]有效任务预览（前 5 条）：[/bold green]")
        for t in valid[:5]:
            console.print(f"  • [bold]{t['product_name']}[/bold] "
                          f"({t['mode']}) → {t['task_data']}")

    return 0 if not errors else 2


# ===== 主流程 =====

async def run_batch(args) -> int:
    """执行批量任务的主流程"""
    setup_logging(level=getattr(logging, args.log_level))

    # 延迟导入需要 aiosqlite/Playwright 的模块，便于轻量子命令快速失败
    from session_manager import SessionManager, SessionExpiredError
    from task_queue import TaskQueue
    from batch_engine import BatchEngine

    concurrent = args.concurrent or config.MAX_CONCURRENT_TABS

    console.print()
    console.print(
        Panel(
            f"[bold cyan]Symphony 批量视频生成[/bold cyan]\n\n"
            f"输入：     {args.input or '(断点续传模式)'}\n"
            f"并发：     {concurrent}\n"
            f"模式：     {'断点续传' if args.resume else '新批次'}\n"
            f"无头：     {args.headless}",
            title="🎬 Symphony Batch",
            border_style="cyan",
        )
    )
    console.print()

    # 1. 初始化任务队列
    task_queue = TaskQueue()
    await task_queue.init_db()

    # 2. 决定 batch_id
    if args.resume:
        # 断点续传：使用指定的或最近的批次
        batch_id = args.batch_id or await task_queue.get_latest_batch_id()
        if not batch_id:
            console.print("[bold red]✗ 未找到任何历史批次，无法断点续传[/bold red]")
            return 1
        task_queue.set_batch_id(batch_id)
        console.print(f"[cyan]📂 断点续传批次：[/cyan] [bold]{batch_id}[/bold]")
        # 重置 running/waiting/downloading 任务为 pending
        await task_queue.reset_running_tasks()

        # 如果同时给了 input，则把新任务并入当前批次
        if args.input and os.path.exists(args.input):
            console.print(f"[cyan]同时合并新 CSV：[/cyan] {args.input}")
            await task_queue.load_from_csv(
                args.input, batch_id=batch_id, skip_existing_done=True
            )
    else:
        # 新批次
        if not args.input:
            console.print("[bold red]✗ 必须通过 --input 指定 CSV 文件，"
                          "或使用 --resume 续传[/bold red]")
            return 1
        if not os.path.exists(args.input):
            console.print(f"[bold red]✗ 找不到输入文件：{args.input}[/bold red]")
            return 1

        batch_id = args.batch_id or TaskQueue.generate_batch_id()
        task_queue.set_batch_id(batch_id)
        console.print(f"[cyan]🆕 创建新批次：[/cyan] [bold]{batch_id}[/bold]")
        # 检查是否存在中断的批次
        if await task_queue.has_unfinished_tasks(batch_id=None):
            console.print(
                "[yellow]⚠ 检测到历史未完成任务，建议使用 --resume 续传[/yellow]"
            )
        await task_queue.load_from_csv(
            args.input, batch_id=batch_id, skip_existing_done=True
        )

    # 3. 校验是否有任务
    stats = await task_queue.get_stats()
    pending_count = stats.get(TaskQueue.STATUS_PENDING, 0)
    if pending_count == 0:
        console.print("[yellow]当前批次没有待处理任务，已退出[/yellow]")
        return 0

    # 4. 启动浏览器
    session = SessionManager()
    engine: Optional[BatchEngine] = None
    exit_code = 0

    # 注册信号处理（Ctrl+C 优雅退出）
    loop = asyncio.get_event_loop()
    stop_event = asyncio.Event()

    def _on_signal():
        if not stop_event.is_set():
            console.print("\n[yellow]⚠ 收到中断信号，正在优雅退出...[/yellow]")
            stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _on_signal)
        except (NotImplementedError, RuntimeError):
            # Windows 不支持 add_signal_handler
            pass

    try:
        await session.init_browser(headless=args.headless)
        try:
            await session.get_context()
        except SessionExpiredError as e:
            console.print(f"[bold red]✗ {e}[/bold red]")
            return 1

        engine = BatchEngine(
            session_manager=session,
            task_queue=task_queue,
            max_concurrent=concurrent,
        )

        # 并发监听 Ctrl+C 与批量任务
        engine_task = asyncio.create_task(engine.start())
        stop_task = asyncio.create_task(stop_event.wait())

        done, pending = await asyncio.wait(
            {engine_task, stop_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        if stop_task in done and not engine_task.done():
            # 用户中断
            await engine.stop()
            try:
                await asyncio.wait_for(engine_task, timeout=30)
            except asyncio.TimeoutError:
                engine_task.cancel()
            exit_code = 130
        else:
            stop_task.cancel()

    except Exception as e:
        console.print(f"[bold red]✗ 批量处理异常：{e}[/bold red]")
        logging.getLogger("symphony_batch").exception("批量异常")
        exit_code = 1

    finally:
        # 关闭浏览器
        console.print("\n[dim]正在关闭浏览器...[/dim]")
        try:
            await session.close()
        except Exception:
            pass

        # 输出最终状态行
        final_stats = await task_queue.get_stats()
        console.print(
            f"\n[dim]最终状态: "
            f"完成 {final_stats.get(TaskQueue.STATUS_DONE, 0)} | "
            f"失败 {final_stats.get(TaskQueue.STATUS_FAILED, 0)} | "
            f"未完成 {final_stats.get(TaskQueue.STATUS_PENDING, 0)}[/dim]"
        )

    return exit_code


def main():
    """命令行入口"""
    args = parse_args()

    # 子命令：生成示例 CSV
    if args.gen_sample:
        sys.exit(cmd_gen_sample(args.gen_sample))

    # 子命令：dry-run
    if args.dry_run:
        sys.exit(asyncio.run(cmd_dry_run(args.input)))

    # 主流程
    try:
        exit_code = asyncio.run(run_batch(args))
    except KeyboardInterrupt:
        console.print("\n[yellow]用户中断[/yellow]")
        exit_code = 130
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
