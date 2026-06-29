"""
任务队列管理器 - 基于 SQLite 的持久化任务队列，支持断点续传
"""

import os
import sys
import json
import uuid
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

import aiosqlite

# 确保可以导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config

logger = logging.getLogger("symphony_batch")


class TaskQueue:
    """基于 SQLite 的任务队列，支持持久化和断点续传"""

    DB_PATH = os.path.join(config.BASE_DIR, "storage", "tasks.db")

    # 任务状态
    STATUS_PENDING = "pending"
    STATUS_RUNNING = "running"
    STATUS_WAITING = "waiting"        # 等待视频生成
    STATUS_DOWNLOADING = "downloading"
    STATUS_DONE = "done"
    STATUS_FAILED = "failed"

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or self.DB_PATH
        # 确保目录存在
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._current_batch_id: Optional[str] = None

    # ===== 数据库初始化 =====

    async def init_db(self):
        """初始化数据库表结构"""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id TEXT NOT NULL,
                    product_name TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    task_data TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    output_path TEXT,
                    error_msg TEXT,
                    retries INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            # 索引：按 batch_id 和 status 查询
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_tasks_batch_status "
                "ON tasks(batch_id, status)"
            )
            # 唯一约束（去重）：相同 batch + product_name + mode 视为同一个任务
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_tasks_unique_key "
                "ON tasks(batch_id, product_name, mode)"
            )
            await db.commit()
        logger.info(f"任务数据库初始化完成: {self.db_path}")

    # ===== 批次管理 =====

    def set_batch_id(self, batch_id: str):
        """设置当前批次 ID"""
        self._current_batch_id = batch_id

    def get_batch_id(self) -> str:
        """获取当前批次 ID"""
        if not self._current_batch_id:
            self._current_batch_id = self.generate_batch_id()
        return self._current_batch_id

    @staticmethod
    def generate_batch_id() -> str:
        """生成新的 batch_id"""
        return f"batch_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"

    async def get_latest_batch_id(self) -> Optional[str]:
        """获取最新一个批次 ID（用于断点续传）"""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT batch_id FROM tasks "
                "ORDER BY created_at DESC LIMIT 1"
            )
            row = await cursor.fetchone()
        return row[0] if row else None

    async def has_unfinished_tasks(self, batch_id: Optional[str] = None) -> bool:
        """检查是否存在未完成的任务"""
        batch_id = batch_id or self._current_batch_id
        async with aiosqlite.connect(self.db_path) as db:
            if batch_id:
                cursor = await db.execute(
                    "SELECT COUNT(*) FROM tasks "
                    "WHERE batch_id = ? AND status NOT IN (?, ?)",
                    (batch_id, self.STATUS_DONE, self.STATUS_FAILED),
                )
            else:
                cursor = await db.execute(
                    "SELECT COUNT(*) FROM tasks "
                    "WHERE status NOT IN (?, ?)",
                    (self.STATUS_DONE, self.STATUS_FAILED),
                )
            row = await cursor.fetchone()
        return (row[0] or 0) > 0

    # ===== 任务导入 =====

    async def load_from_csv(
        self,
        csv_path: str,
        batch_id: Optional[str] = None,
        skip_existing_done: bool = True,
    ) -> int:
        """
        从 CSV 文件导入任务到队列

        Args:
            csv_path: CSV 文件路径
            batch_id: 批次 ID，默认自动生成
            skip_existing_done: 是否跳过已完成的同名任务

        Returns:
            导入的任务数
        """
        # 延迟导入避免循环依赖
        from csv_parser import CSVParser

        if batch_id is None:
            batch_id = self.generate_batch_id()
        self._current_batch_id = batch_id

        tasks = CSVParser.parse(csv_path)
        valid_tasks, errors = CSVParser.validate(tasks)
        if errors:
            for err in errors:
                logger.warning(f"CSV 校验警告: {err}")

        return await self.add_tasks(valid_tasks, batch_id, skip_existing_done)

    async def add_tasks(
        self,
        tasks: List[Dict[str, Any]],
        batch_id: str,
        skip_existing_done: bool = True,
    ) -> int:
        """
        批量添加任务

        Args:
            tasks: 任务列表，每个任务包含 product_name / mode / task_data
            batch_id: 批次 ID
            skip_existing_done: 是否跳过历史已完成的同名任务

        Returns:
            实际新增的任务数
        """
        now = datetime.now().isoformat(timespec="seconds")
        inserted = 0

        async with aiosqlite.connect(self.db_path) as db:
            # 已完成任务集合（按 product_name + mode 去重）
            done_keys = set()
            if skip_existing_done:
                cursor = await db.execute(
                    "SELECT product_name, mode FROM tasks WHERE status = ?",
                    (self.STATUS_DONE,),
                )
                async for row in cursor:
                    done_keys.add((row[0], row[1]))

            for t in tasks:
                product_name = t.get("product_name")
                mode = t.get("mode")
                if not product_name or not mode:
                    continue

                key = (product_name, mode)
                if skip_existing_done and key in done_keys:
                    logger.info(f"跳过已完成任务: {product_name} ({mode})")
                    continue

                task_data_json = json.dumps(t.get("task_data", {}), ensure_ascii=False)
                await db.execute(
                    """
                    INSERT INTO tasks
                        (batch_id, product_name, mode, task_data, status,
                         retries, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        batch_id,
                        product_name,
                        mode,
                        task_data_json,
                        self.STATUS_PENDING,
                        now,
                        now,
                    ),
                )
                inserted += 1

            await db.commit()

        logger.info(f"已导入 {inserted} 个任务到批次 {batch_id}")
        return inserted

    # ===== 任务查询 =====

    async def get_pending_tasks(
        self, limit: Optional[int] = None, batch_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """获取待处理（pending）的任务"""
        batch_id = batch_id or self._current_batch_id
        sql = (
            "SELECT id, batch_id, product_name, mode, task_data, status, "
            "output_path, error_msg, retries, created_at, updated_at "
            "FROM tasks WHERE status = ?"
        )
        params: List[Any] = [self.STATUS_PENDING]
        if batch_id:
            sql += " AND batch_id = ?"
            params.append(batch_id)
        sql += " ORDER BY id ASC"
        if limit:
            sql += " LIMIT ?"
            params.append(limit)

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(sql, params)
            rows = await cursor.fetchall()
        return [self._row_to_dict(r) for r in rows]

    async def get_all_tasks(
        self, batch_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """获取批次内所有任务"""
        batch_id = batch_id or self._current_batch_id
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            if batch_id:
                cursor = await db.execute(
                    "SELECT * FROM tasks WHERE batch_id = ? ORDER BY id ASC",
                    (batch_id,),
                )
            else:
                cursor = await db.execute("SELECT * FROM tasks ORDER BY id ASC")
            rows = await cursor.fetchall()
        return [self._row_to_dict(r) for r in rows]

    async def get_failed_tasks(
        self, batch_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """获取失败任务列表"""
        batch_id = batch_id or self._current_batch_id
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            if batch_id:
                cursor = await db.execute(
                    "SELECT * FROM tasks WHERE batch_id = ? AND status = ? "
                    "ORDER BY id ASC",
                    (batch_id, self.STATUS_FAILED),
                )
            else:
                cursor = await db.execute(
                    "SELECT * FROM tasks WHERE status = ? ORDER BY id ASC",
                    (self.STATUS_FAILED,),
                )
            rows = await cursor.fetchall()
        return [self._row_to_dict(r) for r in rows]

    async def get_stats(
        self, batch_id: Optional[str] = None
    ) -> Dict[str, int]:
        """获取批次统计：pending/running/waiting/downloading/done/failed"""
        batch_id = batch_id or self._current_batch_id
        stats = {
            self.STATUS_PENDING: 0,
            self.STATUS_RUNNING: 0,
            self.STATUS_WAITING: 0,
            self.STATUS_DOWNLOADING: 0,
            self.STATUS_DONE: 0,
            self.STATUS_FAILED: 0,
            "total": 0,
        }
        async with aiosqlite.connect(self.db_path) as db:
            if batch_id:
                cursor = await db.execute(
                    "SELECT status, COUNT(*) FROM tasks "
                    "WHERE batch_id = ? GROUP BY status",
                    (batch_id,),
                )
            else:
                cursor = await db.execute(
                    "SELECT status, COUNT(*) FROM tasks GROUP BY status"
                )
            async for row in cursor:
                stats[row[0]] = row[1]
                stats["total"] += row[1]
        return stats

    # ===== 任务状态更新 =====

    async def update_status(
        self,
        task_id: int,
        status: str,
        error_msg: Optional[str] = None,
        output_path: Optional[str] = None,
    ):
        """更新任务状态"""
        now = datetime.now().isoformat(timespec="seconds")
        async with aiosqlite.connect(self.db_path) as db:
            # 动态构造更新字段
            fields = ["status = ?", "updated_at = ?"]
            params: List[Any] = [status, now]
            if error_msg is not None:
                fields.append("error_msg = ?")
                params.append(error_msg)
            if output_path is not None:
                fields.append("output_path = ?")
                params.append(output_path)
            params.append(task_id)
            await db.execute(
                f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?",
                params,
            )
            await db.commit()

    async def increment_retry(self, task_id: int) -> int:
        """增加重试计数，返回更新后的 retries 值"""
        now = datetime.now().isoformat(timespec="seconds")
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE tasks SET retries = retries + 1, updated_at = ? WHERE id = ?",
                (now, task_id),
            )
            await db.commit()
            cursor = await db.execute(
                "SELECT retries FROM tasks WHERE id = ?", (task_id,)
            )
            row = await cursor.fetchone()
        return row[0] if row else 0

    async def reset_running_tasks(self, batch_id: Optional[str] = None) -> int:
        """
        将 running/waiting/downloading 状态的任务重置为 pending（断点续传用）

        Returns:
            重置的任务数
        """
        batch_id = batch_id or self._current_batch_id
        now = datetime.now().isoformat(timespec="seconds")
        async with aiosqlite.connect(self.db_path) as db:
            if batch_id:
                cursor = await db.execute(
                    "UPDATE tasks SET status = ?, updated_at = ? "
                    "WHERE batch_id = ? AND status IN (?, ?, ?)",
                    (
                        self.STATUS_PENDING,
                        now,
                        batch_id,
                        self.STATUS_RUNNING,
                        self.STATUS_WAITING,
                        self.STATUS_DOWNLOADING,
                    ),
                )
            else:
                cursor = await db.execute(
                    "UPDATE tasks SET status = ?, updated_at = ? "
                    "WHERE status IN (?, ?, ?)",
                    (
                        self.STATUS_PENDING,
                        now,
                        self.STATUS_RUNNING,
                        self.STATUS_WAITING,
                        self.STATUS_DOWNLOADING,
                    ),
                )
            await db.commit()
            count = cursor.rowcount
        if count > 0:
            logger.info(f"已重置 {count} 个未完成任务为 pending（断点续传）")
        return count

    # ===== 辅助方法 =====

    @staticmethod
    def _row_to_dict(row) -> Dict[str, Any]:
        """将 sqlite Row 转为 dict，并解析 task_data JSON"""
        d = dict(row)
        try:
            d["task_data"] = json.loads(d.get("task_data") or "{}")
        except (TypeError, json.JSONDecodeError):
            d["task_data"] = {}
        return d
