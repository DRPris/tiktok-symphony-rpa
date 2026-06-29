"""
登录态管理核心模块 - 管理 Playwright 浏览器会话和登录态
"""

import os
import asyncio
import logging

from playwright.async_api import async_playwright

import config
from utils import get_random_viewport, random_delay

logger = logging.getLogger("symphony_batch")


class SessionManager:
    """管理 Playwright 浏览器会话和登录态"""

    def __init__(self):
        self._playwright = None
        self._browser = None
        self._context = None

    async def init_browser(self, headless=False):
        """
        初始化浏览器，使用真实 Chromium，非 headless 模式
        采用持久化上下文保留 Cookie、LocalStorage、IndexedDB
        
        Args:
            headless: 是否无头模式，默认 False（TikTok 会检测无头浏览器）
        """
        self._playwright = await async_playwright().start()

        # 确保用户数据目录存在
        os.makedirs(config.USER_DATA_DIR, exist_ok=True)

        # 获取随机 viewport
        viewport = get_random_viewport()

        # 使用持久化上下文，保留所有浏览器状态
        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=config.USER_DATA_DIR,
            headless=headless,
            args=config.BROWSER_ARGS,
            user_agent=config.USER_AGENT,
            viewport=viewport,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            # 忽略 HTTPS 错误
            ignore_https_errors=True,
            # 接受下载
            accept_downloads=True,
        )

        logger.info(f"浏览器已启动 (viewport: {viewport['width']}x{viewport['height']})")
        return self._context

    async def load_session(self):
        """
        加载已保存的登录态，返回 browser_context
        持久化上下文模式下，状态会自动从 user_data_dir 加载
        
        Returns:
            browser_context 或 None（如果初始化失败）
        """
        if self._context is None:
            await self.init_browser(headless=False)
        return self._context

    async def save_session(self):
        """
        保存当前浏览器状态到文件
        持久化上下文会自动保存，此方法额外导出 storage_state 作为备份
        """
        if self._context is None:
            logger.warning("没有活跃的浏览器上下文，无法保存状态")
            return False

        try:
            # 确保 storage 目录存在
            os.makedirs(os.path.dirname(config.STORAGE_STATE_PATH), exist_ok=True)
            # 导出 storage state（Cookie + LocalStorage）作为备份
            await self._context.storage_state(path=config.STORAGE_STATE_PATH)
            logger.info(f"登录态已保存到: {config.STORAGE_STATE_PATH}")
            return True
        except Exception as e:
            logger.error(f"保存登录态失败: {e}")
            return False

    async def is_session_valid(self):
        """
        检测当前 session 是否有效（Cookie 未过期）
        方法：导航到 Symphony 页面，检查是否被重定向到登录页
        
        Returns:
            bool: True 表示登录态有效
        """
        if self._context is None:
            return False

        page = None
        try:
            # 新开一个页面进行检测，避免影响当前工作页面
            page = await self._context.new_page()
            
            # 导航到 Symphony 首页
            await page.goto(config.SYMPHONY_URL, wait_until="domcontentloaded", timeout=30000)
            
            # 等待页面加载完成
            await random_delay(2, 4)

            # 获取当前 URL
            current_url = page.url

            # 判断是否被重定向到登录页
            login_indicators = ["login", "signin", "sign-in", "sign_in", "i18n/login"]
            is_valid = not any(indicator in current_url.lower() for indicator in login_indicators)

            if is_valid:
                logger.info("登录态有效 ✓")
            else:
                logger.warning(f"登录态已失效，当前页面: {current_url}")

            return is_valid

        except Exception as e:
            logger.error(f"检测登录态时出错: {e}")
            return False
        finally:
            if page:
                await page.close()

    async def get_context(self):
        """
        获取可用的浏览器上下文
        如果 session 有效直接返回，否则提示用户重新登录
        
        Returns:
            browser_context 或抛出异常
        """
        # 确保浏览器已初始化
        if self._context is None:
            await self.init_browser(headless=False)

        # 检查登录态
        if await self.is_session_valid():
            return self._context

        # 登录态无效，提示用户
        raise SessionExpiredError(
            "登录态已过期，请运行 `python login.py` 重新登录"
        )

    async def close(self):
        """关闭浏览器，释放所有资源"""
        try:
            if self._context:
                # 保存状态后关闭
                await self.save_session()
                await self._context.close()
                self._context = None
                logger.info("浏览器上下文已关闭")

            if self._playwright:
                await self._playwright.stop()
                self._playwright = None
                logger.info("Playwright 已停止")
        except Exception as e:
            logger.error(f"关闭浏览器时出错: {e}")


class SessionExpiredError(Exception):
    """登录态过期异常"""
    pass
