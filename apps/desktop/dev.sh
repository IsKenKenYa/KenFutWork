#!/usr/bin/env bash
# 一键桌面开发形态（FORM-2 免 Docker）：
#   apps/server（内嵌 PG + 桌面单进程）→ apps/web（dev server）→ Tauri 窗口
# 已在跑的进程直接复用（按端口探测）；退出时只清理本脚本自己拉起的进程。
#
# 用法：bash apps/desktop/dev.sh
# 前置：Rust（rustup）+ Postgres 二进制（KENFUTWORK_PG_BIN_DIR 或 npm 依赖包）+ 根 .env.local
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" = "Darwin" ]; then
  exec node apps/desktop/scripts/dev-macos.mjs "$@"
fi

PIDS=()
export KENFUTWORK_DESKTOP_SERVER_CWD="$ROOT"
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

port_up() { curl --noproxy '*' -s -o /dev/null -m 3 "http://127.0.0.1:$1" 2>/dev/null; }

# 注意：macOS 自带 /bin/bash 为 3.2，其分词器缺陷会把「紧邻全角标点的未加括号
# 变量」（如 $pid 后直接跟全角右括号）整体并入变量名，报 "pid: unbound
# variable"（真机复现）。因此中文文案里的变量一律写 ${var} 括号形式，勿改回裸 $var 写法。

# 服务端生命周期归 Tauri 壳（ensure_server_running：不健康才 spawn，关窗优雅停库）。
# 这里只负责 web dev server（Tauri devUrl 指向它）。
# web dev server 由本脚本独占并注入 API base（HTTP+WS 直连 :3001——Next dev
# 的 rewrite 代理不了 WebSocket，同源 ws://localhost:3000/api/ws 必死，
# 运行事件到不了前端——2026-09-28 真机）。重启也保证「最新代码 + 最新 env」。
if port_up 3000; then
  pid="$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    echo "[dev] 停止 3000 上的旧 web dev server（pid ${pid}）——以最新 env 重启"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do port_up 3000 || break; sleep 1; done
  fi
fi
echo "[dev] 启动 web dev server…"
(cd apps/web && NEXT_PUBLIC_SERVER_BASE_URL="http://localhost:3001" \
  ./node_modules/.bin/next dev -p 3000 > "$ROOT/.kenfutwork-data/web-dev.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 45); do
  port_up 3000 && break
  sleep 2
done
port_up 3000 || { echo "[dev] web 未能就绪，看 .kenfutwork-data/web-dev.log"; exit 1; }
echo "[dev] web 就绪（3000，API 直连 :3001）"

# 2.5 3001由源码服务端持有；先释放旧快照，再以最新代码拉起并等健康。
# Tauri就绪后从同一系统数据目录读取私有凭据，申请一次性票据连接。
if port_up 3001; then
  pid="$(lsof -nP -iTCP:3001 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    echo "[dev] 停止 3001 上的旧服务端（pid ${pid}）"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do port_up 3001 || break; sleep 1; done
    port_up 3001 && { echo "[dev] 3001 仍被占用，请手动检查：lsof -nP -iTCP:3001"; exit 1; }
  fi
fi
echo "[dev] 启动源码服务端（本地实例与接入校验）…"
(pnpm --filter @kenfutwork/server dev:server \
  > "$ROOT/.kenfutwork-data/server-dev.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 90); do
  port_up 3001 && break
  sleep 1
done
port_up 3001 || { echo "[dev] 服务端未能就绪，看 .kenfutwork-data/server-dev.log"; exit 1; }
curl --noproxy '*' -sf -m 5 "http://127.0.0.1:3001/api/health" \
  -o /dev/null || { echo "[dev] 服务端尚未就绪，请检查服务端日志"; exit 1; }
echo "[dev] 服务端就绪（3001，本地实例）"

# 3. Tauri 窗口（阻塞在本进程；关窗即退出并回收上面拉起的进程）
echo "[dev] 打开 Tauri 窗口…"
cd apps/desktop/src-tauri
exec cargo tauri dev
