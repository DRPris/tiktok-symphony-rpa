"""
Generate & Remix 生成器 - Symphony Creative Studio 的「生成和混剪」模式

支持的输入：
- 产品 URL
- 产品图片（最多4张）
- 产品文字描述
- 额外创意提示词（prompt）
"""

import asyncio
import logging

from .base import BaseGenerator, ElementNotFoundError
from utils import random_delay
import config

logger = logging.getLogger("symphony_batch")


class GenerateRemixGenerator(BaseGenerator):
    """Generate & Remix 模式视频生成器"""

    MODE_NAME = "generate_remix"

    # ===== 页面选择器集中定义 =====
    # 工具入口选择器（首页卡片）
    SELECTOR_TOOL_ENTRY = 'text="Generate & Remix"'
    SELECTOR_TOOL_ENTRY_ALT = '[data-testid="tool-generate-remix"]'

    # 输入区域
    SELECTOR_URL_INPUT = 'input[placeholder*="URL"], input[placeholder*="link"], input[placeholder*="链接"]'
    SELECTOR_DESCRIPTION_INPUT = 'textarea[placeholder*="describe"], textarea[placeholder*="description"], textarea[placeholder*="描述"]'
    SELECTOR_PROMPT_INPUT = 'textarea[placeholder*="prompt"], textarea[placeholder*="creative"], textarea[placeholder*="提示"]'
    SELECTOR_FILE_INPUT = 'input[type="file"]'
    SELECTOR_UPLOAD_AREA = '[data-testid="upload-area"], [aria-label*="upload"], [aria-label*="Upload"]'

    # Tab/模式切换
    SELECTOR_TAB_URL = 'button:has-text("URL"), [role="tab"]:has-text("URL")'
    SELECTOR_TAB_IMAGE = 'button:has-text("Image"), [role="tab"]:has-text("Image")'
    SELECTOR_TAB_TEXT = 'button:has-text("Text"), button:has-text("Description"), [role="tab"]:has-text("Text")'

    # 语言选择
    SELECTOR_LANGUAGE_SELECT = '[aria-label*="anguage"], [data-testid="language-select"], button:has-text("Language")'
    SELECTOR_LANGUAGE_OPTION = '[role="option"]'

    # 生成按钮
    SELECTOR_GENERATE_BUTTON = 'button:has-text("Generate"):not(:has-text("Generating"))'

    # 完成态/下载
    SELECTOR_DOWNLOAD_BUTTON = 'button:has-text("Download"), [data-testid="download-btn"]'
    SELECTOR_EXPORT_BUTTON = 'button:has-text("Export")'
    SELECTOR_VIDEO_PREVIEW = 'video'
    SELECTOR_VIDEO_CARD = '[data-testid="video-card"], .video-result-item'

    # 错误指示
    SELECTOR_ERROR_INDICATOR = '[role="alert"], [data-testid="error-message"], .error-toast'

    async def navigate(self):
        """导航到 Generate & Remix 工具页面"""
        # 先到 Symphony 首页
        await self.page.goto(config.SYMPHONY_URL, wait_until="domcontentloaded", timeout=60000)
        await random_delay(2, 4)

        # 查找并点击 Generate & Remix 入口
        clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY, timeout=15000)
        if not clicked:
            clicked = await self.safe_click(self.SELECTOR_TOOL_ENTRY_ALT, timeout=10000)
        if not clicked:
            # 退化策略：通过 role + name 定位
            try:
                await self.page.get_by_role("button", name="Generate & Remix").click(timeout=10000)
                clicked = True
            except Exception:
                pass
        if not clicked:
            raise ElementNotFoundError("未找到 Generate & Remix 工具入口")

        # 等待工具页面加载
        await self.page.wait_for_load_state("domcontentloaded", timeout=30000)
        await random_delay(2, 4)
        self.logger.info(f"[{self.MODE_NAME}] 已进入 Generate & Remix 工具页面")

    async def fill_inputs(self, task_data: dict):
        """
        填写输入内容
        
        优先级：product_url > images > description
        如果有 prompt 字段，额外填写 prompt 输入框
        """
        product_url = task_data.get("product_url")
        images = task_data.get("images")
        description = task_data.get("description")
        prompt = task_data.get("prompt")

        # 输入校验
        if not any([product_url, images, description]):
            raise ValueError("task_data 必须至少包含 product_url、images 或 description 之一")

        # 1. 填写产品 URL
        if product_url:
            self.logger.info(f"[{self.MODE_NAME}] 填写产品 URL: {product_url}")
            # 切换到 URL Tab
            await self.safe_click(self.SELECTOR_TAB_URL, timeout=5000)
            await random_delay(0.5, 1)
            # 填写 URL
            ok = await self.safe_fill(self.SELECTOR_URL_INPUT, product_url)
            if not ok:
                # 备选：通过 placeholder 获取
                try:
                    await self.page.get_by_placeholder("URL", exact=False).fill(product_url)
                except Exception as e:
                    raise ElementNotFoundError(f"未找到 URL 输入框: {e}")

        # 2. 上传图片
        elif images:
            # 限制最多 4 张
            images = images[:4]
            self.logger.info(f"[{self.MODE_NAME}] 上传图片 {len(images)} 张")
            await self.safe_click(self.SELECTOR_TAB_IMAGE, timeout=5000)
            await random_delay(0.5, 1)
            await self.upload_files(images)
            # 等待图片上传完成
            await random_delay(3, 5)

        # 3. 填写文字描述
        elif description:
            self.logger.info(f"[{self.MODE_NAME}] 填写产品描述")
            await self.safe_click(self.SELECTOR_TAB_TEXT, timeout=5000)
            await random_delay(0.5, 1)
            ok = await self.safe_fill(self.SELECTOR_DESCRIPTION_INPUT, description)
            if not ok:
                try:
                    await self.page.get_by_placeholder("describe", exact=False).fill(description)
                except Exception as e:
                    raise ElementNotFoundError(f"未找到描述输入框: {e}")

        # 4. 额外的创意 prompt（可选）
        if prompt:
            self.logger.info(f"[{self.MODE_NAME}] 填写创意 prompt")
            try:
                prompt_el = await self.page.query_selector(self.SELECTOR_PROMPT_INPUT)
                if prompt_el:
                    await prompt_el.fill(prompt)
            except Exception:
                self.logger.warning(f"[{self.MODE_NAME}] prompt 输入框未找到，跳过")

    async def configure(self, task_data: dict):
        """配置语言等参数"""
        language = task_data.get("language", "English")
        self.logger.info(f"[{self.MODE_NAME}] 配置语言: {language}")

        try:
            # 点击语言下拉框
            opened = await self.safe_click(self.SELECTOR_LANGUAGE_SELECT, timeout=5000)
            if opened:
                await random_delay(0.5, 1)
                # 选择对应的语言选项
                try:
                    await self.page.get_by_role("option", name=language).click(timeout=5000)
                except Exception:
                    # 退化：用文字匹配
                    await self.page.click(f'{self.SELECTOR_LANGUAGE_OPTION}:has-text("{language}")', timeout=5000)
        except Exception as e:
            self.logger.warning(f"[{self.MODE_NAME}] 语言配置失败（可能已是默认）: {e}")

    async def generate(self):
        """点击 Generate 按钮启动视频生成"""
        self.logger.info(f"[{self.MODE_NAME}] 点击 Generate 按钮")
        clicked = await self.safe_click(self.SELECTOR_GENERATE_BUTTON, timeout=10000)
        if not clicked:
            try:
                await self.page.get_by_role("button", name="Generate").click(timeout=10000)
            except Exception as e:
                raise ElementNotFoundError(f"未找到 Generate 按钮: {e}")

    async def _click_download_button(self):
        """
        Generate & Remix 的下载流程：
        1. 选中已生成的视频卡片（通常已自动选中）
        2. 点击 Export 按钮
        3. 在弹出菜单中点击 Download
        """
        # 先点击视频卡片确保选中（容错）
        try:
            video_card = await self.page.query_selector(self.SELECTOR_VIDEO_CARD)
            if video_card and await video_card.is_visible():
                await video_card.click()
                await random_delay(0.5, 1)
        except Exception:
            pass

        # 点击 Export
        export_btn = await self.page.query_selector(self.SELECTOR_EXPORT_BUTTON)
        if export_btn and await export_btn.is_visible():
            await export_btn.click()
            await random_delay(1, 2)

        # 点击 Download
        try:
            await self.page.get_by_role("button", name="Download").click(timeout=10000)
        except Exception:
            clicked = await self.safe_click(self.SELECTOR_DOWNLOAD_BUTTON, timeout=10000)
            if not clicked:
                raise ElementNotFoundError("未找到 Download 按钮")
