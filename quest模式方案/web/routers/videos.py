"""
视频库 API - 浏览/下载/删除已生成的视频
"""

import os
import sys
import io
import json
import zipfile
import logging
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse

# 确保可导入项目根模块
sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

import aiosqlite

import config
from task_queue import TaskQueue
from web.models import (
    VideoResponse,
    VideoListResponse,
    BatchDownloadRequest,
    SimpleResponse,
)

logger = logging.getLogger("symphony_batch")
router = APIRouter(tags=["videos"])


def _row_to_video(row: dict) -> Optional[VideoResponse]:
    """将任务行（status=done）转为视频模型"""
    output_path = row.get("output_path")
    if not output_path:
        return None
    if not os.path.exists(output_path):
        size = 0
    else:
        try:
            size = os.path.getsize(output_path)
        except OSError:
            size = 0
    return VideoResponse(
        id=row["id"],
        product_name=row["product_name"],
        mode=row["mode"],
        batch_id=row["batch_id"],
        output_path=output_path,
        file_name=os.path.basename(output_path),
        size_bytes=size,
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


@router.get("", response_model=VideoListResponse)
async def list_videos(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    keyword: Optional[str] = None,
    mode: Optional[str] = None,
    batch_id: Optional[str] = None,
) -> VideoListResponse:
    """获取已生成视频列表（仅 status=done 且有 output_path 的任务）"""
    tq = TaskQueue()
    await tq.init_db()

    where_clauses = ["status = ?", "output_path IS NOT NULL"]
    params: List[any] = [TaskQueue.STATUS_DONE]
    if keyword:
        where_clauses.append("product_name LIKE ?")
        params.append(f"%{keyword}%")
    if mode:
        where_clauses.append("mode = ?")
        params.append(mode)
    if batch_id:
        where_clauses.append("batch_id = ?")
        params.append(batch_id)
    where_sql = " WHERE " + " AND ".join(where_clauses)
    offset = (page - 1) * page_size

    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(f"SELECT COUNT(*) AS c FROM tasks{where_sql}", params)
        total_row = await cur.fetchone()
        total = total_row["c"] if total_row else 0

        cur = await db.execute(
            f"SELECT * FROM tasks{where_sql} "
            f"ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, page_size, offset],
        )
        rows = await cur.fetchall()

    items: List[VideoResponse] = []
    for r in rows:
        v = _row_to_video(dict(r))
        if v:
            items.append(v)
    return VideoListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


@router.get("/{video_id}/download")
async def download_video(video_id: int):
    """下载单个视频文件"""
    tq = TaskQueue()
    await tq.init_db()
    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM tasks WHERE id = ?", (video_id,)
        )
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="视频不存在")
    output_path = row["output_path"]
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(status_code=404, detail="视频文件已不存在于服务器")

    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=os.path.basename(output_path),
    )


@router.post("/batch-download")
async def batch_download(payload: BatchDownloadRequest):
    """批量打包下载视频（zip）"""
    if not payload.video_ids:
        raise HTTPException(status_code=400, detail="video_ids 不能为空")

    tq = TaskQueue()
    await tq.init_db()
    placeholders = ",".join("?" for _ in payload.video_ids)
    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"SELECT * FROM tasks WHERE id IN ({placeholders})",
            payload.video_ids,
        )
        rows = await cur.fetchall()

    files: List[tuple] = []  # (filename, fullpath)
    for r in rows:
        out = r["output_path"]
        if out and os.path.exists(out):
            files.append((os.path.basename(out), out))

    if not files:
        raise HTTPException(status_code=404, detail="没有可下载的视频文件")

    # 内存中构建 zip
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # 处理同名冲突
        used_names = set()
        for name, fullpath in files:
            base, ext = os.path.splitext(name)
            final = name
            counter = 1
            while final in used_names:
                final = f"{base}_{counter}{ext}"
                counter += 1
            used_names.add(final)
            zf.write(fullpath, arcname=final)
    buffer.seek(0)

    zip_name = f"symphony_videos_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
    )


@router.delete("/{video_id}", response_model=SimpleResponse)
async def delete_video(video_id: int) -> SimpleResponse:
    """删除视频文件（保留任务记录但清空 output_path）"""
    tq = TaskQueue()
    await tq.init_db()
    async with aiosqlite.connect(tq.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM tasks WHERE id = ?", (video_id,)
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="视频不存在")

        output_path = row["output_path"]
        # 尝试删除磁盘文件
        if output_path and os.path.exists(output_path):
            try:
                os.remove(output_path)
            except OSError as e:
                logger.warning(f"删除视频文件失败: {output_path}: {e}")

        # 清空 output_path 字段
        now = datetime.now().isoformat(timespec="seconds")
        await db.execute(
            "UPDATE tasks SET output_path = NULL, updated_at = ? WHERE id = ?",
            (now, video_id),
        )
        await db.commit()

    return SimpleResponse(success=True, message="已删除")
