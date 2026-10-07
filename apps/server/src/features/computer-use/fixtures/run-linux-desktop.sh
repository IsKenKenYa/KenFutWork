#!/usr/bin/env bash
set -euo pipefail
# /source只读；所有Linux依赖/产物在容器私有目录，主checkout不安装Linux二进制。
mkdir -p /desktop-test
rsync -a --exclude='node_modules' --exclude='.git' --exclude='.env*' \
  --exclude='target' --exclude='.next' --exclude='dist' /source/ /desktop-test/
cd /desktop-test
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @kenfutwork/shared build
exec dbus-run-session -- bash -euo pipefail -c '
  Xvfb :99 -screen 0 1280x960x24 -nolisten tcp &
  cu_xvfb_pid=$!
  cu_wm_pid=
  trap '\''if [[ -n "$cu_wm_pid" ]]; then kill "$cu_wm_pid" 2>/dev/null || true; fi; kill "$cu_xvfb_pid" 2>/dev/null || true'\'' EXIT
  timeout 30 bash -c '\''until xdpyinfo >/dev/null 2>&1; do sleep 0.05; done'\''
  kill -0 "$cu_xvfb_pid"
  openbox &
  cu_wm_pid=$!
  # 等待真实X服务/WM属性，不以固定sleep假定就绪；测试总deadline由外部验证窗口持有。
  timeout 30 bash -c '\''until xprop -root _NET_CLIENT_LIST 2>/dev/null | rg -q "window id"; do sleep 0.05; done'\''
  kill -0 "$cu_wm_pid"
  KENFUTWORK_TEST_DESKTOP=1 corepack pnpm --filter @kenfutwork/server exec vitest run src/features/computer-use/desktop.linux.integration.test.ts
'
