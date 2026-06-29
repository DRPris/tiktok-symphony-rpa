"""
设置 API - 读写运行时配置 + 检查/刷新登录态
"""

import os
import sys
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

# 确保可导入项目根模块
sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

import config
from session_manager import SessionManager
from web.models import SettingsResponse, SettingsUpdate, SimpleResponse

logger = logging.getLogger("symphony_batch")
router = APIRouter(tags=["settings"])


# 缓存最近一次 session 校验结果，避免每次 GET 都启动浏览器
_last_session_valid: Optional[bool] = None


def _build_settings_response(session_valid: bool) -> SettingsResponse:
    """读取 config 模块当前配置生成响应"""
    return SettingsResponse(
        max_concurrent_tabs=config.MAX_CONCURRENT_TABS,
        video_generation_timeout=config.VIDEO_GENERATION_TIMEOUT,
        poll_interval=config.POLL_INTERVAL,
        random_delay_min=config.RANDOM_DELAY_MIN,
        random_delay_max=config.RANDOM_DELAY_MAX,
        output_dir=config.OUTPUT_DIR,
        session_valid=session_valid,
    )


@router.get("", response_model=SettingsResponse)
async def get_settings() -> SettingsResponse:
    """获取当前设置"""
    return _build_settings_response(
        session_valid=bool(_last_session_valid)
    )


@router.put("", response_model=SettingsResponse)
async def update_settings(payload: SettingsUpdate) -> SettingsResponse:
    """
    更新运行时设置（仅修改 config 模块的内存属性）
    注意：这些修改不会持久化到 config.py 文件，重启进程后会还原
    """
    # 校验 random_delay_min < random_delay_max
    new_min = (
        payload.random_delay_min
        if payload.random_delay_min is not None
        else config.RANDOM_DELAY_MIN
    )
    new_max = (
        payload.random_delay_max
        if payload.random_delay_max is not None
        else config.RANDOM_DELAY_MAX
    )
    if new_min > new_max:
        raise HTTPException(
            status_code=400, detail="random_delay_min 不能大于 random_delay_max"
        )

    if payload.max_concurrent_tabs is not None:
        config.MAX_CONCURRENT_TABS = payload.max_concurrent_tabs
    if payload.video_generation_timeout is not None:
        config.VIDEO_GENERATION_TIMEOUT = payload.video_generation_timeout
    if payload.poll_interval is not None:
        config.POLL_INTERVAL = payload.poll_interval
    if payload.random_delay_min is not None:
        config.RANDOM_DELAY_MIN = payload.random_delay_min
    if payload.random_delay_max is not None:
        config.RANDOM_DELAY_MAX = payload.random_delay_max

    return _build_settings_response(
        session_valid=bool(_last_session_valid)
    )


@router.post("/check-session", response_model=SimpleResponse)
async def check_session() -> SimpleResponse:
    """检查当前登录态是否有效"""
    global _last_session_valid
    session = SessionManager()
    try:
        await session.init_browser(headless=True)
        valid = await session.is_session_valid()
        _last_session_valid = valid
        return SimpleResponse(
            success=valid,
            message="登录态有效" if valid else "登录态已失效，请重新登录",
        )
    except Exception as e:
        _last_session_valid = False
        logger.warning(f"检查登录态失败: {e}")
        return SimpleResponse(success=False, message=f"检查失败: {e}")
    finally:
        try:
            await session.close()
        except Exception:
            pass


@router.post("/refresh-session", response_model=SimpleResponse)
async def refresh_session() -> SimpleResponse:
    """
    触发重新登录流程（启动有头浏览器引导用户登录）
    由于登录需要用户交互，这里以子进程方式启动 login.py
    """
    login_script = os.path.join(config.BASE_DIR, "login.py")
    if not os.path.exists(login_script):
        raise HTTPException(status_code=404, detail="未找到 login.py")

    try:
        # 后台启动登录流程，不阻塞 API 响应
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            login_script,
            cwd=config.BASE_DIR,
        )
        logger.info(f"已启动登录子进程 pid={proc.pid}")
        return SimpleResponse(
            success=True,
            message="已启动登录流程，请在弹出的浏览器中完成登录",
        )
    except Exception as e:
        logger.exception("启动登录流程失败")
        raise HTTPException(status_code=500, detail=f"启动失败: {e}")
