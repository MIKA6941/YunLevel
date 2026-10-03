#!/usr/bin/env sh
# Linux / macOS 启动脚本：先编译 C++ 内核，再启动 Node 网关
set -e
cd "$(dirname "$0")"

if [ ! -x "./bin/YunEngine" ]; then
  echo "未找到 ./bin/YunEngine，正在编译…"
  node scripts/build-engine.js
fi

: "${PORT:=8080}"
: "${YUN_ENGINE:=$(pwd)/bin/YunEngine}"
export PORT YUN_ENGINE

echo "访问地址：http://0.0.0.0:${PORT}"
exec node server/server.js
