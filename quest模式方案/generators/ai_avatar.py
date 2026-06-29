"""
AI Avatar 生成器 - Symphony 的「AI 数字形象」模式

输入：数字形象 ID/名称 + 脚本文本 + 语言/配音
输出：数字人讲解视频
"""

import logging

from .base import BaseGenerator, ElementNotFoundError
from utils import random_delay
import config

logger = logging.getLogger("symphony_batch")


class AIAvatarGenerator(BaseGenerator):
    """AI Avatar / Digital Avatar 模式视频生成器"""

    MODE_NAME = "ai_avatar"

    # ===== 页面选择器集中定义 =====
    # 工具入口
    SELECTOR_TOOL_ENTRY = 'text="AI Avatar"'
    SELECTOR_TOOL_ENTRY_ALT = 'text="Digital Avatar"'
    SELECTOR_TOOL_ENTRY_TID = '[data-testid="tool-ai-avatar"]'

    # 形象选择
    SELECTOR_AVATAR_LIST = '[data-testid="avatar-list"], .avatar-list'
    SELECTOR_AVATAR_ITEM_BY_ID = '[data-avatar-id="{avatar_id}"]'
    SELECTOR_AVATAR_ITEM_BY_NAME = '[role="option"]:has-text("{name}"), [data-testid="avatar-item"]:has-text("{name}")'

    # 脚本输入
    SELECTOR_SCRIPT_INPUT = 'textarea[placeholder*="script"], textarea[placeholder*="text"], textarea[placeholder*="脚本"]'

    # 语言/配音
    SELECTOR_LANGUAGE_SELECT = '[aria-label*="anguage"], [data-testid="language-select"], button:has-text("Language")'
    SELECTOR_VOICE_SELECT = '[aria-label*="oice"], [data-testid="voice-select"], button:has-text("Voice")'
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
        """导航到 AI Avatar 工具页面"""
        await self.page.goto(config.SYMPHONY_URL, wait_until="domcontentloaded", timeout=60000)
        await random_delay(2, 4)

        # 依次尝试多种入口选择器
        clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY, timeout=10000)
        if not clicked:
            clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY_ALT, timeout=8000)
        if not clicked:
            clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY_TID, timeout=8000)
        if not clicked:
            for name in ("AI Avatar", "Digital Avatar", "Avatar"):
                try:
                    await self.page.get_by_role("button", name=name).click(timeout=5000)
                    clicked = True
                    break
                except Exception:
                    continue
        if not clicked:
            raise ElementNotFoundError("未找到 AI Avatar 工具入口")

        await self.page.wait_for_load_state("domcontentloaded", timeout=30000)
        await random_delay(2, 4)
        self.logger.info(f"[{self.MODE_NAME}] 已进入 AI Avatar 工具页面")

    async def fill_inputs(self, task_data: dict):
        """选择形象并填写脚本"""
        avatar_id = task_data.get("avatar_id")
        script = task_data.get("script")

        if not script:
            raise ValueError("task_data 必须包含 script 字段")

        # 1. 选择数字形象
        if avatar_id:
            self.logger.info(f"[{self.MODE_NAME}] 选择形象: {avatar_id}")
            selected = False
            # 优先尝试通过 data-avatar-id 选择
            try:
                selector = self.SELECTOR_AVATAR_ITEM_BY_ID.format(avatar_id=avatar_id)
                el = await self.page.query_selector(selector)
                if el:
                    await el.click()
                    selected = True
            except Exception:
                pass

            # 退化：通过名称匹配
            if not selected:
                try:
                    selector = self.SELECTOR_AVATAR_ITEM_BY_NAME.format(name=avatar_id)
                    await self.page.click(selector, timeout=5000)
                    selected = True
                except Exception:
                    pass

            # 最终退化：用 get_by_text
            if not selected:
                try:
                    await self.page.get_by_text(avatar_id, exact=False).first.click(timeout=5000)
                    selected = True
                except Exception:
                    self.logger.warning(f"[{self.MODE_NAME}] 未能精确选择形象 {avatar_id}，将使用默认")

            await random_delay(0.5, 1.5)

        # 2. 填写脚本
        self.logger.info(f"[{self.MODE_NAME}] 填写脚本（{len(script)} 字符）")
        ok = await self.safe_fill(self.SELECTOR_SCRIPT_INPUT, script)
        if not ok:
            try:
                await self.page.get_by_placeholder("script", exact=False).fill(script)
            except Exception as e:
                raise ElementNotFoundError(f"未找到脚本输入框: {e}")

    async def configure(self, task_data: dict):
        """配置语言和配音"""
        language = task_data.get("language", "English")
        voice = task_data.get("voice")

        # 1. 配置语言
        self.logger.info(f"[{self.MODE_NAME}] 配置语言: {language}")
        try:
            if await self.safe_click(self.SELECTOR_LANGUAGE_SELECT, timeout=5000):
                await random_delay(0.5, 1)
                try:
                    await self.page.get_by_role("option", name=language).click(timeout=5000)
                except Exception:
                    await self.page.click(f'{self.SELECTOR_OPTION}:has-text("{language}")', timeout=5000)
        except Exception as e:
            self.logger.warning(f"[{self.MODE_NAME}] 语言配置失败: {e}")

        await random_delay(0.5, 1)

        # 2. 配置配音（可选）
        if voice:
            self.logger.info(f"[{self.MODE_NAME}] 配置配音: {voice}")
            try:
                if await self.safe_click(self.SELECTOR_VOICE_SELECT, timeout=5000):
                    await random_delay(0.5, 1)
                    try:
                        await self.page.get_by_role("option", name=voice).click(timeout=5000)
                    except Exception:
                        await self.page.click(f'{self.SELECTOR_OPTION}:has-text("{voice}")', timeout=5000)
            except Exception as e:
                self.logger.warning(f"[{self.MODE_NAME}] 配音配置失败: {e}")

    async def generate(self):
        """点击 Generate 按钮"""
        self.logger.info(f"[{self.MODE_NAME}] 点击 Generate 按钮")
        clicked = await self.safe_click(self.SELECTOR_GENERATE_BUTTON, timeout=10000)
        if not clicked:
            try:
                await self.page.get_by_role("button", name="Generate").click(timeout=10000)
            except Exception as e:
                raise ElementNotFoundError(f"未找到 Generate 按钮: {e}")
