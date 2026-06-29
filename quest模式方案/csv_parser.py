"""
CSV 数据解析器 - 将产品 CSV 转换为任务字典列表
支持中英文列名混用
"""

import os
import csv
import json
import logging
from typing import List, Dict, Any, Tuple, Optional

logger = logging.getLogger("symphony_batch")


class CSVParser:
    """解析产品 CSV 数据为 task_data 列表"""

    # 列名别名映射：标准字段 → 可能出现的列名
    COLUMN_ALIASES = {
        "product_name": ["产品名", "产品名称", "product_name", "name"],
        "mode": ["模式", "mode", "type"],
        "url": ["URL", "url", "产品URL", "product_url", "链接"],
        "image_path": ["图片路径", "image_path", "image", "images", "图片"],
        "prompt": ["prompt", "Prompt", "提示词", "创意提示", "创意提示词"],
        "language": ["语言", "language", "lang"],
        "script": ["脚本", "script", "文案"],
        "avatar_id": ["形象ID", "avatar_id", "avatar", "数字形象"],
        "voice": ["配音", "voice", "声音"],
        "style": ["风格", "style"],
        "description": ["描述", "description", "产品描述"],
        "extra": ["额外参数", "extra", "extras", "extra_params"],
    }

    REQUIRED_COLUMNS = ["product_name", "mode"]

    SUPPORTED_MODES = {
        "generate_remix",
        "image_to_video",
        "ai_avatar",
        "text_to_video",
    }

    # ===== 公共 API =====

    @classmethod
    def parse(cls, csv_path: str) -> List[Dict[str, Any]]:
        """
        解析 CSV 文件

        CSV 格式支持两种列名风格：
            1. 中文：产品名, 模式, URL, 图片路径, prompt, 语言, 脚本, 形象ID, 风格, 额外参数
            2. 英文：product_name, mode, url, image_path, prompt, language, script,
                    avatar_id, style, extra

        Returns:
            list of {product_name, mode, task_data} dict
        """
        if not os.path.exists(csv_path):
            raise FileNotFoundError(f"CSV 文件不存在: {csv_path}")

        tasks: List[Dict[str, Any]] = []
        with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                logger.warning(f"CSV 文件为空或无表头: {csv_path}")
                return []

            # 构建 列名 → 标准字段名 的反向映射
            field_map = cls._build_field_map(reader.fieldnames)

            for row_idx, raw_row in enumerate(reader, start=2):
                normalized = cls._normalize_row(raw_row, field_map)
                if not normalized:
                    continue
                task = cls._row_to_task(normalized, row_num=row_idx)
                if task:
                    tasks.append(task)

        logger.info(f"已从 {csv_path} 解析 {len(tasks)} 行任务")
        return tasks

    @classmethod
    def validate(
        cls, tasks: List[Dict[str, Any]]
    ) -> Tuple[List[Dict[str, Any]], List[str]]:
        """
        校验任务数据

        Returns:
            (有效任务列表, 错误信息列表)
        """
        valid: List[Dict[str, Any]] = []
        errors: List[str] = []

        for t in tasks:
            row_num = t.get("_row", "?")
            product_name = t.get("product_name")
            mode = t.get("mode")
            task_data = t.get("task_data") or {}

            if not product_name:
                errors.append(f"第 {row_num} 行：缺少产品名")
                continue
            if not mode:
                errors.append(f"第 {row_num} 行：缺少模式")
                continue
            if mode not in cls.SUPPORTED_MODES:
                errors.append(
                    f"第 {row_num} 行：不支持的模式 '{mode}'，"
                    f"支持: {sorted(cls.SUPPORTED_MODES)}"
                )
                continue

            # 模式特定校验
            err = cls._validate_mode_specific(mode, task_data, row_num)
            if err:
                errors.append(err)
                continue

            valid.append(
                {
                    "product_name": product_name,
                    "mode": mode,
                    "task_data": task_data,
                }
            )

        return valid, errors

    @staticmethod
    def generate_sample_csv(output_path: str):
        """生成示例 CSV 文件"""
        rows = [
            {
                "产品名": "产品A",
                "模式": "generate_remix",
                "URL": "https://example.com/product-a",
                "图片路径": "",
                "prompt": "时尚电商广告风格",
                "语言": "English",
                "脚本": "",
                "形象ID": "",
                "风格": "",
                "额外参数": "",
            },
            {
                "产品名": "产品B",
                "模式": "image_to_video",
                "URL": "",
                "图片路径": "/path/to/product_b.jpg",
                "prompt": "展示产品特写和使用场景",
                "语言": "English",
                "脚本": "",
                "形象ID": "",
                "风格": "",
                "额外参数": "",
            },
            {
                "产品名": "产品C",
                "模式": "ai_avatar",
                "URL": "",
                "图片路径": "",
                "prompt": "介绍产品功能",
                "语言": "English",
                "脚本": "大家好这是一款优秀的产品",
                "形象ID": "avatar_001",
                "风格": "",
                "额外参数": "",
            },
            {
                "产品名": "产品D",
                "模式": "text_to_video",
                "URL": "",
                "图片路径": "",
                "prompt": "",
                "语言": "English",
                "脚本": "",
                "形象ID": "",
                "风格": "cinematic",
                "额外参数": "",
            },
        ]
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        fieldnames = [
            "产品名", "模式", "URL", "图片路径", "prompt",
            "语言", "脚本", "形象ID", "风格", "额外参数",
        ]
        with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        logger.info(f"已生成示例 CSV: {output_path}")

    # ===== 内部辅助 =====

    @classmethod
    def _build_field_map(cls, fieldnames: List[str]) -> Dict[str, str]:
        """
        构建 实际列名 → 标准字段名 的映射
        匹配时忽略大小写和首尾空白
        """
        field_map: Dict[str, str] = {}
        for col in fieldnames:
            if col is None:
                continue
            col_clean = col.strip()
            col_lower = col_clean.lower()
            for std_field, aliases in cls.COLUMN_ALIASES.items():
                for alias in aliases:
                    if alias.lower() == col_lower or alias == col_clean:
                        field_map[col] = std_field
                        break
                if col in field_map:
                    break
        return field_map

    @classmethod
    def _normalize_row(
        cls, raw_row: Dict[str, Any], field_map: Dict[str, str]
    ) -> Dict[str, Any]:
        """将原始行（按列名）转为标准字段字典，并清洗空值"""
        normalized: Dict[str, Any] = {}
        for col, value in raw_row.items():
            std_field = field_map.get(col)
            if not std_field:
                continue
            if value is None:
                continue
            value = str(value).strip()
            if value == "":
                continue
            normalized[std_field] = value
        return normalized

    @classmethod
    def _row_to_task(
        cls, row: Dict[str, Any], row_num: int
    ) -> Optional[Dict[str, Any]]:
        """将标准字段行转换为任务结构"""
        product_name = row.get("product_name")
        mode = row.get("mode")
        if not product_name or not mode:
            return None

        # 解析 extra 字段（JSON）
        extra: Dict[str, Any] = {}
        extra_raw = row.get("extra")
        if extra_raw:
            try:
                parsed = json.loads(extra_raw)
                if isinstance(parsed, dict):
                    extra = parsed
            except json.JSONDecodeError:
                logger.warning(f"第 {row_num} 行：额外参数 JSON 解析失败，已忽略")

        # 根据模式构造 task_data
        task_data = cls._build_task_data(mode, row, extra)

        return {
            "product_name": product_name,
            "mode": mode,
            "task_data": task_data,
            "_row": row_num,
        }

    @classmethod
    def _build_task_data(
        cls, mode: str, row: Dict[str, Any], extra: Dict[str, Any]
    ) -> Dict[str, Any]:
        """根据模式构造对应生成器接受的 task_data"""
        language = row.get("language") or "English"
        prompt = row.get("prompt")
        image_path = row.get("image_path")
        # 多图片支持：英文逗号或中文逗号或分号分隔
        images = None
        if image_path:
            if any(sep in image_path for sep in [",", "，", ";", "；"]):
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
                "product_url": row.get("url"),
                "images": images,
                "description": row.get("description") or row.get("script"),
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
                "avatar_id": row.get("avatar_id"),
                "script": row.get("script"),
                "language": language,
                "voice": row.get("voice"),
            }
        elif mode == "text_to_video":
            data = {
                "text": row.get("description") or prompt,
                "style": row.get("style"),
                "language": language,
            }
        else:
            data = {}

        # 合并 extra 参数（不覆盖已有值）
        for k, v in extra.items():
            data.setdefault(k, v)

        # 移除 None 值（保持 task_data 整洁）
        return {k: v for k, v in data.items() if v is not None}

    @classmethod
    def _validate_mode_specific(
        cls, mode: str, task_data: Dict[str, Any], row_num: Any
    ) -> Optional[str]:
        """模式特定字段校验，返回错误信息或 None"""
        if mode == "generate_remix":
            if not (
                task_data.get("product_url")
                or task_data.get("images")
                or task_data.get("description")
            ):
                return f"第 {row_num} 行：generate_remix 至少需要 URL、图片路径或描述之一"
        elif mode == "image_to_video":
            if not task_data.get("image"):
                return f"第 {row_num} 行：image_to_video 需要图片路径"
            if not task_data.get("prompt"):
                return f"第 {row_num} 行：image_to_video 需要 prompt"
        elif mode == "ai_avatar":
            if not task_data.get("script"):
                return f"第 {row_num} 行：ai_avatar 需要脚本"
        elif mode == "text_to_video":
            if not task_data.get("text"):
                return f"第 {row_num} 行：text_to_video 需要文本描述（描述或 prompt）"
        return None
