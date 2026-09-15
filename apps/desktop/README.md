# KenFutWork 桌面壳（Tauri 2，探索期脚手架）

> 状态：**脚手架已就位、本机未构建**（本机无 Rust 工具链）。设计依据：`docs/tech/多端产品设计.md` §4
> （Tauri 2 + 系统 WebView + 服务端 sidecar，拒 Electron）。Windows 侧（朋友的 exe 环境）可直接构建。

## 形态与职责

- **Rust 层保持薄**：窗口/托盘/自更新/深链/系统对话框归这里；**业务一律在服务端**
  （同一份 `apps/server` 代码）——保证桌面与自托管行为一致。
- `tauri.conf.json`：dev 态 `devUrl` 指向 web dev server（`localhost:3000`）；
  打包态 `frontendDist` 用 web 静态导出（`apps/web/out`）。
- **服务端 sidecar 是下一步**（见「路线」）：把 `apps/server` 打成单文件可执行
  （Node SEA / `bun build --compile`），随 Tauri 资源分发，桌面数据落本地数据目录。

## 本机运行（需要 Rust ≥1.77）

```sh
# 一次性：装 Rust 与 tauri-cli（本 Mac 尚未安装，Windows 同理）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --version "^2"

# 先把两端跑起来再开壳（推荐，验证内核/迁移正常）：
pnpm --filter @loomic/server dev:server   # 桌面形态：LOOMIC_EMBEDDED_PG=1 …（见仓库根 .env.local 样例）
pnpm --filter @loomic/web dev             # web UI（3000）

# 开壳：
cd apps/desktop/src-tauri && cargo tauri dev
```

## 路线（对齐《多端产品设计》D1–D3）

1. **本壳可开**（当前提交）：窗口加载 web dev server。
2. **sidecar**：Node SEA 打包 `apps/server` → Tauri `externalBin`；Rust 侧管理生命周期
   （启动/健康探活/退出停库——`desktop/runtime.ts` 的 `shutdown()` 已就位）。
3. **本地数据目录**：`LOOMIC_DATA_DIR` 指向用户数据目录（Rust `app_data_dir` 注入）；
   内嵌 Postgres + 同源迁移已在服务端跑通（46 条迁移全过）。
4. 之后才是托盘/自更新/深链与 Windows 打包（NSIS）。

## 已知限制

- 本脚手架未经 `cargo build` 验证（本机无 Rust）；首次构建需下载 crates 并编译数分钟。
- `frontendDist` 指向的 `apps/web/out` 需要 `apps/web` 以静态导出构建（现有配置已支持）。
- 前端「供应商设置」等 API 调用依赖 `NEXT_PUBLIC_SERVER_BASE_URL` 指向 sidecar 回环端口
  （桌面形态的接线点，随 sidecar 一起做）。
