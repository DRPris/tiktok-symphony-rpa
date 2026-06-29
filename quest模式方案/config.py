"""
配置文件 - Symphony 批量操作工具的全局配置
"""

import os

# 项目根目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Symphony 相关 URL
SYMPHONY_URL = "https://ads.tiktok.com/creative/creativestudio/home"
LOGIN_URL = "https://ads.tiktok.com/i18n/login"

# 浏览器状态存储路径
STORAGE_STATE_PATH = os.path.join(BASE_DIR, "storage", "state.json")
# 持久化浏览器用户目录
USER_DATA_DIR = os.path.join(BASE_DIR, "storage", "browser_data")

# 并发控制
MAX_CONCURRENT_TABS = 3

# 随机延迟范围（秒），模拟人工操作
RANDOM_DELAY_MIN = 1.0
RANDOM_DELAY_MAX = 3.0

# 视频生成超时（秒，10分钟）
VIDEO_GENERATION_TIMEOUT = 600

# 轮询间隔（秒）
POLL_INTERVAL = 10

# 输出目录
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# 最大重试次数
MAX_RETRIES = 3

# 浏览器反检测配置
BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-extensions",
    "--disable-popup-blocking",
]

# 真实 User-Agent
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# Viewport 范围（随机选取）
VIEWPORT_WIDTH_RANGE = (1280, 1920)
VIEWPORT_HEIGHT_RANGE = (800, 1080)
