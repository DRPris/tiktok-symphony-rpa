"""
引擎管理器 - 单例管理 Playwright 批量引擎的生命周期

确保同一时间只有一个 BatchEngine 实例在运行
"""

import os
import sys
import asyncio
import logging
from datetime import datetime
from typing import Optional, Dict, Any

# 确保可以导入项目根模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from session_manager import SessionManager, SessionExpiredError
from task_queue import TaskQueue
from batch_engine import BatchEngine

logger = logging.getLogger("symphony_batch")


class EngineManager:
    """管理后台 Playwright 批量引擎的生命周期（单例模式）"""

    _instance: Optional["EngineManager"] = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        # 防止单例多次初始化
        if getattr(self, "_initialized", False):
            return
        self._initialized = True

        self._engine: Optional[BatchEngine] = None
        self._session: Optional[SessionManager] = None
        self._task_queue: Optional[TaskQueue] = None
        self._task: Optional[asyncio.Task] = None
        self._batch_id: Optional[str] = None
        self._lock = asyncio.Lock()
        self._started_at: Optional[datetime] = None

    # ===== 状态属性 =====

    @property
    def is_running(self) -> bool:
        """引擎是否正在运行"""
        return self._task is not None and not self._task.done()

    @property
    def current_batch_id(self) -> Optional[str]:
        """当前批次 ID"""
        return self._batch_id

    # ===== 启动 / 停止 =====

    async def start(
        self,
        batch_id: Optional[str] = None,
        concurrent: int = 3,
        headless: bool = False,
    ) -> Dict[str, Any]:
        """
        启动批量引擎（在后台异步运行）

        Args:
            batch_id: 指定批次（None 时使用最近批次）
            concurrent: 并发 Tab 数
            headless: 是否无头模式

        Returns:
            启动状态字典
        """
        async with self._lock:
            if self.is_running:
                return {
                    "success": False,
                    "message": f"引擎已在运行：批次 {self._batch_id}",
                    "batch_id": self._batch_id,
                }

            # 1. 初始化任务队列
            self._task_queue = TaskQueue()
            await self._task_queue.init_db()

            # 2. 解析 batch_id
            if not batch_id:
                batch_id = await self._task_queue.get_latest_batch_id()
            if not batch_id:
                return {
                    "success": False,
                    "message": "没有可启动的批次，请先创建批量任务",
                }
            self._task_queue.set_batch_id(batch_id)
            self._batch_id = batch_id

            # 3. 把 running/waiting/downloading 重置为 pending（断点续传）
            await self._task_queue.reset_running_tasks()

            # 4. 检查是否有待处理任务
            stats = await self._task_queue.get_stats()
            pending = stats.get(TaskQueue.STATUS_PENDING, 0)
            if pending == 0:
                return {
                    "success": False,
                    "message": "当前批次没有待处理任务",
                    "batch_id": batch_id,
                }

            # 5. 初始化浏览器
            self._session = SessionManager()
            try:
                await self._session.init_browser(headless=headless)
                await self._session.get_context()
            except SessionExpiredError as e:
                await self._cleanup_session()
                return {
                    "success": False,
                    "message": str(e),
                }
            except Exception as e:
                await self._cleanup_session()
                return {
                    "success": False,
                    "message": f"浏览器启动失败: {e}",
                }

            # 6. 创建引擎并后台运行
            self._engine = BatchEngine(
                session_manager=self._session,
                task_queue=self._task_queue,
                max_concurrent=concurrent,
            )
            self._started_at = datetime.now()
            self._task = asyncio.create_task(self._run_engine())

            logger.info(f"引擎已启动: batch_id={batch_id}, concurrent={concurrent}")
            return {
                "success": True,
                "message": "引擎已启动",
                "batch_id": batch_id,
                "pending": pending,
            }

    async def _run_engine(self):
        """后台执行引擎主循环，结束后清理资源"""
        try:
            await self._engine.start()
        except asyncio.CancelledError:
            logger.warning("引擎被取消")
        except Exception as e:
            logger.exception(f"引擎运行异常: {e}")
        finally:
            await self._cleanup_session()
            self._engine = None

    async def stop(self) -> Dict[str, Any]:
        """停止当前引擎"""
        async with self._lock:
            if not self.is_running:
                return {"success": False, "message": "引擎未运行"}

            try:
                if self._engine is not None:
                    await self._engine.stop()
            except Exception as e:
                logger.warning(f"调用 engine.stop 失败: {e}")

            # 等待后台 task 结束（最多 30s）
            if self._task is not None:
                try:
                    await asyncio.wait_for(self._task, timeout=30)
                except asyncio.TimeoutError:
                    self._task.cancel()
                    try:
                        await self._task
                    except (asyncio.CancelledError, Exception):
                        pass

            self._task = None
            return {"success": True, "message": "引擎已停止"}

    async def _cleanup_session(self):
        """关闭浏览器，释放会话资源"""
        if self._session is not None:
            try:
                await self._session.close()
            except Exception as e:
                logger.warning(f"关闭 session 失败: {e}")
            self._session = None

    # ===== 进度查询 =====

    async def get_progress(self) -> Dict[str, Any]:
        """获取当前进度（从任务队列读取最新统计）"""
        # 即便引擎未运行，也尝试读取最近批次的进度
        tq = self._task_queue or TaskQueue()
        if self._task_queue is None:
            await tq.init_db()
            batch_id = self._batch_id or await tq.get_latest_batch_id()
        else:
            batch_id = self._batch_id

        if not batch_id:
            return {
                "is_running": self.is_running,
                "batch_id": None,
                "total": 0,
                "pending": 0,
                "running": 0,
                "waiting": 0,
                "downloading": 0,
                "done": 0,
                "failed": 0,
                "timestamp": datetime.now(),
            }

        stats = await tq.get_stats(batch_id=batch_id)
        return {
            "is_running": self.is_running,
            "batch_id": batch_id,
            "total": stats.get("total", 0),
            "pending": stats.get(TaskQueue.STATUS_PENDING, 0),
            "running": stats.get(TaskQueue.STATUS_RUNNING, 0),
            "waiting": stats.get(TaskQueue.STATUS_WAITING, 0),
            "downloading": stats.get(TaskQueue.STATUS_DOWNLOADING, 0),
            "done": stats.get(TaskQueue.STATUS_DONE, 0),
            "failed": stats.get(TaskQueue.STATUS_FAILED, 0),
            "timestamp": datetime.now(),
        }


# 全局单例
engine_manager = EngineManager()
