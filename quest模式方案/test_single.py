"""
单视频测试脚本 - 验证某个生成模式是否正常工作

使用示例：
    python test_single.py --mode generate_remix --url "https://example.com/product"
    python test_single.py --mode generate_remix --description "一款有机棉婴儿T恤" --language English
    python test_single.py --mode image_to_video --image "test.jpg" --prompt "产品展示"
    python test_single.py --mode ai_avatar --avatar "avatar_001" --script "Hello world" --language English
    python test_single.py --mode text_to_video --text "A product showcase video" --style cinematic
"""

import os
import sys
import argparse
import asyncio
import logging
from datetime import datetime

# 确保可以导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rich.console import Console
from rich.panel import Panel

import config
from session_manager import SessionManager, SessionExpiredError
from utils import setup_logging, get_output_path
from generators import get_generator, GENERATOR_REGISTRY, GenerationError

console = Console()


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description="Symphony 单视频生成测试脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--mode",
        required=True,
        choices=list(GENERATOR_REGISTRY.keys()),
        help="生成模式",
    )

    # generate_remix 输入
    parser.add_argument("--url", default=None, help="产品 URL（generate_remix）")
    parser.add_argument(
        "--images",
        nargs="*",
        default=None,
        help="产品图片路径列表（generate_remix，最多4张）",
    )
    parser.add_argument(
        "--description", default=None, help="产品描述（generate_remix）"
    )

    # image_to_video 输入
    parser.add_argument("--image", default=None, help="单张图片路径（image_to_video）")

    # ai_avatar 输入
    parser.add_argument("--avatar", default=None, help="数字形象 ID 或名称（ai_avatar）")
    parser.add_argument("--script", default=None, help="脚本文本（ai_avatar）")
    parser.add_argument("--voice", default=None, help="配音名称（ai_avatar，可选）")

    # text_to_video 输入
    parser.add_argument("--text", default=None, help="文本描述（text_to_video）")
    parser.add_argument(
        "--style", default=None, help="视频风格（text_to_video，可选）"
    )

    # 通用参数
    parser.add_argument("--prompt", default=None, help="额外创意提示词（可选）")
    parser.add_argument("--language", default="English", help="语言（默认 English）")
    parser.add_argument(
        "--product-name",
        default=None,
        help="产品名称，用于生成输出文件名（默认根据模式和时间戳生成）",
    )
    parser.add_argument("--output", default=None, help="输出文件路径（覆盖默认值）")
    parser.add_argument("--headless", action="store_true", help="无头模式运行")

    return parser.parse_args()


def build_task_data(args) -> dict:
    """根据 mode 和命令行参数构造 task_data 字典"""
    mode = args.mode

    if mode == "generate_remix":
        if not (args.url or args.images or args.description):
            raise ValueError(
                "generate_remix 模式需要至少提供 --url、--images 或 --description 之一"
            )
        return {
            "product_url": args.url,
            "images": args.images,
            "description": args.description,
            "language": args.language,
            "prompt": args.prompt,
        }

    elif mode == "image_to_video":
        if not args.image:
            raise ValueError("image_to_video 模式需要 --image")
        if not args.prompt:
            raise ValueError("image_to_video 模式需要 --prompt")
        return {
            "image": args.image,
            "prompt": args.prompt,
            "language": args.language,
        }

    elif mode == "ai_avatar":
        if not args.script:
            raise ValueError("ai_avatar 模式需要 --script")
        return {
            "avatar_id": args.avatar,
            "script": args.script,
            "language": args.language,
            "voice": args.voice,
        }

    elif mode == "text_to_video":
        if not args.text:
            raise ValueError("text_to_video 模式需要 --text")
        return {
            "text": args.text,
            "style": args.style,
            "language": args.language,
        }

    raise ValueError(f"不支持的模式: {mode}")


def resolve_output_path(args) -> str:
    """根据参数计算最终的输出文件路径"""
    if args.output:
        return os.path.abspath(args.output)

    # 根据 product_name 或时间戳构造文件名
    product_name = args.product_name or f"{args.mode}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    return get_output_path(product_name)


async def run_test(args):
    """执行单视频生成测试流程"""
    logger = setup_logging(level=logging.INFO)

    # 显示欢迎信息
    console.print()
    console.print(
        Panel(
            f"[bold cyan]Symphony 单视频生成测试[/bold cyan]\n\n"
            f"模式: [bold]{args.mode}[/bold]\n"
            f"语言: {args.language}",
            title="🎬 Test Single",
            border_style="cyan",
        )
    )
    console.print()

    # 1. 构造 task_data
    try:
        task_data = build_task_data(args)
    except ValueError as e:
        console.print(f"[bold red]✗ 参数错误: {e}[/bold red]")
        return False

    output_path = resolve_output_path(args)
    console.print(f"[dim]输出路径: {output_path}[/dim]")
    console.print()

    # 2. 初始化 SessionManager 并校验登录态
    session = SessionManager()

    try:
        console.print("[bold yellow]步骤 1/3[/bold yellow] 启动浏览器并加载登录态...")
        context = await session.init_browser(headless=args.headless)

        # 检查登录态
        try:
            await session.get_context()
        except SessionExpiredError as e:
            console.print(f"[bold red]✗ {e}[/bold red]")
            return False
        console.print("[green]  ✓ 登录态有效[/green]")

        # 3. 创建/获取 page
        pages = context.pages
        page = pages[0] if pages else await context.new_page()

        # 4. 实例化生成器并运行
        console.print(f"[bold yellow]步骤 2/3[/bold yellow] 调用 [cyan]{args.mode}[/cyan] 生成器...")
        GeneratorClass = get_generator(args.mode)
        generator = GeneratorClass(page)

        saved_path = await generator.run(task_data, output_path)

        console.print(f"[bold yellow]步骤 3/3[/bold yellow] 任务完成")
        console.print()
        console.print(
            Panel(
                f"[bold green]✓ 视频生成成功[/bold green]\n\n"
                f"模式: {args.mode}\n"
                f"输出: {saved_path}\n"
                f"大小: {os.path.getsize(saved_path) / 1024 / 1024:.2f} MB"
                if os.path.exists(saved_path)
                else f"[bold green]✓ 流程结束[/bold green]\n\n输出: {saved_path}",
                title="✅ 完成",
                border_style="green",
            )
        )
        return True

    except KeyboardInterrupt:
        console.print("\n[yellow]用户中断操作[/yellow]")
        return False
    except (GenerationError, TimeoutError) as e:
        console.print(f"\n[bold red]✗ 生成失败: {e}[/bold red]")
        logger.exception("生成失败")
        return False
    except Exception as e:
        console.print(f"\n[bold red]✗ 未知错误: {e}[/bold red]")
        logger.exception("test_single 异常")
        return False
    finally:
        console.print("\n[dim]正在关闭浏览器...[/dim]")
        await session.close()
        console.print("[dim]浏览器已关闭[/dim]")


def main():
    """入口函数"""
    args = parse_args()
    success = asyncio.run(run_test(args))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
