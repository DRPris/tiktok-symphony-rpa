"""
工具函数模块 - 随机延迟、路径生成、日志配置
"""

import asyncio
import random
import logging
import os
from datetime import datetime

from rich.logging import RichHandler
from rich.console import Console

import config

console = Console()


async def random_delay(min_s=None, max_s=None):
    """
    随机等待一段时间，模拟人工操作节奏
    
    Args:
        min_s: 最小等待秒数，默认使用配置值
        max_s: 最大等待秒数，默认使用配置值
    """
    min_s = min_s or config.RANDOM_DELAY_MIN
    max_s = max_s or config.RANDOM_DELAY_MAX
    delay = random.uniform(min_s, max_s)
    await asyncio.sleep(delay)
    return delay


def get_output_path(product_name, date=None):
    """
    生成视频输出路径
    
    Args:
        product_name: 产品名称或标识
        date: 日期字符串，默认使用当天日期（MMDD格式）
    
    Returns:
        完整的输出文件路径
    """
    if date is None:
        date = datetime.now().strftime("%m%d")
    
    # 确保输出目录存在
    os.makedirs(config.OUTPUT_DIR, exist_ok=True)
    
    # 生成文件名
    filename = f"{product_name}_{date}_symphony.mp4"
    return os.path.join(config.OUTPUT_DIR, filename)


def setup_logging(level=logging.INFO):
    """
    配置日志系统，使用 rich 美化输出
    
    Args:
        level: 日志级别，默认 INFO
    
    Returns:
        logger 实例
    """
    logging.basicConfig(
        level=level,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[
            RichHandler(
                console=console,
                rich_tracebacks=True,
                show_path=False,
            )
        ],
    )
    
    logger = logging.getLogger("symphony_batch")
    logger.setLevel(level)
    return logger


def get_random_viewport():
    """
    生成随机 viewport 尺寸，避免指纹识别
    
    Returns:
        dict: {"width": int, "height": int}
    """
    width = random.randint(*config.VIEWPORT_WIDTH_RANGE)
    height = random.randint(*config.VIEWPORT_HEIGHT_RANGE)
    return {"width": width, "height": height}
