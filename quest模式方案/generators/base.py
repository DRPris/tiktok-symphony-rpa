"""
基础生成器抽象类 - 定义所有视频生成模式的统一接口
所有具体生成器（generate_remix、image_to_video、ai_avatar、text_to_video）继承此基类
"""

import os
import sys
import time
import asyncio
import logging
from typing import Optional, List, Union

# 确保可以导入项目根目录的模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rich.console import Console

import config
from utils import random_delay

logger = logging.getLogger("symphony_batch")
console = Console()


class GenerationError(Exception):
    """视频生成失败异常"""
    pass


class ElementNotFoundError(Exception):
    """页面元素未找到异常"""
    pass


class BaseGenerator:
    """
    所有视频生成模式的基类
    
    定义统一的生成流程：导航 → 填写 → 配置 → 生成 → 等待 → 下载
    子类需要重写各个抽象方法，并在类顶部定义自己的页面选择器
    """

    # 通用选择器（子类可覆盖）
    SELECTOR_FILE_INPUT = 'input[type="file"]'
    SELECTOR_DOWNLOAD_BUTTON = '[data-testid="download-button"]'
    SELECTOR_GENERATE_BUTTON = 'button:has-text("Generate")'
    SELECTOR_DONE_INDICATOR = '[data-testid="done-indicator"]'
    SELECTOR_ERROR_INDICATOR = '[data-testid="error-indicator"]'
    SELECTOR_PROGRESS_BAR = '[role="progressbar"]'
    SELECTOR_VIDEO_PREVIEW = 'video'

    # 模式名称（子类需要重写）
    MODE_NAME = "base"

    def __init__(self, page, config_override=None):
        """
        Args:
            page: Playwright 的 Page 对象（已登录态）
            config_override: 可选的配置覆盖字典
        """
        self.page = page
        self.config = config_override or {}
        self.logger = logger

    # ===== 抽象方法（子类必须实现）=====

    async def navigate(self):
        """导航到对应的生成工具页面"""
        raise NotImplementedError("子类必须实现 navigate 方法")

    async def fill_inputs(self, task_data: dict):
        """填写输入内容（URL、图片、prompt 等）"""
        raise NotImplementedError("子类必须实现 fill_inputs 方法")

    async def configure(self, task_data: dict):
        """配置参数（语言、风格等）"""
        raise NotImplementedError("子类必须实现 configure 方法")

    async def generate(self):
        """点击生成按钮"""
        raise NotImplementedError("子类必须实现 generate 方法")

    # ===== 通用方法（子类可复用或重写）=====

    async def wait_for_completion(self, timeout: Optional[int] = None) -> bool:
        """
        轮询等待视频生成完成
        
        检测策略（按优先级）：
        1. 查找下载按钮/完成标识出现
        2. 查找视频预览元素出现
        3. 查找进度条消失
        如果同时检测到错误标识，立即抛出 GenerationError
        
        Args:
            timeout: 超时时间（秒），默认使用 config.VIDEO_GENERATION_TIMEOUT
        
        Returns:
            True 表示生成成功
        
        Raises:
            GenerationError: 生成失败
            TimeoutError: 等待超时
        """
        timeout = timeout or config.VIDEO_GENERATION_TIMEOUT
        start_time = time.time()
        last_log_time = start_time

        self.logger.info(f"[{self.MODE_NAME}] 开始等待视频生成（超时 {timeout}s）...")

        while time.time() - start_time < timeout:
            elapsed = int(time.time() - start_time)

            # 1. 优先检测错误状态
            try:
                error_el = await self.page.query_selector(self.SELECTOR_ERROR_INDICATOR)
                if error_el and await error_el.is_visible():
                    error_text = await error_el.inner_text()
                    raise GenerationError(f"视频生成失败: {error_text}")
            except GenerationError:
                raise
            except Exception:
                pass

            # 2. 检测完成标识（下载按钮）
            try:
                done_el = await self.page.query_selector(self.SELECTOR_DOWNLOAD_BUTTON)
                if done_el and await done_el.is_visible():
                    self.logger.info(f"[{self.MODE_NAME}] 检测到下载按钮，生成完成 ✓ (耗时 {elapsed}s)")
                    return True
            except Exception:
                pass

            # 3. 检测视频预览元素
            try:
                video_el = await self.page.query_selector(self.SELECTOR_VIDEO_PREVIEW)
                if video_el and await video_el.is_visible():
                    # 视频元素可见且有 src 属性才认为完成
                    src = await video_el.get_attribute("src")
                    if src:
                        self.logger.info(f"[{self.MODE_NAME}] 检测到视频预览，生成完成 ✓ (耗时 {elapsed}s)")
                        return True
            except Exception:
                pass

            # 每 30 秒打印一次进度日志
            if time.time() - last_log_time >= 30:
                self.logger.info(f"[{self.MODE_NAME}] 仍在生成中... (已等待 {elapsed}s)")
                last_log_time = time.time()

            await asyncio.sleep(config.POLL_INTERVAL)

        raise TimeoutError(f"[{self.MODE_NAME}] 视频生成超时（{timeout}秒）")

    async def download(self, output_path: str) -> str:
        """
        下载生成的视频，使用 Playwright 的 expect_download 监听
        
        Args:
            output_path: 视频保存路径
        
        Returns:
            实际保存的文件路径
        
        Raises:
            GenerationError: 下载失败
        """
        # 确保输出目录存在
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        self.logger.info(f"[{self.MODE_NAME}] 开始下载到: {output_path}")

        try:
            # 监听 download 事件
            async with self.page.expect_download(timeout=120000) as download_info:
                # 点击下载按钮
                await self._click_download_button()

            download = await download_info.value
            await download.save_as(output_path)

            self.logger.info(f"[{self.MODE_NAME}] 下载完成 ✓ {output_path}")
            return output_path

        except Exception as e:
            raise GenerationError(f"[{self.MODE_NAME}] 下载失败: {e}") from e

    async def _click_download_button(self):
        """
        点击下载按钮（包含 Export → Download 流程）
        子类可以重写以支持自定义下载入口
        """
        # 先尝试点击 Export 按钮（如果存在）
        export_btn = await self.page.query_selector('button:has-text("Export")')
        if export_btn and await export_btn.is_visible():
            await export_btn.click()
            await random_delay(1, 2)

        # 点击下载按钮
        download_btn = await self.page.query_selector(self.SELECTOR_DOWNLOAD_BUTTON)
        if not download_btn:
            # 退化策略：用文字匹配
            download_btn = await self.page.query_selector('button:has-text("Download")')
        if not download_btn:
            raise ElementNotFoundError("未找到下载按钮")
        await download_btn.click()

    async def upload_files(self, file_paths: Union[str, List[str]]):
        """
        通用文件上传方法
        
        Args:
            file_paths: 单个或多个文件路径
        """
        if isinstance(file_paths, str):
            file_paths = [file_paths]

        # 验证文件存在
        for fp in file_paths:
            if not os.path.exists(fp):
                raise FileNotFoundError(f"上传文件不存在: {fp}")

        # 查找文件输入框
        file_input = await self.page.query_selector(self.SELECTOR_FILE_INPUT)
        if file_input:
            await file_input.set_input_files(file_paths)
            self.logger.info(f"[{self.MODE_NAME}] 已上传 {len(file_paths)} 个文件")
            return

        # 退化策略：尝试用 set_input_files 配合 file chooser
        try:
            async with self.page.expect_file_chooser() as fc_info:
                # 点击上传区域（子类可重写 _click_upload_area）
                await self._click_upload_area()
            file_chooser = await fc_info.value
            await file_chooser.set_files(file_paths)
            self.logger.info(f"[{self.MODE_NAME}] 已通过 file chooser 上传 {len(file_paths)} 个文件")
        except Exception as e:
            raise ElementNotFoundError(f"未找到文件上传入口: {e}")

    async def _click_upload_area(self):
        """点击上传区域（子类可重写）"""
        # 默认尝试用文字匹配上传按钮
        upload_btn = await self.page.query_selector(
            'button:has-text("Upload"), [role="button"]:has-text("Upload")'
        )
        if upload_btn:
            await upload_btn.click()
        else:
            raise ElementNotFoundError("未找到上传区域")

    async def safe_click(self, selector: str, timeout: int = 10000) -> bool:
        """
        安全点击：等待元素可见后再点击，包含错误处理
        
        Args:
            selector: 选择器
            timeout: 等待超时（毫秒）
        
        Returns:
            是否成功点击
        """
        try:
            await self.page.wait_for_selector(selector, state="visible", timeout=timeout)
            await self.page.click(selector)
            return True
        except Exception as e:
            self.logger.warning(f"[{self.MODE_NAME}] 点击失败 {selector}: {e}")
            return False

    async def safe_fill(self, selector: str, text: str, timeout: int = 10000) -> bool:
        """安全填写文本"""
        try:
            await self.page.wait_for_selector(selector, state="visible", timeout=timeout)
            await self.page.fill(selector, text)
            return True
        except Exception as e:
            self.logger.warning(f"[{self.MODE_NAME}] 填写失败 {selector}: {e}")
            return False

    # ===== 完整流程 =====

    async def run(self, task_data: dict, output_path: str) -> str:
        """
        完整流程：导航 → 填写 → 配置 → 生成 → 等待 → 下载
        
        Args:
            task_data: 任务数据字典（每个生成器有不同的字段要求）
            output_path: 视频输出文件路径
        
        Returns:
            实际保存的文件路径
        
        Raises:
            GenerationError / TimeoutError / FileNotFoundError 等
        """
        self.logger.info(f"[{self.MODE_NAME}] ▶ 开始任务: {task_data}")

        try:
            # 1. 导航
            await self.navigate()
            await random_delay()

            # 2. 填写输入
            await self.fill_inputs(task_data)
            await random_delay()

            # 3. 配置参数
            await self.configure(task_data)
            await random_delay()

            # 4. 触发生成
            await self.generate()

            # 5. 等待完成
            await self.wait_for_completion()
            await random_delay(1, 2)

            # 6. 下载
            saved_path = await self.download(output_path)

            self.logger.info(f"[{self.MODE_NAME}] ✓ 任务完成: {saved_path}")
            return saved_path

        except Exception as e:
            self.logger.error(f"[{self.MODE_NAME}] ✗ 任务失败: {e}")
            raise
