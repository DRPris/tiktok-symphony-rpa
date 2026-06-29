"""
产品数据管理 API
"""

import os
import sys
import tempfile
import logging
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse

# 确保可导入项目根模块
sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

import config
from csv_parser import CSVParser
from web.product_store import ProductStore
from web.models import (
    ProductCreate,
    ProductResponse,
    ProductListResponse,
    CSVUploadResponse,
    SimpleResponse,
)

logger = logging.getLogger("symphony_batch")
router = APIRouter(tags=["products"])

# 模块级单例
_store = ProductStore()


async def _ensure_db():
    """确保数据库表已建立"""
    await _store.init_db()


def _to_response(item: dict) -> ProductResponse:
    """将存储记录转换为 API 响应模型"""
    # 字段对齐
    return ProductResponse(
        id=item["id"],
        product_name=item["product_name"],
        mode=item["mode"],
        url=item.get("url"),
        image_path=item.get("image_path"),
        prompt=item.get("prompt"),
        language=item.get("language") or "English",
        script=item.get("script"),
        avatar_id=item.get("avatar_id"),
        voice=item.get("voice"),
        style=item.get("style"),
        description=item.get("description"),
        extra=item.get("extra") or None,
        created_at=datetime.fromisoformat(item["created_at"]),
    )


@router.get("/sample-csv")
async def download_sample_csv():
    """下载示例 CSV 模板"""
    sample_path = os.path.join(config.BASE_DIR, "sample_products.csv")
    if not os.path.exists(sample_path):
        # 没有则现场生成
        CSVParser.generate_sample_csv(sample_path)
    return FileResponse(
        sample_path,
        media_type="text/csv",
        filename="sample_products.csv",
    )


@router.post("/upload-csv", response_model=CSVUploadResponse)
async def upload_csv(file: UploadFile = File(...)) -> CSVUploadResponse:
    """上传 CSV 文件，校验后导入产品库"""
    await _ensure_db()
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="仅支持 .csv 文件")

    # 写入临时文件
    suffix = ".csv"
    tmp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, mode="wb"
        ) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        # 解析并校验
        parsed = CSVParser.parse(tmp_path)
        valid, errors = CSVParser.validate(parsed)

        # 将 task_data 拍平成产品字段，方便后续编辑
        products: List[dict] = []
        for t in valid:
            mode = t.get("mode")
            task_data = t.get("task_data") or {}
            product_item = {
                "product_name": t.get("product_name"),
                "mode": mode,
                "language": task_data.get("language") or "English",
                "prompt": task_data.get("prompt"),
                "extra": {},
            }
            if mode == "generate_remix":
                product_item["url"] = task_data.get("product_url")
                images = task_data.get("images")
                if images and isinstance(images, list):
                    product_item["image_path"] = ",".join(images)
                product_item["description"] = task_data.get("description")
            elif mode == "image_to_video":
                product_item["image_path"] = task_data.get("image")
            elif mode == "ai_avatar":
                product_item["avatar_id"] = task_data.get("avatar_id")
                product_item["script"] = task_data.get("script")
                product_item["voice"] = task_data.get("voice")
            elif mode == "text_to_video":
                product_item["description"] = task_data.get("text")
                product_item["style"] = task_data.get("style")
            products.append(product_item)

        inserted = await _store.add_batch(products)
        return CSVUploadResponse(
            inserted=inserted,
            errors=errors,
            total_parsed=len(parsed),
        )

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


@router.get("", response_model=ProductListResponse)
async def list_products(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    keyword: Optional[str] = None,
    mode: Optional[str] = None,
) -> ProductListResponse:
    """分页获取产品列表"""
    await _ensure_db()
    items, total = await _store.list(
        page=page, page_size=page_size, keyword=keyword, mode=mode
    )
    return ProductListResponse(
        items=[_to_response(i) for i in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=ProductResponse)
async def create_product(payload: ProductCreate) -> ProductResponse:
    """手动新增单个产品"""
    await _ensure_db()
    if payload.mode not in CSVParser.SUPPORTED_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的模式：{payload.mode}",
        )
    new_id = await _store.add(payload.model_dump())
    item = await _store.get(new_id)
    if not item:
        raise HTTPException(status_code=500, detail="产品创建失败")
    return _to_response(item)


@router.put("/{product_id}", response_model=ProductResponse)
async def update_product(product_id: int, payload: ProductCreate) -> ProductResponse:
    """编辑产品"""
    await _ensure_db()
    if payload.mode not in CSVParser.SUPPORTED_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的模式：{payload.mode}",
        )
    ok = await _store.update(product_id, payload.model_dump())
    if not ok:
        raise HTTPException(status_code=404, detail="产品不存在")
    item = await _store.get(product_id)
    return _to_response(item)


@router.delete("/{product_id}", response_model=SimpleResponse)
async def delete_product(product_id: int) -> SimpleResponse:
    """删除产品"""
    await _ensure_db()
    ok = await _store.delete(product_id)
    if not ok:
        raise HTTPException(status_code=404, detail="产品不存在")
    return SimpleResponse(success=True, message="已删除")
