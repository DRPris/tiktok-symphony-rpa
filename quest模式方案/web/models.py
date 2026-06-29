"""
Pydantic 数据模型 - Web 管理后台 API 入参/出参
"""

from datetime import datetime
from typing import Optional, List, Any, Dict

from pydantic import BaseModel, Field


# ===== 产品管理 =====

class ProductCreate(BaseModel):
    """新增/编辑产品的请求体"""
    product_name: str
    mode: str  # generate_remix / image_to_video / ai_avatar / text_to_video
    url: Optional[str] = None
    image_path: Optional[str] = None
    prompt: Optional[str] = None
    language: str = "English"
    script: Optional[str] = None
    avatar_id: Optional[str] = None
    voice: Optional[str] = None
    style: Optional[str] = None
    description: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


class ProductResponse(BaseModel):
    """产品记录返回结构"""
    id: int
    product_name: str
    mode: str
    url: Optional[str] = None
    image_path: Optional[str] = None
    prompt: Optional[str] = None
    language: str = "English"
    script: Optional[str] = None
    avatar_id: Optional[str] = None
    voice: Optional[str] = None
    style: Optional[str] = None
    description: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None
    created_at: datetime


class ProductListResponse(BaseModel):
    """产品分页列表"""
    items: List[ProductResponse]
    total: int
    page: int
    page_size: int


class CSVUploadResponse(BaseModel):
    """CSV 上传结果"""
    inserted: int
    errors: List[str] = []
    total_parsed: int


# ===== 批量任务 =====

class TaskResponse(BaseModel):
    """任务返回结构"""
    id: int
    batch_id: str
    product_name: str
    mode: str
    status: str
    output_path: Optional[str] = None
    error_msg: Optional[str] = None
    retries: int = 0
    created_at: datetime
    updated_at: datetime
    task_data: Optional[Dict[str, Any]] = None


class TaskListResponse(BaseModel):
    """任务分页列表"""
    items: List[TaskResponse]
    total: int
    page: int
    page_size: int


class BatchCreateRequest(BaseModel):
    """批量任务创建请求"""
    product_ids: List[int]
    concurrent: int = 3


class BatchCreateResponse(BaseModel):
    """批量任务创建结果"""
    batch_id: str
    inserted: int


class StartRequest(BaseModel):
    """启动批量执行请求"""
    batch_id: Optional[str] = None
    concurrent: Optional[int] = None


class SimpleResponse(BaseModel):
    """通用结果响应"""
    success: bool
    message: str = ""


# ===== 视频库 =====

class VideoResponse(BaseModel):
    """视频记录返回结构"""
    id: int
    product_name: str
    mode: str
    batch_id: str
    output_path: str
    file_name: str
    size_bytes: int
    created_at: datetime
    updated_at: datetime


class VideoListResponse(BaseModel):
    """视频分页列表"""
    items: List[VideoResponse]
    total: int
    page: int
    page_size: int


class BatchDownloadRequest(BaseModel):
    """批量下载请求"""
    video_ids: List[int]


# ===== 设置 =====

class SettingsResponse(BaseModel):
    """配置返回结构"""
    max_concurrent_tabs: int
    video_generation_timeout: int
    poll_interval: int
    random_delay_min: float
    random_delay_max: float
    output_dir: str
    session_valid: bool


class SettingsUpdate(BaseModel):
    """配置更新结构（所有字段可选）"""
    max_concurrent_tabs: Optional[int] = Field(default=None, ge=1, le=20)
    video_generation_timeout: Optional[int] = Field(default=None, ge=60)
    poll_interval: Optional[int] = Field(default=None, ge=1)
    random_delay_min: Optional[float] = Field(default=None, ge=0)
    random_delay_max: Optional[float] = Field(default=None, ge=0)


# ===== 仪表盘 =====

class DashboardStats(BaseModel):
    """仪表盘统计指标"""
    today_total: int
    today_success: int
    today_failed: int
    success_rate: float
    queue_pending: int
    queue_running: int
    avg_duration_seconds: float


# ===== SSE 进度 =====

class ProgressEvent(BaseModel):
    """SSE 推送的进度事件"""
    is_running: bool
    batch_id: Optional[str] = None
    total: int = 0
    pending: int = 0
    running: int = 0
    waiting: int = 0
    downloading: int = 0
    done: int = 0
    failed: int = 0
    timestamp: datetime
