"""
登录引导脚本 - 用户运行此脚本手动登录 TikTok For Business
使用方法: python login.py
"""

import asyncio
import sys
import os

# 确保可以导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

import config
from session_manager import SessionManager
from utils import setup_logging, random_delay

console = Console()


async def login_flow():
    """登录流程主函数"""
    
    # 配置日志
    logger = setup_logging()
    
    # 显示欢迎信息
    console.print()
    console.print(Panel(
        "[bold cyan]TikTok Symphony 登录引导[/bold cyan]\n\n"
        "此脚本将打开浏览器，请在浏览器中手动登录 TikTok For Business。\n"
        "登录成功后，系统将自动保存登录态。",
        title="🎵 Symphony Batch Tool",
        border_style="cyan",
    ))
    console.print()

    session = SessionManager()

    try:
        # 步骤1：初始化浏览器
        console.print("[bold yellow]步骤 1/4[/bold yellow] 正在启动浏览器...")
        context = await session.init_browser(headless=False)
        console.print("[green]  ✓ 浏览器已启动[/green]")

        # 步骤2：导航到登录页面
        console.print("[bold yellow]步骤 2/4[/bold yellow] 正在打开 TikTok 登录页面...")
        
        # 获取当前页面或新建页面
        pages = context.pages
        page = pages[0] if pages else await context.new_page()
        
        await page.goto(config.SYMPHONY_URL, wait_until="domcontentloaded", timeout=60000)
        await random_delay(1, 2)
        
        current_url = page.url
        console.print(f"[green]  ✓ 已打开页面: {current_url}[/green]")
        console.print()

        # 步骤3：等待用户手动登录
        console.print(Panel(
            "[bold yellow]请在浏览器中手动登录 TikTok For Business[/bold yellow]\n\n"
            "• 输入邮箱/手机号和密码\n"
            "• 完成验证码（如果有）\n"
            "• 确保成功进入 Symphony Creative Studio 页面\n\n"
            "[dim]系统正在监听页面变化，登录成功后将自动检测...[/dim]",
            title="⏳ 等待登录",
            border_style="yellow",
        ))

        # 轮询检测登录状态
        max_wait_time = 300  # 最长等待5分钟
        poll_interval = 3  # 每3秒检测一次
        elapsed = 0

        while elapsed < max_wait_time:
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

            # 获取当前 URL
            try:
                current_url = page.url
            except Exception:
                # 页面可能被关闭或跳转
                pages = context.pages
                if pages:
                    page = pages[-1]
                    current_url = page.url
                else:
                    continue

            # 检查是否已经离开登录页面并到达 Symphony
            login_indicators = ["login", "signin", "sign-in", "sign_in", "i18n/login"]
            is_on_login_page = any(indicator in current_url.lower() for indicator in login_indicators)

            # 如果不在登录页面，且 URL 包含 creative 或 ads.tiktok.com 的业务页面
            if not is_on_login_page and "ads.tiktok.com" in current_url:
                console.print()
                console.print("[bold green]  ✓ 检测到登录成功！[/bold green]")
                break

            # 每30秒提示一次
            if elapsed % 30 == 0:
                remaining = max_wait_time - elapsed
                console.print(f"[dim]  ... 仍在等待登录（剩余 {remaining} 秒）[/dim]")
        else:
            console.print("[bold red]  ✗ 等待超时（5分钟），请重新运行此脚本[/bold red]")
            await session.close()
            return False

        # 步骤4：保存登录态
        console.print("[bold yellow]步骤 3/4[/bold yellow] 正在保存登录态...")
        
        # 等待页面完全加载
        await random_delay(3, 5)
        
        # 保存状态
        success = await session.save_session()
        
        if success:
            console.print("[green]  ✓ 登录态已保存[/green]")
        else:
            console.print("[yellow]  ⚠ 状态文件保存失败，但持久化目录中的状态仍然有效[/yellow]")

        # 验证
        console.print("[bold yellow]步骤 4/4[/bold yellow] 正在验证登录态...")
        is_valid = await session.is_session_valid()
        
        if is_valid:
            console.print("[green]  ✓ 登录态验证通过[/green]")
            console.print()
            console.print(Panel(
                "[bold green]登录态已保存成功！[/bold green]\n\n"
                "后续运行批量任务时将自动使用此登录态。\n"
                f"状态文件: {config.STORAGE_STATE_PATH}\n"
                f"浏览器数据: {config.USER_DATA_DIR}\n\n"
                "[dim]如果登录态过期，请重新运行此脚本。[/dim]",
                title="✅ 完成",
                border_style="green",
            ))
        else:
            console.print("[yellow]  ⚠ 验证未通过，但登录态可能仍然有效[/yellow]")
            console.print("[dim]  如遇问题，请重新运行此脚本[/dim]")

        return True

    except KeyboardInterrupt:
        console.print("\n[yellow]用户中断操作[/yellow]")
        return False
    except Exception as e:
        console.print(f"\n[bold red]出错: {e}[/bold red]")
        logger.exception("登录流程异常")
        return False
    finally:
        # 关闭浏览器
        console.print("\n[dim]正在关闭浏览器...[/dim]")
        await session.close()
        console.print("[dim]浏览器已关闭[/dim]")


def main():
    """入口函数"""
    asyncio.run(login_flow())


if __name__ == "__main__":
    main()
