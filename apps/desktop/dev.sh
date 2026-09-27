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
# web dev server 由本脚本独占并注入 API base（HTTP+WS 直连 :3001——Next dev
# 的 rewrite 代理不了 WebSocket，同源 ws://localhost:3000/api/ws 必死，
# 运行事件到不了前端——2026-09-28 真机）。重启也保证「最新代码 + 最新 env」。
if port_up 3000; then
  pid="$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    echo "[dev] 停止 3000 上的旧 web dev server（pid $pid）——以最新 env 重启"
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

# 2.5 服务端（源码 + 桌面身份）归本脚本独占：3001 归桌面 dev 独占——先清掉任何
# 占用者（旧打包快照 / `pnpm dev` 的 managed 服务端，壳复用健康 3001 时不注入桌面
# 身份，会出登录页或旧代码——2026-09-27 两次踩坑），再以**最新源码**拉起并等健康，
# 最后才开 Tauri 窗口（壳探到健康 3001 直接复用）。窗口打开时服务端必然已就绪，
# 不会出现「登录页闪现后要手动刷新」。
if port_up 3001; then
  pid="$(lsof -nP -iTCP:3001 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    echo "[dev] 停止 3001 上的旧服务端（pid $pid）"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do port_up 3001 || break; sleep 1; done
    port_up 3001 && { echo "[dev] 3001 仍被占用，请手动检查：lsof -nP -iTCP:3001"; exit 1; }
  fi
fi
echo "[dev] 启动源码服务端（local-trust 本机用户）…"
(KENFUTWORK_AUTH_DRIVER=local-trust pnpm --filter @kenfutwork/server dev:server \
  > "$ROOT/.kenfutwork-data/server-dev.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 90); do
  port_up 3001 && break
  sleep 1
done
port_up 3001 || { echo "[dev] 服务端未能就绪，看 .kenfutwork-data/server-dev.log"; exit 1; }
curl -sf -m 5 "http://127.0.0.1:3001/api/viewer" -H "Origin: http://localhost:3000" \
  -o /dev/null || { echo "[dev] 服务端已监听但 viewer 未就绪，稍后刷新窗口即可"; }
echo "[dev] 服务端就绪（3001，本机用户）"

# 3. Tauri 窗口（阻塞在本进程；关窗即退出并回收上面拉起的进程）
echo "[dev] 打开 Tauri 窗口…"
cd apps/desktop/src-tauri
exec cargo tauri dev
