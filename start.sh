#!/bin/bash
# ovolv999 快速启动 (macOS / Linux)
# 用法: ./start.sh 或 ./start.sh "your task"

set -e
cd "$(dirname "$0")"

# 加载 .env（安全方式：逐行 source 而非 export 注入）
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

# 检查 API Key
if [ -z "$OPENAI_API_KEY" ]; then
    echo "[error] OPENAI_API_KEY not set"
    echo "  Option 1: export OPENAI_API_KEY=sk-... && ./start.sh"
    echo "  Option 2: Copy .env.example to .env and fill in your key"
    exit 1
fi

# 自动编译
if [ ! -f dist/bin/ovogogogo.js ]; then
    echo "[*] Building..."
    pnpm install && pnpm run build
fi

# 启动
node dist/bin/ovogogogo.js "$@"
