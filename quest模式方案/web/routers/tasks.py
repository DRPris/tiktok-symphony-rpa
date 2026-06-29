"""
批量任务 API
"""

import os
import sys
import json
import asyncio
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

# 确保可导入项目根模块
sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

import aiosqlite

import config
from task_queue import TaskQueue
from web.product_store import ProductStore
from web.engine_manager import engine_manager
from web.models import (
    BatchCreateRequest,
    BatchCreateResponse,
    StartRequest,
    SimpleResponse,
    TaskResponse,
    TaskListResponse,
)

logger = logging.getLogger("symphony_batch")
router = APIRouter(tags=["tasks"])

_product_store = ProductStore()


def _row_to_task_response(row: Dict[str, Any]) -> TaskResponse:
    """SQLite 行转 TaskResponse"""
    task_data = row.get("task_data")
    if isinstance(task_data, str):
        try:
            task_data = json.loads(task_data)
        except (TypeError, json.JSONDecodeError):
            task_data = {}
    return TaskResponse(
        id=row["id"],
        batch_id=row["batch_id"],
        product_name=row["product_name"],
        mode=row["mode"],
        status=row["status"],
        output_path=row.get("output_path"),
        error_msg=row.get("error_msg"),
        retries=row.get("retries") or 0,
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
        task_data=task_data if isinstance(task_data, dict) else None,
    )


@router.post("/batch", response_model=BatchCreateResponse)
async def create_batch(payload: BatchCreateRequest) -> BatchCreateResponse:
    """从已导入的产品中创建批量任务"""
    if not payload.product_ids:
        raise HTTPException(status_code=400, detail="product_ids 不能为空")

    await _product_store.init_db()
    products = await _product_store.get_many(payload.product_ids)
    if not products:
        raise HTTPException(status_code=404, detail="未找到对应的产品")

    # 转为 TaskQueue 接受的任务结构
    task_items = [ProductStore.to_task_dict(p) for p in products]

    tq = TaskQueue()
    await tq.init_db()
    batch_id = TaskQueue.generate_batch_id()
    tq.set_batch_id(batch_id)
    inserted = await tq.add_tasks(task_items, batch_id, skip_existing_done=False)

    return BatchCreateResponse(batch_id=batch_id, inserted=inserted)


@router.get("", response_model=TaskListResponse)
async def list_tasks(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    status: Optional[str] = None,
    batch_id: Optional[str] = None,
) -> TaskListResponse:
    """获取任务列表（支持按 status / batch_id 筛选 + 分页）"""
    tq = TaskQueue()
    await tq.init_db()

    where_clauses, params = [], []
    if status:
        where_clauses.append("status = ?")
        params.append(status)
    if batch_id:
        where_clauses.append("batch_id = ?")
        params.append(batch_id)
    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    offset = (page - 1) * page_size

    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"SELECT COUNT(*) AS c FROM tasks{where_sql}", params
        )
        total_row = await cur.fetchone()
        total = total_row["c"] if total_row else 0

        cur = await db.execute(
            f"SELECT * FROM tasks{where_sql} "
            f"ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, page_size, offset],
        )
        rows = await cur.fetchall()

    items = [_row_to_task_response(dict(r)) for r in rows]
    return TaskListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


@router.get("/progress")
async def task_progress():
    """SSE 实时进度推送"""

    async def event_stream():
        try:
            while True:
                progress = await engine_manager.get_progress()
                # 时间戳转字符串方便序列化
                progress["timestamp"] = progress["timestamp"].isoformat(
                    timespec="seconds"
                )
                yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
                # 引擎运行中 1s 一次，空闲时 3s 一次，降低数据库压力
                await asyncio.sleep(1 if progress.get("is_running") else 3)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning(f"SSE 推送中断: {e}")
            return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: int) -> TaskResponse:
    """获取单个任务详情"""
    tq = TaskQueue()
    await tq.init_db()
    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _row_to_task_response(dict(row))


@router.post("/start", response_model=SimpleResponse)
async def start_engine(payload: Optional[StartRequest] = None) -> SimpleResponse:
    """启动/恢复批量引擎"""
    payload = payload or StartRequest()
    concurrent = payload.concurrent or config.MAX_CONCURRENT_TABS
    result = await engine_manager.start(
        batch_id=payload.batch_id,
        concurrent=concurrent,
    )
    return SimpleResponse(
        success=bool(result.get("success")),
        message=result.get("message", ""),
    )


@router.post("/stop", response_model=SimpleResponse)
async def stop_engine() -> SimpleResponse:
    """停止批量引擎"""
    result = await engine_manager.stop()
    return SimpleResponse(
        success=bool(result.get("success")),
        message=result.get("message", ""),
    )


@router.post("/{task_id}/retry", response_model=SimpleResponse)
async def retry_task(task_id: int) -> SimpleResponse:
    """重试单个失败任务（重置为 pending，重置重试次数）"""
    tq = TaskQueue()
    await tq.init_db()
    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="任务不存在")
        now = datetime.now().isoformat(timespec="seconds")
        await db.execute(
            "UPDATE tasks SET status = ?, retries = 0, error_msg = NULL, "
            "updated_at = ? WHERE id = ?",
            (TaskQueue.STATUS_PENDING, now, task_id),
        )
        await db.commit()
    return SimpleResponse(success=True, message="已重置为待处理状态")
