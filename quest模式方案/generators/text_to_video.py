"""
Text to Video 生成器 - Symphony 的「文本转视频」模式

输入：文本描述 + 风格 + 语言
输出：根据文本生成的视频
"""

import logging

from .base import BaseGenerator, ElementNotFoundError
from utils import random_delay
import config

logger = logging.getLogger("symphony_batch")


class TextToVideoGenerator(BaseGenerator):
    """Text to Video 模式视频生成器"""

    MODE_NAME = "text_to_video"

    # ===== 页面选择器集中定义 =====
    # 工具入口
    SELECTOR_TOOL_ENTRY = 'text="Text to Video"'
    SELECTOR_TOOL_ENTRY_ALT = '[data-testid="tool-text-to-video"]'

    # 文本输入
    SELECTOR_TEXT_INPUT = 'textarea[placeholder*="describe"], textarea[placeholder*="text"], textarea[placeholder*="prompt"], textarea[placeholder*="描述"]'

    # 风格选择
    SELECTOR_STYLE_SELECT = '[aria-label*="tyle"], [data-testid="style-select"], button:has-text("Style")'
    SELECTOR_STYLE_OPTION = '[role="option"], [data-testid="style-option"]'

    # 语言选择
    SELECTOR_LANGUAGE_SELECT = '[aria-label*="anguage"], [data-testid="language-select"], button:has-text("Language")'
    SELECTOR_OPTION = '[role="option"]'

    # 生成按钮
    SELECTOR_GENERATE_BUTTON = 'button:has-text("Generate"):not(:has-text("Generating"))'

    # 完成/下载
    SELECTOR_DOWNLOAD_BUTTON = 'button:has-text("Download"), [data-testid="download-btn"]'
    SELECTOR_EXPORT_BUTTON = 'button:has-text("Export")'
    SELECTOR_VIDEO_PREVIEW = 'video'

    # 错误指示
    SELECTOR_ERROR_INDICATOR = '[role="alert"], [data-testid="error-message"], .error-toast'

    async def navigate(self):
        """导航到 Text to Video 工具页面"""
        await self.page.goto(config.SYMPHONY_URL, wait_until="domcontentloaded", timeout=60000)
        await random_delay(2, 4)

        clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY, timeout=15000)
        if not clicked:
            clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY_ALT, timeout=10000)
        if not clicked:
            try:
                await self.page.get_by_role("button", name="Text to Video").click(timeout=10000)
                clicked = True
            except Exception:
                pass
        if not clicked:
            raise ElementNotFoundError("未找到 Text to Video 工具入口")

        await self.page.wait_for_load_state("domcontentloaded", timeout=30000)
        await random_delay(2, 4)
        self.logger.info(f"[{self.MODE_NAME}] 已进入 Text to Video 工具页面")

    async def fill_inputs(self, task_data: dict):
        """填写文本描述"""
        text = task_data.get("text")
        if not text:
            raise ValueError("task_data 必须包含 text 字段")

        self.logger.info(f"[{self.MODE_NAME}] 填写文本（{len(text)} 字符）")
        ok = await self.safe_fill(self.SELECTOR_TEXT_INPUT, text)
        if not ok:
            try:
                await self.page.get_by_placeholder("describe", exact=False).fill(text)
            except Exception as e:
                raise ElementNotFoundError(f"未找到文本输入框: {e}")

    async def configure(self, task_data: dict):
        """配置风格和语言"""
        style = task_data.get("style")
        language = task_data.get("language", "English")

        # 1. 配置风格（可选）
        if style:
            self.logger.info(f"[{self.MODE_NAME}] 配置风格: {style}")
            try:
                if await self.safe_click(self.SELECTOR_STYLE_SELECT, timeout=5000):
                    await random_delay(0.5, 1)
                    try:
                        await self.page.get_by_role("option", name=style).click(timeout=5000)
                    except Exception:
                        await self.page.click(
                            f'{self.SELECTOR_STYLE_OPTION}:has-text("{style}")', timeout=5000
                        )
            except Exception as e:
                self.logger.warning(f"[{self.MODE_NAME}] 风格配置失败: {e}")

            await random_delay(0.5, 1)

        # 2. 配置语言
        self.logger.info(f"[{self.MODE_NAME}] 配置语言: {language}")
        try:
            if await self.safe_click(self.SELECTOR_LANGUAGE_SELECT, timeout=5000):
                await random_delay(0.5, 1)
                try:
                    await self.page.get_by_role("option", name=language).click(timeout=5000)
                except Exception:
                    await self.page.click(
                        f'{self.SELECTOR_OPTION}:has-text("{language}")', timeout=5000
                    )
        except Exception as e:
            self.logger.warning(f"[{self.MODE_NAME}] 语言配置失败: {e}")

    async def generate(self):
        """点击 Generate 按钮"""
        self.logger.info(f"[{self.MODE_NAME}] 点击 Generate 按钮")
        clicked = await self.safe_click(self.SELECTOR_GENERATE_BUTTON, timeout=10000)
        if not clicked:
            try:
                await self.page.get_by_role("button", name="Generate").click(timeout=10000)
            except Exception as e:
                raise ElementNotFoundError(f"未找到 Generate 按钮: {e}")
