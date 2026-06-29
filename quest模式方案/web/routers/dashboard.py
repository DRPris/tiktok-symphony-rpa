"""
仪表盘 API - 提供今日数据、队列状态等聚合统计
"""

import os
import sys
from datetime import datetime, timedelta
from typing import List, Dict, Any

from fastapi import APIRouter

# 确保可导入项目根模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import aiosqlite

from task_queue import TaskQueue
from web.models import DashboardStats

router = APIRouter(tags=["dashboard"])


@router.get("/stats", response_model=DashboardStats)
async def get_stats() -> DashboardStats:
    """
    返回仪表盘聚合统计：
        - 今日总任务/成功/失败/成功率
        - 队列等待中/运行中数量
        - 平均生成耗时
    """
    tq = TaskQueue()
    await tq.init_db()

    # 今日范围（00:00 ~ 当前）
    today_start = datetime.now().replace(
        hour=0, minute=0, second=0, microsecond=0
    ).isoformat(timespec="seconds")

    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row

        # 今日总任务数
        cur = await db.execute(
            "SELECT COUNT(*) AS c FROM tasks WHERE created_at >= ?",
            (today_start,),
        )
        row = await cur.fetchone()
        today_total = (row["c"] if row else 0) or 0

        # 今日按状态分类
        cur = await db.execute(
            "SELECT status, COUNT(*) AS c FROM tasks "
            "WHERE created_at >= ? GROUP BY status",
            (today_start,),
        )
        today_by_status: Dict[str, int] = {}
        async for r in cur:
            today_by_status[r["status"]] = r["c"]

        today_success = today_by_status.get(TaskQueue.STATUS_DONE, 0)
        today_failed = today_by_status.get(TaskQueue.STATUS_FAILED, 0)

        # 全局队列状态（不限批次）
        cur = await db.execute(
            "SELECT status, COUNT(*) AS c FROM tasks GROUP BY status"
        )
        all_by_status: Dict[str, int] = {}
        async for r in cur:
            all_by_status[r["status"]] = r["c"]

        queue_pending = all_by_status.get(TaskQueue.STATUS_PENDING, 0)
        queue_running = (
            all_by_status.get(TaskQueue.STATUS_RUNNING, 0)
            + all_by_status.get(TaskQueue.STATUS_WAITING, 0)
            + all_by_status.get(TaskQueue.STATUS_DOWNLOADING, 0)
        )

        # 平均耗时：基于已完成任务 (updated_at - created_at) 估算
        cur = await db.execute(
            "SELECT created_at, updated_at FROM tasks "
            "WHERE status = ? AND created_at >= ?",
            (TaskQueue.STATUS_DONE, today_start),
        )
        durations: List[float] = []
        async for r in cur:
            try:
                start_t = datetime.fromisoformat(r["created_at"])
                end_t = datetime.fromisoformat(r["updated_at"])
                delta = (end_t - start_t).total_seconds()
                if delta >= 0:
                    durations.append(delta)
            except Exception:
                continue

    avg_duration = (sum(durations) / len(durations)) if durations else 0.0
    success_rate = (
        (today_success / today_total * 100) if today_total else 0.0
    )

    return DashboardStats(
        today_total=today_total,
        today_success=today_success,
        today_failed=today_failed,
        success_rate=round(success_rate, 1),
        queue_pending=queue_pending,
        queue_running=queue_running,
        avg_duration_seconds=round(avg_duration, 1),
    )
