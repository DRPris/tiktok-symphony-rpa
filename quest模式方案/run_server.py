"""
启动 Symphony Batch Web 管理后台

用法：
    python run_server.py
    python run_server.py --port 8080 --host 127.0.0.1
"""

import os
import sys
import argparse

# 确保可导入项目根模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn


def parse_args():
    parser = argparse.ArgumentParser(description="Symphony Batch Web Server")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--port", type=int, default=8000, help="监听端口（默认 8000）")
    parser.add_argument("--reload", action="store_true", help="开启热重载（开发模式）")
    parser.add_argument(
        "--workers", type=int, default=1, help="工作进程数（默认 1，需关闭 reload）"
    )
    return parser.parse_args()


def main():
    args = parse_args()
    uvicorn.run(
        "web.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        workers=args.workers if not args.reload else 1,
    )


if __name__ == "__main__":
    main()
