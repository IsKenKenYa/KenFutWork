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

PIDS=()
export KENFUTWORK_DESKTOP_SERVER_CWD="$ROOT"
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

port_up() { curl -s -o /dev/null -m 3 "http://127.0.0.1:$1" 2>/dev/null; }

# 服务端生命周期归 Tauri 壳（ensure_server_running：不健康才 spawn，关窗优雅停库）。
# 这里只负责 web dev server（Tauri devUrl 指向它）。
if port_up 3000; then
  echo "[dev] web 已在运行（3000），复用"
else
  echo "[dev] 启动 web dev server…"
  (cd apps/web && ./node_modules/.bin/next dev -p 3000 > "$ROOT/.kenfutwork-data/web-dev.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 45); do
    port_up 3000 && break
    sleep 2
  done
  port_up 3000 || { echo "[dev] web 未能就绪，看 .kenfutwork-data/web-dev.log"; exit 1; }
  echo "[dev] web 就绪（3000）"
fi

# 2.5 3001 上若挂着**旧打包快照**（target/**/app/server.cjs）就清掉——
# 壳对「已健康的 3001」会直接复用，快照进程不清就会一直被复用，
# 表现为「改了源码没生效」（2026-09-27 事故）。dev 形态只跑源码最新版。
if port_up 3001; then
  pid="$(lsof -nP -iTCP:3001 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *app/server/server.cjs*)
      kill "$pid" 2>/dev/null || true
      echo "[dev] 已停止旧打包快照服务端（3001 server.cjs）——dev 只跑源码最新版"
      for _ in $(seq 1 10); do port_up 3001 || break; sleep 1; done
      ;;
    *)
      echo "[dev] 3001 已有源码服务端（node --watch，改文件自动重载），复用"
      ;;
  esac
fi

# 3. Tauri 窗口（阻塞在本进程；关窗即退出并回收上面拉起的进程）
echo "[dev] 打开 Tauri 窗口…"
cd apps/desktop/src-tauri
exec cargo tauri dev
