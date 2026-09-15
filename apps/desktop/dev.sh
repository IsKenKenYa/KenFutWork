#!/usr/bin/env bash
# 一键桌面开发形态（FORM-2 免 Docker）：
#   apps/server（内嵌 PG + 桌面单进程）→ apps/web（dev server）→ Tauri 窗口
# 已在跑的进程直接复用（按端口探测）；退出时只清理本脚本自己拉起的进程。
#
# 用法：bash apps/desktop/dev.sh
# 前置：Rust（rustup）+ Postgres 二进制（LOOMIC_PG_BIN_DIR 或 npm 依赖包）+ 根 .env.local
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

port_up() { curl -s -o /dev/null -m 3 "http://127.0.0.1:$1" 2>/dev/null; }

# 1. 服务端（桌面形态：LOOMIC_EMBEDDED_PG 读根 .env.local）
if port_up 3001; then
  echo "[dev] 服务端已在运行（3001），复用"
else
  echo "[dev] 启动服务端（桌面形态，内嵌 Postgres）…"
  (cd apps/server && pnpm dev:server > "$ROOT/.loomic-data/server-dev.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 30); do
    port_up 3001 && break
    sleep 2
  done
  port_up 3001 || { echo "[dev] 服务端未能就绪，看 .loomic-data/server-dev.log"; exit 1; }
  echo "[dev] 服务端就绪（3001）"
fi

# 2. web dev server（Tauri devUrl 指向它）
if port_up 3000; then
  echo "[dev] web 已在运行（3000），复用"
else
  echo "[dev] 启动 web dev server…"
  (cd apps/web && ./node_modules/.bin/next dev -p 3000 > "$ROOT/.loomic-data/web-dev.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 45); do
    port_up 3000 && break
    sleep 2
  done
  port_up 3000 || { echo "[dev] web 未能就绪，看 .loomic-data/web-dev.log"; exit 1; }
  echo "[dev] web 就绪（3000）"
fi

# 3. Tauri 窗口（阻塞在本进程；关窗即退出并回收上面拉起的进程）
echo "[dev] 打开 Tauri 窗口…"
cd apps/desktop/src-tauri
exec cargo tauri dev
