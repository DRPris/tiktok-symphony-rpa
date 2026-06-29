"""
Symphony 视频生成器模块
统一导出所有生成器类，方便外部按模式名称动态加载
"""

from .base import BaseGenerator, GenerationError, ElementNotFoundError
from .generate_remix import GenerateRemixGenerator
from .image_to_video import ImageToVideoGenerator
from .ai_avatar import AIAvatarGenerator
from .text_to_video import TextToVideoGenerator

# 模式名称 → 生成器类的映射，便于通过字符串动态选择生成器
GENERATOR_REGISTRY = {
    "generate_remix": GenerateRemixGenerator,
    "image_to_video": ImageToVideoGenerator,
    "ai_avatar": AIAvatarGenerator,
    "text_to_video": TextToVideoGenerator,
}


def get_generator(mode: str):
    """
    根据模式名称获取对应的生成器类
    
    Args:
        mode: 模式名称（generate_remix / image_to_video / ai_avatar / text_to_video）
    
    Returns:
        生成器类
    
    Raises:
        ValueError: 不支持的模式
    """
    if mode not in GENERATOR_REGISTRY:
        raise ValueError(
            f"不支持的模式: {mode}，支持的模式: {list(GENERATOR_REGISTRY.keys())}"
        )
    return GENERATOR_REGISTRY[mode]


__all__ = [
    "BaseGenerator",
    "GenerationError",
    "ElementNotFoundError",
    "GenerateRemixGenerator",
    "ImageToVideoGenerator",
    "AIAvatarGenerator",
    "TextToVideoGenerator",
    "GENERATOR_REGISTRY",
    "get_generator",
]
