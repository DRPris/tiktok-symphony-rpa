"""
Image to Video 生成器 - Symphony 的「图片转视频」模式

输入：单张图片 + 文字提示词
输出：根据图片生成的短视频
"""

import logging

from .base import BaseGenerator, ElementNotFoundError
from utils import random_delay
import config

logger = logging.getLogger("symphony_batch")


class ImageToVideoGenerator(BaseGenerator):
    """Image to Video 模式视频生成器"""

    MODE_NAME = "image_to_video"

    # ===== 页面选择器集中定义 =====
    # 工具入口
    SELECTOR_TOOL_ENTRY = 'text="Image to Video"'
    SELECTOR_TOOL_ENTRY_ALT = '[data-testid="tool-image-to-video"]'

    # 输入区域
    SELECTOR_FILE_INPUT = 'input[type="file"]'
    SELECTOR_UPLOAD_AREA = '[data-testid="upload-area"], [aria-label*="upload"]'
    SELECTOR_PROMPT_INPUT = 'textarea[placeholder*="prompt"], textarea[placeholder*="describe"], textarea[placeholder*="提示"]'

    # 语言选择
    SELECTOR_LANGUAGE_SELECT = '[aria-label*="anguage"], [data-testid="language-select"]'

    # 生成按钮
    SELECTOR_GENERATE_BUTTON = 'button:has-text("Generate"):not(:has-text("Generating"))'

    # 完成态/下载
    SELECTOR_DOWNLOAD_BUTTON = 'button:has-text("Download"), [data-testid="download-btn"]'
    SELECTOR_EXPORT_BUTTON = 'button:has-text("Export")'
    SELECTOR_VIDEO_PREVIEW = 'video'

    # 错误指示
    SELECTOR_ERROR_INDICATOR = '[role="alert"], [data-testid="error-message"], .error-toast'

    async def navigate(self):
        """导航到 Image to Video 工具页面"""
        await self.page.goto(config.SYMPHONY_URL, wait_until="domcontentloaded", timeout=60000)
        await random_delay(2, 4)

        clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY, timeout=15000)
        if not clicked:
            clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY_ALT, timeout=10000)
        if not clicked:
            try:
                await self.page.get_by_role("button", name="Image to Video").click(timeout=10000)
                clicked = True
            except Exception:
                pass
        if not clicked:
            raise ElementNotFoundError("未找到 Image to Video 工具入口")

        await self.page.wait_for_load_state("domcontentloaded", timeout=30000)
        await random_delay(2, 4)
        self.logger.info(f"[{self.MODE_NAME}] 已进入 Image to Video 工具页面")

    async def fill_inputs(self, task_data: dict):
        """上传图片并填写 prompt"""
        image = task_data.get("image")
        prompt = task_data.get("prompt", "")

        if not image:
            raise ValueError("task_data 必须包含 image 字段")

        # 1. 上传图片
        self.logger.info(f"[{self.MODE_NAME}] 上传图片: {image}")
        await self.upload_files(image)
        # 等待图片上传/预览生成
        await random_delay(3, 5)

        # 2. 填写 prompt
        if prompt:
            self.logger.info(f"[{self.MODE_NAME}] 填写 prompt: {prompt[:50]}...")
            ok = await self.safe_fill(self.SELECTOR_PROMPT_INPUT, prompt)
            if not ok:
                try:
                    await self.page.get_by_placeholder("prompt", exact=False).fill(prompt)
                except Exception as e:
                    self.logger.warning(f"[{self.MODE_NAME}] prompt 输入失败: {e}")

    async def configure(self, task_data: dict):
        """配置语言等参数（Image to Video 通常配置较少）"""
        language = task_data.get("language")
        if not language:
            return

        self.logger.info(f"[{self.MODE_NAME}] 配置语言: {language}")
        try:
            opened = await self.safe_click(self.SELECTOR_LANGUAGE_SELECT, timeout=5000)
            if opened:
                await random_delay(0.5, 1)
                try:
                    await self.page.get_by_role("option", name=language).click(timeout=5000)
                except Exception:
                    await self.page.click(f'[role="option"]:has-text("{language}")', timeout=5000)
        except Exception as e:
            self.logger.warning(f"[{self.MODE_NAME}] 语言配置失败（可能不需要）: {e}")

    async def generate(self):
        """点击 Generate 按钮启动生成"""
        self.logger.info(f"[{self.MODE_NAME}] 点击 Generate 按钮")
        clicked = await self.safe_click(self.SELECTOR_GENERATE_BUTTON, timeout=10000)
        if not clicked:
            try:
                await self.page.get_by_role("button", name="Generate").click(timeout=10000)
            except Exception as e:
                raise ElementNotFoundError(f"未找到 Generate 按钮: {e}")

    async def wait_for_completion(self, timeout=None):
        """Image to Video 通常较快，默认超时缩短为 180 秒"""
        if timeout is None:
            timeout = min(config.VIDEO_GENERATION_TIMEOUT, 180)
        return await super().wait_for_completion(timeout=timeout)
