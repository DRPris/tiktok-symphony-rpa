"""
FastAPI 主应用 - Web 管理后台入口

启动方式：
    python run_server.py
    # 或
    uvicorn web.app:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import sys
import logging

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

# 确保可导入项目根模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from utils import setup_logging
from task_queue import TaskQueue
from web.product_store import ProductStore
from web.routers import dashboard, products, tasks, videos, settings

# 初始化日志
setup_logging(level=logging.INFO)
logger = logging.getLogger("symphony_batch")


app = FastAPI(
    title="Symphony Batch Video Generator",
    description="批量视频生成 Web 管理后台",
    version="1.0.0",
)

# ===== CORS（开发阶段允许所有来源）=====
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===== 全局异常处理：所有错误统一为 JSON 结构 =====

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """HTTPException → 结构化 JSON"""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "code": exc.status_code,
            "message": exc.detail if isinstance(exc.detail, str) else "请求失败",
            "detail": exc.detail,
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """请求体校验错误 → 结构化 JSON"""
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            "code": 422,
            "message": "请求参数校验失败",
            "detail": exc.errors(),
        },
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """未捕获异常 → 结构化 JSON"""
    logger.exception(f"未捕获异常: {request.method} {request.url}")
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "code": 500,
            "message": "服务器内部错误",
            "detail": str(exc),
        },
    )


# ===== 启动钩子：初始化数据库 =====

@app.on_event("startup")
async def on_startup():
    """应用启动时初始化数据库表"""
    tq = TaskQueue()
    await tq.init_db()
    ps = ProductStore()
    await ps.init_db()
    logger.info("Symphony Batch Web 服务已启动")


# ===== 健康检查 =====

@app.get("/api/health")
async def health():
    """健康检查"""
    return {"success": True, "status": "ok", "version": app.version}


# ===== 挂载路由 =====
app.include_router(dashboard.router, prefix="/api/dashboard")
app.include_router(products.router, prefix="/api/products")
app.include_router(tasks.router, prefix="/api/tasks")
app.include_router(videos.router, prefix="/api/videos")
app.include_router(settings.router, prefix="/api/settings")


# ===== 静态资源（前端构建产物）=====
# 必须放在最后挂载，避免拦截 /api 路由
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(_STATIC_DIR, exist_ok=True)
app.mount(
    "/",
    StaticFiles(directory=_STATIC_DIR, html=True),
    name="static",
)
