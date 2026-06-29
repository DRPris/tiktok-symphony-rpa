"""
产品数据存储 - 独立的 SQLite 表，保存上传/手动添加的产品配置
与 task_queue 中的 tasks 表区分：
    products 表保存「可被反复使用的产品定义」
    tasks    表保存「具体批次的执行记录」
"""

import os
import sys
import json
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

import aiosqlite

# 确保可以导入项目根模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config

logger = logging.getLogger("symphony_batch")


class ProductStore:
    """产品定义存储（异步 SQLite）"""

    DB_PATH = os.path.join(config.BASE_DIR, "storage", "products.db")

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or self.DB_PATH
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

    async def init_db(self):
        """初始化产品表"""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_name TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    url TEXT,
                    image_path TEXT,
                    prompt TEXT,
                    language TEXT DEFAULT 'English',
                    script TEXT,
                    avatar_id TEXT,
                    voice TEXT,
                    style TEXT,
                    description TEXT,
                    extra TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_products_name "
                "ON products(product_name)"
            )
            await db.commit()
        logger.info(f"产品数据库初始化完成: {self.db_path}")

    async def add(self, data: Dict[str, Any]) -> int:
        """新增产品，返回新记录 id"""
        now = datetime.now().isoformat(timespec="seconds")
        extra_json = json.dumps(data.get("extra") or {}, ensure_ascii=False)
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                INSERT INTO products
                    (product_name, mode, url, image_path, prompt, language,
                     script, avatar_id, voice, style, description, extra,
                     created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data.get("product_name"),
                    data.get("mode"),
                    data.get("url"),
                    data.get("image_path"),
                    data.get("prompt"),
                    data.get("language") or "English",
                    data.get("script"),
                    data.get("avatar_id"),
                    data.get("voice"),
                    data.get("style"),
                    data.get("description"),
                    extra_json,
                    now,
                ),
            )
            await db.commit()
            return cursor.lastrowid or 0

    async def add_batch(self, items: List[Dict[str, Any]]) -> int:
        """批量新增产品（CSV 上传）"""
        inserted = 0
        for item in items:
            try:
                await self.add(item)
                inserted += 1
            except Exception as e:
                logger.warning(f"产品入库失败: {item.get('product_name')}: {e}")
        return inserted

    async def update(self, product_id: int, data: Dict[str, Any]) -> bool:
        """更新产品信息"""
        # 构造动态更新语句
        allowed = [
            "product_name", "mode", "url", "image_path", "prompt", "language",
            "script", "avatar_id", "voice", "style", "description",
        ]
        fields, params = [], []
        for k in allowed:
            if k in data:
                fields.append(f"{k} = ?")
                params.append(data.get(k))
        if "extra" in data:
            fields.append("extra = ?")
            params.append(json.dumps(data.get("extra") or {}, ensure_ascii=False))
        if not fields:
            return False
        params.append(product_id)
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                f"UPDATE products SET {', '.join(fields)} WHERE id = ?", params
            )
            await db.commit()
            return cursor.rowcount > 0

    async def delete(self, product_id: int) -> bool:
        """删除产品"""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "DELETE FROM products WHERE id = ?", (product_id,)
            )
            await db.commit()
            return cursor.rowcount > 0

    async def get(self, product_id: int) -> Optional[Dict[str, Any]]:
        """根据 id 获取单个产品"""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM products WHERE id = ?", (product_id,)
            )
            row = await cursor.fetchone()
        return self._row_to_dict(row) if row else None

    async def get_many(self, ids: List[int]) -> List[Dict[str, Any]]:
        """批量按 id 获取产品"""
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                f"SELECT * FROM products WHERE id IN ({placeholders})", ids
            )
            rows = await cursor.fetchall()
        return [self._row_to_dict(r) for r in rows]

    async def list(
        self,
        page: int = 1,
        page_size: int = 20,
        keyword: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """分页列出产品"""
        page = max(1, page)
        page_size = max(1, min(200, page_size))
        offset = (page - 1) * page_size

        where_clauses, params = [], []
        if keyword:
            where_clauses.append(
                "(product_name LIKE ? OR prompt LIKE ? OR description LIKE ?)"
            )
            kw = f"%{keyword}%"
            params.extend([kw, kw, kw])
        if mode:
            where_clauses.append("mode = ?")
            params.append(mode)

        where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            count_cur = await db.execute(
                f"SELECT COUNT(*) FROM products{where_sql}", params
            )
            total_row = await count_cur.fetchone()
            total = total_row[0] if total_row else 0

            list_cur = await db.execute(
                f"SELECT * FROM products{where_sql} "
                f"ORDER BY id DESC LIMIT ? OFFSET ?",
                [*params, page_size, offset],
            )
            rows = await list_cur.fetchall()
        items = [self._row_to_dict(r) for r in rows]
        return items, total

    @staticmethod
    def _row_to_dict(row) -> Dict[str, Any]:
        """将 sqlite Row 转 dict 并解析 extra JSON"""
        d = dict(row)
        try:
            d["extra"] = json.loads(d.get("extra") or "{}")
        except (TypeError, json.JSONDecodeError):
            d["extra"] = {}
        return d

    @staticmethod
    def to_task_dict(product: Dict[str, Any]) -> Dict[str, Any]:
        """
        将产品记录转换为 TaskQueue 接受的任务结构
        与 csv_parser._build_task_data 保持一致的语义
        """
        mode = product.get("mode")
        language = product.get("language") or "English"
        prompt = product.get("prompt")
        image_path = product.get("image_path")

        # 多图片支持：英文/中文逗号或分号分隔
        images = None
        if image_path and any(sep in image_path for sep in [",", "，", ";", "；"]):
            images = [
                s.strip()
                for s in image_path.replace("，", ",")
                .replace(";", ",")
                .replace("；", ",")
                .split(",")
                if s.strip()
            ]

        if mode == "generate_remix":
            data = {
                "product_url": product.get("url"),
                "images": images,
                "description": product.get("description") or product.get("script"),
                "language": language,
                "prompt": prompt,
            }
        elif mode == "image_to_video":
            data = {
                "image": image_path,
                "prompt": prompt,
                "language": language,
            }
        elif mode == "ai_avatar":
            data = {
                "avatar_id": product.get("avatar_id"),
                "script": product.get("script"),
                "language": language,
                "voice": product.get("voice"),
            }
        elif mode == "text_to_video":
            data = {
                "text": product.get("description") or prompt,
                "style": product.get("style"),
                "language": language,
            }
        else:
            data = {}

        # 合并 extra
        for k, v in (product.get("extra") or {}).items():
            data.setdefault(k, v)

        # 移除 None
        task_data = {k: v for k, v in data.items() if v is not None}

        return {
            "product_name": product.get("product_name"),
            "mode": mode,
            "task_data": task_data,
        }
